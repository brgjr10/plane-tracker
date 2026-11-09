import * as L from 'leaflet';
import type { MapTheme } from '../../services/map-theme.service';

/**
 * Leaflet tile layer definitions per theme.
 *
 * `day` uses OpenStreetMap standard tiles (light, colourful). `night` uses
 * CartoDB Dark Matter tiles (dark, low contrast) so aircraft markers read
 * clearly against the darkened basemap.
 *
 * All tile sources are keyless (no API key or billing account required):
 *  - OpenStreetMap: https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *  - CartoDB Dark Matter: https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png
 *
 * Attribution is required by the tile providers' terms and is added automatically
 * by Leaflet when the layer is created.
 */

export const LABEL_ZOOM_THRESHOLD = 7; // kept for API compatibility

const TILE_SIZE = 256;
const MAX_ZOOM = 19;

const DAY_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const NIGHT_TILE_URL =
  'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

const DAY_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const NIGHT_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

/**
 * Resolve the Leaflet tile layer for a given theme. Returns a configured
 * L.TileLayer instance ready to addTo(map).
 */
export function tileLayerFor(theme: MapTheme): L.TileLayer {
  const url = theme === 'day' ? DAY_TILE_URL : NIGHT_TILE_URL;
  const attribution = theme === 'day' ? DAY_ATTRIBUTION : NIGHT_ATTRIBUTION;
  return L.tileLayer(url, {
    maxZoom: MAX_ZOOM,
    tileSize: TILE_SIZE,
    attribution,
  });
}
