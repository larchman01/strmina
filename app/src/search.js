// Iskanje brez povezave po vrhovih, kočah, sedlih in krajih iz OSM; ob malo zadetkih še Photon (splet).
const PHOTON = 'https://photon.komoot.io/api/';
const MAX_RESULTS = 12;
const TYPE_WEIGHT = { city: 9, peak: 8, hut: 7, town: 6, saddle: 4, village: 3 };
export const TYPE_LABEL = {
  peak: 'vrh', hut: 'koča', saddle: 'sedlo', city: 'mesto', town: 'mesto', village: 'vas', web: 'splet',
};
const TYPE_ICON = { peak: '▲', hut: '⌂', saddle: '⌒', city: '●', town: '●', village: '•', web: '⌕' };

export const normalize = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export class Search {
  constructor({ input, clear, list }, places, onPick) {
    this.input = input;
    this.clear = clear;
    this.list = list;
    this.onPick = onPick;
    this.index = places.map(p => ({ p, n: normalize(p.name), words: normalize(p.name).split(/[\s\-–/]+/) }));
    this.webAbort = null;
    this.timer = 0;

    input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 120);
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

  local(q) {
    const out = [];
    for (const it of this.index) {
      let s = 0;
      if (it.n === q) s = 100;
      else if (it.n.startsWith(q)) s = 80;
      else if (it.words.some(w => w.startsWith(q))) s = 60;
      else if (q.length >= 3 && it.n.includes(q)) s = 30;
      if (!s) continue;
      out.push({ p: it.p, s: s + (TYPE_WEIGHT[it.p.type] ?? 0) + (it.p.ele ?? 0) / 1000 });
    }
    return out.sort((a, b) => b.s - a.s).slice(0, MAX_RESULTS).map(r => r.p);
  }

  async web(q) {
    this.webAbort?.abort();
    this.webAbort = new AbortController();
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lat=46.15&lon=14.99`;
    const res = await fetch(url, { signal: this.webAbort.signal });
    const json = await res.json();
    return json.features.map(f => ({
      name: f.properties.name ?? q,
      type: 'web',
      detail: [f.properties.city, f.properties.country].filter(Boolean).join(', '),
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      ele: null,
    }));
  }

  async run() {
    const raw = this.input.value.trim();
    this.clear.hidden = !raw;
    if (!raw) return this.close();
    const q = normalize(raw);
    const results = this.local(q);
    this.render(results);

    if (results.length < 3 && q.length >= 3 && navigator.onLine) {
      try {
        const web = await this.web(raw);
        if (normalize(this.input.value.trim()) === q) this.render(results, web);
      } catch {
        /* brez povezave ali prekinjeno */
      }
    }
  }

  render(local, web = []) {
    const items = [...local, ...web];
    this.list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Ni zadetkov';
      this.list.append(li);
    }
    items.forEach((p, i) => {
      if (i === local.length && web.length) {
        const h = document.createElement('li');
        h.className = 'section';
        h.textContent = 'Spletni zadetki';
        this.list.append(h);
      }
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = '<span class="ico"></span><span class="nm"></span><span class="meta"></span>';
      li.querySelector('.ico').textContent = TYPE_ICON[p.type] ?? '•';
      li.querySelector('.nm').textContent = p.name;
      li.querySelector('.meta').textContent = [TYPE_LABEL[p.type], p.ele != null ? `${p.ele} m` : p.detail]
        .filter(Boolean)
        .join(' · ');
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
