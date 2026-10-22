// Zonnevoorspelling via de gratis API van forecast.solar (max. 12 verzoeken per uur per IP).
// We vragen elk dakvlak hooguit één keer per uur op en tellen de vlakken bij elkaar op.

const REFRESH_MS = 60 * 60 * 1000;
const BASE = process.env.FORECAST_SOLAR_URL || 'https://api.forecast.solar';

export class SolarForecast {
  constructor() {
    this.data = null;
    this.error = null;
    this.key = '';
    this.fetchedAt = 0;
    this.busy = false;
  }

  planes(cfg) {
    return cfg.solar.planes.filter((p) => p.kwp > 0);
  }

  async get(cfg) {
    const so = cfg.solar;
    const planes = this.planes(cfg);
    if (!so.enabled) return { enabled: false };
    if (!planes.length) return { enabled: true, error: 'Vul bij instellingen het vermogen (kWp) van je panelen in.' };
    const key = JSON.stringify([so.lat, so.lon, planes]);
    if (!this.busy && (key !== this.key || Date.now() - this.fetchedAt > REFRESH_MS)) await this.refresh(so, planes, key);
    return { enabled: true, error: this.error, updated: this.fetchedAt || null, ...this.data };
  }

  async refresh(so, planes, key) {
    this.busy = true;
    try {
      const results = await Promise.all(
        planes.map(async (p) => {
          const url = `${BASE}/estimate/${so.lat}/${so.lon}/${p.tilt}/${p.azimuth}/${p.kwp}`;
          const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
          if (res.status === 429) throw new Error('Te veel verzoeken bij forecast.solar, probeer het over een uur opnieuw.');
          if (!res.ok) throw new Error(`forecast.solar antwoordt met status ${res.status}.`);
          return (await res.json()).result;
        }),
      );
      const watts = new Map();
      const days = new Map();
      for (const r of results) {
        for (const [t, w] of Object.entries(r.watts || {})) watts.set(t, (watts.get(t) || 0) + w);
        for (const [d, wh] of Object.entries(r.watt_hours_day || {})) days.set(d, (days.get(d) || 0) + wh);
      }
      // Tijden komen als "YYYY-MM-DD HH:MM:SS" in de lokale tijd van de locatie
      this.data = {
        watts: [...watts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, w]) => [t.replace(' ', 'T'), Math.round(w)]),
        days: Object.fromEntries([...days.entries()].map(([d, wh]) => [d, wh / 1000])),
      };
      this.error = null;
      this.key = key;
      this.fetchedAt = Date.now();
    } catch (e) {
      this.error = e.name === 'TimeoutError' ? 'forecast.solar reageert niet.' : e.message;
      this.key = key;
      this.fetchedAt = Date.now() - REFRESH_MS + 10 * 60 * 1000; // over 10 minuten opnieuw proberen
    } finally {
      this.busy = false;
    }
  }
}
