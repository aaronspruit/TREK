/**
 * A new plain flight booking goes to the AirTrail of the person who made it,
 * when that person turned on the write-back and the instance speaks v1.
 *
 * The payload, the arrival date and the match are pure and tested directly.
 * AirtrailLinkService comes out of AirtrailCoreModule over a snapshot test db,
 * so the link is a real statement. AirTrail (the client) and the connection
 * settings are fakes.
 */
import { Reservations } from '../../../../src/db/entities/Reservations.entity';
import { AddonsService } from '../../../../src/nest/addons/addons.service';
import { AirtrailCoreModule } from '../../../../src/nest/integrations/airtrail-core.module';
import { AirtrailLinkService } from '../../../../src/nest/integrations/airtrail-link.service';
import {
  arrivalDate,
  type BookingForCreate,
  buildCreatePayload,
  findMatchingFlight,
} from '../../../../src/nest/integrations/airtrail-sync.helpers';
import {
  AirtrailClient,
  type AirtrailFlightRaw,
  type AirtrailSavePayload,
} from '../../../../src/nest/integrations/airtrail.client';
import { AirtrailService } from '../../../../src/nest/integrations/airtrail.service';
import { createSnapshotTestDb } from '../../../helpers/db-mock';
import { makeReservation, makeReservationEndpoint } from '../../../helpers/factories/reservations';
import { findRow } from '../../../helpers/factories/rows';
import { makeTrip } from '../../../helpers/factories/trips';
import { makeUser } from '../../../helpers/factories/users';
import { resetTestDb } from '../../../helpers/test-db';
import { createTestModule, type TestModule } from '../../../helpers/test-module';
import { MikroORM } from '@mikro-orm/core';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('../../../../src/nest/audit/audit-log.logger', async (original) => ({
  ...(await original<typeof import('../../../../src/nest/audit/audit-log.logger')>()),
  logError,
}));

type Endpoint = NonNullable<BookingForCreate['endpoints']>[number];

const HEL = { code: 'HEL', timezone: 'Europe/Helsinki' };
const LHR = { code: 'LHR', timezone: 'Europe/London' };

function endpoint(role: string, at: { code: string; timezone: string }, date: string | null, time: string | null) {
  return { role, ...at, local_date: date, local_time: time } satisfies Endpoint;
}

/** HEL → LHR, the evening of 1 Dec. */
function plain(overrides: Partial<BookingForCreate> = {}): BookingForCreate {
  return {
    id: 5,
    reservation_time: '2026-12-01T19:05',
    reservation_end_time: '2026-12-01T20:30',
    notes: 'Booked through CWT',
    metadata: JSON.stringify({
      airline: 'Finnair',
      airline_code: 'FIN',
      flight_number: 'AY 1502',
      seat: '4D',
      flight_reason: 'business',
    }),
    endpoints: [endpoint('from', HEL, '2026-12-01', '19:05'), endpoint('to', LHR, '2026-12-01', '20:30')],
    ...overrides,
  };
}

function payloadOf(b: BookingForCreate): AirtrailSavePayload {
  const p = buildCreatePayload(b);
  if (!p) throw new Error('expected a payload');
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
    flightReason: null,
    note: null,
    seats: [],
    ...overrides,
  } as AirtrailFlightRaw;
}

describe('buildCreatePayload', () => {
  it('makes one flight for the key owner, with the local times, the codes, the seat and the note', () => {
    expect(payloadOf(plain())).toMatchObject({
      from: 'HEL',
      to: 'LHR',
      departure: '2026-12-01',
      departureTime: '19:05',
      arrival: '2026-12-01',
      arrivalTime: '20:30',
      departureScheduled: '2026-12-01',
      departureScheduledTime: '19:05',
      airline: 'FIN',
      flightNumber: 'AY 1502',
      flightReason: 'business',
      note: 'Booked through CWT',
      passengers: [{ userId: '<USER_ID>', seatNumber: '4D', flightReason: 'business' }],
    });
  });

  it('leaves out an airline that is not an ICAO code and a flight reason AirTrail does not know', () => {
    const p = payloadOf(
      plain({ metadata: JSON.stringify({ airline_code: 'AY', airline: 'QANTAS AIRWAYS', flight_reason: 'family' }) }),
    );
    expect(p.airline).toBeNull();
    expect(p.flightReason).toBeNull();
  });

  it('sends an ICAO aircraft code but not an IATA one, leaves out a seat over 20 characters, and cuts a long note', () => {
    expect(payloadOf(plain({ metadata: JSON.stringify({ aircraft: 'B738' }) })).aircraft).toBe('B738');
    const p = payloadOf(
      plain({
        notes: 'x'.repeat(10_050),
        metadata: JSON.stringify({ aircraft: '320', seat: 'Seat 12A, window, extra legroom' }),
      }),
    );
    expect(p.aircraft).toBeNull();
    expect(p.passengers[0].seatNumber).toBeNull();
    expect(p.note).toHaveLength(10_000);
  });

  it('works out the arrival date from the airport zones when the booking has only the arrival time', () => {
    const p = payloadOf(
      plain({
        reservation_time: '2026-12-01T23:30',
        reservation_end_time: null,
        endpoints: [endpoint('from', HEL, '2026-12-01', '23:30'), endpoint('to', LHR, null, '00:55')],
      }),
    );
    expect(p).toMatchObject({ departure: '2026-12-01', arrival: '2026-12-02', arrivalTime: '00:55' });
  });

  it.each([
    [
      'a booking with a stop',
      plain({
        endpoints: [
          endpoint('from', HEL, '2026-12-01', '19:05'),
          endpoint('stop', { code: 'ARN', timezone: 'Europe/Stockholm' }, '2026-12-01', '21:00'),
          endpoint('to', LHR, '2026-12-01', '23:30'),
        ],
      }),
    ],
    ['a booking with legs', plain({ metadata: JSON.stringify({ legs: [{}, {}] }) })],
    ['a booking without an arrival airport', plain({ endpoints: [endpoint('from', HEL, '2026-12-01', '19:05')] })],
    [
      'a booking without a departure date',
      plain({
        reservation_time: null,
        endpoints: [endpoint('from', HEL, null, '19:05'), endpoint('to', LHR, null, '20:30')],
      }),
    ],
  ])('gives nothing for %s', (_label, booking) => {
    expect(buildCreatePayload(booking)).toBeNull();
  });
});

describe('arrivalDate', () => {
  it('moves across the date line in both directions', () => {
    // QF94: Oct 4 20:50 in Los Angeles, lands 06:45 in Melbourne two days later.
    expect(arrivalDate('2026-10-04', '20:50', 'America/Los_Angeles', '06:45', 'Australia/Melbourne')).toBe(
      '2026-10-06',
    );
    // QF93: Oct 9 09:45 in Melbourne, lands 06:05 the same calendar day in Los Angeles.
    expect(arrivalDate('2026-10-09', '09:45', 'Australia/Melbourne', '06:05', 'America/Los_Angeles')).toBe(
      '2026-10-09',
    );
  });

  it('takes the next day for an earlier clock time when a zone is missing', () => {
    expect(arrivalDate('2026-12-01', '23:30', null, '00:55', 'Europe/London')).toBe('2026-12-02');
  });
});

describe('findMatchingFlight', () => {
  const payload = payloadOf(plain());

  it('matches the same airports by either code, the same date and the same flight number digits', () => {
    expect(findMatchingFlight([flight()], payload)?.id).toBe(77);
    expect(findMatchingFlight([flight({ flightNumber: null })], payload)?.id).toBe(77);
  });

  it('matches a flight without a number only when it is the only one on that route that day', () => {
    const bare = payloadOf(plain({ metadata: JSON.stringify({}) }));
    expect(findMatchingFlight([flight({ id: 1 })], bare)?.id).toBe(1);
    expect(findMatchingFlight([flight({ id: 1 }), flight({ id: 2, flightNumber: 'AY1504' })], bare)).toBeUndefined();
    expect(findMatchingFlight([flight({ id: 2, flightNumber: 'AY1504' }), flight({ id: 1 })], payload)?.id).toBe(1);
  });

  it.each([
    ['another flight number', flight({ flightNumber: 'AY1504' })],
    ['another date', flight({ date: '2026-12-02' })],
    ['another airport', flight({ to: { iata: 'LGW', icao: 'EGKK' } as AirtrailFlightRaw['to'] })],
  ])('does not match %s', (_label, candidate) => {
    expect(findMatchingFlight([candidate], payload)).toBeUndefined();
  });
});

describe('AirtrailLinkService.addNewFlightToAirtrail', () => {
  const db = createSnapshotTestDb();
  const listFlights = vi.fn();
  const saveFlight = vi.fn();
  const getFlight = vi.fn();
  const speaksV1 = vi.fn();
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
        { provide: AirtrailClient, useValue: { listFlights, saveFlight, getFlight, speaksV1 } },
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

  beforeEach(() => {
    resetTestDb(db);
    vi.clearAllMocks();
    t.realtime.broadcastMock.mockClear();
    isAirtrailWriteEnabled.mockResolvedValue(true);
    getAirtrailCredentials.mockResolvedValue({ baseUrl: 'https://at.example', apiKey: 'k', allowInsecureTls: false });
    speaksV1.mockResolvedValue(true);
    listFlights.mockResolvedValue([]);
    saveFlight.mockResolvedValue({ id: 88 });
    getFlight.mockImplementation(async (_c: unknown, id: number) => flight({ id }));
  });

  async function seed(opts: { booking?: BookingForCreate; type?: string; origin?: Record<string, unknown> } = {}) {
    const { user } = await makeUser(orm());
    const trip = await makeTrip(orm(), user.id);
    const b = opts.booking ?? plain();
    const reservation = await makeReservation(orm(), trip.id, {
      type: opts.type ?? 'flight',
      reservation_time: b.reservation_time,
      reservation_end_time: b.reservation_end_time,
      notes: b.notes,
      metadata: b.metadata,
      ...opts.origin,
    });
    await Promise.all(
      (b.endpoints ?? []).map((e, sequence) =>
        makeReservationEndpoint(orm(), reservation.id, {
          role: e.role,
          sequence,
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

  it('makes the flight and links a booking made by hand with live sync and the hash of the new flight', async () => {
    const { user, trip, reservation } = await seed();

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(saveFlight).toHaveBeenCalledOnce();
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

  it('links to the flight AirTrail has already and makes no second one', async () => {
    listFlights.mockResolvedValue([flight({ id: 77 })]);
    const { user, trip, reservation } = await seed();

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(saveFlight).not.toHaveBeenCalled();
    expect(await row(reservation.id)).toMatchObject({
      external_source: 'airtrail',
      external_id: '77',
      sync_enabled: 1,
    });
  });

  it('sends an imported booking but keeps its import origin, so the import still finds a second copy', async () => {
    const origin = { external_source: 'mail', external_id: 'ABC123|flight|2026-12-01|hel-lhr', sync_enabled: 0 };
    const { user, trip, reservation } = await seed({ origin });

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(saveFlight).toHaveBeenCalledOnce();
    const after = await row(reservation.id);
    expect(after).toMatchObject(origin);
    expect(after?.metadata).toBe(plain().metadata);
  });

  it('leaves a flight that another booking of the trip links, and logs no failure', async () => {
    listFlights.mockResolvedValue([flight({ id: 77 })]);
    const { user, trip, reservation } = await seed();
    await makeReservation(orm(), trip.id, {
      external_source: 'airtrail',
      external_id: '77',
      external_owner_user_id: user.id,
    });

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(await row(reservation.id)).toMatchObject({ external_source: null });
    expect(logError).not.toHaveBeenCalled();
  });

  it('sends one flight when two bookings of the same flight arrive at the same time', async () => {
    const stored: AirtrailFlightRaw[] = [];
    listFlights.mockImplementation(async () => [...stored]);
    saveFlight.mockImplementation(async () => {
      // A slow save: without the queue, the second send reads the list before the first flight is in it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored.push(flight({ id: 88 }));
      return { id: 88 };
    });
    const first = await seed();
    const second = await seed();

    await Promise.all([
      link.addNewFlightToAirtrail(first.reservation.id, first.trip.id, first.user.id),
      link.addNewFlightToAirtrail(second.reservation.id, second.trip.id, first.user.id),
    ]);

    expect(saveFlight).toHaveBeenCalledOnce();
    expect(await row(second.reservation.id)).toMatchObject({ external_id: '88' });
  });

  it('keeps the booking as it is when AirTrail refuses the flight', async () => {
    saveFlight.mockRejectedValue(new Error('The AirTrail API key lacks the scope flight.create.own.'));
    const { user, trip, reservation } = await seed();

    await expect(link.addNewFlightToAirtrail(reservation.id, trip.id, user.id)).resolves.toBeUndefined();

    expect(await row(reservation.id)).toMatchObject({ external_source: null, external_id: null });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('lacks the scope flight.create.own'));
  });

  it.each([
    ['the person did not turn on the write-back', () => isAirtrailWriteEnabled.mockResolvedValue(false)],
    ['the person has no AirTrail connection', () => getAirtrailCredentials.mockResolvedValue(null)],
    ['the instance has only the legacy routes', () => speaksV1.mockResolvedValue(false)],
  ])('sends nothing when %s', async (_label, arrange) => {
    arrange();
    const { user, trip, reservation } = await seed();

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(listFlights).not.toHaveBeenCalled();
    expect(saveFlight).not.toHaveBeenCalled();
    expect(await row(reservation.id)).toMatchObject({ external_source: null });
  });

  it.each([
    ['a train', { type: 'train' }],
    ['a booking linked to AirTrail already', { origin: { external_source: 'airtrail', external_id: '5' } }],
    [
      'a booking with a stop',
      {
        booking: plain({
          endpoints: [
            endpoint('from', HEL, '2026-12-01', '19:05'),
            endpoint('stop', { code: 'ARN', timezone: 'Europe/Stockholm' }, '2026-12-01', '21:00'),
            endpoint('to', LHR, '2026-12-01', '23:30'),
          ],
        }),
      },
    ],
  ])('sends nothing for %s', async (_label, opts) => {
    const { user, trip, reservation } = await seed(opts);

    await link.addNewFlightToAirtrail(reservation.id, trip.id, user.id);

    expect(saveFlight).not.toHaveBeenCalled();
  });
});
