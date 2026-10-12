# Strmina

Aplikacija za Android in iOS s 3D karto naklonov za turno smučanje in gorništvo, izdelano iz
LiDAR podatkov **CLSS 2023–2025** (Geodetska uprava RS) in **ALS DTM** (BEV, Avstrija).
Podrobni nakloni iz LiDAR so zaenkrat izdelani za **Krvavec** (CLSS) in **avstrijsko stran
Karavank** (BEV). 3D teren, oznake vrhov in iskanje pokrivajo vso Slovenijo z obmejnim pasom.

Funkcije:
- 3D teren in senčenje že ob zagonu iz [Mapterhorn](https://mapterhorn.com) (LiDAR 1 m za
  Slovenijo in Avstrijo, drugje Copernicus GLO-30), z možnostjo 2D
- 3D oznake vrhov: ime in višina nad vrhom z navpično črto, pritrjeni na teren; izbor glede
  na višino in oddaljenost ter brez prekrivanja
- iskanje brez povezave po ~23.000 vrhovih, kočah, sedlih in krajih (OSM), ki ne upošteva
  šumnikov; pri malo zadetkih še spletno iskanje (Photon)
- plast naklonov v razredih 27–30°, 30–35°, 35–40°, 40–45° in >45°
- tap na karto ali vrh prikaže naklon, ekspozicijo in višino
- GPS (Capacitor) z naklonom pod tabo

> ⚠️ Naklon **ni** ocena plazovne nevarnosti. Teren je posnet brez snega. Preveri
> [plazovni bilten ARSO](https://meteo.arso.gov.si/met/sl/avalanche/).

## Struktura

```
app/              aplikacija: Vite + MapLibre GL JS + Capacitor
  src/main.js       karta, stil, kontrole
  src/dem.js        poizvedba naklona (naše LiDAR ploščice ali Mapterhorn), roža ekspozicij
  src/peaks.js      3D oznake vrhov
  src/search.js     iskanje
  src/location.js   GPS
  public/tiles      ploščice naklonov in višin
  public/data       meta.json, coverage.geojson, places.json (OSM)
  android/          Android projekt (Capacitor)
scripts/          Python: prenos LiDAR, izdelava ploščic, izvoz OSM
```

## Razvoj

```bash
cd app
npm install
npm run dev          # http://localhost:5173
```

### Android

Potrebuješ Android Studio (SDK 36). Z ukazom `npm run sync` zgradiš splet in ga kopiraš v
Android projekt.

```bash
cd app
npm run sync
npx cap open android      # odpre v Android Studiu → Run
```

Ali iz ukazne vrstice (APK v `android/app/build/outputs/apk/debug/`):

```bash
cd app/android
./gradlew assembleDebug
```

### iOS

Potrebuješ Mac z Xcode ali gradnjo v oblaku (npr. Codemagic). Na Macu dodaš platformo z
`npx cap add ios`.

## Podatki

```bash
python -m venv .venv
.venv/Scripts/python -m pip install "laspy[lazrs]" numpy scipy pyproj pillow requests

# vrhovi, koče, sedla, kraji iz OSM -> app/public/data/places.json
.venv/Scripts/python scripts/osm.py

# Slovenija: LiDAR DMR CLSS (.laz, ~5 MB/km²); območje v D96/TM, metri
.venv/Scripts/python scripts/download.py --bbox 461000 127000 466000 131000

# Avstrija: BEV ALS DTM 1 m, izrez za območje iz scripts/regions.json
.venv/Scripts/python scripts/download_bev.py karavanke

# naklon + ploščice za vsa območja -> app/public/tiles, app/public/data
.venv/Scripts/python scripts/build.py --smooth 3
```

Območja so v [`scripts/regions.json`](scripts/regions.json): okvir v D96/TM in delovna
ločljivost (1 m za majhna, 2 m za večja območja). Vsako območje vzame vse vire, ki ga
pokrivajo; CLSS ima prednost pred BEV.

Postopek:
1. `download.py` poišče liste CLSS prek javnega WFS sloja `tileindex_clss_zdruzeno` na
   `lift.clss.si` in prenese DMR z `assets.flycom.si`. Med prenosi počaka 3 s, ker strežnik
   ob prehitrih zahtevah vrne 429. Portal priporoča največ 20 prenosov na dan; za večja
   območja se obrni na GURS. Liste lahko preneseš tudi ročno na [clss.si](https://clss.si)
   in jih shraniš v `data/raw/`.
2. `download_bev.py` iz BEV listov 50 × 50 km (Cloud Optimized GeoTIFF, EPSG:3035) prebere
   samo izrez za območje in ga shrani v `data/raw/bev/`.
3. `build.py` za vsako območje zloži vire v mrežo D96/TM (BEV prevzorči iz EPSG:3035), zgladi
   (Gauss, privzeto σ = 3 m) in izračuna naklon. Nato izdela ploščice Web Mercator:
   - `tiles/slope/z12–16`: razredi naklona; vsaka povečava je povprečena na velikost piksla
   - `tiles/dem/15`: višine (Terrarium) za poizvedbe naklona, skladne z barvami naklonov. Na
     robu podatkov se mehko prelijejo v Mapterhorn; drugod aplikacija bere Mapterhorn neposredno.
   - `data/coverage.geojson`: obrisi dejanskih podatkov (npr. samo avstrijska stran meje)
4. `osm.py` izvozi imenovane vrhove, sedla, koče in kraje prek Overpass API.

## Naprej

- [ ] nakloni za celo Slovenijo (~20.000 listov) v PMTiles; prenos regij za offline
- [ ] vektorska podlaga za offline (Protomaps / OpenFreeMap)
- [x] Avstrija: Karavanke (BEV ALS 1 m)
- [ ] cela Avstrija (55 listov BEV, ~20 GB) – potrebno gostovanje ploščic (npr. Cloudflare R2)
- [ ] ekspozicija kot svoj sloj; povezava s plazovnim biltenom
- [ ] iOS gradnja in objava v trgovinah

## Viri in licence

- DMR: © GURS, Ciklično lasersko skeniranje Slovenije 2023–2025, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- DTM Avstrija: © BEV, ALS DTM Höhenraster 1 m, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 3D teren: [© Mapterhorn](https://mapterhorn.com/attribution) (ARSO DMR, BEV, Copernicus GLO-30 …)
- Vrhovi, koče, kraji: © OpenStreetMap sodelavci (ODbL)
- Podlage: © OpenStreetMap sodelavci, OpenTopoMap (CC-BY-SA)
