/* global maplibregl */
'use strict';

const DEM_TILES = 'tiles/dem/{z}/{x}/{y}.png';
const SLOPE_TILES = 'tiles/slope/{z}/{x}/{y}.png';
const QUERY_ZOOM = 15; // ločljivost ploščic DEM za poizvedbe (~3 m)
const TILE = 256;
const ASPECTS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];

const BASEMAPS = {
  topo: {
    tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap',
  },
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
};

async function main() {
  const meta = await fetch('data/meta.json').then(r => r.json());
  buildLegend(meta.classes);

  const [w, s, e, n] = meta.bounds;
  const pad = 0.03;

  const map = new maplibregl.Map({
    container: 'map',
    center: [14.533, 46.300],
    zoom: 14,
    minZoom: 12,
    maxZoom: 18,
    maxPitch: 75,
    maxBounds: [[w - pad * 2, s - pad], [e + pad * 2, n + pad]],
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        topo: { type: 'raster', tileSize: 256, ...BASEMAPS.topo },
        osm: { type: 'raster', tileSize: 256, ...BASEMAPS.osm },
        slope: {
          type: 'raster', tiles: [SLOPE_TILES], tileSize: 256,
          minzoom: meta.slope_zooms[0], maxzoom: meta.slope_zooms[1], bounds: meta.bounds,
          attribution: 'Nakloni: GURS CLSS 2023–25 (CC BY 4.0)',
        },
        hillshadeDem: {
          type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, encoding: 'terrarium',
          minzoom: meta.dem_zooms[0], maxzoom: meta.dem_zooms[1],
          attribution: 'AWS Terrain Tiles',
        },
        terrainDem: {
          type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, encoding: 'terrarium',
          minzoom: meta.dem_zooms[0], maxzoom: meta.dem_zooms[1],
        },
        coverage: { type: 'geojson', data: 'data/coverage.geojson' },
        point: { type: 'geojson', data: emptyFC() },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#e9ebe6' } },
        { id: 'topo', type: 'raster', source: 'topo' },
        { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
        {
          id: 'hillshade', type: 'hillshade', source: 'hillshadeDem',
          paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#2d3a44' },
        },
        { id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': 0.6 } },
        {
          id: 'coverage', type: 'line', source: 'coverage',
          paint: { 'line-color': '#1f2a33', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.7 },
        },
        {
          id: 'point', type: 'circle', source: 'point',
          paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#1f2a33', 'circle-stroke-width': 2 },
        },
      ],
    },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  });
  map.addControl(geolocate, 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  const terrain = new TerrainQuery(meta);
  window.strmina = { map, terrain }; // za razhroščevanje v konzoli

  map.on('click', async ev => {
    const { lng, lat } = ev.lngLat;
    setPoint(map, lng, lat);
    showReadout(await terrain.at(lng, lat), 'izbrana točka');
  });

  geolocate.on('geolocate', async pos => {
    const { longitude, latitude } = pos.coords;
    showReadout(await terrain.at(longitude, latitude), 'tvoja lokacija');
  });

  wireControls(map);
}

/** Naklon, ekspozicija in višina iz ploščic DEM (Terrarium), dekodiranih v brskalniku. */
class TerrainQuery {
  constructor(meta) {
    this.meta = meta;
    this.cache = new Map();
  }

  async tile(x, y) {
    const key = `${x}/${y}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, loadHeights(DEM_TILES.replace('{z}', QUERY_ZOOM).replace('{x}', x).replace('{y}', y)));
    }
    return this.cache.get(key);
  }

  async height(px, py) {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const h = await this.tile(tx, ty);
    if (!h) return NaN;
    return h[(py - ty * TILE) * TILE + (px - tx * TILE)];
  }

  async at(lng, lat) {
    const n = TILE * 2 ** QUERY_ZOOM;
    const px = Math.floor((lng + 180) / 360 * n);
    const r = lat * Math.PI / 180;
    const py = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    const cell = 2 * Math.PI * 6378137 / n * Math.cos(r); // velikost piksla v metrih

    // Hornova metoda na oknu 3x3
    const z = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) z.push(await this.height(px + dx, py + dy));
    }
    if (z.some(Number.isNaN)) return null;
    const dzdx = ((z[2] + 2 * z[5] + z[8]) - (z[0] + 2 * z[3] + z[6])) / (8 * cell);
    const dzdyS = ((z[6] + 2 * z[7] + z[8]) - (z[0] + 2 * z[1] + z[2])) / (8 * cell); // y raste proti jugu
    const dzdyN = -dzdyS;

    const slope = Math.atan(Math.hypot(dzdx, dzdyN)) * 180 / Math.PI;
    const azimuth = (Math.atan2(-dzdx, -dzdyN) * 180 / Math.PI + 360) % 360; // smer navzdol
    const [w, s, e, nn] = this.meta.bounds;
    return {
      slope,
      aspect: slope < 2 ? 'ravno' : ASPECTS[Math.round(azimuth / 45) % 8],
      elevation: z[4],
      lidar: lng >= w && lng <= e && lat >= s && lat <= nn,
    };
  }
}

async function loadHeights(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, TILE, TILE).data;
    const h = new Float32Array(TILE * TILE);
    for (let i = 0; i < h.length; i++) {
      h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    }
    return h;
  } catch {
    return null;
  }
}

function showReadout(info, label) {
  const box = document.getElementById('readout');
  box.hidden = false;
  if (!info) {
    document.getElementById('ro-slope').textContent = '–';
    document.getElementById('ro-aspect').textContent = 'ni podatkov';
    document.getElementById('ro-elev').textContent = '–';
    document.getElementById('ro-label').textContent = label;
    return;
  }
  document.getElementById('ro-slope').textContent = Math.round(info.slope);
  document.getElementById('ro-aspect').textContent = info.aspect;
  document.getElementById('ro-elev').textContent = Math.round(info.elevation);
  document.getElementById('ro-label').textContent = info.lidar ? label : `${label} · izven LiDAR`;
}

function setPoint(map, lng, lat) {
  map.getSource('point').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
  });
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

function buildLegend(classes) {
  const el = document.getElementById('legend');
  classes.forEach((c, i) => {
    const next = classes[i + 1];
    const div = document.createElement('div');
    div.style.background = c.color;
    div.textContent = next ? `${c.min}–${next.min}°` : `>${c.min}°`;
    el.appendChild(div);
  });
}

function wireControls(map) {
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('panel-toggle');
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  document.getElementById('opacity').addEventListener('input', ev => {
    whenReady(() => map.setPaintProperty('slope', 'raster-opacity', Number(ev.target.value)));
  });

  // Spremembe sloga pred naloženim stilom vržejo napako, zato jih po potrebi odložimo.
  const whenReady = fn => (map.isStyleLoaded() ? fn() : map.once('style.load', fn));
  const vis = (id, on) => whenReady(() => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  document.getElementById('t-slope').addEventListener('change', ev => vis('slope', ev.target.checked));
  document.getElementById('t-hillshade').addEventListener('change', ev => vis('hillshade', ev.target.checked));

  document.getElementById('t-3d').addEventListener('change', ev => whenReady(() => {
    if (ev.target.checked) {
      map.setTerrain({ source: 'terrainDem', exaggeration: 1 });
      map.easeTo({ pitch: 65, bearing: -20, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  }));

  document.querySelectorAll('input[name=base]').forEach(r => r.addEventListener('change', ev => {
    vis('topo', ev.target.value === 'topo');
    vis('osm', ev.target.value === 'osm');
  }));

  if (window.matchMedia('(max-width: 600px)').matches) {
    panel.classList.add('collapsed');
    toggle.setAttribute('aria-expanded', 'false');
  }
}

main();
