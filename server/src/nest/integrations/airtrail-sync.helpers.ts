import { RESERVATION_METADATA } from '../../db/json-columns';
import { decodeJson } from '../../utils/json-column';
import { wallClockInstant } from '../common/timezoneService';
import { flightPassengers, ownPassenger } from './airtrail.client';
import type { AirtrailFlightRaw, AirtrailPassengerWrite, AirtrailSavePayload } from './airtrail.client';
import { entityCode } from './airtrail.mapper';

/**
 * The pure half of the AirTrail push: turning a TREK reservation plus the flight
 * as AirTrail currently has it into a save body, building the body that creates
 * a new flight, and finding a flight AirTrail already holds.
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
  const seatNumber = fits(text(meta.seat), MAX_SEAT);
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
    flightNumber: flightNumberOf(meta.flight_number) ?? existing.flightNumber ?? null,
    aircraft: meta.aircraft ?? entityCode(existing.aircraft) ?? null,
    aircraftReg: fits(text(meta.aircraft_reg), MAX_REG) ?? existing.aircraftReg ?? null,
    // Flight-level up to 3.11.x, per-passenger from 3.12.0. Write both; each
    // version keeps the one it knows and strips the other.
    flightReason: reason,
    // AirTrail refuses the whole save for a value over its limits.
    note: (reservation.notes != null ? String(reservation.notes).slice(0, MAX_NOTE) : existing.note) ?? null,
    seats,
    passengers: seats,
  } as AirtrailSavePayload;
}

/** The fields of a booking (as getReservationWithJoins returns it) that a create reads. */
export interface BookingForCreate {
  id: number;
  day_id?: number | null;
  end_day_id?: number | null;
  metadata?: string | null;
  notes?: string | null;
  reservation_time?: string | null;
  reservation_end_time?: string | null;
  endpoints?: {
    role: string;
    sequence?: number;
    code?: string | null;
    timezone?: string | null;
    local_date?: string | null;
    local_time?: string | null;
  }[];
}

/** AirTrail looks an airline up by its ICAO code only, so any other value fails the whole save. */
const ICAO_AIRLINE = /^[A-Z0-9]{3}$/i;
/** An ICAO aircraft type designator, such as B738 or A20N. */
const ICAO_AIRCRAFT = /^[A-Z0-9]{2,4}$/i;
/** AirTrail's length limits (its flight zod schema). A longer value fails the whole save. */
const MAX_NOTE = 1000;
const MAX_SEAT = 5;
const MAX_FLIGHT_NUMBER = 10;
const MAX_REG = 10;

function codeOrNull(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A value that fits AirTrail's limit, else null: a cut seat or flight number would be a wrong one. */
function fits(value: string | null, max: number): string | null {
  return value && value.length <= max ? value : null;
}

/** A flight number as written, or without its spaces when only that fits AirTrail's limit. */
function flightNumberOf(value: unknown): string | null {
  const written = text(value);
  return fits(written, MAX_FLIGHT_NUMBER) ?? fits(written?.replace(/\s+/g, '') ?? null, MAX_FLIGHT_NUMBER);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The local date of an arrival whose clock time is known but whose date is not:
 * the first date on which that clock time, in the arrival zone, falls after the
 * departure. It handles an overnight flight and the date line both ways. With a
 * zone missing it falls back to the departure date, or the next day when the
 * clock reads earlier.
 */
export function arrivalDate(
  depDate: string,
  depTime: string,
  depZone: string | null | undefined,
  arrTime: string,
  arrZone: string | null | undefined,
): string {
  const departed = depZone ? wallClockInstant(depDate, depTime, depZone) : null;
  if (departed != null && arrZone) {
    for (const days of [-1, 0, 1, 2]) {
      const date = addDays(depDate, days);
      const landed = wallClockInstant(date, arrTime, arrZone);
      if (landed != null && landed > departed) return date;
    }
  }
  return arrTime < depTime ? addDays(depDate, 1) : depDate;
}

interface CreateLeg {
  from: string | null;
  to: string | null;
  depDate: string | null;
  depTime: string | null;
  arrDate: string | null;
  arrTime: string | null;
  flightNumber: string | null;
  seat: string | null;
  airline: string | null;
  aircraft: string | null;
  aircraftReg: string | null;
}

type Endpoint = NonNullable<BookingForCreate['endpoints']>[number];

function dayDate(dayDates: ReadonlyMap<number, string>, id: unknown): string | null {
  return typeof id === 'number' ? (dayDates.get(id) ?? null) : null;
}

/**
 * The flights a booking stands for, in order. A plain booking is one flight
 * from its `from` to its `to` endpoint. A multi-leg booking (#1535) is one
 * flight for each pair of neighbouring endpoints: a stop carries the departure
 * of the leg that leaves it, and `metadata.legs[i]` holds the codes, number,
 * seat, day ids and clock times of leg i. A date comes from the leg's day id
 * first (the planner form and MCP store one), then from the endpoint. An
 * arrival with no date of its own is worked out from the airport zones. Null
 * when the legs and the endpoints do not line up.
 */
function legsOf(
  reservation: BookingForCreate,
  meta: Record<string, unknown>,
  dayDates: ReadonlyMap<number, string>,
): CreateLeg[] | null {
  const endpoints = [...(reservation.endpoints || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const metaLegs = Array.isArray(meta.legs) ? (meta.legs as Record<string, unknown>[]) : null;
  const dep = splitLocal(reservation.reservation_time);
  const arr = splitLocal(reservation.reservation_end_time);
  const shared = {
    airline: codeOrNull(meta.airline_code, ICAO_AIRLINE),
    aircraft: codeOrNull(meta.aircraft, ICAO_AIRCRAFT),
    aircraftReg: fits(text(meta.aircraft_reg), MAX_REG),
  };

  const leg = (
    i: number,
    start: Endpoint | undefined,
    end: Endpoint | undefined,
    fields: Record<string, unknown>,
    fallback: { depDate: string | null; depTime: string | null; arrDate: string | null; arrTime: string | null },
  ): CreateLeg => {
    const depDate = dayDate(dayDates, fields.dep_day_id) ?? fallback.depDate;
    const depTime = text(fields.dep_time) ?? fallback.depTime;
    const arrTime = text(fields.arr_time) ?? fallback.arrTime;
    let arrDate = dayDate(dayDates, fields.arr_day_id) ?? fallback.arrDate;
    if (!arrDate && depDate && depTime && arrTime) {
      arrDate = arrivalDate(depDate, depTime, start?.timezone, arrTime, end?.timezone);
    }
    return {
      from: text(fields.from) ?? start?.code ?? null,
      to: text(fields.to) ?? end?.code ?? null,
      depDate,
      depTime,
      // AirTrail refuses an arrival date without a time.
      arrDate: arrTime ? arrDate : null,
      arrTime,
      flightNumber: flightNumberOf(fields.flight_number),
      seat: fits(text(fields.seat), MAX_SEAT),
      ...(i === 0
        ? shared
        : { airline: codeOrNull(fields.airline_code, ICAO_AIRLINE), aircraft: null, aircraftReg: null }),
    };
  };

  if (endpoints.length <= 2 && !(metaLegs && metaLegs.length > 1)) {
    const start = endpoints.find((e) => e.role === 'from');
    const end = endpoints.find((e) => e.role === 'to');
    return [
      leg(0, start, end, meta, {
        depDate: dep.date ?? start?.local_date ?? dayDate(dayDates, reservation.day_id),
        depTime: dep.time ?? start?.local_time ?? null,
        arrDate: arr.date ?? end?.local_date ?? dayDate(dayDates, reservation.end_day_id),
        arrTime: arr.time ?? end?.local_time ?? null,
      }),
    ];
  }

  const count = endpoints.length - 1;
  if (metaLegs && metaLegs.length !== count) return null;
  const legs: CreateLeg[] = [];
  for (let i = 0; i < count; i++) {
    const start = endpoints[i];
    const end = endpoints[i + 1];
    const isLast = i === count - 1;
    const fields = metaLegs?.[i] ?? (i === 0 ? { flight_number: meta.flight_number, seat: meta.seat } : {});
    legs.push(
      leg(i, start, end, fields, {
        depDate: start.local_date || (i === 0 ? dep.date : null),
        depTime: start.local_time ?? (i === 0 ? dep.time : null),
        arrDate: isLast ? end.local_date || arr.date : null,
        arrTime: isLast ? (end.local_time ?? arr.time) : null,
      }),
    );
  }
  return legs;
}

/**
 * The POST /flight/save bodies that create the AirTrail flights of a TREK
 * flight booking that has no AirTrail link: one for a plain booking, one for
 * each leg of a multi-leg booking. Null when any flight lacks what AirTrail
 * needs: both airport codes and a departure date. `dayDates` maps the trip's
 * day ids to their dates.
 *
 * They send no `id`, so AirTrail creates each flight and answers with its id.
 * The airline and the aircraft go only as ICAO codes: AirTrail refuses the
 * whole save for a code it does not know, and an imported booking carries an
 * airline name. A value over AirTrail's length limit is left out, and a long
 * note is cut. The key owner is the single passenger (`<USER_ID>`), with the
 * seat of that flight.
 */
export function buildCreatePayloads(
  reservation: BookingForCreate,
  dayDates: ReadonlyMap<number, string> = new Map(),
): AirtrailSavePayload[] | null {
  const meta = decodeJson(RESERVATION_METADATA, reservation.metadata, `reservation ${reservation.id}`);
  const legs = legsOf(reservation, meta, dayDates);
  if (!legs || legs.some((l) => !l.from || !l.to || !l.depDate)) return null;
  const reason = text(meta.flight_reason);
  const note = reservation.notes ? reservation.notes.slice(0, MAX_NOTE) : null;

  return legs.map((l) => {
    const seats: AirtrailPassengerWrite[] = [
      { userId: '<USER_ID>', guestName: null, seat: null, seatNumber: l.seat, seatClass: null, flightReason: reason },
    ];
    return {
      from: l.from as string,
      to: l.to as string,
      departure: l.depDate,
      departureTime: l.depTime,
      arrival: l.arrDate,
      arrivalTime: l.arrTime,
      departureScheduled: `${l.depDate}T00:00:00.000Z`,
      departureScheduledTime: l.depTime,
      arrivalScheduled: l.arrDate ? `${l.arrDate}T00:00:00.000Z` : null,
      arrivalScheduledTime: l.arrTime,
      airline: l.airline,
      flightNumber: l.flightNumber,
      aircraft: l.aircraft,
      aircraftReg: l.aircraftReg,
      flightReason: reason,
      note,
      seats,
      passengers: seats,
    };
  });
}

function sameAirport(a: AirtrailFlightRaw['from'], code: string): boolean {
  const c = code.toUpperCase();
  return a?.iata?.toUpperCase() === c || a?.icao?.toUpperCase() === c;
}

/** The digits of a flight number, so "UA 123", "UA123" and "123" compare equal. */
function flightDigits(value: string | null | undefined): string | null {
  const m = value?.match(/(\d+)\s*$/);
  return m ? String(Number(m[1])) : null;
}

/**
 * The flight already in AirTrail that `payload` describes, or undefined: same
 * airports, same departure date and, when both name one, the same flight
 * number. Linking to it instead of creating a second one keeps a flight that
 * the user logged in AirTrail before (or imported from elsewhere) single.
 */
export function findMatchingFlight(
  flights: AirtrailFlightRaw[],
  payload: AirtrailSavePayload,
): AirtrailFlightRaw | undefined {
  const wanted = flightDigits(payload.flightNumber);
  return flights.find((f) => {
    if (!sameAirport(f.from, payload.from) || !sameAirport(f.to, payload.to)) return false;
    const date = (f.date ?? f.departureScheduled ?? f.departure)?.slice(0, 10);
    if (date !== payload.departure) return false;
    const have = flightDigits(f.flightNumber);
    return !wanted || !have || wanted === have;
  });
}
