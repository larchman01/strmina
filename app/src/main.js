import { Map as MapLibre, Marker, setWorkerUrl, addProtocol } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Dem, fetchLocalPng, tileInRegions } from './dem.js';
import { loadBaseStyle, composeStyle } from './basemap.js';
import { PeakLabels } from './peaks.js';
import { Search } from './search.js';
import { PlaceCard } from './card.js';
import { Locator } from './location.js';

const BASE_URL = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
const SLOVENIA = [[12.9, 45.1], [17.0, 47.2]];
// Prvi zagon: pregled vseh LiDAR območij. Kasneje nadaljujemo, kjer je uporabnik končal.
const OVERVIEW_PITCH = 40;
const CAMERA_KEY = 'strmina.camera';
const REGION_TAP_MAX_ZOOM = 11.5; // pod to povečavo tap na območje odleti tja
const POINT_TAP_MIN_ZOOM = 10; // od daleč tap ne odpre kartice z naklonom
const LEGEND_MIN_ZOOM = 11.5;

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

function savedCamera() {
  try {
    const c = JSON.parse(localStorage.getItem(CAMERA_KEY));
    return c && Array.isArray(c.center) ? c : null;
  } catch {
    return null;
  }
}

function saveCamera(map) {
  try {
    const c = map.getCenter();
    localStorage.setItem(CAMERA_KEY, JSON.stringify({
      center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
    }));
  } catch {
    /* zasebni način ipd. */
  }
}

/**
 * slope://{z}/{x}/{y}: ploščice naklonov iz aplikacije. Območja so razpršena, zato za ploščice
 * izven njih (ali brez strmega terena) vrnemo prosojno sliko namesto napake 404.
 */
async function registerSlopeProtocol(meta) {
  const canvas = new OffscreenCanvas(1, 1);
  canvas.getContext('2d'); // brez konteksta convertToBlob vrže napako
  const empty = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  addProtocol('slope', async (params, abortController) => {
    const [z, x, y] = params.url.slice('slope://'.length).split('/').map(Number);
    if (!tileInRegions(meta, z, x, y)) return { data: empty };
    try {
      const png = await fetchLocalPng(`${BASE_URL}tiles/slope/${z}/${x}/${y}.png`, abortController.signal);
      if (png) return { data: png };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    return { data: empty };
  });
}

/**
 * Bolj prizanesljiva gesta za nagib z dvema prstoma. Privzeto MapLibre odloči po 2 px premika,
 * prsta se morata gibati skoraj navpično (do 45°) in ležati skoraj vodoravno drug ob drugem –
 * na telefonu se gesta zato pogosto prepozna kot zoom. Poseže v interne metode TwoFingersTouchPitchHandler
 * (maplibre-gl 6.x); če jih ni, ostane privzeto obnašanje.
 */
const PITCH_DECIDE_PX = 5;
const PITCH_MAX_MOVE_SLANT = 0.6; // |dx| / |dy| – do ~59° od navpičnice
const PITCH_MAX_FINGER_SLANT = 1.7; // |dy| / |dx| med prstoma – do ~60° od vodoravnice
const PITCH_LAG_MS = 150;

function relaxTouchPitch(map) {
  const h = map.touchPitch;
  if (typeof h?._start !== 'function' || typeof h?.gestureBeginsVertically !== 'function') return;
  h._start = function (points) {
    this._lastPoints = points;
    const d = points[0].sub(points[1]);
    if (Math.abs(d.y) > Math.abs(d.x) * PITCH_MAX_FINGER_SLANT) this._valid = false; // prsta eden nad drugim
  };
  h.gestureBeginsVertically = function (a, b, timeStamp) {
    if (this._valid !== undefined) return this._valid;
    const movedA = a.mag() >= PITCH_DECIDE_PX;
    const movedB = b.mag() >= PITCH_DECIDE_PX;
    if (!movedA && !movedB) return undefined;
    if (!movedA || !movedB) {
      this._firstMove ??= timeStamp;
      return timeStamp - this._firstMove < PITCH_LAG_MS ? undefined : false;
    }
    const vertical = v => Math.abs(v.x) < Math.abs(v.y) / PITCH_MAX_MOVE_SLANT;
    return a.y > 0 === b.y > 0 && vertical(a) && vertical(b);
  };
}

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

async function main() {
  const [meta, coverage, rawPlaces, base] = await Promise.all([
    loadJson('data/meta.json'),
    loadJson('data/coverage.geojson', { type: 'FeatureCollection', features: [] }),
    loadJson('data/places.json', []),
    loadBaseStyle(),
  ]);
  const places = rawPlaces.map(([name, type, lng, lat, ele], id) => ({ id, name, type, lng, lat, ele }));

  const dem = new Dem(meta, coverage, BASE_URL);
  dem.registerProtocol();
  await registerSlopeProtocol(meta);

  const { style, baseLayerIds } = composeStyle(base, meta, coverage);
  const map = new MapLibre({
    container: 'map',
    style,
    ...(savedCamera() ?? {
      bounds: meta.bounds,
      pitch: OVERVIEW_PITCH,
      fitBoundsOptions: { padding: { top: 90, bottom: 60, left: 30, right: 70 }, maxZoom: 11 },
    }),
    maxPitch: 80,
    maxBounds: SLOVENIA,
    attributionControl: { compact: true },
  });
  // Kompaktna atribucija je ob zagonu razprta in na telefonu prekrije pol zaslona.
  map.once('load', () => document.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
  map.on('moveend', () => saveCamera(map));
  relaxTouchPitch(map);
  window.strmina = { map, dem }; // za razhroščevanje

  let userPos = null;
  let pickMarker = null;
  const card = new PlaceCard({
    el: $('card'),
    meta,
    dem,
    places,
    getUserPos: () => userPos,
    toast,
    onClose: () => {
      pickMarker?.remove();
      labels.pin(null);
    },
  });
  const markPoint = (lng, lat) => {
    pickMarker ??= new Marker({ element: Object.assign(document.createElement('div'), { className: 'pick' }) });
    pickMarker.setLngLat([lng, lat]).addTo(map);
  };

  const flyToPlace = p => {
    const zoom = p.type === 'peak' || p.type === 'saddle' || p.type === 'hut' ? 14.2 : 13;
    map.flyTo({ center: [p.lng, p.lat], zoom, pitch: map.getTerrain() ? 60 : 0, duration: 2200, essential: true });
  };
  const flyToRegion = r =>
    map.fitBounds(r.bounds, { pitch: map.getTerrain() ? 55 : 0, bearing: map.getBearing(), padding: 40, duration: 2000 });

  const openPlace = p => {
    pickMarker?.remove();
    labels.pin(p.type === 'peak' ? p : null);
    if (p.type !== 'peak') markPoint(p.lng, p.lat);
    card.openPlace(p);
  };

  const labels = new PeakLabels(map, places, openPlace, () => ({
    top: $('searchbar').getBoundingClientRect().bottom + 6,
    right: window.innerWidth - $('fabs').getBoundingClientRect().left + 6,
  }));

  new Search({ input: $('q'), clear: $('q-clear'), list: $('results') }, places, p => {
    flyToPlace(p);
    openPlace(p);
  });

  map.on('click', ev => {
    $('results').hidden = true;
    $('layers').hidden = true;
    if (map.getZoom() < REGION_TAP_MAX_ZOOM) {
      const hit = map.queryRenderedFeatures(ev.point, { layers: ['coverage-fill'] })[0];
      const region = hit && meta.regions.find(r => r.id === hit.properties.id);
      if (region) return flyToRegion(region);
      if (map.getZoom() < POINT_TAP_MIN_ZOOM) return;
    }
    labels.pin(null);
    markPoint(ev.lngLat.lng, ev.lngLat.lat);
    card.openPoint(ev.lngLat.lng, ev.lngLat.lat);
  });

  const locator = new Locator(
    map,
    pos => {
      userPos = pos;
      if (card.current?.kind === 'gps') card.showGps(pos);
    },
    err => toast(err?.message ?? 'Lokacija ni na voljo'),
  );
  const stopLocating = async () => {
    await locator.stop();
    userPos = null;
    $('btn-locate').classList.remove('on');
  };
  $('btn-locate').addEventListener('click', async () => {
    if (locator.active && card.current?.kind !== 'gps' && userPos) {
      // sledenje že teče: znova pokaži lokacijo
      pickMarker?.remove();
      labels.pin(null);
      card.showGps(userPos);
      map.flyTo({ center: [userPos.lng, userPos.lat], duration: 1200 });
      return;
    }
    if (locator.active) {
      await stopLocating();
      if (card.current?.kind === 'gps') card.close();
      return;
    }
    pickMarker?.remove();
    labels.pin(null);
    card.showGps({ lng: map.getCenter().lng, lat: map.getCenter().lat, accuracy: null });
    $('btn-locate').classList.add('on');
    await locator.start();
  });

  wireLayers(map, baseLayerIds);
  wireCompass(map);
  buildLegends(meta);
  for (const r of meta.regions) {
    const btn = Object.assign(document.createElement('button'), { className: 'chip', textContent: r.name, title: r.source });
    btn.addEventListener('click', () => {
      $('layers').hidden = true;
      flyToRegion(r);
    });
    $('regions').append(btn);
  }

  // Mini legenda samo, ko so nakloni dejansko na zaslonu.
  const updateLegend = () => {
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const visible = $('t-slope').checked && map.getZoom() >= LEGEND_MIN_ZOOM && meta.regions.some(r => intersects(view, r.bounds));
    $('mini-legend').hidden = !visible;
  };
  map.on('moveend', updateLegend);
  $('t-slope').addEventListener('change', updateLegend);
  updateLegend();
}

function wireLayers(map, baseLayerIds) {
  const sheet = $('layers');
  $('btn-layers').addEventListener('click', ev => {
    ev.stopPropagation();
    sheet.hidden = !sheet.hidden;
  });
  $('layers-close').addEventListener('click', () => {
    sheet.hidden = true;
  });

  // map.isStyleLoaded() je false tudi med nalaganjem ploščic, zato si zapomnimo dogodek style.load.
  let styleReady = false;
  const pending = [];
  map.once('style.load', () => {
    styleReady = true;
    pending.splice(0).forEach(fn => fn());
  });
  const whenReady = fn => (styleReady ? fn() : pending.push(fn));
  const vis = (id, on) => whenReady(() => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));

  $('opacity').addEventListener('input', ev => whenReady(() => map.setPaintProperty('slope', 'raster-opacity', Number(ev.target.value))));
  $('t-slope').addEventListener('change', ev => vis('slope', ev.target.checked));
  $('t-hillshade').addEventListener('change', ev => vis('hillshade', ev.target.checked));
  document.querySelectorAll('input[name=base]').forEach(r =>
    r.addEventListener('change', ev => {
      const topo = ev.target.value === 'topo';
      vis('topo', topo);
      for (const id of baseLayerIds) vis(id, !topo);
    }),
  );

  const btn3d = $('btn-3d');
  const sync3d = () => btn3d.classList.toggle('on', !!map.getTerrain());
  whenReady(sync3d);
  btn3d.addEventListener('click', () =>
    whenReady(() => {
      const to3d = !map.getTerrain();
      map.setTerrain(to3d ? { source: 'terrain', exaggeration: 1 } : null);
      map.easeTo({ pitch: to3d ? 60 : 0, bearing: to3d ? map.getBearing() : 0, duration: 900 });
      sync3d();
    }),
  );
}

/** Kompas se pokaže le, ko karta ni obrnjena proti severu; tap jo poravna. */
function wireCompass(map) {
  const btn = $('btn-compass');
  const needle = btn.querySelector('svg');
  const update = () => {
    const bearing = map.getBearing();
    btn.hidden = Math.abs(bearing) < 1;
    needle.style.transform = `rotate(${-bearing}deg)`;
  };
  map.on('rotate', update);
  map.on('load', update);
  btn.addEventListener('click', () => map.easeTo({ bearing: 0, duration: 600 }));
}

function buildLegends(meta) {
  meta.classes.forEach((c, i) => {
    const next = meta.classes[i + 1];
    const full = document.createElement('div');
    full.style.background = c.color;
    full.textContent = next ? `${c.min}–${next.min}°` : `>${c.min}°`;
    $('legend').append(full);

    const mini = document.createElement('span');
    mini.style.background = c.color;
    mini.textContent = next ? c.min : `${c.min}+`;
    $('mini-legend').append(mini);
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
