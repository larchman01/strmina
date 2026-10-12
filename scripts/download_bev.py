"""Prenos avstrijskega ALS DTM 1 m (BEV, CC BY 4.0) za območje iz regions.json.

BEV deli Avstrijo na liste 50 x 50 km v EPSG:3035, objavljene kot Cloud Optimized GeoTIFF.
Iz vsakega lista preberemo samo izrez, ki pokriva območje, in ga shranimo v
``data/raw/bev/<območje>_<list>.tif``.

Uporaba:
    python scripts/download_bev.py karavanke
"""

import argparse
import json
import math
from pathlib import Path

import rasterio
import requests
from pyproj import Transformer
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "raw" / "bev"
URL_CACHE = ROOT / "data" / "cache" / "bev_urls.json"

BEV_URL = "https://data.bev.gv.at/download/ALS/DTM/{date}/ALS_DTM_CRS3035RES50000m{tile}.tif"
# Datum stanja je v poti in se med listi razlikuje; poskusimo od najnovejšega.
BEV_DATES = ["20250915", "20240915", "20230915", "20220915", "20210915", "20200915", "20190915"]
TILE_M = 50000
MARGIN_M = 50

to_3035 = Transformer.from_crs(3794, 3035, always_xy=True)


def bbox_3035(bbox_d96):
    xmin, ymin, xmax, ymax = bbox_d96
    xs, ys = [], []
    for i in range(11):
        for x, y in [(xmin + (xmax - xmin) * i / 10, ymin), (xmin + (xmax - xmin) * i / 10, ymax),
                     (xmin, ymin + (ymax - ymin) * i / 10), (xmax, ymin + (ymax - ymin) * i / 10)]:
            ex, ey = to_3035.transform(x, y)
            xs.append(ex)
            ys.append(ey)
    return min(xs) - MARGIN_M, min(ys) - MARGIN_M, max(xs) + MARGIN_M, max(ys) + MARGIN_M


def tile_url(tile, cache):
    if tile in cache:
        return cache[tile]
    for date in BEV_DATES:
        url = BEV_URL.format(date=date, tile=tile)
        if requests.head(url, timeout=30).status_code == 200:
            cache[tile] = url
            return url
    cache[tile] = None  # list ne obstaja (npr. v celoti izven Avstrije)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("region", help="id območja iz scripts/regions.json")
    args = ap.parse_args()

    regions = {r["id"]: r for r in json.loads((ROOT / "scripts" / "regions.json").read_text(encoding="utf-8"))}
    region = regions[args.region]
    x0, y0, x1, y1 = bbox_3035(region["bbox_d96"])

    cache = json.loads(URL_CACHE.read_text()) if URL_CACHE.exists() else {}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2")
    with env:
        for ty in range(math.floor(y0 / TILE_M) * TILE_M, math.ceil(y1 / TILE_M) * TILE_M, TILE_M):
            for tx in range(math.floor(x0 / TILE_M) * TILE_M, math.ceil(x1 / TILE_M) * TILE_M, TILE_M):
                tile = f"N{ty}E{tx}"
                url = tile_url(tile, cache)
                if not url:
                    print(f"  {tile}: ni lista")
                    continue
                dest = OUT_DIR / f"{region['id']}_{tile}.tif"
                if dest.exists():
                    print(f"  {dest.name} že obstaja")
                    continue
                with rasterio.open("/vsicurl/" + url) as src:
                    win = from_bounds(max(x0, tx), max(y0, ty), min(x1, tx + TILE_M), min(y1, ty + TILE_M), src.transform)
                    win = win.round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
                    print(f"  {tile}: izrez {win.width} x {win.height} ...", flush=True)
                    data = src.read(1, window=win)
                    profile = src.profile | {
                        "width": win.width, "height": win.height, "transform": src.window_transform(win),
                        "compress": "deflate", "predictor": 3, "tiled": True, "blockxsize": 512, "blockysize": 512,
                    }
                    with rasterio.open(dest, "w", **profile) as dst:
                        dst.write(data, 1)
                    valid = (data != src.nodata).mean() * 100
                    print(f"    -> {dest.name} ({dest.stat().st_size // 2**20} MB, {valid:.0f} % s podatki)")

    URL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    URL_CACHE.write_text(json.dumps(cache, indent=2))


if __name__ == "__main__":
    main()
