import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
  ElementRef,
  AfterViewInit,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { interval } from 'rxjs';
import * as L from 'leaflet';
import {
  AircraftInfoPanelComponent,
  FlightPanelInfo,
  PanelAction,
} from '../aircraft-info-panel/aircraft-info-panel.component';
import { Aircraft } from '../../models/aircraft.model';
import { AIRPORTS, cityForAirport, SEED_FLIGHTS } from '../../data/seed-data';
import { LiveFlightService } from '../../services/live-flight.service';
import { MapThemeService } from '../../services/map-theme.service';
import {
  AircraftCardInfo,
  AircraftLiveStats,
  AircraftMarker,
  createAircraftMarker,
} from './aircraft-marker.overlay';
import { tileLayerFor, LABEL_ZOOM_THRESHOLD } from './map-styles';

/**
 * Aircraft marker diameter (px) scales with altitude — bigger when higher (a
 * rough sense of "closer to the viewer"), smaller near the ground. MIN is a
 * little smaller than the old flat 40px.
 */
const MARKER_MIN_SIZE_PX = 30;
const MARKER_MAX_SIZE_PX = 52;
/** Altitude (ft) mapped to MARKER_MAX_SIZE_PX (≈ the simulator's cruise alt). */
const MARKER_MAX_ALTITUDE_FT = 35000;
/**
 * Degrees added to each aircraft's heading before rotating the badge. Set this
 * if the plane in flight.svg doesn't already point "up" (north) at 0°.
 */
const MARKER_ROTATION_OFFSET_DEG = 0;

/**
 * Below this zoom, aircraft markers are clustered into grid cells so the map
 * doesn't paint thousands of overlapping SVG badges at once. At/above this zoom
 * every aircraft gets its own marker.
 */
const CLUSTER_MAX_ZOOM = 6;
/** Grid cell size (px at current zoom) used to bucket nearby aircraft into one cluster. */
const CLUSTER_CELL_SIZE_PX = 90;
/** Cluster marker radius (px). */
const CLUSTER_MARKER_SIZE_PX = 40;

/**
 * How often follow mode re-centres the map on the plane. The animation loop runs
 * ~60×/sec; panning every frame drifts the map continuously, so instead we step
 * to the plane's latest position on this cadence.
 */
const FOLLOW_PAN_INTERVAL_MS = 5000;

/**
 * URL format `/lat,lng/zoom` (FlightRadar24 style). Lat/lng use 4 decimals
 * (~11m — precise enough to be meaningful, short enough to read); zoom keeps
 * up to 2 decimals (fractional zoom is enabled) with trailing zeros stripped.
 * Accepts the same range on parse.
 */
const URL_VIEW_PATTERN =
  /^\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/?$/;
const URL_COORD_DECIMALS = 4;
const URL_ZOOM_DECIMALS = 2;

/** Marker size for a given altitude, clamped between MIN and MAX. */
function markerSizeForAltitude(altitudeFt: number): number {
  const t = Math.min(1, Math.max(0, altitudeFt / MARKER_MAX_ALTITUDE_FT));
  return Math.round(
    MARKER_MIN_SIZE_PX + t * (MARKER_MAX_SIZE_PX - MARKER_MIN_SIZE_PX),
  );
}

/**
 * Displays the Leaflet map that aircraft will eventually be plotted on.
 *
 * The map is rendered in ngAfterViewInit once the container div exists. While
 * loading we show a status message; Leaflet loads synchronously via its CSS/JS
 * (included in index.html) so there's no async API key step — the map just works.
 */
@Component({
  selector: 'app-map',
  standalone: true,
  imports: [AircraftInfoPanelComponent],
  templateUrl: './map.component.html',
  styleUrl: './map.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapComponent
  implements OnInit, OnDestroy, AfterViewInit
{
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly mapTheme = inject(MapThemeService);
  private readonly liveFlights = inject(LiveFlightService);
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);

  private readonly mapContainer =
    viewChild.required<ElementRef<HTMLElement>>('mapContainer');

  /** The underlying Leaflet map instance, created in ngAfterViewInit. */
  private map?: L.Map;

  /**
   * Aircraft markers keyed by flightId. These are custom L.Layer instances
   * (rotatable), managed imperatively — not via the template.
   */
  private readonly markers = new Map<string, AircraftMarker>();

  /** Handle for the animation loop so we can cancel it on destroy. */
  private animationFrameId?: number;

  /** Last time (performance.now()) aircraft markers were synced to the fleet. Throttled to ~5fps since OpenSky only pushes new positions every ~10s — no need to touch 10k markers' DOM at 60fps. */
  private lastMarkerSyncMs = 0;
  /** Minimum ms between marker sync passes in the animation loop. */
  private readonly MARKER_SYNC_INTERVAL_MS = 200;
  /** Last applied style bucket ("theme:labelsVisible") to skip redundant restyles. */
  private lastStyleKey = '';

  /** True when grounded aircraft are hidden from the map. */
  readonly hideGrounded = signal(false);

  /** Clustering mode: below CLUSTER_MAX_ZOOM we bucket nearby aircraft into grid cells. */
  private readonly clustering = signal(false);

  /** Layer group holding cluster markers (only populated while clustering). */
  private readonly clusterLayer = L.layerGroup();
  /** Cluster markers keyed by grid cell key (e.g. "12:34"). */
  private readonly clusterMarkers = new Map<string, L.Marker>();
  /** FlightIds currently absorbed into a cluster (their individual markers are detached). */
  private readonly clusteredFlightIds = new Set<string>();

  /**
   * Route overlays for the selected flight (toggled by the panel's Route
   * action): a solid line origin→plane (flown), a dashed line plane→destination
   * (remaining), plus a marker at each airport. Created lazily once the map
   * exists; shown/hidden via setMap.
   */
  private readonly routeActive = signal(false);
  /** True while "follow mode" keeps the map centred on the selected plane. */
  private readonly followActive = signal(false);
  /**
   * performance.now() of the last follow re-centre. Follow mode pans on the
   * FOLLOW_PAN_INTERVAL_MS cadence rather than every frame; reset to 0 when
   * follow turns on so the first frame centres immediately.
   */
  private lastFollowPanMs = 0;
  private solidLine?: L.Polyline;
  private dashedLine?: L.Polyline;
  private originMarker?: L.Marker;
  private destMarker?: L.Marker;

  /** flightId of the currently selected aircraft (drives the info panel). */
  private readonly selectedFlightId = signal<string | null>(null);

  /**
   * ~2 Hz clock. The markers animate at 60 fps outside Angular; the info panel
   * only needs occasional text updates, so this drives `selectedAircraft`
   * without pulling the whole animation into change detection.
   */
  private readonly clock = toSignal(interval(500), { initialValue: 0 });

  /** Latest live fleet from the WebSocket feed. */
  readonly liveFleet = this.liveFlights.fleet;

  /** True when the live WebSocket feed is connected. */
  readonly feedConnected = this.liveFlights.connected;

  /** Live data for the selected aircraft, or null when none is selected. */
  readonly selectedAircraft = computed<Aircraft | null>(() => {
    this.clock(); // refresh periodically while the panel is open
    const flightId = this.selectedFlightId();
    if (!flightId) {
      return null;
    }
    return (
      this.liveFleet().find((plane) => plane.flightId === flightId) ?? null
    );
  });

  /** View model for the details panel, derived from the selected aircraft. */
  readonly selectedFlightInfo = computed<FlightPanelInfo | null>(() => {
    const plane = this.selectedAircraft();
    return plane ? this.panelInfoFor(plane) : null;
  });

  /** Action-bar buttons currently active (highlighted in the panel). */
  readonly activeActions = computed<PanelAction[]>(() => {
    const active: PanelAction[] = [];
    if (this.routeActive()) {
      active.push('route');
    }
    if (this.followActive()) {
      active.push('follow');
    }
    return active;
  });

  /** True once the map has been initialised. Leaflet loads synchronously. */
  mapReady = false;
  /** Populated if the map fails to initialise; shown to the user. */
  loadError: string | null = null;

  /**
   * Bounds of the whole world map. ~85.05° is the latitude edge of the Web
   * Mercator projection; full longitude (-180..180) is the whole east/west span.
   * Reused for both the initial auto-fit and the drag restriction.
   */
  private readonly worldBounds: L.LatLngBounds = L.latLngBounds([
    -60,
    -180,
  ], [85, 180]);

  /** Fallback initial view (equator × prime meridian). */
  readonly center: L.LatLngLiteral = { lat: 0, lng: 0 };
  readonly zoom = 0;

  /**
   * Map behaviour options. Zoom controls are explicitly enabled; other default UI
   * is kept minimal for a cleaner tracking view.
   */
  readonly mapOptions: L.MapOptions = {
    zoomControl: true,
    minZoom: 2,
    maxZoom: 18,
  };

  /** The current tile layer (swapped when the theme changes). */
  private tileLayer?: L.TileLayer;

  constructor() {
    // Re-apply map styles whenever the shared day/night theme changes.
    effect(() => {
      this.mapTheme.theme();
      this.applyMapStyle();
    });
  }

  ngAfterViewInit(): void {
    try {
      const el = this.mapContainer().nativeElement;
      this.map = L.map(el, {
        ...this.mapOptions,
        center: [this.center.lat, this.center.lng],
        zoom: this.zoom,
        layers: [tileLayerFor(this.mapTheme.theme())],
        // Stop the map from dragging past the edges of the world into the grey
        // void beyond the poles. maxBounds keeps the *entire viewport* inside
        // these bounds (not just the centre), so the map always fills the view.
        maxBounds: this.worldBounds,
        maxBoundsViscosity: 1.0,
      });

      // Initial view: honour a shareable /lat,lng/zoom URL if present, else fit
      // the whole world (first visit / bare `/`). fitBounds recomputes both
      // center and zoom to frame these bounds; setView is the direct equivalent
      // when the URL already specifies both.
      const view = this.parseUrlView();
      if (view) {
        this.map.setView([view.lat, view.lng], view.zoom);
      } else {
        this.map.fitBounds(this.worldBounds, { padding: [0, 0] });
      }
      this.mapReady = true;

      // Add the cluster layer (empty until clustering kicks in at low zoom).
      this.clusterLayer.addTo(this.map);

      // Re-apply when zoom crosses the label threshold or the clustering boundary.
      this.map.on('zoomend', () => {
        this.applyMapStyle();
        this.evaluateClustering();
      });

      // Sync URL after every pan/zoom settles. `moveend` fires once when the
      // user stops, not per-frame during a drag — no extra debounce needed.
      this.map.on('moveend', () => this.zone.run(() => this.writeUrlView()));

      // Clicking empty map (not a marker) clears the selection / closes the panel.
      this.map.on('click', () => this.zone.run(() => this.clearSelection()));

      // Drive the markers from an animation-frame loop, outside Angular so we
      // don't run change detection ~60×/sec. Each frame we read the live fleet
      // from the WebSocket feed and move the marker DOM directly — smooth motion,
      // no per-frame CD.
      this.zone.runOutsideAngular(() => {
        const animate = () => {
          const now = performance.now();
          if (now - this.lastMarkerSyncMs >= this.MARKER_SYNC_INTERVAL_MS) {
            const fleet = this.liveFleet();
            this.syncAircraftMarkers(fleet);
            this.lastMarkerSyncMs = now;
          }
          // Route and follow updates are cheap (one polyline each), keep them
          // every frame for smooth panning. Also re-evaluate clustering each
          // frame since route/follow state can flip clustering on/off.
          if (this.routeActive() || this.followActive()) {
            const fleet = this.liveFleet();
            this.updateRoute(fleet);
            this.updateFollow(fleet);
          }
          this.evaluateClustering();
          this.animationFrameId = requestAnimationFrame(animate);
        };
        this.animationFrameId = requestAnimationFrame(animate);
      });

      this.cdr.markForCheck();
    } catch (error) {
      this.loadError =
        error instanceof Error ? error.message : 'Failed to load the map.';
      this.cdr.markForCheck();
    }
  }

  /**
   * Parse the current URL's `/lat,lng/zoom` segment (FR24-style shareable view).
   * Returns null if the URL isn't in that form, the numbers are out of range,
   * or the app is on the 3D-view route (where the URL means something else).
   */
  private parseUrlView(): { lat: number; lng: number; zoom: number } | null {
    const url = this.router.url.split('?')[0].split('#')[0];
    if (url === '/' || url.startsWith('/3d-view')) {
      return null;
    }
    const match = URL_VIEW_PATTERN.exec(url);
    if (!match) {
      return null;
    }
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    const zoom = parseFloat(match[3]);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(zoom)) {
      return null;
    }
    if (
      lat < this.worldBounds.getSouth() ||
      lat > this.worldBounds.getNorth()
    ) {
      return null;
    }
    if (lng < this.worldBounds.getWest() || lng > this.worldBounds.getEast()) {
      return null;
    }
    const minZoom = this.mapOptions.minZoom ?? 0;
    const maxZoom = this.mapOptions.maxZoom ?? 22;
    if (zoom < minZoom || zoom > maxZoom) {
      return null;
    }
    return { lat, lng, zoom };
  }

  /**
   * Write the map's current center+zoom into the URL as `/lat,lng/zoom`,
   * using `replaceUrl` so pan/zoom doesn't pollute the browser back-stack.
   */
  private writeUrlView(): void {
    if (!this.map) {
      return;
    }
    if (this.router.url.startsWith('/3d-view')) {
      return;
    }
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    if (!center || zoom === undefined) {
      return;
    }
    const lat = center.lat.toFixed(URL_COORD_DECIMALS);
    const lng = center.lng.toFixed(URL_COORD_DECIMALS);
    const z = zoom.toFixed(URL_ZOOM_DECIMALS).replace(/\.?0+$/, '');
    const path = `/${lat},${lng}/${z}`;
    if (path === this.router.url) {
      return;
    }
    this.router.navigateByUrl(path, { replaceUrl: true });
  }

  /**
   * Apply the map style for the current theme + zoom. Swaps the tile layer
   * when the theme changes (day → OSM, night → CartoDB Dark Matter).
   */
  private applyMapStyle(): void {
    if (!this.map) {
      return;
    }
    const theme = this.mapTheme.theme();
    const zoom = this.map.getZoom() ?? this.zoom;
    const labelsVisible = zoom >= LABEL_ZOOM_THRESHOLD;
    const key = `${theme}:${labelsVisible}`;
    if (key === this.lastStyleKey) {
      return;
    }
    this.lastStyleKey = key;

    // Swap the tile layer for the current theme.
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
    }
    this.tileLayer = tileLayerFor(theme);
    this.tileLayer.addTo(this.map);
  }

  /**
   * Decide whether to cluster based on the current zoom, and re-sync markers
   * when the clustering mode flips. Called from the animation loop's route/follow
   * path and from the map's zoomend event so the view updates as soon as the
   * user zooms past the clustering boundary.
   */
  private evaluateClustering(): void {
    if (!this.map) {
      return;
    }
    const zoom = this.map.getZoom() ?? 0;
    const wantClustering = zoom < CLUSTER_MAX_ZOOM && !this.routeActive() && !this.followActive();
    if (wantClustering === this.clustering()) {
      return;
    }
    this.clustering.set(wantClustering);
    // Re-sync on next animation frame so cluster markers appear/disappear.
  }

  /**
   * Reconcile the on-map markers with the current fleet: update existing
   * aircraft, create markers for new ones, and remove markers for any that are
   * gone. Keyed by flightId so each plane keeps its own marker across ticks.
   *
   * When clustering is active (low zoom, no route/follow), nearby aircraft are
   * bucketed into grid cells and shown as a single cluster marker instead of
   * individual badges — far cheaper than painting 10k SVG markers at once.
   */
  private syncAircraftMarkers(fleet: Aircraft[]): void {
    if (!this.map) {
      return;
    }

    const selectedId = this.selectedFlightId();
    const soloView =
      (this.routeActive() || this.followActive()) && selectedId !== null;
    const zoom = this.map.getZoom() ?? 0;
    const clustering = zoom < CLUSTER_MAX_ZOOM && !soloView;

    // Filter: hide grounded aircraft when the toggle is on; solo view shows only
    // the selected flight. Then cull anything outside the current viewport —
    // off-screen aircraft shouldn't pay marker DOM costs every sync pass.
    const bounds = this.map.getBounds();
    const visible = fleet.filter((plane) => {
      if (soloView && plane.flightId !== selectedId) {
        return false;
      }
      if (this.hideGrounded() && plane.onGround) {
        return false;
      }
      return bounds.contains([plane.latitude, plane.longitude]);
    });

    if (clustering) {
      this.syncClusters(visible, zoom);
      // Detach every individual marker while clustered.
      for (const marker of this.markers.values()) {
        marker.setMap(null);
      }
      this.clusteredFlightIds.clear();
      for (const plane of visible) {
        this.clusteredFlightIds.add(plane.flightId);
      }
    } else {
      // Not clustering: remove all cluster markers, show individual markers.
      for (const cm of this.clusterMarkers.values()) {
        this.clusterLayer.removeLayer(cm);
      }
      this.clusterMarkers.clear();
      this.clusterLayer.clearLayers();
      this.syncIndividualMarkers(visible);
    }

    // Drop markers for flights no longer visible (kept in the map for reuse).
    for (const [flightId, marker] of this.markers) {
      if (!visible.some((p) => p.flightId === flightId)) {
        marker.setMap(null);
        this.markers.delete(flightId);
      }
    }
  }

  /**
   * Build cluster markers from the visible fleet using a fixed grid over the
   * current viewport. Cells with one aircraft fall through to individual
   * markers (handled by the caller); cells with many get one cluster marker
   * showing the count.
   */
  private syncClusters(visible: Aircraft[], zoom: number): void {
    const cellSize = CLUSTER_CELL_SIZE_PX / Math.pow(2, zoom);
    const cells = new Map<string, { planes: Aircraft[]; center: L.LatLngLiteral }>();

    for (const plane of visible) {
      const point = this.map!.latLngToLayerPoint([
        plane.latitude,
        plane.longitude,
      ]);
      const gx = Math.floor(point.x / cellSize);
      const gy = Math.floor(point.y / cellSize);
      const key = `${gx}:${gy}`;
      let entry = cells.get(key);
      if (!entry) {
        entry = { planes: [], center: { lat: plane.latitude, lng: plane.longitude } };
        cells.set(key, entry);
      }
      entry.planes.push(plane);
      // Running average for the cluster centre.
      entry.center.lat =
        (entry.center.lat * (entry.planes.length - 1) + plane.latitude) /
        entry.planes.length;
      entry.center.lng =
        (entry.center.lng * (entry.planes.length - 1) + plane.longitude) /
        entry.planes.length;
    }

    const seen = new Set<string>();
    for (const [key, entry] of cells) {
      seen.add(key);
      let marker = this.clusterMarkers.get(key);
      if (!marker) {
        marker = this.createClusterMarker(entry.center, entry.planes.length);
        marker.addTo(this.clusterLayer);
        this.clusterMarkers.set(key, marker);
      } else {
        marker.setLatLng(entry.center as L.LatLngExpression);
        this.updateClusterMarkerCount(marker, entry.planes.length);
      }
    }

    // Remove cluster markers for cells that are now empty.
    for (const [key, cm] of this.clusterMarkers) {
      if (!seen.has(key)) {
        this.clusterLayer.removeLayer(cm);
        this.clusterMarkers.delete(key);
      }
    }
  }

  /** Create a cluster marker at a given position showing the aircraft count. */
  private createClusterMarker(
    position: L.LatLngLiteral,
    count: number,
  ): L.Marker {
    const icon = L.divIcon({
      className: 'cluster-marker',
      html: `<div class="cluster-marker__count">${count}</div>`,
      iconSize: [CLUSTER_MARKER_SIZE_PX, CLUSTER_MARKER_SIZE_PX],
      iconAnchor: [
        CLUSTER_MARKER_SIZE_PX / 2,
        CLUSTER_MARKER_SIZE_PX / 2,
      ],
    }) as unknown as L.DivIcon;
    return L.marker(position as L.LatLngExpression, {
      icon,
      interactive: false,
      zIndexOffset: 1000, // draw above individual aircraft markers
    });
  }

  /** Update the count shown on an existing cluster marker. */
  private updateClusterMarkerCount(marker: L.Marker, count: number): void {
    const el = marker.getElement();
    if (!el) {
      return;
    }
    const countEl = el.querySelector('.cluster-marker__count');
    if (countEl) {
      countEl.textContent = String(count);
    }
  }

  /**
   * Sync individual aircraft markers (create/update/setSelected) for the given
   * fleet slice. Used when not clustering; callers pass the already-filtered
   * visible aircraft.
   */
  private syncIndividualMarkers(visible: Aircraft[]): void {
    const selectedId = this.selectedFlightId();
    const present = new Set<string>();
    for (const plane of visible) {
      present.add(plane.flightId);
      const position: L.LatLngExpression = [
        plane.latitude,
        plane.longitude,
      ];
      const stats: AircraftLiveStats = {
        altitudeFt: plane.altitude,
        speedKts: plane.speed,
        progress: plane.progress,
      };
      const sizePx = markerSizeForAltitude(plane.altitude);

      let marker = this.markers.get(plane.flightId);
      if (!marker) {
        marker = createAircraftMarker(position, plane.heading, {
          iconUrl: 'markers/flight.svg',
          sizePx,
          rotationOffsetDeg: MARKER_ROTATION_OFFSET_DEG,
          card: this.cardInfoFor(plane),
          onClick: () =>
            this.zone.run(() => {
              if (this.selectedFlightId() !== plane.flightId) {
                this.resetFlightModes();
              }
              this.selectedFlightId.set(plane.flightId);
              this.followActive.set(false);
              // Only activate route mode when origin/destination airports are
              // resolvable. Live OpenSky flights carry empty source/destination
              // codes, so the route overlay cannot draw for them.
              if (this.hasRouteData(plane)) {
                this.routeActive.set(true);
                this.showRouteFor(plane, true);
              }
            }),
        });
        marker.setMap(this.map ?? null);
        this.markers.set(plane.flightId, marker);
      }
      marker.update(position, plane.heading, stats, sizePx);
      marker.setSelected(plane.flightId === selectedId);
    }
  }

  /**
   * Build the static hover-card details for a flight. The photo is identity
   * data (not on the live `Aircraft` record), so it's looked up from the seed;
   * city names are resolved from the airport codes the aircraft carries.
   */
  private cardInfoFor(plane: Aircraft): AircraftCardInfo {
    const photoUrl =
      SEED_FLIGHTS.find((seed) => seed.flightId === plane.flightId)?.photo ??
      '';
    return {
      flightCode: plane.flightId,
      aircraftType: plane.aircraft,
      photoUrl,
      originCity: cityForAirport(plane.source),
      destinationCity: cityForAirport(plane.destination),
    };
  }

  /**
   * Build the details-panel view model for a flight: identity + airport names
   * (from the seed/airport reference) plus the live position values.
   */
  private panelInfoFor(plane: Aircraft): FlightPanelInfo {
    const seed = SEED_FLIGHTS.find((s) => s.flightId === plane.flightId);
    const origin = AIRPORTS[plane.source];
    const destination = AIRPORTS[plane.destination];
    return {
      flightCode: plane.flightId,
      airline: plane.airline,
      aircraftType: plane.aircraft,
      photoUrl: seed?.photo ?? '',
      origin: {
        code: plane.source,
        city: cityForAirport(plane.source),
        airport: origin?.name ?? '',
      },
      destination: {
        code: plane.destination,
        city: cityForAirport(plane.destination),
        airport: destination?.name ?? '',
      },
      progress: plane.progress,
      altitudeFt: plane.altitude,
      speedKts: plane.speed,
      headingDeg: plane.heading,
    };
  }

  /** Handle an action-bar button from the panel. */
  onPanelAction(action: PanelAction): void {
    if (action === 'follow') {
      this.toggleFollow();
      return;
    }
    if (action === 'route') {
      this.toggleRoute();
      return;
    }
    if (action === 'onboard') {
      // Navigate to the standalone 3D flight view for the selected aircraft.
      const flightId = this.selectedFlightId();
      if (flightId) {
        this.router.navigate(['/3d-view', flightId]);
      }
    }
  }

  /**
   * Toggle follow mode. Enabling it draws the route path (like the Route action)
   * but WITHOUT fitting/zooming — the view stays at the current zoom and simply
   * pans to keep the plane centred (updateFollow only calls panTo). Follow
   * and Route are mutually exclusive, so turning follow on clears the Route
   * action's highlight; turning it off removes the path.
   */
  /** True when both origin and destination airports resolve from the seed map. */
  private hasRouteData(plane: Aircraft): boolean {
    return Boolean(AIRPORTS[plane.source] && AIRPORTS[plane.destination]);
  }

  private toggleFollow(): void {
    const plane = this.selectedAircraft();
    if (!plane || !this.map) {
      return;
    }
    if (!this.hasRouteData(plane)) {
      // Follow mode draws a route path; without origin/destination airports
      // there is nothing to draw.
      return;
    }
    if (this.followActive()) {
      this.hideRoute(); // turn follow off → remove the path
      return;
    }
    this.routeActive.set(false); // mutual exclusion with the Route action
    this.followActive.set(true);
    this.lastFollowPanMs = 0; // centre on the plane immediately on the next frame
    this.showRouteFor(plane, false); // draw the path, but keep the current zoom
  }

  /**
   * Keep the map centred on the selected plane while follow mode is on. Called
   * every animation frame, but it only re-centres every FOLLOW_PAN_INTERVAL_MS
   * so the map steps to the plane periodically instead of panning continuously.
   */
  private updateFollow(fleet: Aircraft[]): void {
    if (!this.followActive() || !this.map) {
      return;
    }
    const now = performance.now();
    if (now - this.lastFollowPanMs < FOLLOW_PAN_INTERVAL_MS) {
      return;
    }
    const flightId = this.selectedFlightId();
    const plane = flightId
      ? fleet.find((p) => p.flightId === flightId)
      : undefined;
    if (plane) {
      // panTo animates the move (smooth glide) rather than jumping like
      // setView, so each periodic re-centre eases toward the plane.
      this.map.panTo([plane.latitude, plane.longitude]);
      this.lastFollowPanMs = now;
    }
  }

  /**
   * Toggle the flown/remaining route overlay for the selected flight. Draws the
   * same path as follow mode but also fits the whole route into view. Route and
   * follow are mutually exclusive: enabling the route turns follow off (mirrors
   * toggleFollow) so only one action is ever active.
   */
  private toggleRoute(): void {
    const plane = this.selectedAircraft();
    if (!plane || !this.map) {
      return;
    }
    if (!this.hasRouteData(plane)) {
      // Route mode draws origin→plane→destination; without known airports
      // there is nothing to draw.
      return;
    }
    if (this.routeActive()) {
      this.hideRoute();
      return;
    }
    this.followActive.set(false); // mutual exclusion with the Follow action
    this.routeActive.set(true);
    this.showRouteFor(plane, true); // draw the path and fit it into view
  }
  private resetFlightModes(): void {
    this.hideRoute(); // detaches the path and clears both action signals
  }

  /**
   * Show the route for a flight: solid line origin→plane, dashed plane→dest,
   * airport markers at each end. When `fit` is true the whole route is framed in
   * the viewport (Route action); when false the current zoom is left untouched
   * (Follow mode just pans). The caller sets the route/follow signal first.
   */
  private showRouteFor(plane: Aircraft, fit: boolean): void {
    const origin = AIRPORTS[plane.source];
    const destination = AIRPORTS[plane.destination];
    if (!origin || !destination || !this.map) {
      return;
    }

    this.ensureRouteObjects();
    const originPos: L.LatLngExpression = [
      origin.latitude,
      origin.longitude,
    ];
    const destPos: L.LatLngExpression = [
      destination.latitude,
      destination.longitude,
    ];

    this.originMarker!.setLatLng(originPos);
    this.originMarker!.bindTooltip(origin.name, {
      permanent: false,
      direction: 'top',
      offset: [0, -8],
    });
    this.destMarker!.setLatLng(destPos);
    this.destMarker!.bindTooltip(destination.name, {
      permanent: false,
      direction: 'top',
      offset: [0, -8],
    });

    for (const obj of [
      this.solidLine,
      this.dashedLine,
      this.originMarker,
      this.destMarker,
    ]) {
      obj?.addTo(this.map);
    }
    this.updateRoute([plane]); // draw the initial split immediately

    if (fit) {
      // Fit origin + plane + destination into view; extra left padding keeps the
      // route clear of the details panel on the left edge.
      const bounds = L.latLngBounds([originPos, destPos]);
      bounds.extend([plane.latitude, plane.longitude]);
      this.map.fitBounds(bounds, {
        padding: [380, 60], // [left/right, top/bottom] — leaflet padding is [topBottom, leftRight]
      });
    }
  }

  /**
   * Update the flown/remaining split each frame while the route path is shown.
   * The path is drawn by both the Route action and Follow mode, so this runs
   * while either is active.
   */
  private updateRoute(fleet: Aircraft[]): void {
    if (
      (!this.routeActive() && !this.followActive()) ||
      !this.solidLine ||
      !this.dashedLine
    ) {
      return;
    }
    const flightId = this.selectedFlightId();
    const plane = flightId
      ? fleet.find((p) => p.flightId === flightId)
      : undefined;
    if (!plane) {
      return;
    }
    const origin = AIRPORTS[plane.source];
    const destination = AIRPORTS[plane.destination];
    if (!origin || !destination) {
      return;
    }
    const planePos: L.LatLngExpression = [plane.latitude, plane.longitude];
    this.solidLine.setLatLngs([
      [origin.latitude, origin.longitude],
      planePos,
    ]);
    this.dashedLine.setLatLngs([
      planePos,
      [destination.latitude, destination.longitude],
    ]);
  }

  /**
   * Detach the route overlays (keeps the objects for reuse) and clear both
   * action signals. Hiding the path always exits both Route and Follow, so this
   * is the single teardown for either action being turned off.
   */
  private hideRoute(): void {
    for (const obj of [
      this.solidLine,
      this.dashedLine,
      this.originMarker,
      this.destMarker,
    ]) {
      obj?.remove();
    }
    this.routeActive.set(false);
    this.followActive.set(false);
  }

  /**
   * IATA-code label shown above an airport pin. Leaflet uses tooltips instead
   * of MarkerLabel; the text is set via bindTooltip.
   */
  private airportLabel(code: string): string {
    return code;
  }

  /** Lazily create the route polylines + airport markers (needs Leaflet). */
  private ensureRouteObjects(): void {
    if (this.solidLine) {
      return;
    }
    // Literal hex (map canvas can't read the CSS `--color-accent` token — keep
    // in sync with it).
    const ACCENT = '#38bdf8';

    this.solidLine = L.polyline([], {
      color: ACCENT,
      weight: 3,
      opacity: 1,
      // Leaflet polylines are straight lines on the screen; Leaflet does not
      // support geodesic (great-circle) lines natively like Google Maps.
    });

    // Dashed line: use dashArray for the dashed pattern.
    this.dashedLine = L.polyline([], {
      color: ACCENT,
      weight: 3,
      opacity: 1,
      dashArray: '6, 12',
    });

    // Airport pin PNGs (public/markers). They're portrait pins (1070×1200) with
    // the tip at the bottom centre, so anchor there — the tip sits on the airport.
    const pinHeight = 30;
    const pinWidth = Math.round((pinHeight * 1070) / 1200);
    const pinIcon = (url: string): L.Icon => ({
      ...L.icon({
        iconUrl: url,
        iconSize: [pinWidth, pinHeight],
        iconAnchor: [pinWidth / 2, pinHeight],
        popupAnchor: [0, -8],
      }),
    } as L.Icon);
    this.originMarker = L.marker([0, 0], {
      icon: pinIcon('markers/source.png'),
      zIndexOffset: 4,
    });
    this.destMarker = L.marker([0, 0], {
      icon: pinIcon('markers/destination.png'),
      zIndexOffset: 4,
    });
  }

  /** Close the info panel / clear the selected aircraft (and its route/follow). */
  clearSelection(): void {
    this.resetFlightModes();
    this.selectedFlightId.set(null);
  }

  /** Toggle hiding grounded (on_ground) aircraft from the map. */
  toggleHideGrounded(): void {
    this.hideGrounded.set(!this.hideGrounded());
  }

  ngOnInit(): void {}

  ngOnDestroy(): void {
    // Stop the animation loop and detach all overlays so nothing leaks if the
    // component is torn down.
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
    }
    for (const marker of this.markers.values()) {
      marker.setMap(null);
    }
    this.markers.clear();
    this.hideRoute();
    if (this.map) {
      this.map.remove();
      this.map = undefined;
    }
  }
}
