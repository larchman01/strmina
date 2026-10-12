import { addProtocol } from 'maplibre-gl';
import SlopeWorker from './slope-worker.js?worker';
import { TERRAIN_TILES } from './dem.js';

/** Barve razredov iz meta.json (#rrggbb) -> [r, g, b]. */
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

function polygonsOf(coverage) {
  const out = [];
  for (const f of coverage.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      const xs = rings[0].map(c => c[0]);
      const ys = rings[0].map(c => c[1]);
      out.push({ bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], rings });
    }
  }
  return out;
}

/**
 * slopelive://{z}/{x}/{y}: ploščica naklonov, izračunana sproti iz Mapterhornove višinske ploščice
 * v skupini delavcev (Web Worker). Območja s predračunanimi nakloni (coverage) so izrezana.
 */
export function registerLiveSlope(meta, coverage) {
  const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: count }, () => new SlopeWorker());
  const init = {
    type: 'init',
    classes: meta.classes.map(c => ({ min: c.min, rgb: rgb(c.color) })),
    polygons: polygonsOf(coverage),
  };
  const pending = new Map();
  for (const w of workers) {
    w.postMessage(init);
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else if (data.png) p.resolve({ data: data.png });
      else p.reject(new DOMException('Prekinjeno', 'AbortError'));
    };
  }

  let seq = 0;
  addProtocol('slopelive', (params, abortController) => {
    const [z, x, y] = params.url.slice('slopelive://'.length).split('/').map(Number);
    const id = ++seq;
    const worker = workers[id % count];
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, z, x, y, url: TERRAIN_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y) });
      abortController.signal.addEventListener('abort', () => {
        worker.postMessage({ type: 'cancel', id });
        pending.delete(id);
        reject(new DOMException('Prekinjeno', 'AbortError'));
      });
    });
  });
}
