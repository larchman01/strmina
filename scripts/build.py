"""Iz prenesenih listov DMR naredi ploščice za spletno karto.

Izhod (v ``app/public/tiles``):
  slope/{z}/{x}/{y}.png   razredi naklona (RGBA), Web Mercator, 256 px
  dem/{z}/{x}/{y}.png     višine v kodiranju Terrarium za 3D teren, senčenje in poizvedbe;
                          izven območja LiDAR dopolnjeno z odprtimi ploščicami AWS Terrain Tiles

Uporaba:
    python scripts/build.py [--smooth 2.0]
"""

import argparse
import io
import json
import math
from pathlib import Path

import laspy
import numpy as np
import requests
from PIL import Image
from pyproj import Transformer
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "app" / "public" / "tiles"
DATA_DIR = ROOT / "app" / "public" / "data"
CACHE_DIR = ROOT / "data" / "cache" / "terrarium"

SRC_RES = 0.5   # mreža DMR v CLSS 2023-25
RES = 1.0       # delovna ločljivost
SHEET = 1000.0

SLOPE_ZOOMS = range(12, 18)
DEM_ZOOMS = range(10, 16)
TILE = 256
WORLD = 20037508.342789244

AWS_TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
FEATHER_M = 60.0  # širina prehoda med LiDAR in AWS višinami

# (spodnja meja v stopinjah, RGBA). Pod prvo mejo je prosojno.
SLOPE_CLASSES = [
    (27, (140, 214, 110, 255)),
    (30, (255, 230, 60, 255)),
    (35, (255, 150, 30, 255)),
    (40, (230, 40, 40, 255)),
    (45, (170, 60, 200, 255)),
]

to_d96 = Transformer.from_crs(3857, 3794, always_xy=True)
to_wgs = Transformer.from_crs(3794, 4326, always_xy=True)


def load_dem():
    files = sorted(RAW_DIR.glob("DMR_*.laz"))
    if not files:
        raise SystemExit("Ni datotek v data/raw - najprej zaženi scripts/download.py")
    sheets = [tuple(int(v) * 1000 for v in f.stem.split("_")[1:3]) for f in files]
    xmin = min(s[0] for s in sheets)
    ymin = min(s[1] for s in sheets)
    xmax = max(s[0] for s in sheets) + SHEET
    ymax = max(s[1] for s in sheets) + SHEET

    n_rows = int((ymax - ymin) / SRC_RES)
    n_cols = int((xmax - xmin) / SRC_RES)
    dem = np.full((n_rows, n_cols), np.nan, dtype=np.float32)
    for f in files:
        las = laspy.read(f)
        col = np.round((np.asarray(las.x) - xmin) / SRC_RES - 0.5).astype(np.int64)
        row = np.round((ymax - np.asarray(las.y)) / SRC_RES - 0.5).astype(np.int64)
        dem[row, col] = np.asarray(las.z, dtype=np.float32)
        print(f"  {f.name}: {len(col):,} točk")

    # 0,5 m -> 1 m (povprečje 2x2)
    f = int(RES / SRC_RES)
    dem = np.nanmean(dem.reshape(n_rows // f, f, n_cols // f, f), axis=(1, 3))

    missing = np.isnan(dem)
    if missing.any():
        print(f"  zapolnjujem {missing.sum():,} manjkajočih celic")
        idx = ndimage.distance_transform_edt(missing, return_distances=False, return_indices=True)
        dem = dem[tuple(idx)]
    return dem.astype(np.float32), (xmin, ymin, xmax, ymax)


def compute_slope(dem, smooth_m):
    # Glajenje: ločljivost 1 m pokaže vsako skalo; za plazovni teren nas zanima pobočje.
    z = ndimage.gaussian_filter(dem, smooth_m / RES) if smooth_m > 0 else dem
    gy, gx = np.gradient(z, RES)
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)


def tile_range(bounds_d96, z):
    xmin, ymin, xmax, ymax = bounds_d96
    xs = np.linspace(xmin, xmax, 20)
    ys = np.linspace(ymin, ymax, 20)
    ex = np.concatenate([xs, xs, np.full(20, xmin), np.full(20, xmax)])
    ey = np.concatenate([np.full(20, ymin), np.full(20, ymax), ys, ys])
    lon, lat = to_wgs.transform(ex, ey)
    n = 2 ** z

    def tx(lo):
        return int((lo + 180) / 360 * n)

    def ty(la):
        r = math.radians(la)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)

    return tx(min(lon)), tx(max(lon)), ty(max(lat)), ty(min(lat))


def tile_pixels_d96(z, x, y):
    res = 2 * WORLD / (TILE * 2 ** z)
    i = np.arange(TILE) + 0.5
    mx = -WORLD + (x * TILE + i) * res
    my = WORLD - (y * TILE + i) * res
    MX, MY = np.meshgrid(mx, my)
    return to_d96.transform(MX, MY)


def sample(grid, bounds_d96, X, Y):
    xmin, _, _, ymax = bounds_d96
    col = (X - xmin) / RES - 0.5
    row = (ymax - Y) / RES - 0.5
    return ndimage.map_coordinates(grid, [row, col], order=1, mode="constant", cval=np.nan)


def classify(slope):
    rgba = np.zeros(slope.shape + (4,), dtype=np.uint8)
    for lower, color in SLOPE_CLASSES:
        rgba[slope >= lower] = color
    return rgba


def fetch_terrarium(z, x, y):
    path = CACHE_DIR / str(z) / str(x) / f"{y}.png"
    if not path.exists():
        r = requests.get(AWS_TERRARIUM.format(z=z, x=x, y=y), timeout=60)
        r.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def encode_terrarium(h):
    v = np.clip(h + 32768, 0, 65535.99)
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - r * 256 - g) * 256)
    return np.dstack([r, g, b]).astype(np.uint8)


def save_png(arr, path, **kw):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path, optimize=True, **kw)


def pixel_size_m(z, bounds):
    _, lat = to_wgs.transform((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)
    return 2 * WORLD / (TILE * 2 ** z) * math.cos(math.radians(lat))


def build_slope_tiles(slope, bounds):
    count = 0
    for z in SLOPE_ZOOMS:
        # Povprečje čez velikost piksla, sicer pri manjših povečavah dobimo šum (aliasing).
        px = pixel_size_m(z, bounds) / RES
        level = ndimage.uniform_filter(slope, size=int(round(px))) if px > 1.5 else slope
        x0, x1, y0, y1 = tile_range(bounds, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                X, Y = tile_pixels_d96(z, x, y)
                s = sample(level, bounds, X, Y)
                if np.all(np.isnan(s)):
                    continue
                rgba = classify(np.nan_to_num(s, nan=0))
                if not rgba[..., 3].any():
                    continue
                # paleta zmanjša velikost datotek ~4x
                img = Image.fromarray(rgba).quantize(colors=len(SLOPE_CLASSES) + 1, method=Image.Quantize.FASTOCTREE)
                p = OUT_DIR / "slope" / str(z) / str(x) / f"{y}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                img.save(p, optimize=True)
                count += 1
        print(f"  slope z{z}: skupaj {count} ploščic")


def build_dem_tiles(dem, bounds):
    xmin, ymin, xmax, ymax = bounds
    count = 0
    for z in DEM_ZOOMS:
        px = pixel_size_m(z, bounds) / RES
        level = ndimage.uniform_filter(dem, size=int(round(px))) if px > 1.5 else dem
        x0, x1, y0, y1 = tile_range(bounds, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                X, Y = tile_pixels_d96(z, x, y)
                lidar = sample(level, bounds, X, Y)
                base = fetch_terrarium(z, x, y)
                edge = np.minimum.reduce([X - xmin, xmax - X, Y - ymin, ymax - Y])
                w = np.clip(edge / FEATHER_M, 0, 1)
                w[np.isnan(lidar)] = 0
                h = w * np.nan_to_num(lidar) + (1 - w) * base
                save_png(encode_terrarium(h), OUT_DIR / "dem" / str(z) / str(x) / f"{y}.png")
                count += 1
        print(f"  dem z{z}: skupaj {count} ploščic")


def write_meta(bounds, smooth_m):
    xmin, ymin, xmax, ymax = bounds
    ring = [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax), (xmin, ymin)]
    coords = [list(map(lambda v: round(v, 6), to_wgs.transform(px, py))) for px, py in ring]
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "coverage.geojson").write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"name": "CLSS 2023-25 DMR"},
                      "geometry": {"type": "Polygon", "coordinates": [coords]}}],
    }), encoding="utf-8")
    (DATA_DIR / "meta.json").write_text(json.dumps({
        "bounds": [min(lons), min(lats), max(lons), max(lats)],
        "bounds_d96": bounds,
        "slope_zooms": [SLOPE_ZOOMS.start, SLOPE_ZOOMS.stop - 1],
        "dem_zooms": [DEM_ZOOMS.start, DEM_ZOOMS.stop - 1],
        "smooth_m": smooth_m,
        "classes": [{"min": lo, "color": "#%02x%02x%02x" % c[:3]} for lo, c in SLOPE_CLASSES],
    }, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smooth", type=float, default=3.0, help="sigma Gaussovega glajenja v metrih")
    args = ap.parse_args()

    print("Berem DMR ...")
    dem, bounds = load_dem()
    print(f"  mreža {dem.shape[1]} x {dem.shape[0]} @ {RES} m, višine {dem.min():.0f}-{dem.max():.0f} m")

    print("Računam naklone ...")
    slope = compute_slope(dem, args.smooth)
    for lo, _ in SLOPE_CLASSES:
        print(f"  >= {lo}°: {np.mean(slope >= lo) * 100:.1f} % površine")

    print("Ploščice naklonov ...")
    build_slope_tiles(slope, bounds)
    print("Ploščice višin ...")
    build_dem_tiles(ndimage.gaussian_filter(dem, 1.0), bounds)
    write_meta(bounds, args.smooth)
    print("Končano.")


if __name__ == "__main__":
    main()
