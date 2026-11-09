import { Injectable, signal, effect, inject, NgZone } from '@angular/core';
import { Aircraft } from '../models/aircraft.model';

/**
 * Live aircraft feed backed by the OpenSky WebSocket endpoint (/ws/flights).
 *
 * Emits the full fleet on every broadcast from the backend. Consumers call
 * `fleet()` to get the latest snapshot — no time-based simulation, purely
 * live ADS-B positions. Falls back gracefully when the socket is unavailable.
 */
@Injectable({ providedIn: 'root' })
export class LiveFlightService {
  private readonly zone = inject(NgZone);

  /** Latest fleet snapshot keyed internally; exposed as a signal. */
  private readonly fleetSignal = signal<Aircraft[]>([]);
  readonly fleet = this.fleetSignal.asReadonly();

  /** True when the WebSocket is connected. */
  readonly connected = signal(false);

  /** Feed error message when the live feed is unavailable (cleared on connect). */
  readonly feedError = signal<string | null>(null);

  private ws?: WebSocket;

  private retryCount = 0;
  private readonly MAX_RETRIES = 10;
  private readonly BASE_BACKOFF_MS = 3000;

  constructor() {
    this.connect();
    // Reconnect if the page regains focus after a disconnect.
    effect(() => {
      // no-op; keeps effect alive if needed later
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
        this.feedError.set(null);
        this.retryCount = 0;
      });
      log('[LiveFlightService] connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'fleet' && Array.isArray(payload.aircraft)) {
          const aircraft = payload.aircraft.map((a: unknown) => this.normalise(a));
          this.zone.run(() => this.fleetSignal.set(aircraft));
        }
      } catch (err) {
        log('[LiveFlightService] bad message', err);
      }
    };

    this.ws.onclose = () => {
      this.zone.run(() => this.connected.set(false));
      log('[LiveFlightService] disconnected; reconnecting in 3s');
      this.ws = undefined;
      setTimeout(() => this.reconnect(), 3000);
    };

    this.ws.onerror = (err) => {
      log('[LiveFlightService] error', err);
    };
  }

  /** Attempt to reconnect with exponential backoff, capping at MAX_RETRIES.
   * Sets feedError when retries are exhausted. */
  private reconnect(): void {
    if (this.retryCount >= this.MAX_RETRIES) {
      this.zone.run(() => {
        this.feedError.set(
          `Live flight feed unavailable after ${this.MAX_RETRIES} reconnect attempts.`,
        );
      });
      log('[LiveFlightService] max retries reached; giving up');
      return;
    }
    const backoffMs = this.BASE_BACKOFF_MS * Math.pow(2, this.retryCount);
    this.retryCount++;
    log(`[LiveFlightService] reconnect attempt ${this.retryCount} in ${backoffMs}ms`);
    setTimeout(() => this.connect(), backoffMs);
  }

  /** Map the backend's Aircraft-shaped dict (which may carry extra fields) onto
   *  the strict Aircraft interface the UI expects. */
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
  // eslint-disable-next-line no-console
  console.log('[LiveFlightService]', ...args);
}
