/**
 * A rotatable aircraft marker built on Leaflet's L.Layer, with a Flight
 * Radar-style hover card.
 *
 * Why a custom L.Layer instead of L.marker:
 *  - L.marker with L.divIcon renders HTML but rotating just the plane badge
 *    while keeping the card upright requires splitting DOM into a rotated img
 *    and an unrotated card — easier with our own layer.
 *  - We position the container via latLngToLayerPoint each frame so the badge
 *    centre sits on the aircraft coordinate, then rotate the img alone.
 *
 * DOM layout (why it's two nested elements):
 *   container  ← positioned at the aircraft coordinate, NEVER rotated
 *     ├─ img   ← the plane badge; THIS is what we rotate to the heading
 *     └─ card  ← the hover info card; stays upright because it's a sibling of
 *                the rotated img, not a child of it
 * If the card lived inside the rotated element it would spin with the plane, so
 * rotation is applied to the img alone.
 */

import * as L from 'leaflet';

/** Static, per-flight identity shown in the hover card (doesn't change). */
export interface AircraftCardInfo {
  /** Call sign / flight number, e.g. '6E-201'. */
  flightCode: string;
  /** Aircraft type, e.g. 'Airbus A320neo'. */
  aircraftType: string;
  /** URL of the aircraft photo (served from public/). */
  photoUrl: string;
  /** Origin city name, e.g. 'Hyderabad'. */
  originCity: string;
  /** Destination city name, e.g. 'Bengaluru'. */
  destinationCity: string;
}

/** Live values shown in the hover card; refreshed on every position update. */
export interface AircraftLiveStats {
  /** Current altitude in feet. */
  altitudeFt: number;
  /** Current ground speed in knots. */
  speedKts: number;
  /** Leg completion, 0 → 1, driving the progress bar. */
  progress: number;
}

export interface AircraftMarkerOptions {
  /** URL of the badge SVG (served from public/, e.g. 'markers/flight.svg'). */
  iconUrl: string;
  /** Rendered diameter in pixels. */
  sizePx: number;
  /**
   * Degrees added to the heading before rotating, to correct for an icon whose
   * nose isn't already pointing "up" (north) at 0°. Use 0 if it points north.
   */
  rotationOffsetDeg: number;
  /** Details rendered in the hover card. */
  card: AircraftCardInfo;
  /** Optional click handler. When provided, the marker becomes clickable. */
  onClick?: () => void;
}

/** The minimal control surface the map component uses to drive a marker. */
export interface AircraftMarker {
  /**
   * Move/rotate/resize the marker and refresh its live hover-card stats.
   * `sizePx` is the current rendered diameter (varies with altitude).
   */
  update(
    position: L.LatLngExpression,
    heading: number,
    stats: AircraftLiveStats,
    sizePx: number,
  ): void;
  /** Mark this aircraft as the selected one (renders it in the hot red). */
  setSelected(selected: boolean): void;
  /** Attach (map) or detach (null) the marker from the map. */
  setMap(map: L.Map | null): void;
}

/** Cached constructor, built on first use (after Leaflet is available). */
let overlayCtor:
  | (new (
      position: L.LatLngExpression,
      heading: number,
      markerOptions: AircraftMarkerOptions,
    ) => AircraftMarker)
  | null = null;

function buildOverlayCtor() {
  return class AircraftMarkerLayer extends L.Layer implements AircraftMarker {
    private container?: HTMLDivElement;
    private img?: HTMLImageElement;
    private card?: HTMLDivElement;
    /** Live card fields updated each frame while hovered. */
    private altValueEl?: HTMLElement;
    private speedValueEl?: HTMLElement;
    private progressFillEl?: HTMLElement;
    /** Latest stats, so entering hover can render immediately. */
    private stats?: AircraftLiveStats;
    private hovered = false;
    private selected = false;
    /** Current rendered diameter (px); driven by altitude, updated per frame. */
    private currentSizePx: number;

    constructor(
      private position: L.LatLngExpression,
      private heading: number,
      private readonly markerOptions: AircraftMarkerOptions,
    ) {
      super();
      this.currentSizePx = markerOptions.sizePx;
    }

    update(
      position: L.LatLngExpression,
      heading: number,
      stats: AircraftLiveStats,
      sizePx: number,
    ): void {
      this.position = position;
      this.heading = heading;
      this.stats = stats;
      this.currentSizePx = sizePx;
      // Only touch the (potentially hidden) card DOM when it's actually shown.
      if (this.hovered) {
        this.renderCardStats();
      }
      // Reposition/rotate/resize immediately.
      this._resetPosition();
    }

    override onAdd(map: L.Map): this {
      const container = document.createElement('div');
      container.className = 'aircraft-marker';
      container.style.position = 'absolute';
      container.style.width = `${this.markerOptions.sizePx}px`;
      container.style.height = `${this.markerOptions.sizePx}px`;
      // Capture hover/click on the plane itself.
      container.style.pointerEvents = 'auto';
      container.style.cursor = this.markerOptions.onClick ? 'pointer' : 'default';

      const img = this.buildImg();
      const card = this.buildCard();
      container.append(img, card);

      // Show the card on hover and tint the plane; hide/untint on leave.
      container.addEventListener('mouseenter', () => this.setHovered(true));
      container.addEventListener('mouseleave', () => this.setHovered(false));
      if (this.markerOptions.onClick) {
        container.addEventListener('click', (event) => {
          // Stop the click reaching the map (which would clear the selection).
          event.stopPropagation();
          this.markerOptions.onClick?.();
        });
      }

      this.container = container;
      this.img = img;
      this.card = card;

      // Leaflet's overlay pane receives DOM pointer events, which both the
      // hover and click behaviour need.
      const pane = map.getPane('overlayPane') as HTMLElement;
      pane.appendChild(container);

      this._resetPosition();
      return this;
    }

    override onRemove(map: L.Map): this {
      this.container?.remove();
      this.container = undefined;
      this.img = undefined;
      this.card = undefined;
      this.altValueEl = undefined;
      this.speedValueEl = undefined;
      this.progressFillEl = undefined;
      return this;
    }

    override getEvents(): { [key: string]: () => void } {
      return {
        moveend: this._resetPosition.bind(this),
        zoomend: this._resetPosition.bind(this),
      };
    }

    /** The rotatable plane badge. */
    private buildImg(): HTMLImageElement {
      const img = document.createElement('img');
      img.className = 'aircraft-marker__img';
      img.src = this.markerOptions.iconUrl;
      img.alt = '';
      img.draggable = false;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.display = 'block';
      return img;
    }

    /** Build the hover card DOM once; live fields are filled in each frame. */
    private buildCard(): HTMLDivElement {
      const { card } = this.markerOptions;

      const el = document.createElement('div');
      el.className = 'aircraft-marker__card';

      const photo = document.createElement('img');
      photo.className = 'aircraft-card__photo';
      photo.src = card.photoUrl;
      photo.alt = `${card.aircraftType} aircraft`;
      photo.draggable = false;
      // A missing photo file shouldn't show a broken-image icon — hide it.
      photo.addEventListener('error', () => {
        photo.style.display = 'none';
      });

      const body = document.createElement('div');
      body.className = 'aircraft-card__body';

      // Header: flight code + aircraft type badge.
      const head = document.createElement('div');
      head.className = 'aircraft-card__head';
      const code = document.createElement('span');
      code.className = 'aircraft-card__code';
      code.textContent = card.flightCode;
      const type = document.createElement('span');
      type.className = 'aircraft-card__type';
      type.textContent = card.aircraftType;
      head.append(code, type);

      // Route: origin → destination cities.
      const route = document.createElement('div');
      route.className = 'aircraft-card__route';
      route.textContent = `${card.originCity} to ${card.destinationCity}`;

      // Progress bar.
      const track = document.createElement('div');
      track.className = 'aircraft-card__progress';
      const fill = document.createElement('div');
      fill.className = 'aircraft-card__progress-fill';
      track.appendChild(fill);

      // Stats line: altitude · speed.
      const stats = document.createElement('div');
      stats.className = 'aircraft-card__stats';
      const alt = document.createElement('span');
      const sep = document.createElement('span');
      sep.className = 'aircraft-card__dot';
      sep.textContent = '·';
      const spd = document.createElement('span');
      stats.append(alt, sep, spd);

      body.append(head, route, track, stats);
      el.append(photo, body);

      this.altValueEl = alt;
      this.speedValueEl = spd;
      this.progressFillEl = fill;
      return el;
    }

    setSelected(selected: boolean): void {
      this.selected = selected;
      this.applyHotState();
    }

    private setHovered(hovered: boolean): void {
      this.hovered = hovered;
      // Card only appears on hover; the red tint applies for hover OR selection.
      this.card?.classList.toggle('aircraft-marker__card--visible', hovered);
      this.applyHotState();
      if (hovered) {
        this.renderCardStats();
      }
    }

    /** The plane badge shows the red "hot" tint when hovered or selected. */
    private applyHotState(): void {
      this.img?.classList.toggle(
        'aircraft-marker__img--hot',
        this.hovered || this.selected,
      );
    }

    /** Push the latest live stats into the card fields. */
    private renderCardStats(): void {
      if (!this.stats) {
        return;
      }
      if (this.altValueEl) {
        this.altValueEl.textContent = `${Math.round(
          this.stats.altitudeFt,
        ).toLocaleString('en-US')} ft`;
      }
      if (this.speedValueEl) {
        this.speedValueEl.textContent = `${Math.round(this.stats.speedKts)} kts`;
      }
      if (this.progressFillEl) {
        const pct = Math.max(0, Math.min(1, this.stats.progress)) * 100;
        this.progressFillEl.style.width = `${pct}%`;
      }
    }

    /** Reposition and rotate the marker based on its current lat/lng. */
    private _resetPosition(): void {
      if (!this.container || !this.img) {
        return;
      }
      const map = this._map;
      if (!map) {
        return;
      }
      const point = map.latLngToLayerPoint(this.position as L.LatLngLiteral);
      if (!point) {
        return;
      }
      const size = this.currentSizePx;
      const half = size / 2;
      // Resize the marker (altitude-driven) and position it so the badge centre
      // sits on the coordinate...
      this.container.style.width = `${size}px`;
      this.container.style.height = `${size}px`;
      this.container.style.left = `${point.x - half}px`;
      this.container.style.top = `${point.y - half}px`;
      // ...then rotate the plane image alone (the card stays upright).
      this.img.style.transform = `rotate(${
        this.heading + this.markerOptions.rotationOffsetDeg
      }deg)`;
    }

    setMap(map: L.Map | null): void {
      if (map && !this._map) {
        map.addLayer(this);
      } else if (!map && this._map) {
        this._map.removeLayer(this);
      }
    }
  };
}

/**
 * Create an aircraft marker. Can be called once Leaflet is loaded (the layer
 * is added to the map via setMap or addTo).
 */
export function createAircraftMarker(
  position: L.LatLngExpression,
  heading: number,
  markerOptions: AircraftMarkerOptions,
): AircraftMarker {
  overlayCtor ??= buildOverlayCtor();
  return new overlayCtor(position, heading, markerOptions);
}
