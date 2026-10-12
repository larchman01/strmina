"""Izvoz imenovanih vrhov, sedel, koč in krajev iz OpenStreetMap (Overpass API).

Rezultat ``app/public/data/places.json`` je kompakten seznam za 3D oznake in iskanje brez povezave:
    [[ime, tip, lon, lat, višina|null], ...]

Uporaba:
    python scripts/osm.py [--bbox JUG ZAHOD SEVER VZHOD]
"""

import argparse
import json
import re
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "data" / "places.json"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Slovenija z obmejnim pasom (Karavanke, Julijci na italijanski strani …)
DEFAULT_BBOX = (45.40, 13.30, 46.95, 16.65)

QUERY = """
[out:json][timeout:180];
(
  node["natural"="peak"]["name"]({bbox});
  node["natural"="saddle"]["name"]({bbox});
  node["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"]({bbox});
  way["tourism"="alpine_hut"]["name"]({bbox});
  node["place"~"^(city|town|village)$"]["name"]({bbox});
);
out center tags;
"""


def classify(tags):
    if tags.get("natural") == "peak":
        return "peak"
    if tags.get("natural") == "saddle":
        return "saddle"
    if tags.get("tourism") in ("alpine_hut", "wilderness_hut"):
        return "hut"
    return tags.get("place", "place")


def parse_ele(value):
    if not value:
        return None
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)", value)
    return round(float(m.group(1).replace(",", "."))) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX, metavar=("S", "W", "N", "E"))
    args = ap.parse_args()

    bbox = ",".join(str(v) for v in args.bbox)
    elements = None
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": QUERY.format(bbox=bbox)},
                              headers={"User-Agent": "strmina/0.1 (github.com/larchman01/strmina)"}, timeout=240)
            r.raise_for_status()
            elements = r.json()["elements"]
            break
        except (requests.RequestException, ValueError) as e:
            print(f"  {url}: {e}")
    if elements is None:
        raise SystemExit("Noben Overpass strežnik ni odgovoril - poskusi kasneje.")

    places = []
    seen = set()
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name:sl") or tags.get("name")
        lon = el.get("lon", el.get("center", {}).get("lon"))
        lat = el.get("lat", el.get("center", {}).get("lat"))
        if not name or lon is None:
            continue
        kind = classify(tags)
        key = (name, kind, round(lon, 3), round(lat, 3))
        if key in seen:
            continue
        seen.add(key)
        places.append([name, kind, round(lon, 5), round(lat, 5), parse_ele(tags.get("ele"))])

    places.sort(key=lambda p: (p[1], -(p[4] or 0)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    counts = {}
    for p in places:
        counts[p[1]] = counts.get(p[1], 0) + 1
    print(f"{len(places)} krajev -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
