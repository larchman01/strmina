"""Izvoz krajev za oznake, iskanje in kartice: OSM (Overpass) + gorovja iz Wikidata.

Rezultat ``app/public/data/places.json``:
    {
      "v": 2,
      "labels": [...],             # tabela nizov za skupine in gorovja
      "places": [[ime, tip, lon, lat, višina|null, skupina|-1, gorovje|-1, država, [vzdevki]|0], ...],
      "areas":  [[ime, -, zahod, jug, vzhod, sever, najvišji_kraj|-1, gorovje|-1, št_vrhov], ...]
    }
Država je "" za Slovenijo, sicer ISO koda (AT, IT, HR, HU).

Uporaba:
    python scripts/osm.py
"""

import argparse
import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "data" / "places.json"
CACHE = ROOT / "data" / "cache" / "osm"
REFRESH = False
UA = {"User-Agent": "strmina/0.1 (github.com/larchman01/strmina)"}
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
BBOX = (45.40, 13.30, 46.95, 16.65)  # J, Z, S, V – Slovenija z obmejnim pasom
COUNTRIES = ["SI", "AT", "IT", "HR", "HU"]

PLACE_FILTERS = """
  node["natural"="peak"]["name"]{b};
  node["natural"="saddle"]["name"]{b};
  node["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"]{b};
  way["tourism"="alpine_hut"]["name"]{b};
  node["place"~"^(city|town|village)$"]["name"]{b};
"""
NAME_KEYS = ["name:sl", "name", "name:de", "name:it", "alt_name", "alt_name:sl", "old_name", "loc_name", "short_name"]

# Splošni nivoji hierarhije Wikidata, ki so preširoki za prikaz »gorovja«.
SUPER_RANGES = {
    "Alpe", "Vzhodne Alpe", "Južne apneniške Alpe", "Centralne Vzhodne Alpe", "Karawanken und Bachergebirge",
    "Julijske Alpe in Predalpe", "Koroško-slovenske Alpe", "Koroško-štajerske Alpe", "Severovzhodne Slovenske Predalpe",
    "Štajerske Predalpe", "Dinarsko gorovje", "Dinarsko gorje", "Krške Alpe", "Severne apneniške Alpe",
}
INHERIT_RANGE_M = 3000  # vrh brez Wikidata podeduje skupino najbližjega vrha z zapisom
RIDGE_MAX_M = 600       # ali greben/masiv iz OSM, če je bližje od tega


def cached(kind, query, fetch):
    """Odgovore shranimo v data/cache/osm, da so ponovni zagoni hitri (--refresh jih osveži)."""
    path = CACHE / f"{kind}-{hashlib.sha1(query.encode()).hexdigest()[:12]}.json"
    if path.exists() and not REFRESH:
        return json.loads(path.read_text(encoding="utf-8"))
    data = fetch(query)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def overpass(query):
    return cached("overpass", query, _overpass)


def _overpass(query):
    last = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": query}, headers=UA, timeout=300)
            r.raise_for_status()
            data = r.json()
            # ob prekoračenem času Overpass vrne 200 z opombo in delnimi (ali nobenimi) podatki
            if "error" in data.get("remark", "").lower() or "timed out" in data.get("remark", "").lower():
                raise ValueError(data["remark"])
            return data["elements"]
        except (requests.RequestException, ValueError) as e:
            last = e
            print(f"  {url}: {e}")
    raise SystemExit(f"Noben Overpass strežnik ni odgovoril ({last}) - poskusi kasneje.")


def bbox_parts(rows=2, cols=3):
    s, w, n, e = BBOX
    for i in range(rows):
        for j in range(cols):
            yield (s + (n - s) * i / rows, w + (e - w) * j / cols, s + (n - s) * (i + 1) / rows, w + (e - w) * (j + 1) / cols)


def overpass_split(make_query):
    """Poizvedbo razdeli na podokvirje (manjše poizvedbe Overpass ob obremenitvi lažje uspejo)."""
    out = {}
    for part in bbox_parts():
        for e in overpass(make_query("({:.4f},{:.4f},{:.4f},{:.4f})".format(*part))):
            out[(e["type"], e["id"])] = e
    return list(out.values())


def sparql(query):
    return cached("sparql", query, _sparql)


def _sparql(query):
    r = requests.get("https://query.wikidata.org/sparql", params={"query": query, "format": "json"}, headers=UA, timeout=300)
    r.raise_for_status()
    return r.json()["results"]["bindings"]


def qid(uri):
    return uri.rsplit("/", 1)[1]


def dist_m(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def seg_dist_m(p, a, b):
    k = math.cos(math.radians(p[1])) * 111320
    px, py, ax, ay, bx, by = p[0] * k, p[1] * 111320, a[0] * k, a[1] * 111320, b[0] * k, b[1] * 111320
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def classify(tags):
    if tags.get("natural") == "peak":
        return "peak"
    if tags.get("natural") == "saddle":
        return "saddle"
    if tags.get("tourism") in ("alpine_hut", "wilderness_hut"):
        return "hut"
    return tags.get("place", "place")


def parse_ele(value):
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)", value or "")
    return round(float(m.group(1).replace(",", "."))) if m else None


def names_of(tags):
    """Prikazno ime (slovensko, če obstaja) in vsi ostali zapisi imena za iskanje."""
    variants = []
    for k in NAME_KEYS:
        for v in (tags.get(k) or "").split(";"):
            for part in v.split(" / "):
                part = part.strip()
                if part and part not in variants:
                    variants.append(part)
    if not variants:
        return None, []
    display = re.split(r" / |;", tags.get("name:sl") or tags["name"])[0].strip()
    return display, [v for v in variants if v != display]


def main():
    global REFRESH
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ponovno prenesi OSM in Wikidata")
    REFRESH = ap.parse_args().refresh
    b = "({},{},{},{})".format(*BBOX)

    print("OSM: kraji ...")
    elements = overpass_split(lambda bb: f"[out:json][timeout:180];({PLACE_FILTERS.format(b=bb)});out center tags;")
    print("OSM: grebeni in masivi ...")
    ridges = overpass_split(lambda bb: f'[out:json][timeout:180];way["natural"~"^(mountain_range|ridge|massif|arete)$"]["name"]{bb};out geom tags;')

    print("OSM: države ...")
    country_of = {}
    for cc in COUNTRIES:
        for e in overpass_split(lambda bb: f'[out:json][timeout:180];area["ISO3166-1"="{cc}"]["admin_level"="2"]->.a;'
                                           f'({PLACE_FILTERS.format(b="(area.a)" + bb)});out ids;'):
            country_of[(e["type"], e["id"])] = cc

    print("Wikidata: gorovja ...")
    rows = sparql(f"""SELECT ?item ?range WHERE {{ SERVICE wikibase:box {{ ?item wdt:P625 ?loc .
      bd:serviceParam wikibase:cornerWest "Point({BBOX[1]} {BBOX[0]})"^^geo:wktLiteral .
      bd:serviceParam wikibase:cornerEast "Point({BBOX[3]} {BBOX[2]})"^^geo:wktLiteral . }}
      ?item wdt:P4552 ?range . }}""")
    item_ranges = defaultdict(list)
    for r in rows:
        item_ranges[qid(r["item"]["value"])].append(qid(r["range"]["value"]))
    seeds = " ".join(f"wd:{q}" for q in {q for v in item_ranges.values() for q in v})
    rows = sparql(f"""SELECT ?r ?rLabel ?p WHERE {{ VALUES ?s {{ {seeds} }} ?s wdt:P4552* ?r .
      OPTIONAL {{ ?r wdt:P4552 ?p }} SERVICE wikibase:label {{ bd:serviceParam wikibase:language "sl,en,de". }} }}""")
    range_label, range_parent = {}, {}
    for r in rows:
        q = qid(r["r"]["value"])
        lbl = r["rLabel"]["value"]
        range_label[q] = lbl[:1].upper() + lbl[1:]  # »osrednje Kamniško-…« -> »Osrednje Kamniško-…«
        if "p" in r:
            range_parent.setdefault(q, qid(r["p"]["value"]))

    def chain(q):
        out, seen = [], set()
        while q and q not in seen:
            seen.add(q)
            out.append(range_label.get(q, q))
            q = range_parent.get(q)
        return out

    def group_major(q):
        c = [n for n in chain(q) if not re.fullmatch(r"Q\d+", n)]
        below = [n for n in c if n not in SUPER_RANGES]
        if not below:
            return None, None
        return below[0], below[-1]

    # --- kraji ---
    places = []
    for e in elements:
        tags = e.get("tags", {})
        name, aliases = names_of(tags)
        lon = e.get("lon", e.get("center", {}).get("lon"))
        lat = e.get("lat", e.get("center", {}).get("lat"))
        if not name or lon is None:
            continue
        group = major = None
        if tags.get("wikidata") in item_ranges:
            group, major = group_major(item_ranges[tags["wikidata"]][0])
        places.append({
            "name": name, "aliases": aliases, "type": classify(tags), "lon": round(lon, 5), "lat": round(lat, 5),
            "ele": parse_ele(tags.get("ele")), "group": group, "major": major,
            "country": country_of.get((e["type"], e["id"]), ""), "prominence": parse_ele(tags.get("prominence")),
        })

    # podvojeni zapisi (vozlišče in pot iste koče ipd.)
    seen, unique = set(), []
    for p in places:
        key = (p["name"], p["type"], round(p["lon"], 3), round(p["lat"], 3))
        if key not in seen:
            seen.add(key)
            unique.append(p)
    places = unique

    # vrhovi brez Wikidata podedujejo skupino najbližjega vrha z zapisom; sicer bližnji greben iz OSM
    anchored = [p for p in places if p["major"] and p["type"] == "peak"]
    cell = defaultdict(list)
    for p in anchored:
        cell[(int(p["lon"] * 20), int(p["lat"] * 30))].append(p)
    pad = RIDGE_MAX_M / 70000  # ~ v stopinjah
    ridge_lines = []
    for w in ridges:
        if not w.get("geometry"):
            continue
        line = [(g["lon"], g["lat"]) for g in w["geometry"]]
        xs, ys = [c[0] for c in line], [c[1] for c in line]
        ridge_lines.append((w["tags"].get("name:sl") or w["tags"]["name"].split(" / ")[0], line,
                            (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)))
    for p in places:
        if p["type"] not in ("peak", "saddle", "hut"):
            continue
        if not p["major"]:
            cx, cy = int(p["lon"] * 20), int(p["lat"] * 30)
            best = min((q for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in cell[(cx + dx, cy + dy)]),
                       key=lambda q: dist_m((p["lon"], p["lat"]), (q["lon"], q["lat"])), default=None)
            if best and dist_m((p["lon"], p["lat"]), (best["lon"], best["lat"])) <= INHERIT_RANGE_M:
                p["group"], p["major"] = best["group"], best["major"]
        near = None
        for name, line, bb in ridge_lines:
            if not (bb[0] <= p["lon"] <= bb[2] and bb[1] <= p["lat"] <= bb[3]):
                continue
            d = min(seg_dist_m((p["lon"], p["lat"]), a, c) for a, c in zip(line, line[1:])) if len(line) > 1 else 1e9
            if d <= RIDGE_MAX_M and (near is None or d < near[0]):
                near = (d, name)
        if near and not p["group"] and near[1] not in (p["name"], p["major"]):
            p["group"] = near[1]
        if p["group"] == p["major"]:
            p["group"] = None

    # Slovenija se ne izpisuje; kraji brez države (rob poizvedb) dobijo državo najbližjega kraja
    known = defaultdict(list)
    for p in places:
        if p["country"]:
            known[(int(p["lon"] * 20), int(p["lat"] * 30))].append(p)
    for p in places:
        if not p["country"]:
            cx, cy = int(p["lon"] * 20), int(p["lat"] * 30)
            best = min((q for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in known[(cx + dx, cy + dy)]),
                       key=lambda q: dist_m((p["lon"], p["lat"]), (q["lon"], q["lat"])), default=None)
            p["country"] = best["country"] if best else "SI"
    for p in places:
        if p["country"] == "SI":
            p["country"] = ""

    # --- območja za iskanje: skupine in gorovja z najvišjim vrhom ---
    members = defaultdict(list)
    for i, p in enumerate(places):
        if p["type"] != "peak":
            continue
        for n in {p["group"], p["major"]} - {None}:
            members[n].append(i)
    for name, *_ in ridge_lines:
        members.setdefault(name, [])
    areas = []
    for name, idx in members.items():
        if not idx:
            continue
        pts = [places[i] for i in idx]
        top = max(idx, key=lambda i: places[i]["ele"] or 0)
        major = places[top]["major"] if places[top]["major"] != name else None
        areas.append({"name": name, "bbox": [min(p["lon"] for p in pts), min(p["lat"] for p in pts),
                                             max(p["lon"] for p in pts), max(p["lat"] for p in pts)],
                      "top": top, "major": major, "n": len(idx)})

    # --- zapis ---
    labels = sorted({p["group"] for p in places if p["group"]} | {p["major"] for p in places if p["major"]}
                    | {a["major"] for a in areas if a["major"]})
    li = {n: i for i, n in enumerate(labels)}
    out = {
        "v": 2,
        "labels": labels,
        "places": [[p["name"], p["type"], p["lon"], p["lat"], p["ele"], li.get(p["group"], -1), li.get(p["major"], -1),
                    p["country"], p["aliases"] or 0] for p in places],
        "areas": [[a["name"], "", *[round(v, 4) for v in a["bbox"]], a["top"], li.get(a["major"], -1), a["n"]]
                  for a in sorted(areas, key=lambda a: -a["n"])],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    counts = defaultdict(int)
    for p in places:
        counts[p["type"]] += 1
    with_range = sum(1 for p in places if p["type"] == "peak" and p["major"])
    print(f"{len(places)} krajev, {len(areas)} območij -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    print("  " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))
    print(f"  vrhov z gorovjem: {with_range} / {counts['peak']}")


if __name__ == "__main__":
    main()
