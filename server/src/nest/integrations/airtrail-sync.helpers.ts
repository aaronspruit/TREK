import { RESERVATION_METADATA } from '../../db/json-columns';
import { decodeJson } from '../../utils/json-column';
import { wallClockInstant } from '../common/timezoneService';
import { AIRTRAIL_SELF_USER_PLACEHOLDER } from './airtrail-v1';
import { flightPassengers, ownPassenger } from './airtrail.client';
import type { AirtrailFlightRaw, AirtrailPassengerWrite, AirtrailSavePayload } from './airtrail.client';
import { entityCode } from './airtrail.mapper';

/**
 * The pure half of the AirTrail push: turning a TREK reservation plus the flight
 * as AirTrail currently has it into a save body.
 *
 * Free functions rather than methods, and in their own file, because
 * buildSavePayload is the part with the real rules and its unit test drives it
 * directly with fixture objects — no database, no HTTP, no container.
 */
function splitLocal(dt: string | null | undefined): { date: string | null; time: string | null } {
  if (!dt) return { date: null, time: null };
  const date = dt.slice(0, 10);
  const m = dt.slice(10).match(/(\d{2}:\d{2})/);
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, time: m ? m[1] : null };
}

/**
 * Build the POST /flight/save body. AirTrail's save fully overwrites the flight,
 * so we start from the flight as AirTrail currently has it (`existing`, the raw
 * GET object) and overwrite ONLY the fields TREK manages. Everything else —
 * terminal, gate, scheduled/actual times, customFields, track, and any field
 * AirTrail may add later — passes through untouched. We deliberately do NOT model
 * those fields; spreading the raw object keeps us decoupled from AirTrail's schema
 * (#1240).
 */
export function buildSavePayload(reservation: any, existing: AirtrailFlightRaw): AirtrailSavePayload | null {
  const meta = decodeJson(RESERVATION_METADATA, reservation.metadata, `reservation ${reservation.id}`);
  const endpoints: any[] = reservation.endpoints || [];
  const fromEp = endpoints.find((e) => e.role === 'from');
  const toEp = endpoints.find((e) => e.role === 'to');
  const fromCode = fromEp?.code || existing.from?.iata || existing.from?.icao || null;
  const toCode = toEp?.code || existing.to?.iata || existing.to?.icao || null;
  if (!fromCode || !toCode) return null;

  const dep = splitLocal(reservation.reservation_time);
  const arr = splitLocal(reservation.reservation_end_time);
  if (!dep.date) return null;

  // Preserve the existing passenger manifest (an update replaces all of them);
  // fall back to the key-owner placeholder so AirTrail attributes it to the
  // connecting user. 3.12.0 renamed the list from seats to passengers, so read
  // whichever one this instance sent.
  const seats: AirtrailPassengerWrite[] = flightPassengers(existing).map((s) => ({
    userId: s.userId,
    guestName: s.guestName,
    seat: s.seat,
    seatNumber: s.seatNumber,
    seatClass: s.seatClass,
    ...(s.flightReason !== undefined ? { flightReason: s.flightReason } : {}),
  }));
  if (seats.length === 0) {
    seats.push({ userId: '<USER_ID>', guestName: null, seat: null, seatNumber: null, seatClass: null });
  }

  // Push the seat the user set in TREK onto their own AirTrail entry (the one
  // with a userId), leaving any co-passenger seats untouched.
  const seatNumber = typeof meta.seat === 'string' && meta.seat.trim() ? meta.seat.trim() : null;
  const ownSeat = seats.find((s) => s.userId) ?? seats[0];
  if (seatNumber && ownSeat) ownSeat.seatNumber = seatNumber;

  // The reason lives on the flight up to 3.11.x and on the passenger from 3.12.0.
  // Resolve it once from whichever place this instance kept it, then write it to
  // both — the version that does not know a key drops it.
  const reason =
    (meta.flight_reason as string | undefined) ?? existing.flightReason ?? ownPassenger(existing)?.flightReason ?? null;
  if (ownSeat) ownSeat.flightReason = reason;

  // Spread the existing flight first to preserve every AirTrail-owned field, then
  // overwrite only what TREK manages. `from`/`to`/`airline`/`aircraft` come back
  // from GET as objects but the save shape wants codes — those are exactly the
  // keys we override, so the spread never ships an object where a code is wanted.
  return {
    // Cast so the spread carries through the AirTrail-owned keys we deliberately
    // don't model (terminal, gate, scheduled/actual times, customFields, track, …).
    ...(existing as unknown as Record<string, unknown>),
    id: Number(reservation.external_id),
    from: fromCode,
    to: toCode,
    departure: dep.date,
    departureTime: dep.time,
    arrival: arr.date,
    arrivalTime: arr.time,
    // Import reads the SCHEDULED time, so a TREK edit must write back there too —
    // otherwise the next pull (scheduled-wins) would revert it. AirTrail rebuilds the
    // instant from a full-ISO date carrier + the HH:MM time, so pass a date carrier.
    departureScheduled: dep.date ? `${dep.date}T00:00:00.000Z` : null,
    departureScheduledTime: dep.time,
    arrivalScheduled: arr.date ? `${arr.date}T00:00:00.000Z` : null,
    arrivalScheduledTime: arr.time,
    // These are AirTrail-owned details TREK doesn't surface in its edit UI — a TREK
    // edit can leave them out of `metadata`. Preserve AirTrail's current value when
    // TREK has none rather than nulling it out (#1240). Use airline_code (not the
    // display name in metadata.airline, #1334); both it and entityCode mirror the
    // import/hash code-selection so a writeback stays a no-op for the hash.
    airline: meta.airline_code ?? entityCode(existing.airline) ?? null,
    flightNumber: meta.flight_number ?? existing.flightNumber ?? null,
    aircraft: meta.aircraft ?? entityCode(existing.aircraft) ?? null,
    aircraftReg: meta.aircraft_reg ?? existing.aircraftReg ?? null,
    // Flight-level up to 3.11.x, per-passenger from 3.12.0. Write both; each
    // version keeps the one it knows and strips the other.
    flightReason: reason,
    note: reservation.notes ?? existing.note ?? null,
    seats,
    passengers: seats,
  } as AirtrailSavePayload;
}

/** The fields of a booking (as getReservationWithJoins returns it) that a create reads. */
export interface BookingForCreate {
  id: number;
  metadata?: string | null;
  notes?: string | null;
  reservation_time?: string | null;
  reservation_end_time?: string | null;
  endpoints?: {
    role: string;
    code?: string | null;
    timezone?: string | null;
    local_date?: string | null;
    local_time?: string | null;
  }[];
}

/** AirTrail looks an airline up by its ICAO code only. A name or an IATA code would fail the whole save. */
const ICAO_AIRLINE = /^[A-Z0-9]{3}$/i;
/** An ICAO aircraft type designator, such as B738 or A20N. It starts with a letter, an IATA code such as 320 does not. */
const ICAO_AIRCRAFT = /^[A-Z][A-Z0-9]{1,3}$/i;
/** AirTrail's length limits (its v1 flight schema). A longer value fails the whole flight. */
const MAX_SEAT = 20;
const MAX_NOTE = 10000;
/** The flight reasons AirTrail accepts. Another value fails the whole save. */
const FLIGHT_REASONS = new Set(['leisure', 'business', 'crew', 'other']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A value within AirTrail's limit, else null: a cut seat would be a wrong seat. */
function fits(value: string | null, max: number): string | null {
  return value && value.length <= max ? value : null;
}

function codeOrNull(value: unknown, pattern: RegExp): string | null {
  const code = text(value);
  return code && pattern.test(code) ? code.toUpperCase() : null;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The local date of an arrival whose clock time is known but whose date is not:
 * the first date on which that clock time, in the arrival zone, falls after the
 * departure. This covers an overnight flight and the date line in both
 * directions. Without both zones, it is the departure date, or the next day
 * when the clock reads earlier.
 */
export function arrivalDate(
  depDate: string,
  depTime: string,
  depZone: string | null | undefined,
  arrTime: string,
  arrZone: string | null | undefined,
): string {
  const departed = depZone ? wallClockInstant(depDate, depTime, depZone) : null;
  if (departed !== null && arrZone) {
    const date = [-1, 0, 1, 2]
      .map((days) => addDays(depDate, days))
      .find((d) => (wallClockInstant(d, arrTime, arrZone) ?? -Infinity) > departed);
    if (date) return date;
  }
  return arrTime < depTime ? addDays(depDate, 1) : depDate;
}

/**
 * The body that creates the AirTrail flight of a plain TREK flight booking:
 * one flight from its `from` to its `to` endpoint. Null for a booking with
 * stops or legs, and for one without both airport codes or a departure date.
 *
 * The key owner is the one passenger, with the booking's seat. The airline and
 * the aircraft go only as ICAO codes, and a flight reason only when AirTrail
 * knows it, because AirTrail refuses the whole save for a value it does not
 * know. Without one of these values the flight still goes, without that field.
 */
export function buildCreatePayload(reservation: BookingForCreate): AirtrailSavePayload | null {
  const meta = decodeJson(RESERVATION_METADATA, reservation.metadata, `reservation ${reservation.id}`);
  const endpoints = reservation.endpoints ?? [];
  if (endpoints.length > 2 || (Array.isArray(meta.legs) && meta.legs.length > 1)) return null;
  const start = endpoints.find((e) => e.role === 'from');
  const end = endpoints.find((e) => e.role === 'to');
  const from = text(start?.code);
  const to = text(end?.code);
  const dep = splitLocal(reservation.reservation_time);
  const arr = splitLocal(reservation.reservation_end_time);
  const depDate = dep.date ?? start?.local_date ?? null;
  const depTime = dep.time ?? text(start?.local_time);
  const arrTime = arr.time ?? text(end?.local_time);
  let arrDate = arr.date ?? end?.local_date ?? null;
  if (!from || !to || !depDate) return null;
  if (!arrDate && depTime && arrTime) arrDate = arrivalDate(depDate, depTime, start?.timezone, arrTime, end?.timezone);

  const reason = text(meta.flight_reason);
  const flightReason = reason && FLIGHT_REASONS.has(reason) ? reason : null;
  const seats: AirtrailPassengerWrite[] = [
    {
      userId: AIRTRAIL_SELF_USER_PLACEHOLDER,
      guestName: null,
      seat: null,
      seatNumber: fits(text(meta.seat), MAX_SEAT),
      seatClass: null,
      flightReason,
    },
  ];
  return {
    from,
    to,
    departure: depDate,
    departureTime: depTime,
    // AirTrail refuses an arrival date without a time.
    arrival: arrTime ? arrDate : null,
    arrivalTime: arrTime,
    departureScheduled: depDate,
    departureScheduledTime: depTime,
    arrivalScheduled: arrTime ? arrDate : null,
    arrivalScheduledTime: arrTime,
    airline: codeOrNull(meta.airline_code, ICAO_AIRLINE),
    flightNumber: text(meta.flight_number),
    aircraft: codeOrNull(meta.aircraft, ICAO_AIRCRAFT),
    aircraftReg: text(meta.aircraft_reg),
    flightReason,
    note: text(reservation.notes)?.slice(0, MAX_NOTE) ?? null,
    seats,
    passengers: seats,
  };
}

function sameAirport(airport: AirtrailFlightRaw['from'], code: string): boolean {
  const c = code.toUpperCase();
  return airport?.iata?.toUpperCase() === c || airport?.icao?.toUpperCase() === c;
}

/** The digits of a flight number, so that "UA 123", "UA123" and "123" compare equal. */
function flightDigits(value: string | null | undefined): string | null {
  const m = value?.match(/(\d+)\s*$/);
  return m ? String(Number(m[1])) : null;
}

/**
 * The flight in AirTrail that `payload` describes, or undefined: the same
 * airports, the same departure date and the same flight number. When one side
 * has no flight number, the flight matches only when it is the only one on that
 * route that day. TREK links to that flight and does not make a second one, so
 * a flight that is in AirTrail already (logged by hand, or synced from another
 * tool) stays single.
 */
export function findMatchingFlight(
  flights: AirtrailFlightRaw[],
  payload: AirtrailSavePayload,
): AirtrailFlightRaw | undefined {
  const sameDay = flights.filter(
    (f) => sameAirport(f.from, payload.from) && sameAirport(f.to, payload.to) && f.date === payload.departure,
  );
  const wanted = flightDigits(payload.flightNumber);
  const same = sameDay.find((f) => wanted !== null && flightDigits(f.flightNumber) === wanted);
  if (same) return same;
  const only = sameDay.length === 1 ? sameDay[0] : undefined;
  return only && (wanted === null || flightDigits(only.flightNumber) === null) ? only : undefined;
}
