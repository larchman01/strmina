// Kraji iz data/places.json (v2: z gorovji, državami in vzdevki; v1: le osnovni seznam).

export const COUNTRY = { SI: 'Slovenija', AT: 'Avstrija', IT: 'Italija', HR: 'Hrvaška', HU: 'Madžarska' };

export const KIND_LABEL = {
  peak: 'vrh', hut: 'koča', saddle: 'sedlo', city: 'mesto', town: 'mesto', village: 'vas', area: 'gorstvo', web: 'splet',
};

export function loadPlaces(raw) {
  if (Array.isArray(raw)) {
    const places = raw.map(([name, type, lng, lat, ele], id) => ({ id, name, type, lng, lat, ele, aliases: [] }));
    return { places, areas: [] };
  }
  const L = raw.labels;
  const label = i => (i >= 0 ? L[i] : null);
  const places = raw.places.map(([name, type, lng, lat, ele, g, m, country, aliases], id) => ({
    id, name, type, lng, lat, ele, group: label(g), major: label(m), country, aliases: aliases || [],
  }));
  const areas = raw.areas.map(([name, , w, s, e, n, top, m, count], i) => ({
    id: `a${i}`,
    name,
    type: 'area',
    bbox: [w, s, e, n],
    lng: (w + e) / 2,
    lat: (s + n) / 2,
    top: top >= 0 ? places[top] : null,
    major: label(m),
    count,
    aliases: [],
  }));
  return { places, areas };
}

/** »Kaj je kje«: skupina, gorovje in država (Slovenija se ne izpiše). */
export function contextOf(p) {
  const parts = [];
  for (const v of [p.group, p.major]) if (v && v !== p.name && !parts.includes(v)) parts.push(v);
  if (p.country && p.country !== 'SI') parts.push(COUNTRY[p.country] ?? p.country);
  return parts;
}

export function distanceM(a, b) {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371000;
}

export function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
