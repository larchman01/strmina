import { Map as MapLibre, NavigationControl, ScaleControl, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Dem, DEM_MAX_ZOOM } from './dem.js';
import { PeakLabels } from './peaks.js';
import { Search, TYPE_LABEL } from './search.js';
import { Locator } from './location.js';

const BASE_URL = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
const SLOVENIA = [[12.9, 45.1], [17.0, 47.2]];
const START = { center: [14.528, 46.288], zoom: 13.3, pitch: 62, bearing: 20 };

const BASEMAPS = {
  topo: {
    tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
};

const $ = id => document.getElementById(id);

// MapLibre išče worker poleg svojega modula, ki ga Vite zapakira drugam.
setWorkerUrl(workerUrl);

async function loadJson(path, fallback) {
  try {
    const res = await fetch(BASE_URL + path);
    return res.ok ? await res.json() : fallback;
  } catch {
    return fallback;
  }
}

function buildStyle(meta) {
  const demSource = { type: 'raster-dem', tiles: ['dem://{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', maxzoom: DEM_MAX_ZOOM };
  return {
    version: 8,
    sky: {
      'sky-color': '#7fb2e5',
      'horizon-color': '#dce8f2',
      'fog-color': '#e4ecf2',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.4,
    },
    terrain: { source: 'terrain', exaggeration: 1 },
    sources: {
      topo: { type: 'raster', tileSize: 256, ...BASEMAPS.topo },
      osm: { type: 'raster', tileSize: 256, ...BASEMAPS.osm },
      terrain: { ...demSource, attribution: 'Višine: GURS CLSS 2023–25, AWS Terrain Tiles' },
      hillshade: demSource,
      slope: {
        type: 'raster',
        tiles: [`${BASE_URL}tiles/slope/{z}/{x}/{y}.png`],
        tileSize: 256,
        minzoom: meta.slope_zooms[0],
        maxzoom: meta.slope_zooms[1],
        bounds: meta.bounds,
        attribution: 'Nakloni: GURS CLSS 2023–25 (CC BY 4.0)',
      },
      coverage: { type: 'geojson', data: `${BASE_URL}data/coverage.geojson` },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9ebe6' } },
      { id: 'topo', type: 'raster', source: 'topo' },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshade',
        paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#2d3a44' },
      },
      { id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': 0.6 } },
      {
        id: 'coverage',
        type: 'line',
        source: 'coverage',
        paint: { 'line-color': '#1f2a33', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.6 },
      },
    ],
  };
}

function slopeColor(meta, slope) {
  let color = null;
  for (const c of meta.classes) if (slope >= c.min) color = c.color;
  return color;
}

async function main() {
  const [meta, rawPlaces] = await Promise.all([loadJson('data/meta.json'), loadJson('data/places.json', [])]);
  const places = rawPlaces.map(([name, type, lng, lat, ele], id) => ({ id, name, type, lng, lat, ele }));

  const dem = new Dem(meta, BASE_URL);
  dem.registerProtocol();

  const map = new MapLibre({
    container: 'map',
    style: buildStyle(meta),
    ...START,
    maxPitch: 80,
    maxBounds: SLOVENIA,
    attributionControl: { compact: true },
  });
  map.addControl(new NavigationControl({ visualizePitch: true, showZoom: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
  // Kompaktna atribucija je ob zagonu razprta in na telefonu prekrije pol zaslona.
  map.once('load', () => document.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
  window.strmina = { map, dem }; // za razhroščevanje

  const readout = new Readout(meta);
  let pointMarker = null;
  const showPoint = async (lng, lat, title, subtitle) => {
    pointMarker ??= new Marker({ element: Object.assign(document.createElement('div'), { className: 'pick' }) });
    pointMarker.setLngLat([lng, lat]).addTo(map);
    readout.loading(title, subtitle);
    readout.show(await dem.query(lng, lat), title, subtitle);
  };

  const flyToPlace = p => {
    const zoom = p.type === 'peak' || p.type === 'saddle' || p.type === 'hut' ? 14.2 : 13;
    map.flyTo({ center: [p.lng, p.lat], zoom, pitch: map.getPitch() > 20 ? 62 : 0, duration: 2200, essential: true });
  };

  const labels = new PeakLabels(
    map,
    places,
    p => {
      labels.pin(p);
      showPoint(p.lng, p.lat, p.name, `vrh${p.ele != null ? ` · ${p.ele} m` : ''}`);
    },
    () => ({
      top: $('searchbar').getBoundingClientRect().bottom + 6,
      right: window.innerWidth - $('fabs').getBoundingClientRect().left + 6,
    }),
  );

  new Search({ input: $('q'), clear: $('q-clear'), list: $('results') }, places, p => {
    if (p.type === 'peak') labels.pin(p);
    flyToPlace(p);
    showPoint(p.lng, p.lat, p.name, [TYPE_LABEL[p.type], p.ele != null ? `${p.ele} m` : p.detail].filter(Boolean).join(' · '));
  });

  map.on('click', ev => {
    $('results').hidden = true;
    labels.pin(null);
    showPoint(ev.lngLat.lng, ev.lngLat.lat, 'Izbrana točka');
  });

  const locator = new Locator(
    map,
    async pos => {
      if (readout.mode !== 'gps') return;
      readout.show(await dem.query(pos.lng, pos.lat), 'Tvoja lokacija', `natančnost ${Math.round(pos.accuracy)} m`);
    },
    err => toast(err?.message ?? 'Lokacija ni na voljo'),
  );
  $('btn-locate').addEventListener('click', async () => {
    if (locator.active) {
      await locator.stop();
      readout.mode = 'point';
      $('btn-locate').classList.remove('on');
      return;
    }
    readout.mode = 'gps';
    pointMarker?.remove();
    readout.loading('Tvoja lokacija', 'iščem GPS …');
    $('btn-locate').classList.add('on');
    await locator.start();
  });

  wireLayers(map);
  buildLegend(meta);
  readout.onClose = () => pointMarker?.remove();
}

class Readout {
  constructor(meta) {
    this.meta = meta;
    this.el = $('readout');
    this.mode = 'point';
    this.onClose = null;
    $('readout-close').addEventListener('click', () => {
      this.el.hidden = true;
      this.onClose?.();
    });
  }

  loading(title, subtitle = '') {
    this.el.hidden = false;
    $('ro-title').textContent = title;
    $('ro-sub').textContent = subtitle;
    $('ro-slope').textContent = '…';
  }

  show(info, title, subtitle = '') {
    this.el.hidden = false;
    $('ro-title').textContent = title;
    $('ro-sub').textContent = subtitle;
    if (!info) {
      $('ro-slope').textContent = '–';
      $('ro-aspect').textContent = '–';
      $('ro-elev').textContent = '–';
      $('ro-src').textContent = 'ni podatkov';
      $('ro-chip').style.background = 'transparent';
      return;
    }
    $('ro-slope').textContent = `${Math.round(info.slope)}°`;
    $('ro-aspect').textContent = info.aspect;
    $('ro-elev').textContent = `${Math.round(info.elevation)} m`;
    $('ro-src').textContent = info.lidar ? 'LiDAR 0,5 m' : 'grob model (izven LiDAR)';
    $('ro-chip').style.background = slopeColor(this.meta, info.slope) ?? 'var(--line)';
  }
}

function wireLayers(map) {
  const sheet = $('layers');
  $('btn-layers').addEventListener('click', () => {
    sheet.hidden = !sheet.hidden;
  });
  $('layers-close').addEventListener('click', () => {
    sheet.hidden = true;
  });

  const whenReady = fn => (map.isStyleLoaded() ? fn() : map.once('style.load', fn));
  const vis = (id, on) => whenReady(() => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));

  $('opacity').addEventListener('input', ev => whenReady(() => map.setPaintProperty('slope', 'raster-opacity', Number(ev.target.value))));
  $('t-slope').addEventListener('change', ev => vis('slope', ev.target.checked));
  $('t-hillshade').addEventListener('change', ev => vis('hillshade', ev.target.checked));
  document.querySelectorAll('input[name=base]').forEach(r =>
    r.addEventListener('change', ev => {
      vis('topo', ev.target.value === 'topo');
      vis('osm', ev.target.value === 'osm');
    }),
  );

  const btn3d = $('btn-3d');
  btn3d.addEventListener('click', () =>
    whenReady(() => {
      const to3d = !map.getTerrain();
      map.setTerrain(to3d ? { source: 'terrain', exaggeration: 1 } : null);
      map.easeTo({ pitch: to3d ? 62 : 0, bearing: to3d ? map.getBearing() : 0, duration: 900 });
      btn3d.textContent = to3d ? '2D' : '3D';
    }),
  );
}

function buildLegend(meta) {
  const el = $('legend');
  meta.classes.forEach((c, i) => {
    const next = meta.classes[i + 1];
    const div = document.createElement('div');
    div.style.background = c.color;
    div.textContent = next ? `${c.min}–${next.min}°` : `>${c.min}°`;
    el.append(div);
  });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

main();
