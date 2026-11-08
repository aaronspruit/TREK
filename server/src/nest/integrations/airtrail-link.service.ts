import { ADDON_IDS } from '../../addons';
import { AppSettings } from '../../db/entities/AppSettings.entity';
import { Days } from '../../db/entities/Days.entity';
import { ReservationEndpoints } from '../../db/entities/ReservationEndpoints.entity';
import { Reservations } from '../../db/entities/Reservations.entity';
import { RESERVATION_METADATA } from '../../db/json-columns';
import { AppSettingsRepository } from '../../db/repositories/AppSettings.repository';
import { DaysRepository } from '../../db/repositories/Days.repository';
import { ReservationAirtrailRepository } from '../../db/repositories/ReservationAirtrail.repository';
import { ReservationEndpointsRepository } from '../../db/repositories/ReservationEndpoints.repository';
import { ReservationsRepository } from '../../db/repositories/Reservations.repository';
import { decodeJson } from '../../utils/json-column';
import { AddonsService } from '../addons/addons.service';
import { logError } from '../audit/audit-log.logger';
import { readAppSetting } from '../common/app-settings.registry';
import { RealtimeService } from '../realtime/realtime.service';
import { ReservationsReadService } from '../reservations/reservations-read.service';
import {
  type BookingForCreate,
  buildCreatePayloads,
  buildSavePayload,
  findMatchingFlight,
} from './airtrail-sync.helpers';
import {
  AirtrailAuthError,
  type AirtrailCreds,
  type AirtrailFlightRaw,
  type AirtrailSavePayload,
} from './airtrail.client';
import { AirtrailClient } from './airtrail.client';
import { canonicalHash } from './airtrail.mapper';
import { AirtrailService } from './airtrail.service';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable } from '@nestjs/common';

/**
 * The AirTrail link lifecycle — the enablement gate, the detach policy, the
 * multi-leg guard (#1535) and the TREK → AirTrail write-back (#1240) — split
 * out of AirtrailSyncService so ReservationsModule can inject it: it reads
 * reservations through the leaf ReservationsReadService, never through
 * ReservationsService, so AirtrailCoreModule stays off the
 * ReservationsModule → AirtrailModule → ReservationsModule loop that used to
 * force airtrail.bridge. The pull half stays in AirtrailSyncService, which
 * genuinely needs ReservationsService (remote changes apply through the real
 * update path) and delegates these shared pieces back here.
 */
@Injectable()
export class AirtrailLinkService {
  constructor(
    @InjectRepository(Reservations) private readonly reservationsRepo: ReservationsRepository,
    @InjectRepository(ReservationEndpoints) private readonly endpointsRepo: ReservationEndpointsRepository,
    @InjectRepository(AppSettings) private readonly appSettings: AppSettingsRepository,
    private readonly realtime: RealtimeService,
    private readonly addons: AddonsService,
    private readonly reads: ReservationsReadService,
    private readonly client: AirtrailClient,
    private readonly airtrail: AirtrailService,
    private readonly createLinks: ReservationAirtrailRepository,
    @InjectRepository(Days) private readonly daysRepo: DaysRepository,
  ) {}

  /** Global on/off: the addon must be enabled and sync not explicitly turned off. */
  async syncGloballyEnabled(): Promise<boolean> {
    if (!(await this.addons.isAddonEnabled(ADDON_IDS.AIRTRAIL))) return false;
    const value = await readAppSetting(this.appSettings, 'airtrail_sync_enabled');
    return value !== 'false';
  }

  async broadcastUpdated(tripId: number, reservationId: number): Promise<void> {
    try {
      const reservation = await this.reads.getReservationWithJoins(reservationId);
      if (reservation)
        this.realtime.broadcast(String(tripId), 'reservation:updated', { reservation } as never, undefined);
    } catch {
      /* broadcast failure is non-fatal */
    }
  }

  async detach(tripId: number, reservationId: number): Promise<void> {
    await this.reservationsRepo.setAirtrailSyncDisabled(reservationId);
    await this.broadcastUpdated(tripId, reservationId);
  }

  /**
   * True when the reservation has grown into a multi-leg booking locally (extra
   * stops / metadata.legs) — a shape the single AirTrail flight it is linked to
   * cannot represent. Syncing such a row in either direction would corrupt one
   * side: a pull flattens the layover chain back to from→to, a push rewrites the
   * AirTrail flight to span the whole route (#1535).
   */
  async hasLocalMultiLegShape(reservationId: number, metadataJson: string | null | undefined): Promise<boolean> {
    // Malformed metadata falls through to the endpoint count.
    const legs = decodeJson(RESERVATION_METADATA, metadataJson, `reservation ${reservationId}`).legs;
    if (Array.isArray(legs) && legs.length > 1) return true;
    const n = await this.endpointsRepo.count({ reservation: reservationId });
    return n > 2;
  }

  /**
   * Push a locally-edited linked reservation back to AirTrail using the importer's
   * (owner's) credentials — even if a different member made the edit. If the owner
   * is gone or the flight no longer exists in AirTrail, the link is detached so the
   * next pull's AirTrail-wins policy can't silently revert the local edit.
   */
  async pushReservationToAirtrail(reservationId: number, tripId: number): Promise<void> {
    if (!(await this.syncGloballyEnabled())) return;

    const row = await this.reservationsRepo.findAirtrailLinked(reservationId);
    if (!row || !row.sync_enabled) return;

    // An edit that turned this linked flight into a multi-leg booking severs the
    // 1:1 mapping to the AirTrail flight: pushing would rewrite that flight to the
    // full span, and the next pull would flatten the layover again. Detach — the
    // merge is a deliberate local restructuring, like a joined import (#1535).
    const reservation = await this.reads.getReservationWithJoins(row.id);
    if (!reservation) return;
    if (await this.hasLocalMultiLegShape(row.id, (reservation as { metadata?: string | null }).metadata)) {
      await this.detach(tripId, row.id);
      return;
    }

    // AirTrail is read-only by default (#1240). Only push when the flight's owner has
    // explicitly opted in. A no-op skip (not a detach): the link stays active so the
    // inbound, AirTrail-wins pull keeps the reservation up to date.
    if (!row.external_owner_user_id || !(await this.airtrail.isAirtrailWriteEnabled(row.external_owner_user_id)))
      return;

    const creds: AirtrailCreds | null = await this.airtrail.getAirtrailCredentials(row.external_owner_user_id);
    if (!creds) {
      await this.detach(tripId, row.id); // owner disconnected — cannot push, so stop syncing
      return;
    }

    let existing: AirtrailFlightRaw | null;
    try {
      existing = await this.client.getFlight(creds, Number(row.external_id));
    } catch (err) {
      if (err instanceof AirtrailAuthError) await this.detach(tripId, row.id);
      else logError(`AirTrail push: get failed for reservation ${row.id}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!existing) {
      await this.detach(tripId, row.id); // gone in AirTrail → treat like a remote delete
      return;
    }

    const payload = buildSavePayload(reservation, existing);
    if (!payload) return;

    try {
      await this.client.saveFlight(creds, payload);
      // Self-write suppression: re-read the saved flight and store its hash so the
      // next poll doesn't treat our own write as an inbound change.
      const saved = await this.client.getFlight(creds, Number(row.external_id));
      if (saved) {
        await this.reservationsRepo.setAirtrailSyncStamp(row.id, canonicalHash(saved), new Date().toISOString());
      }
    } catch (err) {
      logError(`AirTrail push failed for reservation ${row.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Put a flight booking that has no AirTrail link into the AirTrail of `userId`,
   * and link the two.
   *
   * It runs only under the same opt-in as the write-back (#1240), and only for a
   * booking that was never linked: a detached booking keeps its `external_id`, so
   * it is not sent again. It skips a booking without airport codes and a date for
   * every flight. On a `create`, the flight belongs to the user who wrote it. On
   * an `edit`, only to a traveller of it, or, with no travellers named, to the
   * only member of the trip: an edit by someone else must not put another
   * person's flight in their log.
   *
   * A flight the user's AirTrail already holds (same airports, date and number)
   * is not made again. When no booking links it yet, the booking links to it; a
   * plain booking then pushes its data over it through the ordinary write-back.
   * When another booking links it already, nothing is written: a second link
   * would let an edit of one booking rewrite the other's flight.
   *
   * The booking is claimed in the database before anything is written (see
   * ReservationAirtrailRepository), so a second edit or another process cannot
   * create it twice; a claim left by a crash is taken over after a while. A plain
   * booking links with live sync, like an imported flight. A multi-leg booking
   * becomes one flight for each leg and links the way a multi-leg import does
   * (#1535): every flight id in `metadata.airtrail_ids`, sync off. When anything
   * after the claim fails, the flights this call made are deleted and the claim
   * is given back, so the next edit tries again. An edit that landed while the
   * flights were made is pushed after the link.
   *
   * @txIndependent every write is around network I/O against AirTrail: the claim
   * before it, the link or the release after it. One transaction cannot hold them.
   */
  async createInAirtrail(
    reservationId: number,
    tripId: number,
    userId: number,
    trigger: 'create' | 'edit',
  ): Promise<void> {
    try {
      if (!(await this.syncGloballyEnabled())) return;
      const reservation = await this.reads.getReservationWithJoins(reservationId);
      if (!reservation || !isUnlinkedFlight(reservation)) return;
      if (trigger === 'edit' && !(await this.ownsEditedFlight(reservation, tripId, userId))) return;
      if (!(await this.airtrail.isAirtrailWriteEnabled(userId))) return;

      const dayDates = await this.tripDayDates(tripId);
      const payloads = buildCreatePayloads(reservation as BookingForCreate, dayDates);
      if (!payloads) return;
      const creds = await this.airtrail.getAirtrailCredentials(userId);
      if (!creds) return;

      const existing = await this.client.listFlights(creds);
      const taken = await this.createLinks.listLinkedAirtrailIds(userId);
      const matches = payloads.map((p) => findMatchingFlight(existing, p));
      if (matches.some((m) => m && taken.has(String(m.id)))) return;

      if (!(await this.createLinks.claimForAirtrailCreate(reservationId, userId, new Date()))) return;
      const made: number[] = [];
      try {
        const flights = await this.saveFlights(creds, payloads, matches, made);
        if (!(await this.linkCreated(reservationId, flights))) {
          // Deleted while the flights were made.
          await this.undoCreate(creds, reservationId, made);
          return;
        }
        await this.broadcastUpdated(tripId, reservationId);
        await this.pushAfterLink(creds, reservationId, tripId, flights, payloads, dayDates, made);
      } catch (err) {
        await this.undoCreate(creds, reservationId, made);
        throw err;
      }
    } catch (err) {
      logError(`AirTrail create failed for reservation ${reservationId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async ownsEditedFlight(
    reservation: Record<string, unknown>,
    tripId: number,
    userId: number,
  ): Promise<boolean> {
    const travelers = (reservation.travelers as { user_id: number }[] | undefined) ?? [];
    if (travelers.length > 0) return travelers.some((t) => t.user_id === userId);
    const roster = await this.reads.tripRoster(tripId);
    return roster.size === 1 && roster.has(userId);
  }

  private async tripDayDates(tripId: number): Promise<Map<number, string>> {
    const days = await this.daysRepo.listByTrip(tripId);
    return new Map(days.filter((d) => d.date).map((d) => [d.id, d.date as string]));
  }

  /**
   * One AirTrail flight for each payload, in order: the matched flight as it is,
   * or a new one. Every flight it makes goes into `made` as soon as AirTrail
   * answers, so a failure can remove it.
   */
  private async saveFlights(
    creds: AirtrailCreds,
    payloads: AirtrailSavePayload[],
    matches: (AirtrailFlightRaw | undefined)[],
    made: number[],
  ): Promise<AirtrailFlightRaw[]> {
    const results = await Promise.allSettled(
      payloads.map(async (payload, i) => {
        const match = matches[i];
        if (match) return match;
        const { id } = await this.client.saveFlight(creds, payload);
        if (id != null) made.push(id);
        // The hash needs the flight as AirTrail stored it, so the next pull does
        // not read TREK's own write as a remote change.
        const saved = id == null ? null : await this.client.getFlight(creds, id);
        if (!saved) throw new Error(`flight ${id ?? '(no id)'} not readable after save`);
        return saved;
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((r) => (r as PromiseFulfilledResult<AirtrailFlightRaw>).value);
  }

  /** Turns the claim into the link. False when the booking is gone. */
  private async linkCreated(reservationId: number, flights: AirtrailFlightRaw[]): Promise<boolean> {
    const now = new Date().toISOString();
    if (flights.length === 1) {
      return this.createLinks.linkCreatedSingle(reservationId, String(flights[0].id), canonicalHash(flights[0]), now);
    }
    // Read the metadata again: an edit may have changed it while the flights were made.
    const current = await this.reads.getReservationWithJoins(reservationId);
    if (!current) return false;
    const meta = decodeJson(RESERVATION_METADATA, current.metadata as string | null, `reservation ${reservationId}`);
    const metadata = JSON.stringify({ ...meta, airtrail_ids: flights.map((f) => String(f.id)) });
    return this.createLinks.linkCreatedMultiLeg(reservationId, String(flights[0].id), metadata, now);
  }

  private async undoCreate(creds: AirtrailCreds, reservationId: number, made: number[]): Promise<void> {
    const removed = await Promise.allSettled(made.map((id) => this.client.deleteFlight(creds, id)));
    removed.forEach((r, i) => {
      if (r.status === 'rejected')
        logError(`AirTrail create: could not delete flight ${made[i]} after a failed create`);
    });
    await this.createLinks.releaseAirtrailClaim(reservationId);
  }

  /**
   * What AirTrail does not have yet once the link stands. A plain booking that
   * linked to a flight AirTrail already held, or that was edited while its
   * flight was made, goes through the ordinary write-back. A multi-leg booking
   * has no write-back: when it was edited meanwhile, the flights this call made
   * are saved again from the new payloads, and a matched flight is left as it is.
   */
  private async pushAfterLink(
    creds: AirtrailCreds,
    reservationId: number,
    tripId: number,
    flights: AirtrailFlightRaw[],
    sent: AirtrailSavePayload[],
    dayDates: Map<number, string>,
    made: number[],
  ): Promise<void> {
    const current = await this.reads.getReservationWithJoins(reservationId);
    if (!current) return;
    const now = buildCreatePayloads(current as BookingForCreate, dayDates);
    const edited = !!now && JSON.stringify(now) !== JSON.stringify(sent);
    if (flights.length === 1) {
      if (edited || made.length === 0) await this.pushReservationToAirtrail(reservationId, tripId);
      return;
    }
    if (!edited || !now || now.length !== flights.length) return;
    await Promise.all(
      flights.map((f, i) =>
        made.includes(f.id) ? this.client.saveFlight(creds, { ...now[i], id: f.id }) : Promise.resolve(undefined),
      ),
    );
  }
}

/**
 * A flight booking with no AirTrail flight behind it: never linked, or claimed
 * for a create that has not linked yet (a claim left by a crash can be taken over).
 */
export function isUnlinkedFlight(r: { type?: unknown; external_source?: unknown; external_id?: unknown }): boolean {
  return r.type === 'flight' && !r.external_id && (!r.external_source || r.external_source === 'airtrail');
}
