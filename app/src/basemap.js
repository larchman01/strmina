import { DEM_MAX_ZOOM } from './dem.js';

// Umirjena vektorska podlaga (OpenFreeMap, brez ključa, dovoljena tudi komercialna raba).
const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const ACCENT = '#2563eb';

const TOPO = {
  type: 'raster',
  tileSize: 256,
  tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
  maxzoom: 17,
  attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
};

const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f1ed' } }],
};

export async function loadBaseStyle() {
  try {
    const res = await fetch(BASE_STYLE_URL);
    if (res.ok) return await res.json();
  } catch {
    /* brez povezave */
  }
  return structuredClone(FALLBACK_STYLE);
}

function regionLabelPoints(meta) {
  return {
    type: 'FeatureCollection',
    features: meta.regions.map(r => ({
      type: 'Feature',
      properties: { id: r.id, name: r.name },
      geometry: { type: 'Point', coordinates: [(r.bounds[0] + r.bounds[2]) / 2, (r.bounds[1] + r.bounds[3]) / 2] },
    })),
  };
}

/**
 * Podlago dopolni s terenom, senčenjem, nakloni in označbo LiDAR območij.
 * Vrne { style, baseLayerIds } – slednje skrijemo, ko je izbrana podlaga Topo.
 */
export function composeStyle(base, meta, coverage) {
  const style = structuredClone(base);

  // Manj napisov: brez številk cest, zaselki in imena cest šele od blizu.
  for (const l of style.layers) {
    if (/shield/.test(l.id)) l.layout = { ...l.layout, visibility: 'none' };
    else if (l.id === 'label_other') l.minzoom = Math.max(l.minzoom ?? 0, 13.5);
    else if (/^highway-name/.test(l.id)) l.minzoom = Math.max(l.minzoom ?? 0, 15);
  }
  const baseLayerIds = style.layers
    .filter(l => l.type !== 'background' && l.layout?.visibility !== 'none')
    .map(l => l.id);
  const dem = { type: 'raster-dem', tiles: ['dem://{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', maxzoom: DEM_MAX_ZOOM };

  style.sky = {
    'sky-color': '#9cc3ea',
    'horizon-color': '#e8eef3',
    'fog-color': '#eef1f3',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.45,
  };
  style.terrain = { source: 'terrain', exaggeration: 1 };
  Object.assign(style.sources, {
    topo: TOPO,
    terrain: { ...dem, attribution: 'Višine: GURS CLSS 2023–25, BEV, AWS Terrain Tiles' },
    hillshade: dem,
    slope: {
      type: 'raster',
      tiles: ['slope://{z}/{x}/{y}'],
      tileSize: 256,
      minzoom: meta.slope_zooms[0],
      maxzoom: meta.slope_zooms[1],
      bounds: meta.bounds,
      attribution: 'Nakloni: GURS CLSS 2023–25, BEV ALS DTM (CC BY 4.0)',
    },
    coverage: { type: 'geojson', data: coverage },
    regionLabels: { type: 'geojson', data: regionLabelPoints(meta) },
  });

  const insertAt = (index, ...layers) => style.layers.splice(index, 0, ...layers);
  const indexOf = id => style.layers.findIndex(l => l.id === id);
  const firstSymbol = () => {
    const i = style.layers.findIndex(l => l.type === 'symbol');
    return i < 0 ? style.layers.length : i;
  };

  // Topo je takoj nad ozadjem; senčenje in nakloni pod vodotoki, cestami in napisi.
  insertAt(1, { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } });
  const relief = indexOf('waterway') >= 0 ? indexOf('waterway') : firstSymbol();
  insertAt(
    relief,
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'hillshade',
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#46525c',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#5b6770',
      },
    },
    { id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': 0.6, 'raster-fade-duration': 200 } },
  );

  // LiDAR območja: od daleč obarvana, od blizu le tanek rob (tam govorijo nakloni).
  insertAt(
    firstSymbol(),
    {
      id: 'coverage-fill',
      type: 'fill',
      source: 'coverage',
      paint: {
        'fill-color': ACCENT,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 10.5, 0.28, 12, 0.06, 13, 0],
      },
    },
    {
      id: 'coverage-casing',
      type: 'line',
      source: 'coverage',
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 3, 12, 3.5, 15, 2.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.9, 13, 0.5],
      },
    },
    {
      id: 'coverage-line',
      type: 'line',
      source: 'coverage',
      paint: {
        'line-color': ACCENT,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 12, 1.5, 15, 1],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 0.8, 14, 0.45],
      },
    },
  );

  if (style.glyphs) {
    style.layers.push({
      id: 'region-label',
      type: 'symbol',
      source: 'regionLabels',
      maxzoom: 11.5,
      layout: {
        'text-field': ['format', ['get', 'name'], {}, '\nLiDAR', { 'font-scale': 0.7 }],
        'text-font': ['Noto Sans Bold'],
        'text-size': 14,
        'text-allow-overlap': true,
        'text-letter-spacing': 0.02,
      },
      paint: {
        'text-color': '#1e40af',
        'text-halo-color': 'rgba(255, 255, 255, 0.95)',
        'text-halo-width': 1.8,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 1, 11.5, 0],
      },
    });
  }

  return { style, baseLayerIds };
}
