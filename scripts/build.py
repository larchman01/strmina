"""Iz LiDAR podatkov za območja v scripts/regions.json naredi ploščice za aplikacijo.

Viri (vsak se uporabi, kjer obstaja; CLSS ima prednost):
  data/raw/DMR_*.laz          Slovenija, CLSS 2023-25, mreža 0,5 m (scripts/download.py)
  data/raw/bev/<id>_*.tif     Avstrija, BEV ALS DTM 1 m (scripts/download_bev.py)

Izhod (v ``app/public``):
  tiles/slope/{z}/{x}/{y}.png  razredi naklona (paleta), Web Mercator, 256 px
  tiles/dem/{z}/{x}/{y}.png    višine (Terrarium) za 3D teren, senčenje in poizvedbe; na robu
                               podatkov mehak prehod v AWS Terrain Tiles
  data/meta.json               območja, povečave, razredi
  data/coverage.geojson        obrisi dejanskih LiDAR podatkov

Uporaba:
    python scripts/build.py [--smooth 3]
"""

import argparse
import json
import math
import shutil
from pathlib import Path

import laspy
import numpy as np
import rasterio
import requests
from PIL import Image
from pyproj import Transformer
from rasterio import features
from rasterio.enums import Resampling
from rasterio.transform import Affine
from scipy import ndimage
import shapely
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
BEV_DIR = RAW_DIR / "bev"
OUT_DIR = ROOT / "app" / "public" / "tiles"
DATA_DIR = ROOT / "app" / "public" / "data"
CACHE_DIR = ROOT / "data" / "cache" / "terrarium"
REGIONS = ROOT / "scripts" / "regions.json"

CLSS_SHEET = 1000.0
SLOPE_ZOOMS = range(12, 17)  # z17+ MapLibre poveča iz z16; naklon je itak zglajen na ~5 m
DEM_ZOOMS = range(10, 16)
TILE = 256
WORLD = 20037508.342789244
DEM_STEP = 0.125  # zaokroževanje višin v ploščicah (m) – manjše datoteke, natančnost zadošča

AWS_TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
FEATHER_M = 60.0      # širina prehoda med LiDAR in AWS višinami
COVERAGE_CELL_M = 20  # ločljivost maske za obrise pokritosti

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
d96_to_3035 = Transformer.from_crs(3794, 3035, always_xy=True)


# ---------------------------------------------------------------------------
# Območja
# ---------------------------------------------------------------------------

def smooth_nan(a, size=None, sigma=None):
    """Glajenje, ki NaN ne razširi: povprečje le čez veljavne celice."""
    valid = ~np.isnan(a)
    v = np.where(valid, a, 0).astype(np.float32)
    m = valid.astype(np.float32)
    if sigma is not None:
        num, den = ndimage.gaussian_filter(v, sigma), ndimage.gaussian_filter(m, sigma)
    else:
        num, den = ndimage.uniform_filter(v, size), ndimage.uniform_filter(m, size)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[~valid] = np.nan
    return out


class Region:
    def __init__(self, cfg):
        self.id = cfg["id"]
        self.name = cfg["name"]
        self.res = float(cfg["res"])
        self.xmin, self.ymin, self.xmax, self.ymax = map(float, cfg["bbox_d96"])
        self.cols = int(round((self.xmax - self.xmin) / self.res))
        self.rows = int(round((self.ymax - self.ymin) / self.res))
        self.dem = np.full((self.rows, self.cols), np.nan, dtype=np.float32)
        self.sources = []

    @property
    def bbox(self):
        return self.xmin, self.ymin, self.xmax, self.ymax

    # --- viri ---

    def add_clss(self):
        files = []
        for f in sorted(RAW_DIR.glob("DMR_*.laz")):
            sx, sy = (int(v) * 1000 for v in f.stem.split("_")[1:3])
            if sx < self.xmax and sx + CLSS_SHEET > self.xmin and sy < self.ymax and sy + CLSS_SHEET > self.ymin:
                files.append(f)
        if not files:
            return
        total = np.zeros(self.rows * self.cols, dtype=np.float64)
        count = np.zeros(self.rows * self.cols, dtype=np.uint32)
        for f in files:
            las = laspy.read(f)
            col = np.floor((np.asarray(las.x) - self.xmin) / self.res).astype(np.int64)
            row = np.floor((self.ymax - np.asarray(las.y)) / self.res).astype(np.int64)
            ok = (col >= 0) & (col < self.cols) & (row >= 0) & (row < self.rows)
            idx = row[ok] * self.cols + col[ok]
            total += np.bincount(idx, weights=np.asarray(las.z)[ok], minlength=total.size)
            count += np.bincount(idx, minlength=count.size).astype(np.uint32)
        with np.errstate(invalid="ignore", divide="ignore"):
            grid = (total / count).astype(np.float32).reshape(self.rows, self.cols)
        fill = np.isnan(self.dem) & ~np.isnan(grid)
        self.dem[fill] = grid[fill]
        self.sources.append("CLSS 0,5 m")
        print(f"  CLSS: {len(files)} listov")

    def add_bev(self):
        files = sorted(BEV_DIR.glob(f"{self.id}_*.tif"))
        used = 0
        for f in files:
            with rasterio.open(f) as src:
                decim = max(1, int(round(self.res / src.res[0])))
                data = src.read(
                    1,
                    out_shape=(math.ceil(src.height / decim), math.ceil(src.width / decim)),
                    resampling=Resampling.average if decim > 1 else Resampling.nearest,
                ).astype(np.float32)
                if src.nodata is not None:
                    data[data == src.nodata] = np.nan
                if np.isnan(data).all():
                    continue
                inv = ~(src.transform * Affine.scale(src.width / data.shape[1], src.height / data.shape[0]))
            used += 1
            # Prevzorčenje EPSG:3035 -> D96/TM po pasovih vrstic, da ostane poraba pomnilnika majhna.
            xs = self.xmin + (np.arange(self.cols) + 0.5) * self.res
            for r0 in range(0, self.rows, 512):
                r1 = min(self.rows, r0 + 512)
                ys = self.ymax - (np.arange(r0, r1) + 0.5) * self.res
                X, Y = np.meshgrid(xs, ys)
                ex, ey = d96_to_3035.transform(X, Y)
                c, r = inv * (ex, ey)
                v = ndimage.map_coordinates(data, [r - 0.5, c - 0.5], order=1, mode="constant", cval=np.nan)
                block = self.dem[r0:r1]
                fill = np.isnan(block) & ~np.isnan(v)
                block[fill] = v[fill]
        if used:
            self.sources.append("BEV 1 m")
            print(f"  BEV: {used} izrezov")

    # --- izpeljani rastri ---

    def finish(self, smooth_m):
        valid = ~np.isnan(self.dem)
        print(f"  mreža {self.cols} x {self.rows} @ {self.res} m, podatki na {valid.mean() * 100:.0f} %")
        if not valid.any():
            raise SystemExit(f"Območje {self.id} nima podatkov - prenesi vire.")
        z = smooth_nan(self.dem, sigma=smooth_m / self.res) if smooth_m > 0 else self.dem
        gy, gx = np.gradient(z, self.res)
        self.slope = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)
        del gx, gy, z
        self.dem_smooth = smooth_nan(self.dem, sigma=1.0 / self.res)

        # utež za prehod v AWS: oddaljenost od roba podatkov, na grobi mreži
        k = max(1, int(round(COVERAGE_CELL_M / self.res)))
        rows, cols = self.rows // k, self.cols // k
        coarse = valid[: rows * k, : cols * k].reshape(rows, k, cols, k).all(axis=(1, 3))
        self.coarse_valid = coarse
        self.coarse_cell = k * self.res
        dist = ndimage.distance_transform_edt(coarse) * self.coarse_cell
        self.weight = np.clip(dist / FEATHER_M, 0, 1).astype(np.float32)

    def level(self, grid, pixel_m):
        size = int(round(pixel_m / self.res))
        return smooth_nan(grid, size=size) if size > 1 else grid

    def sample(self, grid, X, Y, cell=None):
        cell = cell or self.res
        col = (X - self.xmin) / cell - 0.5
        row = (self.ymax - Y) / cell - 0.5
        return ndimage.map_coordinates(grid, [row, col], order=1, mode="constant", cval=np.nan)

    def coverage(self):
        t = Affine(self.coarse_cell, 0, self.xmin, 0, -self.coarse_cell, self.ymax)
        polys = [shape(g) for g, v in features.shapes(self.coarse_valid.astype(np.uint8), transform=t) if v == 1]
        geom = unary_union(polys).simplify(self.coarse_cell * 1.5)
        return shapely.transform(geom, lambda c: np.column_stack(to_wgs.transform(c[:, 0], c[:, 1])))


# ---------------------------------------------------------------------------
# Ploščice
# ---------------------------------------------------------------------------

def lonlat_bounds(bbox_d96):
    xmin, ymin, xmax, ymax = bbox_d96
    xs = np.linspace(xmin, xmax, 20)
    ys = np.linspace(ymin, ymax, 20)
    ex = np.concatenate([xs, xs, np.full(20, xmin), np.full(20, xmax)])
    ey = np.concatenate([np.full(20, ymin), np.full(20, ymax), ys, ys])
    lon, lat = to_wgs.transform(ex, ey)
    return float(min(lon)), float(min(lat)), float(max(lon)), float(max(lat))


def tiles_for(bbox_d96, z):
    w, s, e, n = lonlat_bounds(bbox_d96)
    k = 2 ** z

    def tx(lo):
        return int((lo + 180) / 360 * k)

    def ty(la):
        r = math.radians(la)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * k)

    return {(x, y) for x in range(tx(w), tx(e) + 1) for y in range(ty(n), ty(s) + 1)}


def tile_pixels_d96(z, x, y):
    res = 2 * WORLD / (TILE * 2 ** z)
    i = np.arange(TILE) + 0.5
    MX, MY = np.meshgrid(-WORLD + (x * TILE + i) * res, WORLD - (y * TILE + i) * res)
    return to_d96.transform(MX, MY)


def pixel_size_m(z, lat):
    return 2 * WORLD / (TILE * 2 ** z) * math.cos(math.radians(lat))


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
    v = np.clip(np.round(h / DEM_STEP) * DEM_STEP + 32768, 0, 65535.99)
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - r * 256 - g) * 256)
    return np.dstack([r, g, b]).astype(np.uint8)


def build_slope_tiles(regions):
    for z in SLOPE_ZOOMS:
        levels = [r.level(r.slope, pixel_size_m(z, 46.4)) for r in regions]
        count = 0
        for x, y in sorted(set().union(*(tiles_for(r.bbox, z) for r in regions))):
            X, Y = tile_pixels_d96(z, x, y)
            s = np.full(X.shape, np.nan)
            for r, lv in zip(regions, levels):
                s = np.where(np.isnan(s), r.sample(lv, X, Y), s)
            rgba = classify(np.nan_to_num(s, nan=0))
            if not rgba[..., 3].any():
                continue
            img = Image.fromarray(rgba).quantize(colors=len(SLOPE_CLASSES) + 1, method=Image.Quantize.FASTOCTREE)
            p = OUT_DIR / "slope" / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            img.save(p, optimize=True)
            count += 1
        print(f"  slope z{z}: {count} ploščic")


def build_dem_tiles(regions):
    for z in DEM_ZOOMS:
        levels = [r.level(r.dem_smooth, pixel_size_m(z, 46.4)) for r in regions]
        count = 0
        for x, y in sorted(set().union(*(tiles_for(r.bbox, z) for r in regions))):
            X, Y = tile_pixels_d96(z, x, y)
            h = np.zeros(X.shape)
            w = np.zeros(X.shape)
            for r, lv in zip(regions, levels):
                hr = r.sample(lv, X, Y)
                wr = np.nan_to_num(r.sample(r.weight, X, Y, cell=r.coarse_cell))
                wr[np.isnan(hr)] = 0
                take = wr > w
                h[take] = hr[take]
                w[take] = wr[take]
            if not w.any():
                continue  # brez LiDAR: aplikacija vzame AWS neposredno
            out = w * h + (1 - w) * fetch_terrarium(z, x, y)
            p = OUT_DIR / "dem" / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(encode_terrarium(out)).save(p, optimize=True)
            count += 1
        print(f"  dem z{z}: {count} ploščic")


def write_meta(regions, smooth_m):
    meta_regions, feats = [], []
    for r in regions:
        geom = r.coverage()
        w, s, e, n = geom.bounds
        meta_regions.append({"id": r.id, "name": r.name, "source": " + ".join(r.sources),
                             "bounds": [round(w, 5), round(s, 5), round(e, 5), round(n, 5)]})
        feats.append({"type": "Feature", "properties": {"id": r.id, "name": r.name, "source": " + ".join(r.sources)},
                      "geometry": json.loads(json.dumps(mapping(geom)), parse_float=lambda v: round(float(v), 5))})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "coverage.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
    b = [r["bounds"] for r in meta_regions]
    (DATA_DIR / "meta.json").write_text(json.dumps({
        "regions": meta_regions,
        "bounds": [min(v[0] for v in b), min(v[1] for v in b), max(v[2] for v in b), max(v[3] for v in b)],
        "slope_zooms": [SLOPE_ZOOMS.start, SLOPE_ZOOMS.stop - 1],
        "dem_zooms": [DEM_ZOOMS.start, DEM_ZOOMS.stop - 1],
        "smooth_m": smooth_m,
        "classes": [{"min": lo, "color": "#%02x%02x%02x" % c[:3]} for lo, c in SLOPE_CLASSES],
    }, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smooth", type=float, default=3.0, help="sigma Gaussovega glajenja v metrih")
    args = ap.parse_args()

    regions = []
    for cfg in json.loads(REGIONS.read_text(encoding="utf-8")):
        print(f"Območje {cfg['name']} ...")
        r = Region(cfg)
        r.add_clss()
        r.add_bev()
        if not r.sources:
            print("  ni podatkov - preskočeno")
            continue
        r.finish(args.smooth)
        regions.append(r)

    shutil.rmtree(OUT_DIR, ignore_errors=True)
    print("Ploščice naklonov ...")
    build_slope_tiles(regions)
    print("Ploščice višin ...")
    build_dem_tiles(regions)
    write_meta(regions, args.smooth)
    print("Končano.")


if __name__ == "__main__":
    main()
