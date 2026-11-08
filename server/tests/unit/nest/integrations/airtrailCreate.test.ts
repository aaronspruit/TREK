/**
 * A TREK flight booking with no AirTrail link goes into a user's AirTrail and is
 * linked, under the write-back opt-in (#1240): one flight, or one for each leg
 * of a connection (#1535).
 *
 * The payload, the arrival date and the duplicate match are pure and tested
 * directly. AirtrailLinkService.createInAirtrail comes out of AirtrailCoreModule
 * over a snapshot test db, so the claim, the link and the release run as real
 * statements; AirTrail itself (the client) and the connection settings are fakes.
 */
import { Reservations } from '../../../../src/db/entities/Reservations.entity';
import { AddonsService } from '../../../../src/nest/addons/addons.service';
import { AirtrailCoreModule } from '../../../../src/nest/integrations/airtrail-core.module';
import { AirtrailLinkService } from '../../../../src/nest/integrations/airtrail-link.service';
import {
  arrivalDate,
  type BookingForCreate,
  buildCreatePayloads,
  buildSavePayload,
  findMatchingFlight,
} from '../../../../src/nest/integrations/airtrail-sync.helpers';
import {
  AirtrailClient,
  type AirtrailFlightRaw,
  type AirtrailSavePayload,
} from '../../../../src/nest/integrations/airtrail.client';
import { AirtrailService } from '../../../../src/nest/integrations/airtrail.service';
import { createSnapshotTestDb } from '../../../helpers/db-mock';
import {
  addReservationTraveler,
  makeReservation,
  makeReservationEndpoint,
} from '../../../helpers/factories/reservations';
import { deleteRows, findRow, updateRows } from '../../../helpers/factories/rows';
import { addTripMember, makeTrip } from '../../../helpers/factories/trips';
import { makeUser } from '../../../helpers/factories/users';
import { resetTestDb } from '../../../helpers/test-db';
import { createTestModule, type TestModule } from '../../../helpers/test-module';
import { MikroORM } from '@mikro-orm/core';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Endpoint = NonNullable<BookingForCreate['endpoints']>[number];

const HEL = { code: 'HEL', timezone: 'Europe/Helsinki' };
const LHR = { code: 'LHR', timezone: 'Europe/London' };
const ARN = { code: 'ARN', timezone: 'Europe/Stockholm' };

function endpoint(
  role: string,
  sequence: number,
  at: { code: string; timezone: string },
  date: string | null,
  time: string | null,
): Endpoint {
  return { role, sequence, ...at, local_date: date, local_time: time };
}

/** HEL → LHR, the evening of 1 Dec. */
function plain(overrides: Partial<BookingForCreate> = {}): BookingForCreate {
  return {
    id: 5,
    reservation_time: '2026-12-01T19:05',
    reservation_end_time: '2026-12-01T20:30',
    notes: 'Booked through CWT',
    metadata: JSON.stringify({ airline: 'Finnair', airline_code: 'FIN', flight_number: 'AY 1502', seat: '4D' }),
    endpoints: [endpoint('from', 0, HEL, '2026-12-01', '19:05'), endpoint('to', 1, LHR, '2026-12-01', '20:30')],
    ...overrides,
  };
}

/**
 * HEL → ARN late in the evening, then ARN → LHR in the morning, as the
 * KItinerary import saves a connection: no day ids. The first leg lands at an
 * earlier clock time than it left, the same evening, because Stockholm is an
 * hour behind Helsinki.
 */
function connection(overrides: Partial<BookingForCreate> = {}): BookingForCreate {
  return plain({
    reservation_time: '2026-12-01T23:30',
    reservation_end_time: '2026-12-02T08:55',
    metadata: JSON.stringify({
      airline: 'Finnair',
      airline_code: 'FIN',
      flight_number: 'AY801',
      legs: [
        { from: 'HEL', to: 'ARN', flight_number: 'AY801', seat: '4D', dep_time: '23:30', arr_time: '23:20' },
        { from: 'ARN', to: 'LHR', flight_number: 'BA777', seat: '12A', dep_time: '07:00', arr_time: '08:55' },
      ],
    }),
    endpoints: [
      endpoint('from', 0, HEL, '2026-12-01', '23:30'),
      endpoint('stop', 1, ARN, '2026-12-02', '07:00'),
      endpoint('to', 2, LHR, '2026-12-02', '08:55'),
    ],
    ...overrides,
  });
}

function payloadsOf(b: BookingForCreate, dayDates?: Map<number, string>): AirtrailSavePayload[] {
  const p = buildCreatePayloads(b, dayDates);
  if (!p) throw new Error('expected payloads');
  return p;
}

function flight(overrides: Partial<AirtrailFlightRaw> = {}): AirtrailFlightRaw {
  return {
    id: 77,
    from: { iata: 'HEL', icao: 'EFHK' },
    to: { iata: 'LHR', icao: 'EGLL' },
    date: '2026-12-01',
    datePrecision: 'day',
    departure: null,
    arrival: null,
    departureScheduled: null,
    arrivalScheduled: null,
    airline: null,
    flightNumber: 'AY1502',
    aircraft: null,
    aircraftReg: null,
    note: null,
    passengers: [],
    ...overrides,
  } as AirtrailFlightRaw;
}

describe('buildCreatePayloads', () => {
  it('builds a create body with no id, the airports, the local times, the seat and the ICAO airline', () => {
    const [p] = payloadsOf(plain());
    expect(p.id).toBeUndefined();
    expect(p).toMatchObject({
      from: 'HEL',
      to: 'LHR',
      departure: '2026-12-01',
      departureTime: '19:05',
      arrival: '2026-12-01',
      arrivalTime: '20:30',
      departureScheduledTime: '19:05',
      arrivalScheduledTime: '20:30',
      airline: 'FIN',
      flightNumber: 'AY 1502',
      note: 'Booked through CWT',
    });
    expect(p.passengers).toEqual([
      { userId: '<USER_ID>', guestName: null, seat: null, seatNumber: '4D', seatClass: null, flightReason: null },
    ]);
    expect(p.seats).toBe(p.passengers);
  });

  it('reads the local clock from a stored time with an offset', () => {
    const [p] = payloadsOf(
      plain({ reservation_time: '2025-11-17T10:00:00-08:00', reservation_end_time: '2025-11-17T17:28:00-05:00' }),
    );
    expect(p).toMatchObject({
      departure: '2025-11-17',
      departureTime: '10:00',
      arrival: '2025-11-17',
      arrivalTime: '17:28',
    });
  });

  it('leaves out an airline or an aircraft that is not an ICAO code, so AirTrail does not refuse the save', () => {
    const [p] = payloadsOf(plain({ metadata: JSON.stringify({ airline_code: 'AY', aircraft: 'Airbus A350-900' }) }));
    expect(p.airline).toBeNull();
    expect(p.aircraft).toBeNull();
  });

  it('keeps every value within AirTrail limits: cuts a long note, leaves out what is too long to cut', () => {
    const meta = JSON.stringify({ seat: '12A/12B', aircraft_reg: 'OH-LWA-EXTRA-1', flight_number: 'AY 1502 / 1504' });
    const [p] = payloadsOf(plain({ metadata: meta, notes: 'x'.repeat(1500) }));
    expect(p.note).toHaveLength(1000);
    expect(p.passengers[0].seatNumber).toBeNull();
    expect(p.aircraftReg).toBeNull();
    expect(p.flightNumber).toBeNull();
  });

  it('takes the date of a booking saved with a day and no time from its endpoints or its day', () => {
    const [fromEndpoint] = payloadsOf(plain({ reservation_time: null, reservation_end_time: null }));
    expect(fromEndpoint).toMatchObject({ departure: '2026-12-01', departureTime: '19:05' });

    const noTimes = plain({
      reservation_time: null,
      reservation_end_time: null,
      day_id: 31,
      endpoints: [endpoint('from', 0, HEL, null, null), endpoint('to', 1, LHR, null, null)],
    });
    const [fromDay] = payloadsOf(noTimes, new Map([[31, '2026-12-01']]));
    expect(fromDay).toMatchObject({ departure: '2026-12-01', departureTime: null });
  });

  it('sends no arrival date when the arrival has no time, which AirTrail refuses', () => {
    const [p] = payloadsOf(
      plain({
        reservation_end_time: '2026-12-01',
        endpoints: [endpoint('from', 0, HEL, '2026-12-01', '19:05'), endpoint('to', 1, LHR, '2026-12-01', null)],
      }),
    );
    expect(p.arrival).toBeNull();
    expect(p.arrivalScheduled).toBeNull();
  });

  it('returns null without both airport codes or without a departure date', () => {
    expect(buildCreatePayloads(plain({ endpoints: [endpoint('from', 0, HEL, '2026-12-01', '19:05')] }))).toBeNull();
    expect(
      buildCreatePayloads(
        plain({
          reservation_time: null,
          endpoints: [endpoint('from', 0, HEL, null, null), endpoint('to', 1, LHR, null, null)],
        }),
      ),
    ).toBeNull();
  });

  it('makes one flight for each leg of a connection, with its own number, seat, times and dates', () => {
    const [first, second] = payloadsOf(connection());
    // The clock alone would put the landing on the next day.
    expect(first).toMatchObject({
      from: 'HEL',
      to: 'ARN',
      departure: '2026-12-01',
      departureTime: '23:30',
      arrival: '2026-12-01',
      arrivalTime: '23:20',
      flightNumber: 'AY801',
      airline: 'FIN',
    });
    expect(first.passengers[0].seatNumber).toBe('4D');
    // Only the first leg is known to fly the booking's airline.
    expect(second).toMatchObject({
      from: 'ARN',
      to: 'LHR',
      departure: '2026-12-02',
      departureTime: '07:00',
      arrival: '2026-12-02',
      arrivalTime: '08:55',
      flightNumber: 'BA777',
      airline: null,
    });
    expect(second.passengers[0].seatNumber).toBe('12A');
  });

  it('takes the leg dates from the day ids the planner form and MCP store', () => {
    const legs = [
      {
        from: 'SFO',
        to: 'HKG',
        flight_number: 'CX873',
        dep_day_id: 40,
        dep_time: '11:00',
        arr_day_id: 41,
        arr_time: '18:00',
      },
      {
        from: 'HKG',
        to: 'BKK',
        flight_number: 'CX751',
        dep_day_id: 41,
        dep_time: '20:00',
        arr_day_id: 41,
        arr_time: '21:50',
      },
    ];
    const booking = plain({
      reservation_time: '2026-12-01T11:00',
      reservation_end_time: '2026-12-02T21:50',
      metadata: JSON.stringify({ flight_number: 'CX873', legs }),
      endpoints: [
        endpoint('from', 0, { code: 'SFO', timezone: 'America/Los_Angeles' }, '2026-12-01', '11:00'),
        endpoint('stop', 1, { code: 'HKG', timezone: 'Asia/Hong_Kong' }, null, '20:00'),
        endpoint('to', 2, { code: 'BKK', timezone: 'Asia/Bangkok' }, '2026-12-02', '21:50'),
      ],
    });
    const dayDates = new Map([
      [40, '2026-12-01'],
      [41, '2026-12-02'],
    ]);
    const [first, second] = payloadsOf(booking, dayDates);
    expect(first).toMatchObject({ departure: '2026-12-01', arrival: '2026-12-02', arrivalTime: '18:00' });
    expect(second).toMatchObject({ departure: '2026-12-02', arrival: '2026-12-02' });
  });

  it('reads the legs of a connection saved with stops and no leg details from the endpoints', () => {
    const [first, second] = payloadsOf(connection({ metadata: JSON.stringify({ flight_number: 'AY801' }) }));
    expect(first).toMatchObject({
      from: 'HEL',
      to: 'ARN',
      departure: '2026-12-01',
      departureTime: '23:30',
      flightNumber: 'AY801',
    });
    expect(first.arrival).toBeNull();
    expect(second).toMatchObject({ from: 'ARN', to: 'LHR', departure: '2026-12-02', arrivalTime: '08:55' });
  });

  it('returns null when the legs and the endpoints do not line up', () => {
    const endpoints = connection().endpoints?.filter((e) => e.role !== 'stop');
    expect(buildCreatePayloads(connection({ endpoints }))).toBeNull();
  });
});

describe('arrivalDate', () => {
  it('finds the next day for a long flight east across the date line', () => {
    expect(arrivalDate('2026-12-01', '11:00', 'America/Los_Angeles', '18:00', 'Asia/Hong_Kong')).toBe('2026-12-02');
  });

  it('finds the same day for a flight west across the date line that lands at an earlier clock time', () => {
    expect(arrivalDate('2026-12-01', '19:00', 'Asia/Tokyo', '07:00', 'Pacific/Honolulu')).toBe('2026-12-01');
  });

  it('falls back to the clock without zones: the next day when the arrival clock is earlier', () => {
    expect(arrivalDate('2026-12-01', '23:30', null, '00:20', null)).toBe('2026-12-02');
    expect(arrivalDate('2026-12-01', '08:00', null, '09:00', null)).toBe('2026-12-01');
  });
});

describe('findMatchingFlight', () => {
  const [payload] = payloadsOf(plain());

  it('matches the same route and date, by IATA or ICAO, and the same flight number however it is spaced', () => {
    expect(findMatchingFlight([flight({ flightNumber: 'AY 1502' })], payload)?.id).toBe(77);
    expect(findMatchingFlight([flight({ from: { icao: 'EFHK' } as never })], { ...payload, from: 'efhk' })?.id).toBe(
      77,
    );
  });

  it('matches when one side has no flight number', () => {
    expect(findMatchingFlight([flight({ flightNumber: null })], payload)?.id).toBe(77);
  });

  it('does not match another date, another route or another flight number', () => {
    expect(findMatchingFlight([flight({ date: '2026-12-02' })], payload)).toBeUndefined();
    expect(findMatchingFlight([flight({ to: { iata: 'LGW' } as never })], payload)).toBeUndefined();
    expect(findMatchingFlight([flight({ flightNumber: 'AY1504' })], payload)).toBeUndefined();
  });
});

describe('buildSavePayload', () => {
  it('keeps the push within AirTrail limits too, so an edit after the create is not refused', () => {
    const booking = {
      ...plain({ notes: 'x'.repeat(1500), metadata: JSON.stringify({ seat: '12A/12B', flight_number: 'AY 1502' }) }),
      external_id: '77',
    };
    const p = buildSavePayload(
      booking,
      flight({ passengers: [{ userId: 'u1', guestName: null, seat: null, seatNumber: '4D', seatClass: null }] }),
    );
    expect(p?.note).toHaveLength(1000);
    expect(p?.passengers[0].seatNumber).toBe('4D');
    expect(p?.flightNumber).toBe('AY 1502');
  });
});

describe('AirtrailLinkService.createInAirtrail', () => {
  const db = createSnapshotTestDb();
  const listFlights = vi.fn();
  const saveFlight = vi.fn();
  const getFlight = vi.fn();
  const deleteFlight = vi.fn();
  const isAirtrailWriteEnabled = vi.fn();
  const getAirtrailCredentials = vi.fn();
  let t: TestModule;
  let link: AirtrailLinkService;
  const orm = () => t.get(MikroORM);

  beforeAll(async () => {
    t = await createTestModule({
      db,
      imports: [AirtrailCoreModule],
      overrides: [
        { provide: AirtrailClient, useValue: { listFlights, saveFlight, getFlight, deleteFlight } },
        { provide: AirtrailService, useValue: { isAirtrailWriteEnabled, getAirtrailCredentials } },
        { provide: AddonsService, useValue: { isAddonEnabled: async () => true } },
      ],
    });
    link = t.get(AirtrailLinkService);
  });
  afterAll(async () => {
    await t.close();
    db.close();
  });

  let nextId: number;
  beforeEach(() => {
    resetTestDb(db);
    vi.clearAllMocks();
    t.realtime.broadcastMock.mockClear();
    nextId = 88;
    isAirtrailWriteEnabled.mockResolvedValue(true);
    getAirtrailCredentials.mockResolvedValue({ baseUrl: 'https://at.example', apiKey: 'k', allowInsecureTls: false });
    listFlights.mockResolvedValue([]);
    saveFlight.mockImplementation(async (_c: unknown, p: AirtrailSavePayload) => ({ id: p.id ?? nextId++ }));
    getFlight.mockImplementation(async (_c: unknown, id: number) => flight({ id }));
    deleteFlight.mockResolvedValue(undefined);
  });

  async function seed(opts: { booking?: BookingForCreate; type?: string; members?: number } = {}) {
    const { user } = await makeUser(orm());
    const trip = await makeTrip(orm(), user.id);
    const others = Array.from({ length: (opts.members ?? 1) - 1 }, () => makeUser(orm()));
    await Promise.all(others.map(async (made) => addTripMember(orm(), trip.id, (await made).user.id)));
    const b = opts.booking ?? plain();
    const reservation = await makeReservation(orm(), trip.id, {
      type: opts.type ?? 'flight',
      reservation_time: b.reservation_time,
      reservation_end_time: b.reservation_end_time,
      notes: b.notes,
      metadata: b.metadata,
    });
    await Promise.all(
      (b.endpoints ?? []).map((e) =>
        makeReservationEndpoint(orm(), reservation.id, {
          role: e.role,
          sequence: e.sequence ?? 0,
          code: e.code,
          timezone: e.timezone,
          local_date: e.local_date,
          local_time: e.local_time,
        }),
      ),
    );
    return { user, trip, reservation };
  }

  const row = (id: number) => findRow(orm(), Reservations, { id });

  it('creates the flight under the user and links the booking with live sync and the hash of the saved flight', async () => {
    const { user, trip, reservation } = await seed();
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight).toHaveBeenCalledTimes(1);
    expect(saveFlight.mock.calls[0][1].id).toBeUndefined();
    expect(getAirtrailCredentials).toHaveBeenCalledWith(user.id);
    const linked = await row(reservation.id);
    expect(linked).toMatchObject({
      external_source: 'airtrail',
      external_id: '88',
      external_owner_user_id: user.id,
      sync_enabled: 1,
    });
    expect(linked?.external_hash).toEqual(expect.any(String));
    expect(t.realtime.broadcastMock).toHaveBeenCalledWith(
      String(trip.id),
      'reservation:updated',
      expect.anything(),
      undefined,
    );
  });

  it('makes a flight for each leg of a connection and links them the way a multi-leg import does', async () => {
    const { user, trip, reservation } = await seed({ booking: connection() });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight.mock.calls.map((c) => [c[1].from, c[1].to])).toEqual([
      ['HEL', 'ARN'],
      ['ARN', 'LHR'],
    ]);
    const linked = await row(reservation.id);
    expect(linked).toMatchObject({ external_source: 'airtrail', external_id: '88', sync_enabled: 0 });
    const metadata = JSON.parse(String(linked?.metadata));
    expect(metadata.airtrail_ids).toEqual(['88', '89']);
    expect(metadata.legs).toHaveLength(2);
    expect(metadata.airline).toBe('Finnair');
  });

  it('links to a matching flight AirTrail already holds, then pushes the booking over it', async () => {
    listFlights.mockResolvedValue([flight({ id: 77, flightNumber: 'AY1502' })]);
    const { user, trip, reservation } = await seed();
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight).toHaveBeenCalledTimes(1);
    expect(saveFlight.mock.calls[0][1]).toMatchObject({ id: 77, departureTime: '19:05', note: 'Booked through CWT' });
    expect(await row(reservation.id)).toMatchObject({ external_id: '77', sync_enabled: 1 });
  });

  it('writes nothing when the matching flight is already linked to another booking', async () => {
    listFlights.mockResolvedValue([flight({ id: 77 })]);
    const { user, trip, reservation } = await seed();
    await makeReservation(orm(), trip.id, {
      external_source: 'airtrail',
      external_id: '77',
      external_owner_user_id: user.id,
    });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight).not.toHaveBeenCalled();
    expect(await row(reservation.id)).toMatchObject({ external_source: null });
  });

  it('takes over a claim a stopped process left, and leaves a fresh claim alone', async () => {
    const { user, trip, reservation } = await seed();
    const claim = (at: Date) =>
      updateRows(
        orm(),
        Reservations,
        { id: reservation.id },
        { external_source: 'airtrail', external_id: null, sync_enabled: 0, external_synced_at: at.toISOString() },
      );
    await claim(new Date());
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
    expect(saveFlight).not.toHaveBeenCalled();

    await claim(new Date(Date.now() - 60 * 60 * 1000));
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
    expect(await row(reservation.id)).toMatchObject({ external_id: '88', sync_enabled: 1 });
  });

  it('undoes the create when the link itself fails', async () => {
    const { user, trip, reservation } = await seed();
    // Another member's booking in the trip already links flight 88: the unique index refuses a second link.
    const { user: other } = await makeUser(orm());
    await makeReservation(orm(), trip.id, {
      external_source: 'airtrail',
      external_id: '88',
      external_owner_user_id: other.id,
    });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(deleteFlight).toHaveBeenCalledWith(expect.anything(), 88);
    expect(await row(reservation.id)).toMatchObject({ external_source: null, external_id: null });
  });

  it.each([
    ['the user has not opted in to write', () => isAirtrailWriteEnabled.mockResolvedValue(false)],
    ['the user has no AirTrail connection', () => getAirtrailCredentials.mockResolvedValue(null)],
  ])('writes nothing when %s', async (_label, arrange) => {
    arrange();
    const { user, trip, reservation } = await seed();
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight).not.toHaveBeenCalled();
    expect(await row(reservation.id)).toMatchObject({ external_source: null });
  });

  it('writes nothing for another booking type, a linked booking or a booking without an arrival airport', async () => {
    const train = await seed({ type: 'train' });
    await link.createInAirtrail(train.reservation.id, train.trip.id, train.user.id, 'create');
    const linkedBefore = await seed();
    await updateRows(
      orm(),
      Reservations,
      { id: linkedBefore.reservation.id },
      { external_source: 'airtrail', external_id: '5', sync_enabled: 0 },
    );
    await link.createInAirtrail(linkedBefore.reservation.id, linkedBefore.trip.id, linkedBefore.user.id, 'create');
    const noArrival = await seed({ booking: plain({ endpoints: [endpoint('from', 0, HEL, '2026-12-01', '19:05')] }) });
    await link.createInAirtrail(noArrival.reservation.id, noArrival.trip.id, noArrival.user.id, 'create');
    expect(saveFlight).not.toHaveBeenCalled();
    expect(await row(noArrival.reservation.id)).toMatchObject({ external_source: null });
  });

  describe('on an edit, the flight belongs only to its traveller or the only member of the trip', () => {
    it('skips an editor who is not a traveller, and creates for one who is', async () => {
      const { user, trip, reservation } = await seed({ members: 2 });
      const { user: other } = await makeUser(orm());
      await addReservationTraveler(orm(), reservation.id, other.id);
      await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
      expect(saveFlight).not.toHaveBeenCalled();

      await addReservationTraveler(orm(), reservation.id, user.id);
      await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
      expect(saveFlight).toHaveBeenCalledTimes(1);
    });

    it('skips a booking with no travellers in a shared trip, and creates it in a trip of one', async () => {
      const shared = await seed({ members: 2 });
      await link.createInAirtrail(shared.reservation.id, shared.trip.id, shared.user.id, 'edit');
      expect(saveFlight).not.toHaveBeenCalled();

      const solo = await seed();
      await link.createInAirtrail(solo.reservation.id, solo.trip.id, solo.user.id, 'edit');
      expect(saveFlight).toHaveBeenCalledTimes(1);
    });

    it('creates on a new booking in a shared trip, where the writer is the one who booked', async () => {
      const { user, trip, reservation } = await seed({ members: 2 });
      await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
      expect(saveFlight).toHaveBeenCalledTimes(1);
    });
  });

  it('deletes the legs it made and gives the claim back when a leg fails, so the next edit starts again', async () => {
    const { user, trip, reservation } = await seed({ booking: connection() });
    saveFlight.mockImplementation(async (_c: unknown, p: AirtrailSavePayload) => {
      if (p.from === 'ARN') throw new Error('Invalid airport');
      return { id: nextId++ };
    });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(deleteFlight).toHaveBeenCalledWith(expect.anything(), 88);
    expect(await row(reservation.id)).toMatchObject({ external_source: null, external_id: null, sync_enabled: 1 });

    saveFlight.mockImplementation(async () => ({ id: nextId++ }));
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
    expect(JSON.parse(String((await row(reservation.id))?.metadata)).airtrail_ids).toEqual(['89', '90']);
  });

  it('creates once when a second call arrives while the first is still running', async () => {
    const { user, trip, reservation } = await seed();
    let release: (flights: AirtrailFlightRaw[]) => void = () => undefined;
    listFlights.mockReturnValueOnce(new Promise<AirtrailFlightRaw[]>((resolve) => (release = resolve)));
    const first = link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    await vi.waitFor(() => expect(listFlights).toHaveBeenCalled());
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'edit');
    release([]);
    await first;
    expect(saveFlight).toHaveBeenCalledTimes(1);
  });

  it('deletes the flight again when the booking was deleted while it was made', async () => {
    const { user, trip, reservation } = await seed();
    saveFlight.mockImplementation(async () => {
      await deleteRows(orm(), Reservations, { id: reservation.id });
      return { id: 88 };
    });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(deleteFlight).toHaveBeenCalledWith(expect.anything(), 88);
  });

  it('pushes an edit that landed while the flight was made', async () => {
    const { user, trip, reservation } = await seed();
    saveFlight.mockImplementationOnce(async () => {
      await updateRows(orm(), Reservations, { id: reservation.id }, { notes: 'Gate B' });
      return { id: 88 };
    });
    await link.createInAirtrail(reservation.id, trip.id, user.id, 'create');
    expect(saveFlight).toHaveBeenCalledTimes(2);
    expect(saveFlight.mock.calls[1][1]).toMatchObject({ id: 88, note: 'Gate B' });
  });
});
