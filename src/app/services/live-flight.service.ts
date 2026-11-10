import { Injectable, signal, effect, inject, NgZone } from '@angular/core';
import { Aircraft } from '../models/aircraft.model';

/** Static airline route mapping: callsign prefix -> (origin, destination) IATA codes. */
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

  private ws?: WebSocket;
  /** Track enrichment timers to clear on disconnect. */
  private enrichTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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
      this.zone.run(() => this.connected.set(true));
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
      log('[LiveFlightService] disconnected; reconnecting in 3s');
      this.ws = undefined;
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      log('[LiveFlightService] error', err);
    };
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
    const [origin, destination] = route;
    this.fleetSignal.update((fleet) =>
      fleet.map((ac) => {
        const key = (ac as any).icao24 || ac.flightId;
        if (key === icao24 && !ac.source && !ac.destination) {
          return { ...ac, source: origin, destination };
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
