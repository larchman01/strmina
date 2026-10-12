import { addProtocol } from 'maplibre-gl';

// Višinske ploščice (Terrarium). Kjer imamo LiDAR, jih beremo iz aplikacije, drugje iz AWS Terrain Tiles.
const AWS_TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAX_ZOOM = 15;
const TILE = 256;
const ASPECTS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = v => (v / n) * 360 - 180;
  const lat = v => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/**
 * Prenese PNG iz aplikacije; vrne null, če ga ni. Razvojni strežnik in nekateri WebView-i za
 * manjkajočo datoteko vrnejo index.html s statusom 200, zato preverimo podpis PNG.
 */
export async function fetchLocalPng(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const sig = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47 ? buf : null;
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lng, lat, rings) {
  return inRing(lng, lat, rings[0]) && !rings.slice(1).some(r => inRing(lng, lat, r));
}

/** Ali tile (z/x/y) seka katero od LiDAR območij iz meta.json. */
export function tileInRegions(meta, z, x, y) {
  const b = tileBounds(z, x, y);
  return meta.regions.some(r => intersects(b, r.bounds));
}

export class Dem {
  /** coverage: GeoJSON z obrisi dejanskih LiDAR podatkov (properties.source). */
  constructor(meta, coverage, baseUrl) {
    this.meta = meta;
    this.coverage = coverage;
    this.baseUrl = baseUrl;
    this.heights = new Map(); // "x/y" -> Promise<Float32Array|null>
  }

  hasLidar(z, x, y) {
    const [zMin, zMax] = this.meta.dem_zooms;
    return z >= zMin && z <= zMax && tileInRegions(this.meta, z, x, y);
  }

  /** Vir LiDAR v točki (npr. "CLSS 0,5 m") ali null. */
  lidarAt(lng, lat) {
    for (const f of this.coverage.features) {
      const g = f.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      if (polys.some(rings => inPolygon(lng, lat, rings))) return f.properties.source;
    }
    return null;
  }

  async fetchTile(z, x, y, signal) {
    if (this.hasLidar(z, x, y)) {
      const local = await fetchLocalPng(`${this.baseUrl}tiles/dem/${z}/${x}/${y}.png`, signal);
      if (local) return local;
    }
    const url = AWS_TERRARIUM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`DEM ${z}/${x}/${y}: ${res.status}`);
    return res.arrayBuffer();
  }

  /** Registrira protokol dem://{z}/{x}/{y} za vire raster-dem. */
  registerProtocol() {
    addProtocol('dem', async (params, abortController) => {
      const [z, x, y] = params.url.slice('dem://'.length).split('/').map(Number);
      return { data: await this.fetchTile(z, x, y, abortController.signal) };
    });
  }

  tileHeights(x, y) {
    const key = `${x}/${y}`;
    if (!this.heights.has(key)) {
      if (this.heights.size > 64) this.heights.delete(this.heights.keys().next().value);
      this.heights.set(key, this.decode(DEM_MAX_ZOOM, x, y));
    }
    return this.heights.get(key);
  }

  async decode(z, x, y) {
    try {
      const buf = await this.fetchTile(z, x, y);
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      const ctx = new OffscreenCanvas(TILE, TILE).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, TILE, TILE).data;
      const h = new Float32Array(TILE * TILE);
      for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      return h;
    } catch {
      return null;
    }
  }

  async height(px, py) {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const h = await this.tileHeights(tx, ty);
    return h ? h[(py - ty * TILE) * TILE + (px - tx * TILE)] : NaN;
  }

  /** Naklon, ekspozicija in višina v točki (Hornova metoda na oknu 3x3, ~3 m piksli). */
  async query(lng, lat) {
    const n = TILE * 2 ** DEM_MAX_ZOOM;
    const r = (lat * Math.PI) / 180;
    const px = Math.floor(((lng + 180) / 360) * n);
    const py = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    const cell = ((2 * Math.PI * 6378137) / n) * Math.cos(r);

    const z = await Promise.all(
      [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => this.height(px + dx, py + dy))),
    );
    if (z.some(Number.isNaN)) return null;
    const dzdx = (z[2] + 2 * z[5] + z[8] - (z[0] + 2 * z[3] + z[6])) / (8 * cell);
    const dzdn = -(z[6] + 2 * z[7] + z[8] - (z[0] + 2 * z[1] + z[2])) / (8 * cell); // y slike raste proti jugu
    const slope = (Math.atan(Math.hypot(dzdx, dzdn)) * 180) / Math.PI;
    const azimuth = ((Math.atan2(-dzdx, -dzdn) * 180) / Math.PI + 360) % 360; // smer navzdol
    return {
      slope,
      aspect: slope < 2 ? 'ravno' : ASPECTS[Math.round(azimuth / 45) % 8],
      elevation: z[4],
      source: this.lidarAt(lng, lat),
    };
  }
}
