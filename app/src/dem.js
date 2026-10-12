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

export class Dem {
  constructor(meta, baseUrl) {
    this.meta = meta;
    this.baseUrl = baseUrl;
    this.heights = new Map(); // "z/x/y" -> Promise<Float32Array|null>
  }

  hasLidar(z, x, y) {
    const [zMin, zMax] = this.meta.dem_zooms;
    return z >= zMin && z <= zMax && intersects(tileBounds(z, x, y), this.meta.bounds);
  }

  async fetchTile(z, x, y, signal) {
    if (this.hasLidar(z, x, y)) {
      const res = await fetch(`${this.baseUrl}tiles/dem/${z}/${x}/${y}.png`, { signal });
      if (res.ok) return res.arrayBuffer();
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
    const [w, s, e, nn] = this.meta.bounds;
    return {
      slope,
      aspect: slope < 2 ? 'ravno' : ASPECTS[Math.round(azimuth / 45) % 8],
      elevation: z[4],
      lidar: lng >= w && lng <= e && lat >= s && lat <= nn,
    };
  }
}
