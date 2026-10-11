"""Prenos listov DMR (CLSS 2023-25) za izbrano območje.

Seznam listov in povezave dobimo iz javnega WFS sloja pregledovalnika clss.si
(sloj ``tileindex_clss_zdruzeno``). Vsak list pokriva 1 km x 1 km v D96/TM (EPSG:3794).

Primer (Krvavec, privzeto):
    python scripts/download.py --bbox 461000 127000 466000 131000

Portal priporoča največ 20 prenosov na dan; za večja območja se obrni na GURS.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import requests

WFS_URL = "https://lift.clss.si/geoserver/wfs"
LAYER = "tileindex_clss_zdruzeno"
ASSET_BASE = "https://assets.flycom.si/"
MAX_SHEETS = 20
PAUSE_S = 3  # vljudnostni premor med prenosi; strežnik sicer vrne 429

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"


def list_sheets(xmin, ymin, xmax, ymax):
    params = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typeName": LAYER,
        "outputFormat": "application/json",
        "srsName": "EPSG:3794",
        # BBOX z robom 1 m navznoter, da ne dobimo sosednjih listov, ki se samo dotikajo.
        "bbox": f"{xmin + 1},{ymin + 1},{xmax - 1},{ymax - 1},EPSG:3794",
    }
    r = requests.get(WFS_URL, params=params, timeout=60)
    r.raise_for_status()
    return [f["properties"] for f in r.json()["features"]]


def download(url, dest, retries=5):
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(retries):
        with requests.get(url, stream=True, timeout=120) as r:
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 30 * (attempt + 1)))
                print(f"    preveč zahtev, čakam {wait} s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 20):
                    fh.write(chunk)
        tmp.replace(dest)
        return
    raise RuntimeError(f"Prenos ni uspel: {url}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    default=[461000, 127000, 466000, 131000], help="območje v D96/TM (m)")
    ap.add_argument("--product", default="dmr", choices=["dmr", "dmp", "gkot", "pas", "ndmp"])
    ap.add_argument("--force", action="store_true", help=f"dovoli več kot {MAX_SHEETS} listov")
    args = ap.parse_args()

    sheets = list_sheets(*args.bbox)
    print(f"Najdenih listov: {len(sheets)}")
    if len(sheets) > MAX_SHEETS and not args.force:
        sys.exit(f"Več kot {MAX_SHEETS} listov - zmanjšaj območje ali dodaj --force.")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for s in sorted(sheets, key=lambda s: s["ti_name"]):
        path = s[f"path_{args.product}"]
        dest = RAW_DIR / Path(path).name
        index.append({"sheet": s["ti_name"], "file": dest.name, "region": s["ime_ob"]})
        if dest.exists():
            print(f"  {dest.name} že obstaja")
            continue
        print(f"  {dest.name} ({s['ime_ob']}) ...", flush=True)
        download(ASSET_BASE + path, dest)
        time.sleep(PAUSE_S)

    (RAW_DIR / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    print("Končano.")


if __name__ == "__main__":
    main()
