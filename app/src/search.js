import { KIND_LABEL, contextOf, distanceM, fmtDist } from './places.js';

// Iskanje brez povezave po vrhovih, kočah, sedlih, krajih in gorstvih (vsa imena in vzdevki),
// s toleranco za tipkarske napake; ob malo zadetkih še Photon (splet).
const PHOTON = 'https://photon.komoot.io/api/';
const MAX_RESULTS = 12;
const TYPE_WEIGHT = { area: 10, city: 9, peak: 8, hut: 7, town: 6, saddle: 4, village: 3 };
const ICONS = {
  peak: '<path d="m3 19 6.5-11 3.5 5.5 2-3L21 19Z"/>',
  area: '<path d="m2 19 5-8 3 4 4-7 8 11Z"/>',
  hut: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/>',
  saddle: '<path d="M3 9c3 0 4 6 9 6s6-6 9-6"/>',
  place: '<circle cx="12" cy="11" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/>',
  web: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
};
const iconFor = t => ICONS[t] ?? ICONS.place;

export const normalize = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const words = s => s.split(/[\s\-–/(),.]+/).filter(Boolean);

/** Levenshteinova razdalja z zgodnjim izstopom nad mejo. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export class Search {
  /** getOrigin(): {lng, lat} – od kod merimo razdaljo (uporabnik ali središče karte). */
  constructor({ input, clear, list }, items, onPick, getOrigin) {
    this.input = input;
    this.clear = clear;
    this.list = list;
    this.onPick = onPick;
    this.getOrigin = getOrigin;
    this.index = items.map(p => {
      const n = normalize(p.name);
      const aliases = p.aliases.map(normalize);
      return {
        p,
        n,
        aliases,
        words: [...new Set([n, ...aliases].flatMap(words))],
        context: [p.group, p.major].filter(Boolean).map(normalize),
      };
    });
    this.webAbort = null;
    this.timer = 0;

    input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 100);
    });
    input.addEventListener('focus', () => input.value && this.run());
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') this.list.querySelector('li[data-i]')?.click();
      if (ev.key === 'Escape') this.close();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      this.close();
      input.focus();
    });
  }

  close() {
    this.list.hidden = true;
    this.list.replaceChildren();
    this.clear.hidden = !this.input.value;
    this.webAbort?.abort();
  }

  score(it, q, qWords) {
    if (it.n === q) return { s: 100 };
    const ai = it.aliases.indexOf(q);
    // vrh, ki nosi ime svojega masiva (Kordeževa glava = »Peca«), je glavni vrh tega imena
    if (ai >= 0) return { s: it.context[0] === q ? 108 : 95, via: it.p.aliases[ai] };
    if (it.n.startsWith(q)) return { s: 80 };
    const ap = it.aliases.findIndex(a => a.startsWith(q));
    if (ap >= 0) return { s: 75, via: it.p.aliases[ap] };
    if (qWords.every(w => it.words.some(x => x.startsWith(w)))) return { s: 60 };
    if (q.length >= 3 && it.n.includes(q)) return { s: 35 };
    if (q.length >= 3 && it.context.some(c => c === q || c.startsWith(q))) return { s: 25, ctx: true };
    return null;
  }

  local(q) {
    const qWords = words(q);
    const origin = this.getOrigin();
    const out = [];
    for (const it of this.index) {
      const m = this.score(it, q, qWords);
      if (m) out.push({ ...m, it });
    }
    // tipkarske napake, ko je dobrih zadetkov malo
    if (q.length >= 4 && out.filter(r => r.s >= 60).length < 5) {
      const max = q.length >= 7 ? 2 : 1;
      for (const it of this.index) {
        if (out.some(r => r.it === it)) continue;
        let best = max + 1;
        for (const w of it.words) {
          best = Math.min(best, editDistance(q, w, max), editDistance(q, w.slice(0, q.length), max));
          if (best === 0) break;
        }
        if (best <= max) out.push({ s: 40 - best * 10, it, fuzzy: true });
      }
    }
    for (const r of out) {
      const p = r.it.p;
      const near = origin ? 4 * Math.exp(-distanceM(origin, p) / 40000) : 0;
      const size = p.type === 'area' ? Math.min(4, Math.log2(1 + p.count)) : 0;
      r.rank = r.s + (TYPE_WEIGHT[p.type] ?? 0) + (p.ele ?? 0) / 1000 + near + size;
    }
    return out.sort((a, b) => b.rank - a.rank).slice(0, MAX_RESULTS);
  }

  async web(q) {
    this.webAbort?.abort();
    this.webAbort = new AbortController();
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lat=46.15&lon=14.99`;
    const res = await fetch(url, { signal: this.webAbort.signal });
    const json = await res.json();
    return json.features.map(f => ({
      it: {
        p: {
          name: f.properties.name ?? q,
          type: 'web',
          detail: [f.properties.city, f.properties.country].filter(Boolean).join(', '),
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          ele: null,
          aliases: [],
        },
      },
    }));
  }

  async run() {
    const raw = this.input.value.trim();
    this.clear.hidden = !raw;
    if (!raw) return this.close();
    const q = normalize(raw);
    const results = this.local(q);
    this.render(results);

    if (results.filter(r => !r.fuzzy).length < 3 && q.length >= 3 && navigator.onLine) {
      try {
        const web = await this.web(raw);
        if (normalize(this.input.value.trim()) === q) this.render(results, web);
      } catch {
        /* brez povezave ali prekinjeno */
      }
    }
  }

  meta(p, via) {
    if (p.type === 'web') return p.detail;
    if (p.type === 'area') return [p.major, `${p.count} ${p.count === 1 ? 'vrh' : p.count === 2 ? 'vrha' : p.count < 5 ? 'vrhovi' : 'vrhov'}`].filter(Boolean).join(' · ');
    const ctx = contextOf(p);
    return [via ? `»${via}«` : null, p.ele != null ? `${p.ele} m` : KIND_LABEL[p.type], ctx[0]].filter(Boolean).join(' · ');
  }

  render(local, web = []) {
    const origin = this.getOrigin();
    const rows = [...local, ...web];
    this.list.replaceChildren();
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Ni zadetkov';
      this.list.append(li);
    }
    rows.forEach((r, i) => {
      if (i === local.length && web.length) {
        const h = document.createElement('li');
        h.className = 'section';
        h.textContent = 'Spletni zadetki';
        this.list.append(h);
      }
      const p = r.it.p;
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = `<svg class="ico" viewBox="0 0 24 24">${iconFor(p.type)}</svg><span class="txt"><span class="nm"></span><span class="meta"></span></span><span class="dist"></span>`;
      li.querySelector('.nm').textContent = p.name;
      li.querySelector('.meta').textContent = this.meta(p, r.via);
      li.querySelector('.dist').textContent = origin && p.type !== 'area' ? fmtDist(distanceM(origin, p)) : '';
      li.addEventListener('click', () => {
        this.input.value = p.name;
        this.close();
        this.input.blur();
        this.onPick(p);
      });
      this.list.append(li);
    });
    this.list.hidden = false;
  }
}
