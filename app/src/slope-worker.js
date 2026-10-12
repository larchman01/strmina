// Izračun ploščice naklonov iz višinske ploščice Terrarium (Mapterhorn), v ločeni niti.
// Sporočila: {type:'init', classes, polygons}, {type:'cancel', id}, {id, z, x, y, url} -> {id, png}

const SMOOTH_M = 3; // enako glajenje kot pri predračunanih naklonih (build.py --smooth 3)
const R = 6378137;

let classes = []; // [{min, rgb:[r,g,b]}], naraščajoče
let polygons = []; // [{bbox:[w,s,e,n], rings:[[[lng,lat],...],...]}] – območja s predračunanimi nakloni
const canceled = new Set();

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    classes = data.classes;
    polygons = data.polygons;
    return;
  }
  if (data.type === 'cancel') {
    canceled.add(data.id);
    return;
  }
  try {
    const png = await renderTile(data);
    self.postMessage({ id: data.id, png }, png ? [png] : []);
  } catch (e) {
    self.postMessage({ id: data.id, error: String(e?.message ?? e) });
  } finally {
    canceled.delete(data.id);
  }
};

function tileToLonLat(z, x, y) {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

function gaussianBlur(src, size, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const clamp = v => (v < 0 ? 0 : v >= size ? size - 1 : v);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[row + clamp(x + k)] * kernel[k + radius];
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[clamp(y + k) * size + x] * kernel[k + radius];
      out[y * size + x] = acc;
    }
  }
  return out;
}

async function renderTile({ id, z, x, y, url }) {
  const res = await fetch(url);
  if (res.status === 404) return emptyPng(256);
  if (!res.ok) throw new Error(`DEM ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  if (canceled.has(id)) return null;

  const S = bmp.width;
  const canvas = new OffscreenCanvas(S, S);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, S, S);
  const d = px.data;
  let h = new Float32Array(S * S);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;

  const [, latTop] = tileToLonLat(z, x, y);
  const [, latBottom] = tileToLonLat(z, x, y + 1);
  const cellM = ((2 * Math.PI * R) / (2 ** z * S)) * Math.cos((((latTop + latBottom) / 2) * Math.PI) / 180);
  const sigmaPx = SMOOTH_M / cellM;
  if (sigmaPx > 0.5) h = gaussianBlur(h, S, sigmaPx);
  if (canceled.has(id)) return null;

  // naklon s centralnimi razlikami (na robu enostranske) in razvrstitev v razrede
  let any = false;
  const t = classes.map(c => Math.tan((c.min * Math.PI) / 180) ** 2); // primerjamo tan² namesto kotov
  for (let yy = 0; yy < S; yy++) {
    const y0 = yy > 0 ? yy - 1 : yy;
    const y1 = yy < S - 1 ? yy + 1 : yy;
    for (let xx = 0; xx < S; xx++) {
      const x0 = xx > 0 ? xx - 1 : xx;
      const x1 = xx < S - 1 ? xx + 1 : xx;
      const gx = (h[yy * S + x1] - h[yy * S + x0]) / ((x1 - x0) * cellM);
      const gy = (h[y1 * S + xx] - h[y0 * S + xx]) / ((y1 - y0) * cellM);
      const g2 = gx * gx + gy * gy;
      let k = -1;
      for (let c = t.length - 1; c >= 0; c--) {
        if (g2 >= t[c]) {
          k = c;
          break;
        }
      }
      const o = (yy * S + xx) * 4;
      if (k < 0) {
        d[o + 3] = 0;
      } else {
        const rgb = classes[k].rgb;
        d[o] = rgb[0];
        d[o + 1] = rgb[1];
        d[o + 2] = rgb[2];
        d[o + 3] = 255;
        any = true;
      }
    }
  }
  if (!any) return emptyPng(256);
  ctx.putImageData(px, 0, 0);

  // Izreži območja s predračunanimi (novejšimi) nakloni.
  const [w, n] = tileToLonLat(z, x, y);
  const [e, s] = tileToLonLat(z, x + 1, y + 1);
  const scale = 2 ** z * S;
  const toPx = (lng, lat) => {
    const r = (lat * Math.PI) / 180;
    return [((lng + 180) / 360) * scale - x * S, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale - y * S];
  };
  ctx.globalCompositeOperation = 'destination-out';
  for (const poly of polygons) {
    const [pw, ps, pe, pn] = poly.bbox;
    if (pe < w || pw > e || pn < s || ps > n) continue;
    const path = new Path2D();
    for (const ring of poly.rings) {
      ring.forEach(([lng, lat], i) => {
        const [px2, py2] = toPx(lng, lat);
        if (i === 0) path.moveTo(px2, py2);
        else path.lineTo(px2, py2);
      });
      path.closePath();
    }
    ctx.fill(path, 'evenodd');
  }
  if (canceled.has(id)) return null;
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

let empty = null;
async function emptyPng(size) {
  if (!empty) {
    const c = new OffscreenCanvas(size, size);
    c.getContext('2d');
    empty = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  return empty.slice(0);
}
