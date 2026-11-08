import { decodeJson } from '../../utils/json-column';
import { Reservations } from '../entities/Reservations.entity';
import { RESERVATION_METADATA } from '../json-columns';
import { TrekRepository } from './_shared/trek-repository';
import type { EntityManager } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';

/**
 * The statements `AirtrailLinkService.createInAirtrail` issues against
 * `reservations` when it puts a TREK flight into AirTrail: claiming a booking
 * for the create, releasing the claim when the create fails, and linking a
 * multi-leg booking with the ids of its flights. The import and sync
 * statements stay in `ReservationsRepository`.
 *
 * A claim is the link with no flight id yet: `external_source = 'airtrail'`,
 * `external_id` null, sync off, and the time of the claim in `external_synced_at`. Every write path that would create or push
 * reads `external_source` first, so while the claim holds, a second create
 * (another edit, another process) and a push both stand down.
 */
/** A create calls AirTrail a few times, 12 s at most each; a claim this old was abandoned. */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

export class ReservationAirtrailRepository extends TrekRepository<Reservations> {
  /** Built over the context-resolving EntityManager, like the repositories MikroORM hands out per entity. */
  constructor(em: EntityManager) {
    super(em as SqlEntityManager, Reservations);
  }

  /**
   * ATL6 — `UPDATE reservations SET external_source = 'airtrail', external_id = NULL,
   * external_owner_user_id = ?, sync_enabled = 0, external_synced_at = ? WHERE id = ?
   * AND (external_source IS NULL OR (external_source = 'airtrail' AND external_id IS NULL
   * AND external_synced_at < ?))`. False when the booking is gone, linked, or claimed by
   * a create that is still running. A claim older than CLAIM_TIMEOUT_MS was left by a
   * process that stopped mid-create, and is taken over.
   */
  async claimForAirtrailCreate(id: number, external_owner_user_id: number, now: Date): Promise<boolean> {
    const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
    const changed = await this.nativeUpdate(
      {
        id,
        $or: [
          { external_source: null },
          { external_source: 'airtrail', external_id: null, external_synced_at: { $lt: stale } },
        ],
      },
      {
        external_source: 'airtrail',
        external_id: null,
        external_owner_user_id,
        sync_enabled: 0,
        external_synced_at: now.toISOString(),
      },
    );
    return changed > 0;
  }

  /**
   * ATL7 — `UPDATE reservations SET external_source = NULL, external_owner_user_id = NULL,
   * sync_enabled = 1, external_synced_at = NULL WHERE id = ? AND external_source = 'airtrail'
   * AND external_id IS NULL`. Gives a claim back after a failed create, so the next edit
   * tries again.
   */
  async releaseAirtrailClaim(id: number): Promise<void> {
    await this.nativeUpdate(
      { id, external_source: 'airtrail', external_id: null },
      { external_source: null, external_owner_user_id: null, sync_enabled: 1, external_synced_at: null },
    );
  }

  /**
   * ATL8 — `SELECT external_id, metadata FROM reservations WHERE external_source = 'airtrail'
   * AND external_owner_user_id = ?`: every AirTrail flight id a booking of this user
   * already links, through `external_id` or a multi-leg booking's `metadata.airtrail_ids`.
   */
  async listLinkedAirtrailIds(external_owner_user_id: number): Promise<Set<string>> {
    const rows = await this.find(
      { external_source: 'airtrail', external_owner_user_id },
      { fields: ['external_id', 'metadata'] },
    );
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.external_id) ids.add(row.external_id);
      const legs = decodeJson(RESERVATION_METADATA, row.metadata, `reservation ${row.id}`).airtrail_ids;
      if (Array.isArray(legs)) for (const leg of legs) ids.add(String(leg));
    }
    return ids;
  }

  /**
   * ATL9 — `UPDATE reservations SET external_id = ?, sync_enabled = 0, metadata = ?,
   * external_synced_at = ? WHERE id = ? AND external_source = 'airtrail'`. Turns the
   * claim on a multi-leg booking into the link a multi-leg import writes: sync off,
   * every leg's flight id in `metadata.airtrail_ids`. False when the booking is gone.
   */
  async linkCreatedMultiLeg(
    id: number,
    external_id: string,
    metadata: string,
    external_synced_at: string,
  ): Promise<boolean> {
    const changed = await this.nativeUpdate(
      { id, external_source: 'airtrail' },
      { external_id, sync_enabled: 0, metadata, external_synced_at },
    );
    return changed > 0;
  }

  /**
   * ATL10 — `UPDATE reservations SET external_id = ?, sync_enabled = 1, external_hash = ?,
   * external_synced_at = ? WHERE id = ? AND external_source = 'airtrail'`. Turns the claim
   * on a plain booking into the link an import writes, with live sync. False when the
   * booking is gone.
   */
  async linkCreatedSingle(
    id: number,
    external_id: string,
    external_hash: string,
    external_synced_at: string,
  ): Promise<boolean> {
    const changed = await this.nativeUpdate(
      { id, external_source: 'airtrail' },
      { external_id, sync_enabled: 1, external_hash, external_synced_at },
    );
    return changed > 0;
  }
}
