import { Marker } from 'maplibre-gl';

const MAX_LABELS = 40;
const STEM_PX = 34;
const BOX_H = 36;
const PAD = 6;
const DIST_PENALTY_M_PER_KM = 18; // bližnji vrhovi imajo prednost pred oddaljenimi višjimi

/** 3D oznake vrhov: napis nad vrhom z navpično črto, pritrjen na teren. */
export class PeakLabels {
  /** getInsets() vrne {top, right} v px – površino pod iskalno vrstico in gumbi, kamor oznak ne postavljamo. */
  constructor(map, places, onSelect, getInsets = () => ({ top: 0, right: 0 })) {
    this.map = map;
    this.onSelect = onSelect;
    this.getInsets = getInsets;
    this.peaks = places
      .filter(p => p.type === 'peak')
      .map(p => ({ ...p, labelW: Math.max(p.name.length, 6) * 7.2 + 22 }));
    this.markers = new Map(); // id -> Marker
    this.pinned = null; // vrh, ki ga je uporabnik izbral, je vedno prikazan

    map.on('moveend', () => this.update());
    map.on('terrain', () => this.update());
    map.once('idle', () => this.update());
  }

  pin(peak) {
    this.pinned = peak;
    this.update();
  }

  update() {
    const map = this.map;
    const canvas = map.getCanvas();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const center = map.getCenter();
    const b = map.getBounds();
    const kmPerDegLon = 111.32 * Math.cos((center.lat * Math.PI) / 180);
    const inset = this.getInsets();

    const candidates = [];
    for (const p of this.peaks) {
      if (p.lng < b.getWest() || p.lng > b.getEast() || p.lat < b.getSouth() || p.lat > b.getNorth()) continue;
      const pt = map.project([p.lng, p.lat]);
      const halfW = p.labelW / 2;
      if (pt.x - halfW < 4 || pt.x + halfW > W - inset.right || pt.y - BOX_H - STEM_PX < inset.top || pt.y > H) continue;
      const distKm = Math.hypot((p.lng - center.lng) * kmPerDegLon, (p.lat - center.lat) * 111.32);
      const score = (p.ele ?? 0) - distKm * DIST_PENALTY_M_PER_KM + (p === this.pinned ? 1e6 : 0);
      candidates.push({ p, pt, score });
    }
    candidates.sort((a, b2) => b2.score - a.score);

    const placed = [];
    const chosen = new Set();
    for (const { p, pt } of candidates) {
      const rect = [pt.x - p.labelW / 2 - PAD, pt.y - STEM_PX - BOX_H - PAD, pt.x + p.labelW / 2 + PAD, pt.y];
      if (p !== this.pinned && placed.some(r => rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1])) continue;
      placed.push(rect);
      chosen.add(p.id);
      if (!this.markers.has(p.id)) this.markers.set(p.id, this.createMarker(p));
      if (placed.length >= MAX_LABELS) break;
    }

    for (const [id, marker] of this.markers) {
      if (!chosen.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
    for (const [id, marker] of this.markers) {
      marker.getElement().classList.toggle('pinned', this.pinned?.id === id);
    }
  }

  createMarker(p) {
    const el = document.createElement('div');
    el.className = 'peak';
    el.innerHTML = '<div class="peak-box"><b></b><span></span></div><div class="peak-stem"></div><div class="peak-dot"></div>';
    el.querySelector('b').textContent = p.name;
    el.querySelector('span').textContent = p.ele != null ? `${p.ele} m` : '';
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      this.onSelect(p);
    });
    return new Marker({ element: el, anchor: 'bottom', opacityWhenCovered: 0, subpixelPositioning: true })
      .setLngLat([p.lng, p.lat])
      .addTo(this.map);
  }
}
