import { Injectable, signal, effect, inject, NgZone } from '@angular/core';
import { Aircraft } from '../models/aircraft.model';
import { AIRPORTS } from '../data/seed-data';

/**
 * Static airline route mapping: callsign prefix -> (origin, destination) airport
 * codes. The codes here are **ICAO** (4-letter, e.g. EGLL), which is what airline
 * callsigns naturally carry (BAW, AFR, DLH are ICAO airline designators).
 *
 * The map is resolved against the seed `AIRPORTS` table (keyed by **IATA**,
 * 3-letter, e.g. LHR) at enrichment time via `ICAO_TO_IATA`. Only airports present
 * in `AIRPORTS` can draw a route; the rest are silently skipped (best-effort).
 */
const ICAO_TO_IATA: Record<string, string> = {
  KDFW: 'DFW', KLAX: 'LAX', KATL: 'ATL', KORD: 'ORD', KSFO: 'SFO',
  KDAL: 'DAL', KPHX: 'PHX', KJFK: 'JFK', KSEA: 'SEA', KPDX: 'PDX',
  KDEN: 'DEN', KLAS: 'LAS', KFLL: 'FLL', KLGA: 'LGA', PHNL: 'HNL', KOGG: 'OGG',
  CYYZ: 'YYZ', CYVR: 'YVR', CYYC: 'YYC',
  EGLL: 'LHR', EHAM: 'AMS', LFPG: 'CDG', LFMN: 'MRS', EDDF: 'FRA', EDDM: 'MUC',
  LEMD: 'MAD', EIDW: 'DUB', LIRF: 'FCO', EGKK: 'LGW', ESSA: 'ARN', EKCH: 'CPH',
  EFHK: 'HEL', EFVA: 'TMP', LEBL: 'BCN', LEPA: 'PAQ',
  OMDB: 'DXB', OTHH: 'DOH', OMAA: 'MCT',
  WSSS: 'SIN', WMKK: 'KUL', VHHH: 'HKG', ZBAA: 'PEK', RJAA: 'HND', RJBB: 'KIX',
  RJTT: 'HND', RJOO: 'KIX', RKSI: 'ICN', RKPK: 'PUS', ZGGG: 'CAN', ZSPD: 'SHA',
  VTBD: 'BKK', VTCC: 'CNX', WIII: 'CGK', WAHH: 'HLP',
  YSSY: 'SYD', YMML: 'MEL', YBBN: 'BNE',
  KMEM: 'MEM', KIND: 'IND', KSDF: 'SDF', KONT: 'ONT',
};

const AIRLINE_ROUTES: Record<string, [string, string]> = {
  // US majors
  AAL: ['KDFW', 'KLAX'], DAL: ['KATL', 'KLAX'], UAL: ['KORD', 'KSFO'],
  SWA: ['KDAL', 'KPHX'], JBU: ['KJFK', 'KLAX'], ASA: ['KSEA', 'KPDX'],
  FFT: ['KDEN', 'KLAS'], NKS: ['KFLL', 'KLGA'], HAW: ['PHNL', 'KOGG'],
  // Canadian
  ACA: ['CYYZ', 'CYVR'], WJA: ['CYYC', 'CYVR'],
  // European majors
  BAW: ['EGLL', 'EHAM'], AFR: ['LFPG', 'LFMN'], DLH: ['EDDF', 'EDDM'],
  KLM: ['EHAM', 'LEMD'], RYR: ['EIDW', 'LIRF'], EZY: ['EGKK', 'LFPG'],
  SAS: ['ESSA', 'EKCH'], FIN: ['EFHK', 'EFVA'], IBE: ['LEMD', 'LEBL'],
  VLG: ['LEBL', 'LEPA'],
  // Middle East
  UAE: ['OMDB', 'OTHH'], QTR: ['OTHH', 'OMDB'], ETD: ['OMAA', 'OMDB'],
  // Asian
  SIA: ['WSSS', 'WMKK'], CPA: ['VHHH', 'ZBAA'], ANA: ['RJAA', 'RJBB'],
  JAL: ['RJTT', 'RJOO'], KAL: ['RKSI', 'RKPK'], CSN: ['ZGGG', 'ZBAA'],
  CCA: ['ZBAA', 'ZSPD'], CES: ['ZSPD', 'ZGGG'], HKE: ['VHHH', 'RKSI'],
  THA: ['VTBD', 'VTCC'], MAS: ['WMKK', 'WBKK'], GIA: ['WIII', 'WAHH'],
  // Australian
  QFA: ['YSSY', 'YMML'], VOZ: ['YBBN', 'YMML'],
  // Cargo
  FDX: ['KMEM', 'KIND'], UPS: ['KSDF', 'KONT'],
};

/**
 * Live aircraft feed backed by the OpenSky WebSocket endpoint (/ws/flights).
 * Emits the full fleet on every broadcast. Enriches routes client-side
 * with incremental updates (one by one) for commercial callsigns.
 */
@Injectable({ providedIn: 'root' })
export class LiveFlightService {
  private readonly zone = inject(NgZone);

  private readonly fleetSignal = signal<Aircraft[]>([]);
  readonly fleet = this.fleetSignal.asReadonly();
  readonly connected = signal(false);

  /** Feed error surfaced to the UI when reconnect retries are exhausted. */
  private readonly feedErrorSignal = signal<string | null>(null);
  readonly feedError = this.feedErrorSignal.asReadonly();

  private ws?: WebSocket;
  /** Track enrichment timers to clear on disconnect. */
  private enrichTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Bounded reconnect policy: 3s initial backoff, doubling each attempt, capped at ~60s, give up after 7 failed attempts. */
  private readonly RECONNECT_INITIAL_MS = 3000;
  private readonly RECONNECT_MAX_MS = 60000;
  private readonly RECONNECT_MAX_ATTEMPTS = 7;
  private reconnectAttempts = 0;

  constructor() {
    this.connect();
    effect(() => {
      this.fleet();
    });
  }

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/flights`;
    log('[LiveFlightService] connecting', url);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.zone.run(() => {
        this.connected.set(true);
        this.reconnectAttempts = 0;
        this.feedErrorSignal.set(null);
      });
      log('[LiveFlightService] connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'fleet' && Array.isArray(payload.aircraft)) {
          const aircraft = payload.aircraft.map((a: unknown) => this.normalise(a));
          this.zone.run(() => {
            this.fleetSignal.set(aircraft);
            this.scheduleEnrichment(aircraft);
          });
        }
      } catch (err) {
        log('[LiveFlightService] bad message', err);
      }
    };

    this.ws.onclose = () => {
      this.zone.run(() => this.connected.set(false));
      // Clear pending enrichment timers
      this.enrichTimers.forEach((timer) => clearTimeout(timer));
      this.enrichTimers.clear();
      this.ws = undefined;

      if (this.reconnectAttempts >= this.RECONNECT_MAX_ATTEMPTS) {
        this.zone.run(() => {
          this.feedErrorSignal.set(
            `Live feed unavailable: reconnection failed after ${this.RECONNECT_MAX_ATTEMPTS} attempts.`,
          );
        });
        log('[LiveFlightService] disconnected; max reconnect attempts reached, giving up');
        return;
      }

      this.reconnectAttempts++;
      const backoffMs = Math.min(
        this.RECONNECT_INITIAL_MS * 2 ** (this.reconnectAttempts - 1),
        this.RECONNECT_MAX_MS,
      );
      log(
        `[LiveFlightService] disconnected; reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts}/${this.RECONNECT_MAX_ATTEMPTS})`,
      );
      setTimeout(() => this.connect(), backoffMs);
    };

    this.ws.onerror = (err) => {
      log('[LiveFlightService] error', err);
    };
  }

  /** Clear the feed error state (e.g. user dismissed the error banner). */
  clearFeedError(): void {
    this.feedErrorSignal.set(null);
  }

  /** Schedule incremental route enrichment for aircraft with commercial callsigns. */
  private scheduleEnrichment(aircraft: Aircraft[]): void {
    let delay = 0;
    const DELAY_STEP_MS = 80; // stagger: one route appears every ~80ms
    const now = Date.now();

    for (const ac of aircraft) {
      if (ac.source || ac.destination) {
        continue; // already has route
      }
      const callsign = ac.flightId?.toUpperCase() || '';
      const match = callsign.match(/^([A-Z]{2,3})\d/);
      if (!match || !AIRLINE_ROUTES[match[1]]) {
        continue; // not a commercial callsign we know
      }
      const icao24 = (ac as any).icao24 || ac.flightId; // fallback key
      const timerId = setTimeout(() => {
        this.zone.run(() => {
          this.enrichSingle(icao24, match[1]);
        });
        this.enrichTimers.delete(icao24);
      }, delay);
      this.enrichTimers.set(icao24, timerId);
      delay += DELAY_STEP_MS;
    }
  }

  /** Enrich a single aircraft's route and update the fleet signal. */
  private enrichSingle(icao24: string, airline: string): void {
    const route = AIRLINE_ROUTES[airline];
    if (!route) return;
    // AIRLINE_ROUTES stores ICAO codes; the map resolves them against the
    // IATA-keyed AIRPORTS table. Skip airports we don't have coordinates for.
    const originIata = ICAO_TO_IATA[route[0]];
    const destIata = ICAO_TO_IATA[route[1]];
    if (!originIata || !destIata || !AIRPORTS[originIata] || !AIRPORTS[destIata]) {
      return;
    }
    this.fleetSignal.update((fleet) =>
      fleet.map((ac) => {
        const key = (ac as any).icao24 || ac.flightId;
        if (key === icao24 && !ac.source && !ac.destination) {
          return { ...ac, source: originIata, destination: destIata };
        }
        return ac;
      })
    );
  }

  /** Map the backend's Aircraft-shaped dict onto the strict Aircraft interface. */
  private normalise(a: unknown): Aircraft {
    const src = a as Record<string, unknown>;
    return {
      flightId: String(src['flightId'] ?? src['icao24'] ?? ''),
      airline: String(src['airline'] ?? ''),
      aircraft: String(src['aircraft'] ?? ''),
      source: String(src['source'] ?? ''),
      destination: String(src['destination'] ?? ''),
      latitude: Number(src['latitude'] ?? 0),
      longitude: Number(src['longitude'] ?? 0),
      altitude: Number(src['altitude'] ?? 0),
      heading: Number(src['heading'] ?? 0),
      speed: Number(src['speed'] ?? 0),
      progress: Number(src['progress'] ?? 0),
      departure: String(src['departure'] ?? ''),
      eta: String(src['eta'] ?? ''),
      onGround: Boolean(src['onGround'] ?? false),
    };
  }
}

function log(...args: unknown[]): void {
  console.log('[LiveFlightService]', ...args);
}
