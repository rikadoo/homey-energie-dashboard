import { parseTelegram } from './dsmr.js';

const TIMEOUT = 8000;
const DONGLE_STALE_MS = 60_000;

// ---------- Homey Energy Dongle (lokale WebSocket) ----------

const CONNECT_TIMEOUT_MS = 10_000; // verbinding moet binnen 10 s open zijn
const SILENT_MS = 30_000; // een slimme meter stuurt elke 1–10 s; 30 s stilte = dode verbinding

export class DongleClient {
  constructor(url) {
    this.url = url;
    this.buf = '';
    this.latest = null;
    this.latestAt = 0;
    this.lastMsgAt = 0;
    this.error = null;
    this.state = 'idle';
    this.delay = 2000;
    this.closed = false;
    this.listeners = new Set();
    this.conn = 0; // volgnummer, zodat afgebroken verbindingen niets meer doen
    this.watchdog = setInterval(() => this.check(), 5000);
    this.watchdog.unref?.();
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const id = ++this.conn;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.error = `Ongeldig adres: ${e.message}`;
      return this.retry();
    }
    this.ws = ws;
    this.state = 'connecting';
    this.connectStarted = Date.now();
    this.buf = '';
    const live = () => id === this.conn && !this.closed;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (!live()) return;
      this.state = 'open';
      this.lastMsgAt = Date.now();
      this.error = null;
    };
    ws.onmessage = (ev) => {
      if (!live()) return;
      this.lastMsgAt = Date.now();
      this.buf += typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      let bang;
      while ((bang = this.buf.indexOf('!')) !== -1) {
        const end = this.buf.indexOf('\n', bang);
        if (end === -1) break;
        const telegram = this.buf.slice(0, end + 1);
        this.buf = this.buf.slice(end + 1);
        const values = parseTelegram(telegram);
        if (values) {
          this.latest = values;
          this.latestAt = Date.now();
          this.delay = 2000;
          for (const fn of this.listeners) fn(values);
        }
      }
      if (this.buf.length > 50_000) this.buf = '';
    };
    ws.onerror = () => {
      if (!live()) return;
      this.error = 'Kan geen verbinding maken met de dongle. Klopt het IP-adres en mag de server het IoT-netwerk bereiken?';
    };
    ws.onclose = (ev) => {
      if (!live()) return;
      this.state = 'closed';
      const reason = String(ev.reason || '');
      if (/limit/i.test(reason)) this.error = 'De dongle heeft al 2 verbindingen (het maximum). Sluit andere programma\'s die de Local API gebruiken.';
      else if (/disabled/i.test(reason)) this.error = 'De Local API van de dongle staat uit. Zet hem aan in de Homey-app.';
      else if (ev.code === 1008) this.error = `De dongle weigert de verbinding${reason ? ` (${reason})` : ''}.`;
      this.retry();
    };
  }

  // Herstelt hangende of stil gevallen verbindingen (bijv. na een wifi-onderbreking of herstart van de dongle)
  check() {
    if (this.closed) return;
    const now = Date.now();
    if (this.state === 'connecting' && now - this.connectStarted > CONNECT_TIMEOUT_MS) {
      this.error = 'De dongle reageert niet. Klopt het IP-adres en mag de server het IoT-netwerk bereiken?';
      this.abandon();
    } else if (this.state === 'open' && now - this.lastMsgAt > SILENT_MS) {
      this.error = 'De verbinding met de dongle viel stil; opnieuw verbinden.';
      this.abandon();
    }
  }

  abandon() {
    const ws = this.ws;
    this.conn++; // oude verbinding negeren
    this.state = 'closed';
    try {
      ws?.close();
    } catch {}
    this.delay = 2000;
    this.retry();
  }

  retry() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 60_000);
  }

  read(field) {
    if (!this.latest || Date.now() - this.latestAt > DONGLE_STALE_MS) {
      throw new Error(this.error || 'Nog geen recente meting van de dongle ontvangen.');
    }
    const v = this.latest[field];
    if (v == null) throw new Error(`De meter levert geen waarde voor "${field}".`);
    return v;
  }

  waitForTelegram(ms) {
    if (this.latest && Date.now() - this.latestAt < DONGLE_STALE_MS) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners.delete(fn);
        const why = this.error
          || (this.state === 'open'
            ? 'Verbonden met de dongle, maar er komen geen meetgegevens binnen. Zit de dongle goed in de slimme meter?'
            : 'Geen verbinding met de dongle. Klopt het IP-adres en mag de server het IoT-netwerk bereiken?');
        reject(new Error(why));
      }, ms);
      const fn = (v) => {
        clearTimeout(t);
        this.listeners.delete(fn);
        resolve(v);
      };
      this.listeners.add(fn);
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {}
  }
}

// ---------- Homey Pro (lokale Web API) ----------

async function homeyFetch(homey, pathname) {
  if (!homey.url || !homey.token) throw new Error('Vul het Homey-adres en de API-sleutel in.');
  const res = await fetch(homey.url + pathname, {
    headers: { Authorization: `Bearer ${homey.token}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Homey weigert de API-sleutel. Controleer sleutel en rechten.');
  if (!res.ok) throw new Error(`Homey antwoordt met status ${res.status}.`);
  return res.json();
}

export async function listHomeyDevices(homey) {
  const devices = await homeyFetch(homey, '/api/manager/devices/device/');
  return Object.values(devices)
    .map((d) => ({
      id: d.id,
      name: d.name,
      caps: Object.entries(d.capabilitiesObj || {})
        .filter(([, o]) => typeof o?.value === 'number')
        .map(([id, o]) => ({ id, title: o.title || id, value: o.value, units: o.units || '' })),
    }))
    .filter((d) => d.caps.length)
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}

// ---------- Algemene HTTP JSON-bron ----------

function getPath(obj, p) {
  if (!p) return obj;
  return p.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

async function readHttp(m) {
  if (!m.url) throw new Error('Vul een URL in.');
  const headers = m.auth ? { Authorization: m.auth } : {};
  const res = await fetch(m.url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`De URL antwoordt met status ${res.status}.`);
  const v = getPath(await res.json(), m.path);
  if (v === undefined) throw new Error(`Pad "${m.path}" niet gevonden in het antwoord.`);
  return v;
}

// ---------- Alles samen ----------

export class Sources {
  constructor() {
    this.dongle = null;
  }

  configure(cfg) {
    const url = cfg.dongle.url;
    const needed = Object.values(cfg.metrics).some((m) => m.source === 'dongle');
    if (this.dongle && (this.dongle.url !== url || !needed)) {
      this.dongle.close();
      this.dongle = null;
    }
    if (!this.dongle && needed && url) this.dongle = new DongleClient(url);
  }

  async readOne(cfg, m, homeyCache = new Map(), meta = {}) {
    let raw;
    if (m.source === 'homey') {
      if (!m.deviceId || !m.capability) throw new Error('Kies een Homey-apparaat en meetwaarde.');
      if (!homeyCache.has(m.deviceId)) {
        homeyCache.set(m.deviceId, homeyFetch(cfg.homey, `/api/manager/devices/device/${encodeURIComponent(m.deviceId)}`));
      }
      const dev = await homeyCache.get(m.deviceId);
      const cap = dev.capabilitiesObj?.[m.capability];
      if (!cap) throw new Error(`Apparaat "${dev.name}" heeft geen "${m.capability}".`);
      raw = cap.value;
      meta.updated = cap.lastUpdated ? Date.parse(cap.lastUpdated) : null;
    } else if (m.source === 'dongle') {
      if (!this.dongle) throw new Error('Vul het adres van de Energy Dongle in.');
      raw = this.dongle.read(m.field || 'grid_w');
      meta.updated = this.dongle.latestAt;
    } else if (m.source === 'http') {
      raw = await readHttp(m);
    } else {
      return null;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error('De bron gaf geen getal terug.');
    return v * (m.factor || 1) * (m.invert ? -1 : 1);
  }

  async readAll(cfg) {
    const values = {};
    const errors = {};
    const updated = {};
    const homeyCache = new Map();
    await Promise.all(
      Object.entries(cfg.metrics).map(async ([key, m]) => {
        if (m.source === 'none') return;
        try {
          const meta = {};
          values[key] = await this.readOne(cfg, m, homeyCache, meta);
          updated[key] = meta.updated ?? Date.now();
        } catch (e) {
          // Bijvoorbeeld een omvormer die 's nachts uit staat: dan geldt 0 en is er geen fout
          if (m.zeroOnError) values[key] = 0;
          else if (e.name === 'TimeoutError') errors[key] = 'Bron reageert niet (time-out).';
          else if (e.message === 'fetch failed') errors[key] = 'Bron niet bereikbaar op het netwerk.';
          else errors[key] = e.message;
        }
      }),
    );
    return { values, errors, updated };
  }

  close() {
    this.dongle?.close();
    this.dongle = null;
  }
}
