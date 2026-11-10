import * as THREE from 'three';
import { MapTheme } from '../../services/map-theme.service';
import {
  clampTile,
  elevationTileUrl,
  imageryTileUrl,
  lonLatToTileFrac,
  terrariumToMetres,
  tileSizeMetres,
  wrapTile,
} from '../../utils/tiles';

/**
 * Real-world tile terrain for the 3D flight view — a drop-in replacement for the
 * procedural fbm terrain, keeping the same "aircraft fixed at the origin, world
 * streams past" model but sourcing the world from FREE, keyless open tiles:
 *
 *   - Imagery: Esri "World Imagery" satellite tiles (draped as the colour).
 *   - Elevation: AWS Terrain Tiles (Terrarium PNG) displacing the mesh (the shape).
 *
 * A fixed N×N pool of tile meshes surrounds the aircraft. Each tile is a
 * subdivided plane displaced on the GPU by its heightmap (sampled in the vertex
 * shader, exactly the onBeforeCompile technique the old procedural terrain used —
 * only the height source changes from fbm noise to a real elevation texture).
 * `setView(lat, lon, alt)` positions the grid from the aircraft's true position
 * each frame and re-fetches only the new edge tiles when it crosses a boundary,
 * so it scrolls endlessly with no per-frame allocation.
 *
 * WORLD FRAME: north = +Z, geographic east = −X. The −X for east is deliberate —
 * it matches the existing aircraft-model / chase-camera yaw convention in the
 * component (nose forward is (sin(−heading), cos(−heading))) so that flying along
 * the heading streams the map the right way and turns rotate the ground
 * correctly. A side effect is that the satellite imagery reads mirrored east-west
 * (imperceptible at this zoom — no readable labels, just terrain and fields). To
 * make it geographically exact instead, mirror both textures in X
 * (`repeat.x = -1; offset.x = 1`) and sample the CPU height buffer at `1 - rx`.
 *
 * No API key, no billing — see CLAUDE.md's no-billing constraint. Attribution is
 * rendered as a persistent credit line in the component template.
 */

/** Zoom level for imagery/elevation tiles (higher = sharper). */
export const TILE_ZOOM = 15;
/** Grid radius in tiles from the centre (16 → a 33×33 grid, ±1280 units). */
const GRID_RADIUS = 16;
/** Vertex subdivision per tile edge (heightmaps are 256px; 64 balances detail/perf). */
const TILE_SEGMENTS = 64;
/** World units per tile edge. */
const TILE_UNITS = 80;
/** Height relief multiplier over the true horizontal scale (drama vs. realism knob). */
const VERTICAL_EXAGGERATION = 2.4;
/** Clamp for how far (world units) the aircraft floats above local ground. */
const MIN_CAM_AGL_UNITS = 8;
/** Cap so cruising at 35,000 ft keeps the terrain framed rather than tiny + far below. */
const MAX_CAM_AGL_UNITS = 32;
/** Feet → metres. */
const FT_TO_M = 0.3048;
/** Heightmap resolution (Terrarium tiles are 256×256). */
const HEIGHT_PX = 256;

/** Y the terrain group sits at before any heightmap has loaded (matches the old look). */
export const TERRAIN_BASE_Y = -20;

/** Day/night terrain tints — imagery stays true-colour by day, cools + dims at night. */
const TINT_DAY = new THREE.Color('#ffffff');
const TINT_NIGHT = new THREE.Color('#6a7686');
/** Flat colour shown on a tile whose imagery failed to load (per theme). */
const FLAT_DAY = new THREE.Color('#b7ae98');
const FLAT_NIGHT = new THREE.Color('#2b3038');

export interface TileTerrain {
  /** Root object to add to the scene; holds the whole tile grid. */
  group: THREE.Group;
  /** Swap day/night tint (imagery stays photographic; night just cools + dims). */
  recolor: (theme: MapTheme) => void;
  /**
   * Anchor the grid to the aircraft's real geographic position and altitude.
   * Call every frame: it repositions the tiles smoothly and, on tile-boundary
   * crossings, recycles the pool and fetches the new edge tiles.
   */
  setView: (lat: number, lon: number, altitudeFt: number) => void;
  /** Free every geometry, material and texture (tile pool + placeholders). */
  dispose: () => void;
}

/** Per-slot record in the fixed tile pool. Meshes are reused; textures churn. */
interface Tile {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  uElevScale: { value: number };
  uTint: { value: THREE.Color };
  uHeightMap: { value: THREE.Texture };
  /** Slippy-tile coords this slot currently shows (unwrapped, for continuity). */
  tileX: number;
  tileY: number;
  imageryTex: THREE.Texture | null;
  heightTex: THREE.Texture | null;
  /** Decoded elevation (metres), row 0 = north — for the CPU under-aircraft sample. */
  heightBuf: Float32Array | null;
  /** Bumped per (re)assignment so stale async loads can be ignored. */
  imageryToken: number;
  heightToken: number;
  /** True while showing the flat-colour fallback because imagery failed. */
  imageryFailed: boolean;
}

/** Build the 1×1 placeholder textures shared by every tile until real ones arrive. */
function makePlaceholders(): { imagery: THREE.DataTexture; height: THREE.DataTexture } {
  // Neutral grey imagery.
  const imagery = new THREE.DataTexture(
    new Uint8Array([120, 130, 120, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  imagery.colorSpace = THREE.SRGBColorSpace;
  imagery.needsUpdate = true;

  // Terrarium value 32768 (R=128) decodes to exactly 0 m → flat sea level.
  const height = new THREE.DataTexture(
    new Uint8Array([128, 0, 0, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  height.needsUpdate = true; // DataTexture defaults: Nearest filter, NoColorSpace — exactly right.

  return { imagery, height };
}

/**
 * Patch a MeshStandardMaterial to displace vertices by a Terrarium heightmap and
 * tint the imagery. The heightmap is sampled RAW (Nearest filter, no colour-space
 * decode) so the packed bytes survive; elevation is decoded in-shader. Normals
 * are recomputed from neighbouring height samples and passed to the fragment
 * stage (same approach as the old procedural terrain).
 */
function patchMaterial(
  material: THREE.MeshStandardMaterial,
  uElevScale: { value: number },
  uTint: { value: THREE.Color },
  uHeightMap: { value: THREE.Texture },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uElevScale'] = uElevScale;
    shader.uniforms['uTint'] = uTint;
    shader.uniforms['uHeightMap'] = uHeightMap;

    shader.vertexShader =
      `
      uniform sampler2D uHeightMap;
      uniform float uElevScale;
      varying vec3 vWorldPos;

      // Decode Terrarium RGB (raw 0..1 bytes) → elevation in metres.
      // Sample directly; texture uses ClampToEdgeWrapping so edge taps sample
      // across tile boundaries continuously, matching adjacent tiles.
      float sampleElevM(vec2 uvh) {
        vec2 uv = uvh;
        vec3 e = texture2D(uHeightMap, uv).rgb * 255.0;
        return (e.r * 256.0 + e.g + e.b / 256.0) - 32768.0;
      }
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      float elevM = sampleElevM(uv);
      transformed.y += elevM * uElevScale;
      `,
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      #include <project_vertex>
      vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `,
    );

    shader.fragmentShader =
      `
      uniform vec3 uTint;
      varying vec3 vWorldPos;
    ` + shader.fragmentShader;

    // Tint the (photographic) imagery — day = identity, night = cool dim.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      diffuseColor.rgb *= uTint;
      `,
    );

    // Drive lighting from geometric normal in world space so displaced terrain
    // and tile boundaries shade consistently without heightmap normal seams.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `
      #include <normal_fragment_begin>
      normal = normalize(mat3(viewMatrix) * normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos))));
      `,
    );
  };
}

export function createTileTerrain(
  theme: MapTheme,
  renderer: THREE.WebGLRenderer,
): TileTerrain {
  const group = new THREE.Group();
  const { imagery: placeholderImagery, height: placeholderHeight } =
    makePlaceholders();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const imageryLoader = new THREE.TextureLoader(); // crossOrigin defaults to 'anonymous'

  // Shared elevation scale (world units per metre of height); recomputed when the
  // aircraft's latitude band changes. Same value drives the shader displacement
  // and the CPU group-Y maths, so they stay in lockstep.
  let elevScale = (TILE_UNITS / tileSizeMetres(0, TILE_ZOOM)) * VERTICAL_EXAGGERATION;

  const tintColor = theme === 'day' ? TINT_DAY.clone() : TINT_NIGHT.clone();
  let currentTheme: MapTheme = theme;

  // --- Build the fixed tile pool -------------------------------------------
  const tiles: Tile[] = [];
  // Skirt depth: must exceed max possible vertex displacement so the vertical
// walls reach "bedrock" even after the shader lifts the top surface.
// Max elevation diff within a tile ~2000 m, elevScale ~1.2 → ~2400 units.
// Use 20000 for a huge margin.
  const SKIRT_DEPTH = 20000;

  for (let i = 0; i < (GRID_RADIUS * 2 + 1) ** 2; i++) {
    // Build a plane with skirts: a grid of (TILE_SEGMENTS+1)^2 top vertices +
    // 4 * TILE_SEGMENTS skirt vertices around the perimeter.
    const seg = TILE_SEGMENTS;
    const half = TILE_UNITS / 2;
    const topCount = (seg + 1) * (seg + 1);
    const skirtCount = 4 * seg;
    const totalVerts = topCount + skirtCount;

    const positions = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const indices = [];

    let vi = 0, ui = 0;

    // Top surface vertices (y = 0, displacement in shader)
    for (let z = 0; z <= seg; z++) {
      for (let x = 0; x <= seg; x++) {
        const ux = x / seg;
        const uz = z / seg;
        positions[vi++] = (ux - 0.5) * TILE_UNITS;
        positions[vi++] = 0;
        positions[vi++] = (uz - 0.5) * TILE_UNITS;
        uvs[ui++] = ux;
        uvs[ui++] = 1 - uz; // flip V so uv(0,0) = NW corner (matches imagery)
      }
    }

    // Skirt vertices: for each edge, add a ring of vertices at y = -SKIRT_DEPTH
    // with same x/z as the edge, same u/v as the edge.
    // Bottom edge (z = 0, south)
    for (let x = 0; x < seg; x++) {
      const ux = (x + 0.5) / seg;
      positions[vi++] = (ux - 0.5) * TILE_UNITS;
      positions[vi++] = -SKIRT_DEPTH;
      positions[vi++] = -half;
      uvs[ui++] = ux;
      uvs[ui++] = 1; // match top surface south edge: V=1
    }
    // Top edge (z = seg, north)
    for (let x = 0; x < seg; x++) {
      const ux = (x + 0.5) / seg;
      positions[vi++] = (ux - 0.5) * TILE_UNITS;
      positions[vi++] = -SKIRT_DEPTH;
      positions[vi++] = half;
      uvs[ui++] = ux;
      uvs[ui++] = 0; // match top surface north edge: V=0
    }
    // Left edge (x = 0, west) — note: world east = -X, so west = +X
    for (let z = 0; z < seg; z++) {
      const uz = (z + 0.5) / seg;
      positions[vi++] = -half;
      positions[vi++] = -SKIRT_DEPTH;
      positions[vi++] = (uz - 0.5) * TILE_UNITS;
      uvs[ui++] = 0; // match top surface west edge: U=0
      uvs[ui++] = 1 - uz;
    }
    // Right edge (x = seg, east)
    for (let z = 0; z < seg; z++) {
      const uz = (z + 0.5) / seg;
      positions[vi++] = half;
      positions[vi++] = -SKIRT_DEPTH;
      positions[vi++] = (uz - 0.5) * TILE_UNITS;
      uvs[ui++] = 1; // match top surface east edge: U=1
      uvs[ui++] = 1 - uz;
    }

    // Indices: top surface quads (two triangles each)
    for (let gz = 0; gz < seg; gz++) {
      for (let gx = 0; gx < seg; gx++) {
        const a = gz * (seg + 1) + gx;
        const b = gz * (seg + 1) + gx + 1;
        const c = (gz + 1) * (seg + 1) + gx;
        const d = (gz + 1) * (seg + 1) + gx + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    // Skirt triangles: for each edge, connect each top edge vertex to its
    // corresponding skirt vertex and the next top edge vertex.
    // Each edge has seg segments → seg skirt vertices → seg triangles.
    // Use consistent winding: (topIdx, nextTop, skirtIdx) for all edges
    // to ensure normals point outward/downward correctly.
    const skirtBase = topCount;
    // Bottom edge (south, z=0): top vertices 0..seg, skirt vertices 0..seg-1
    for (let x = 0; x < seg; x++) {
      const topIdx = x;
      const nextTop = x + 1;
      const skirtIdx = skirtBase + x;
      indices.push(topIdx, nextTop, skirtIdx);
    }
    // Top edge (north, z=seg): top vertices seg*(seg+1) .. seg*(seg+1)+seg
    for (let x = 0; x < seg; x++) {
      const topIdx = seg * (seg + 1) + x;
      const nextTop = seg * (seg + 1) + x + 1;
      const skirtIdx = skirtBase + seg + x;
      indices.push(topIdx, nextTop, skirtIdx);
    }
    // Left edge (west, x=0): top vertices 0, seg+1, 2*(seg+1), ..., seg*(seg+1)
    for (let z = 0; z < seg; z++) {
      const topIdx = z * (seg + 1);
      const nextTop = (z + 1) * (seg + 1);
      const skirtIdx = skirtBase + 2 * seg + z;
      indices.push(topIdx, nextTop, skirtIdx);
    }
    // Right edge (east, x=seg): top vertices seg, 2*seg+1, ..., seg*(seg+1)+seg
    for (let z = 0; z < seg; z++) {
      const topIdx = z * (seg + 1) + seg;
      const nextTop = (z + 1) * (seg + 1) + seg;
      const skirtIdx = skirtBase + 3 * seg + z;
      indices.push(topIdx, nextTop, skirtIdx);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    // No need to rotate — vertices are already in XZ plane with Y up.

const material = new THREE.MeshStandardMaterial({
      map: placeholderImagery,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide, // skirts + displaced top can have inconsistent winding
    });

    const uElevScale = { value: elevScale };
    const uTint = { value: tintColor };
    const uHeightMap = { value: placeholderHeight as THREE.Texture };
    patchMaterial(material, uElevScale, uTint, uHeightMap);

    const mesh = new THREE.Mesh(geometry, material);
    // Slight overlap + skirts = no visible cracks.
    mesh.scale.set(1.002, 1, 1.002);
    mesh.frustumCulled = false;
    group.add(mesh);

    tiles.push({
      mesh,
      material,
      uElevScale,
      uTint,
      uHeightMap,
      tileX: Number.NaN,
      tileY: Number.NaN,
      imageryTex: null,
      heightTex: null,
      heightBuf: null,
      imageryToken: 0,
      heightToken: 0,
      imageryFailed: false,
    });
  }

  let centerX = Number.NaN;
  let centerY = Number.NaN;

  const disposeTexture = (tex: THREE.Texture | null): void => {
    if (tex && tex !== placeholderImagery && tex !== placeholderHeight) {
      tex.dispose();
    }
  };

  /** Draw an elevation image to a canvas and decode it to metres (row 0 = north). */
  const decodeHeights = (img: HTMLImageElement): Float32Array | null => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = HEIGHT_PX;
      canvas.height = HEIGHT_PX;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        return null;
      }
      ctx.drawImage(img, 0, 0, HEIGHT_PX, HEIGHT_PX);
      const data = ctx.getImageData(0, 0, HEIGHT_PX, HEIGHT_PX).data;
      const buf = new Float32Array(HEIGHT_PX * HEIGHT_PX);
      for (let p = 0; p < buf.length; p++) {
        const i = p * 4;
        buf[p] = terrariumToMetres(data[i], data[i + 1], data[i + 2]);
      }
      return buf;
    } catch (err) {
      // Tainted canvas (CORS) or decode failure — fall back to flat, never throw.
      console.error('[TileTerrain] elevation decode failed — tile stays flat.', err);
      return null;
    }
  };

  const loadImagery = (tile: Tile): void => {
    const token = ++tile.imageryToken;
    const url = imageryTileUrl(
      wrapTile(tile.tileX, TILE_ZOOM),
      clampTile(tile.tileY, TILE_ZOOM),
      TILE_ZOOM,
    );
    imageryLoader.load(
      url,
      (tex) => {
        if (tile.imageryToken !== token) {
          tex.dispose(); // a newer assignment already superseded this slot
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false; // uv(0,0) = top-left = tile's NW corner
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // World frame uses east = -X (matches aircraft yaw). Mirror imagery
        // horizontally so geographic content aligns with that frame and adjacent
        // tiles line up at their edges.
        tex.repeat.set(-1, 1);
        tex.offset.set(1, 0);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.anisotropy = Math.min(16, maxAnisotropy);
        tex.needsUpdate = true;
        disposeTexture(tile.imageryTex);
        tile.imageryTex = tex;
        tile.material.map = tex;
        tile.material.color.set('#ffffff');
        tile.material.needsUpdate = true;
        tile.imageryFailed = false;
      },
      undefined,
      () => {
        if (tile.imageryToken !== token) {
          return;
        }
        console.error(
          `[TileTerrain] imagery z${TILE_ZOOM}/${tile.tileX}/${tile.tileY} failed — flat patch.`,
        );
        tile.imageryFailed = true;
        tile.material.map = placeholderImagery;
        tile.material.color.copy(currentTheme === 'day' ? FLAT_DAY : FLAT_NIGHT);
        tile.material.needsUpdate = true;
      },
    );
  };

  const loadHeight = (tile: Tile): void => {
    const token = ++tile.heightToken;
    const url = elevationTileUrl(
      wrapTile(tile.tileX, TILE_ZOOM),
      clampTile(tile.tileY, TILE_ZOOM),
      TILE_ZOOM,
    );
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required for both the GPU texture and canvas read-back
    img.onload = () => {
      if (tile.heightToken !== token) {
        return;
      }
      const tex = new THREE.Texture(img);
      tex.magFilter = THREE.NearestFilter; // never interpolate packed height bytes
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace; // raw bytes, no sRGB decode
      tex.flipY = false; // match imagery + the canvas decode orientation
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      // Mirror to match the east = -X world frame (keeps elevation aligned with imagery).
      tex.repeat.set(-1, 1);
      tex.offset.set(1, 0);
      tex.needsUpdate = true;
      disposeTexture(tile.heightTex);
      tile.heightTex = tex;
      tile.uHeightMap.value = tex;
      tile.heightBuf = decodeHeights(img);
    };
    img.onerror = () => {
      if (tile.heightToken !== token) {
        return;
      }
      console.error(
        `[TileTerrain] elevation z${TILE_ZOOM}/${tile.tileX}/${tile.tileY} failed — tile stays flat.`,
      );
    };
    img.src = url;
  };

  /**
   * Recycle the pool for a new centre tile: keep any slot whose coords are still
   * inside the window, and reassign the rest to the newly-exposed coords,
   * nearest-first. Only the new edge tiles trigger fetches.
   */
  const assignTiles = (cx: number, cy: number): void => {
    // Every (tileX, tileY) the new window needs.
    const needed: { x: number; y: number }[] = [];
    for (let i = -GRID_RADIUS; i <= GRID_RADIUS; i++) {
      for (let j = -GRID_RADIUS; j <= GRID_RADIUS; j++) {
        needed.push({ x: cx + i, y: cy + j });
      }
    }

    const claimed = new Array<boolean>(tiles.length).fill(false);
    const stillNeeded: { x: number; y: number }[] = [];

    // Keep slots already showing a needed coord.
    for (const want of needed) {
      const idx = tiles.findIndex(
        (t, k) => !claimed[k] && t.tileX === want.x && t.tileY === want.y,
      );
      if (idx >= 0) {
        claimed[idx] = true;
      } else {
        stillNeeded.push(want);
      }
    }

    // Nearest-first so the ground under the aircraft resolves before the edges.
    stillNeeded.sort(
      (a, b) =>
        Math.max(Math.abs(a.x - cx), Math.abs(a.y - cy)) -
        Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy)),
    );

    // Reassign the unclaimed slots to the remaining coords and (re)fetch them.
    let free = 0;
    for (const want of stillNeeded) {
      while (free < tiles.length && claimed[free]) {
        free++;
      }
      const tile = tiles[free];
      claimed[free] = true;
      tile.tileX = want.x;
      tile.tileY = want.y;
      tile.heightBuf = null;
      tile.uHeightMap.value = placeholderHeight;
      loadImagery(tile);
      loadHeight(tile);
    }
  };

  /** Bilinear elevation (metres) under the aircraft from the centre tile's buffer. */
  const groundElevMetres = (rx: number, ry: number): number => {
    const centre = tiles.find((t) => t.tileX === centerX && t.tileY === centerY);
    if (!centre?.heightBuf) {
      return 0;
    }
    const buf = centre.heightBuf;
    const fx = Math.max(0, Math.min(1, rx)) * (HEIGHT_PX - 1);
    const fy = Math.max(0, Math.min(1, ry)) * (HEIGHT_PX - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, HEIGHT_PX - 1);
    const y1 = Math.min(y0 + 1, HEIGHT_PX - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v00 = buf[y0 * HEIGHT_PX + x0];
    const v10 = buf[y0 * HEIGHT_PX + x1];
    const v01 = buf[y1 * HEIGHT_PX + x0];
    const v11 = buf[y1 * HEIGHT_PX + x1];
    return (
      v00 * (1 - tx) * (1 - ty) +
      v10 * tx * (1 - ty) +
      v01 * (1 - tx) * ty +
      v11 * tx * ty
    );
  };

  const setView = (lat: number, lon: number, altitudeFt: number): void => {
    const frac = lonLatToTileFrac(lon, lat, TILE_ZOOM);
    const cx = Math.floor(frac.x);
    const cy = Math.floor(frac.y);

    if (cx !== centerX || cy !== centerY) {
      centerX = cx;
      centerY = cy;
      // Tile size (and thus world scale) drifts with latitude — refresh it and
      // push the new value to every tile's shader uniform.
      elevScale =
        (TILE_UNITS / tileSizeMetres(lat, TILE_ZOOM)) * VERTICAL_EXAGGERATION;
      for (const tile of tiles) {
        tile.uElevScale.value = elevScale;
      }
      assignTiles(cx, cy);
    }

    // Reposition every tile continuously from the fractional position (smooth
    // between boundary crossings). World frame: north = +Z, geographic east = −X.
    for (const tile of tiles) {
      const dtx = tile.tileX + 0.5 - frac.x;
      const dty = tile.tileY + 0.5 - frac.y;
      tile.mesh.position.x = -dtx * TILE_UNITS;
      tile.mesh.position.z = -dty * TILE_UNITS;
    }

    // Drop the whole group so the ground under the aircraft sits the right AGL
    // below the origin. Folding −groundElev·scale into group.y lets the shader
    // displace by ABSOLUTE elevation with no per-frame uniform update.
    const groundElevM = groundElevMetres(frac.x - cx, frac.y - cy);
    const realAglM = Math.max(0, altitudeFt * FT_TO_M - groundElevM);
    const camAglUnits = THREE.MathUtils.clamp(
      realAglM * elevScale,
      MIN_CAM_AGL_UNITS,
      MAX_CAM_AGL_UNITS,
    );
    group.position.y = -groundElevM * elevScale - camAglUnits;
  };

  const recolor = (t: MapTheme): void => {
    currentTheme = t;
    tintColor.copy(t === 'day' ? TINT_DAY : TINT_NIGHT);
    // Re-tone any tiles currently showing the imagery-failure flat colour.
    for (const tile of tiles) {
      if (tile.imageryFailed) {
        tile.material.color.copy(t === 'day' ? FLAT_DAY : FLAT_NIGHT);
      }
    }
  };

  const dispose = (): void => {
    for (const tile of tiles) {
      tile.mesh.geometry.dispose();
      tile.material.dispose();
      disposeTexture(tile.imageryTex);
      disposeTexture(tile.heightTex);
    }
    placeholderImagery.dispose();
    placeholderHeight.dispose();
  };

  group.position.y = TERRAIN_BASE_Y; // transient; setView overrides on the first frame
  return { group, recolor, setView, dispose };
}
