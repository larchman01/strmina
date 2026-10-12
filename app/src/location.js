import { Geolocation } from '@capacitor/geolocation';
import { Marker } from 'maplibre-gl';

/** Sledenje lokaciji prek Capacitorja (nativno na telefonu, v brskalniku prek navigator.geolocation). */
export class Locator {
  constructor(map, onPosition, onError) {
    this.map = map;
    this.onPosition = onPosition;
    this.onError = onError;
    this.watchId = null;
    this.marker = null;
    this.first = true;
  }

  get active() {
    return this.watchId !== null;
  }

  async start() {
    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === 'denied') throw new Error('Dostop do lokacije ni dovoljen');
    } catch (e) {
      // V brskalniku requestPermissions ni implementiran; dovoljenje vpraša brskalnik sam.
      if (!/not implemented/i.test(String(e?.message ?? e))) return this.onError(e);
    }
    this.first = true;
    this.watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
      (pos, err) => {
        if (err || !pos) return this.onError(err ?? new Error('Lokacija ni na voljo'));
        this.update(pos.coords);
      },
    );
  }

  async stop() {
    if (this.watchId !== null) await Geolocation.clearWatch({ id: this.watchId });
    this.watchId = null;
    this.marker?.remove();
    this.marker = null;
  }

  update({ longitude, latitude, accuracy }) {
    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'me';
      this.marker = new Marker({ element: el }).setLngLat([longitude, latitude]).addTo(this.map);
    }
    this.marker.setLngLat([longitude, latitude]);
    if (this.first) {
      this.first = false;
      this.map.flyTo({ center: [longitude, latitude], zoom: Math.max(this.map.getZoom(), 14.5), duration: 1500 });
    }
    this.onPosition({ lng: longitude, lat: latitude, accuracy });
  }
}
