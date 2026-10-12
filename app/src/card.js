import { ASPECTS } from './dem.js';

const ROSE_RADIUS_M = 300;
const NEAR_HUT_MAX_M = 5000;
const NEAR_PLACE_MAX_M = 1500;

const ICONS = {
  peak: '<path d="m3 19 6.5-11 3.5 5.5 2-3L21 19Z"/>',
  hut: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
  saddle: '<path d="M3 9c3 0 4 6 9 6s6-6 9-6"/>',
  place: '<circle cx="12" cy="11" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/>',
  point: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>',
  gps: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7"/>',
  nav: '<path d="m3 11 18-8-8 18-2-8Z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

const KIND = {
  peak: { label: 'Vrh', icon: 'peak' },
  hut: { label: 'Koča', icon: 'hut' },
  saddle: { label: 'Sedlo', icon: 'saddle' },
  city: { label: 'Mesto', icon: 'place' },
  town: { label: 'Mesto', icon: 'place' },
  village: { label: 'Vas', icon: 'place' },
  web: { label: 'Kraj', icon: 'place' },
  point: { label: 'Točka', icon: 'point' },
  gps: { label: 'Tvoja lokacija', icon: 'gps' },
};

const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function distanceM(a, b) {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371000;
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

const fmtCoord = (lng, lat) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

/** Kartica izbranega kraja ali točke (spodnji list). */
export class PlaceCard {
  constructor({ el, meta, dem, places, getUserPos, toast, onClose }) {
    this.el = el;
    this.meta = meta;
    this.dem = dem;
    this.places = places;
    this.huts = places.filter(p => p.type === 'hut');
    this.peaks = places.filter(p => p.type === 'peak');
    this.getUserPos = getUserPos;
    this.toast = toast;
    this.onClose = onClose;
    this.token = 0; // zavrže zastarele asinhrone rezultate
    this.current = null;
  }

  get open() {
    return !this.el.hidden;
  }

  close() {
    this.el.hidden = true;
    this.current = null;
    this.token++;
    this.onClose?.();
  }

  colorFor(slope) {
    let color = null;
    for (const c of this.meta.classes) if (slope >= c.min) color = c.color;
    return color;
  }

  /** Vrh, koča, sedlo, kraj ali spletni zadetek. */
  async openPlace(p) {
    const showRose = p.type === 'peak' || p.type === 'saddle';
    const sub = [p.ele != null ? `${p.ele} m` : null, p.detail].filter(Boolean);
    this.render({ kind: p.type, name: p.name, sub, at: p, rose: showRose, stats: !showRose });
    const token = this.token;

    const near = this.nearest(p);
    if (near) {
      this.$('.near').innerHTML = `${svg(near.place.type === 'hut' ? 'hut' : 'peak')}<b></b><span></span>`;
      this.$('.near').title = near.label;
      this.$('.near b').textContent = near.place.name;
      this.$('.near span').textContent = fmtDist(near.dist);
    }
    this.$('.near').hidden = !near;

    const info = await this.dem.query(p.lng, p.lat);
    if (token !== this.token) return;
    this.setSource(info);
    if (!showRose) return this.setStats(info);

    const rose = await this.dem.aspectRose(p.lng, p.lat, ROSE_RADIUS_M);
    if (token === this.token) this.setRose(rose);
  }

  /** Poljubna točka na karti. */
  async openPoint(lng, lat) {
    const nearby = this.nearestOf(this.places, { lng, lat }, NEAR_PLACE_MAX_M);
    const name = nearby ? `blizu: ${nearby.place.name}` : 'Izbrana točka';
    this.render({ kind: 'point', name, sub: [], at: { lng, lat }, stats: true });
    const token = this.token;
    const info = await this.dem.query(lng, lat);
    if (token !== this.token) return;
    this.setStats(info);
    this.setSource(info);
  }

  /** Lokacija uporabnika; ob vsakem novem položaju se osvežijo le številke. */
  async showGps(pos) {
    if (this.current?.kind !== 'gps') this.render({ kind: 'gps', name: 'Tvoja lokacija', sub: [], at: pos, stats: true, nav: false });
    this.current.at = pos;
    this.$('.sub').textContent = pos.accuracy != null ? `± ${Math.round(pos.accuracy)} m` : 'iščem GPS …';
    this.$('.coords').textContent = fmtCoord(pos.lng, pos.lat);
    if (pos.accuracy == null) return;
    const token = this.token;
    const info = await this.dem.query(pos.lng, pos.lat);
    if (token !== this.token) return;
    this.setStats(info);
    this.setSource(info);
  }

  // --- izris ---

  $(sel) {
    return this.el.querySelector(sel);
  }

  render({ kind, name, sub, at, rose = false, stats = false, nav = true }) {
    this.token++;
    this.current = { kind, name, at };
    const k = KIND[kind] ?? KIND.point;
    const user = this.getUserPos();
    if (user && kind !== 'gps') sub = [...sub, `${fmtDist(distanceM(user, at))} od tebe`];

    this.el.innerHTML = `
      <div class="card-head">
        <span class="kind">${svg(k.icon)}<span></span></span>
        <button class="icon close" aria-label="Zapri">${svg('close')}</button>
      </div>
      <h2 class="name"></h2>
      <div class="sub"></div>
      <div class="stats" ${stats ? '' : 'hidden'}>
        <div class="stat"><span class="chip"></span><b class="v-slope skel">00°</b><small>naklon</small></div>
        <div class="stat"><b class="v-aspect skel">SV</b><small>ekspozicija</small></div>
        <div class="stat"><b class="v-elev skel">0000 m</b><small>višina</small></div>
      </div>
      <div class="rose-block" ${rose ? '' : 'hidden'}>
        <svg class="rose" viewBox="0 0 100 100" aria-label="Roža ekspozicij"></svg>
        <div class="rose-text">
          <b>Strmine okoli vrha</b>
          <span class="r-steepest skel">najbolj strmo 00° · S</span>
          <span class="r-share skel">nad 30°: 00 % v krogu ${ROSE_RADIUS_M} m</span>
        </div>
      </div>
      <div class="near" hidden></div>
      <div class="card-foot">
        <button class="coords" title="Kopiraj koordinate"></button>
        <span class="src"></span>
        <span class="actions">
          ${nav ? `<button class="act nav" aria-label="Navigacija">${svg('nav')}</button>` : ''}
          <button class="act share" aria-label="Deli">${svg('share')}</button>
        </span>
      </div>`;
    this.$('.kind span').textContent = k.label;
    this.$('.name').textContent = name;
    this.$('.sub').textContent = sub.join(' · ');
    this.$('.coords').textContent = fmtCoord(at.lng, at.lat);
    if (rose) this.drawRose(null);

    this.$('.close').addEventListener('click', () => this.close());
    this.$('.coords').addEventListener('click', () => this.copyCoords());
    this.$('.nav')?.addEventListener('click', () => this.navigate());
    this.$('.share').addEventListener('click', () => this.share());

    this.el.hidden = false;
    this.el.classList.remove('enter');
    void this.el.offsetWidth; // ponovni zagon animacije
    this.el.classList.add('enter');
  }

  setStats(info) {
    const slope = this.$('.v-slope');
    for (const el of this.el.querySelectorAll('.stats .skel')) el.classList.remove('skel');
    if (!info) {
      slope.textContent = '–';
      this.$('.v-aspect').textContent = '–';
      this.$('.v-elev').textContent = '–';
      return;
    }
    slope.textContent = `${Math.round(info.slope)}°`;
    this.$('.v-aspect').textContent = info.aspect;
    this.$('.v-elev').textContent = `${Math.round(info.elevation)} m`;
    this.$('.stats .chip').style.background = this.colorFor(info.slope) ?? 'var(--line)';
  }

  setSource(info) {
    const src = this.$('.src');
    src.textContent = info?.source ? `LiDAR · ${info.source}` : 'grob model';
    src.classList.toggle('coarse', !info?.source);
  }

  setRose(rose) {
    this.drawRose(rose);
    const s = rose.steepest;
    this.$('.r-steepest').textContent = s ? `najbolj strmo ${Math.round(s.slope)}° · ${s.aspect}` : 'ni strmin';
    this.$('.r-share').textContent = `nad 30°: ${Math.round(rose.steepShare * 100)} % v krogu ${rose.radius} m`;
    for (const el of this.el.querySelectorAll('.rose-text .skel')) el.classList.remove('skel');
  }

  /** Dolžina izseka je sorazmerna z naklonom (do 60°), barva je razred naklona. */
  drawRose(rose) {
    const c = 50;
    const R = 36;
    const r0 = 6;
    const MAX_SLOPE = 60;
    const radius = slope => r0 + (R - r0) * Math.min(1, Math.max(0, slope / MAX_SLOPE));
    const xy = (deg, r) => {
      const a = (deg * Math.PI) / 180;
      return [c + r * Math.sin(a), c - r * Math.cos(a)];
    };
    const pt = (deg, r) => xy(deg, r).map(v => v.toFixed(2)).join(' ');

    const rings = [30, 45]
      .map(s => `<circle class="ring" cx="${c}" cy="${c}" r="${radius(s).toFixed(2)}"/>`)
      .join('');
    const wedges = ASPECTS.map((name, i) => {
      const a0 = i * 45 - 22.5 + 1.5;
      const a1 = i * 45 + 22.5 - 1.5;
      const s = rose?.sectors[i];
      const r = rose ? (s?.slope != null ? radius(s.slope) : r0 + 2) : R;
      const fill = !rose ? 'var(--rose-empty)' : s?.slope != null ? this.colorFor(s.slope) ?? 'var(--rose-flat)' : 'var(--rose-empty)';
      const title = s?.slope != null ? `${name}: ${Math.round(s.slope)}°` : name;
      return `<path class="${rose ? '' : 'pending'}" fill="${fill}" d="M ${pt(a0, r0)} L ${pt(a0, r)} A ${r} ${r} 0 0 1 ${pt(a1, r)} L ${pt(a1, r0)} A ${r0} ${r0} 0 0 0 ${pt(a0, r0)} Z"><title>${title}</title></path>`;
    });
    const labels = [['S', 0], ['V', 90], ['J', 180], ['Z', 270]].map(([t, d]) => {
      const [x, y] = xy(d, 45.5);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}">${t}</text>`;
    });
    this.$('.rose').innerHTML = rings + wedges.join('') + labels.join('');
  }

  // --- okolica ---

  nearestOf(list, at, maxM, exclude) {
    let best = null;
    for (const p of list) {
      if (p === exclude) continue;
      const d = distanceM(at, p);
      if (d <= maxM && (!best || d < best.dist)) best = { place: p, dist: d };
    }
    return best;
  }

  nearest(p) {
    if (p.type === 'hut') {
      const n = this.nearestOf(this.peaks, p, NEAR_HUT_MAX_M);
      return n && { ...n, label: 'Najbližji vrh' };
    }
    if (p.type === 'peak' || p.type === 'saddle') {
      const n = this.nearestOf(this.huts, p, NEAR_HUT_MAX_M, p);
      return n && { ...n, label: 'Najbližja koča' };
    }
    return null;
  }

  // --- dejanja ---

  async copyCoords() {
    const { lng, lat } = this.current.at;
    try {
      await navigator.clipboard.writeText(fmtCoord(lng, lat));
      this.toast('Koordinate kopirane');
    } catch {
      this.toast(fmtCoord(lng, lat));
    }
  }

  mapsUrl() {
    const { lng, lat } = this.current.at;
    return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=walking`;
  }

  navigate() {
    window.open(this.mapsUrl(), '_blank', 'noopener');
  }

  async share() {
    const { name, at } = this.current;
    const text = `${name} – ${fmtCoord(at.lng, at.lat)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: name, text, url: this.mapsUrl() });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    await this.copyCoords();
  }
}
