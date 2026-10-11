# Strmina

Prototip karte naklonov za turno smučanje in gorništvo v Sloveniji, izdelane iz novih
LiDAR podatkov **CLSS 2023–2025** (Geodetska uprava RS). Trenutno pokriva **Krvavec**
(20 km², listi 461–465 × 127–130 v D96/TM).

Funkcije:
- plast naklonov v razredih 27–30°, 30–35°, 35–40°, 40–45° in >45°
- tap na karto prikaže naklon, ekspozicijo in nadmorsko višino (izračun v brskalniku iz ploščic DEM)
- GPS lokacija z naklonom pod tabo
- senčenje reliefa in 3D teren iz LiDAR DMR
- podlagi OpenTopoMap in OSM

> ⚠️ Naklon **ni** ocena plazovne nevarnosti. Teren je posnet brez snega. Preveri
> [plazovni bilten ARSO](https://meteo.arso.gov.si/met/sl/avalanche/).

## Zagon

```bash
python -m venv .venv
.venv/Scripts/python -m pip install "laspy[lazrs]" numpy scipy pyproj pillow requests
.venv/Scripts/python -m http.server 8765 --directory web
```

Nato odpri <http://localhost:8765>. Ploščice za Krvavec so že v repozitoriju.

## Izdelava podatkov za drugo območje

```bash
# 1. prenos listov DMR (.laz, ~5 MB/km²); območje v D96/TM, metri
.venv/Scripts/python scripts/download.py --bbox 461000 127000 466000 131000

# 2. naklon + ploščice (web/tiles) in metapodatki (web/data)
.venv/Scripts/python scripts/build.py --smooth 3
```

Postopek:
1. `download.py` poišče liste prek javnega WFS sloja `tileindex_clss_zdruzeno` na
   `lift.clss.si` in prenese DMR z `assets.flycom.si`. Med prenosi počaka 3 s, ker strežnik
   ob prehitrih zahtevah vrne 429. Portal priporoča največ 20 prenosov na dan; za večja
   območja se obrni na GURS.
2. `build.py` zloži DMR (mreža 0,5 m) v raster, ga povpreči na 1 m, zgladi
   (Gauss, privzeto σ = 3 m) in izračuna naklon. Nato izdela ploščice Web Mercator:
   - `tiles/slope/z12–17`: razredi naklona; vsaka povečava je povprečena na velikost piksla
   - `tiles/dem/z10–15`: višine v kodiranju Terrarium. Izven območja LiDAR so dopolnjene z
     [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), na robu z mehkim prehodom.

## Naprej

- [ ] cela Slovenija: ~20.000 listov, ploščice v PMTiles na CDN
- [ ] mobilna aplikacija (Flutter + MapLibre) z offline regijami
- [ ] ekspozicija kot svoja plast; povezava s plazovnim biltenom
- [ ] razredi po ATES / ocena izpostavljenosti (izteki plazov)

## Viri in licence

- DMR: © GURS, Ciklično lasersko skeniranje Slovenije 2023–2025, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Višine izven območja: AWS Terrain Tiles (Mapzen, SRTM, EU-DEM …)
- Podlage: © OpenStreetMap sodelavci, OpenTopoMap (CC-BY-SA)
