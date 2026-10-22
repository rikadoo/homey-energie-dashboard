import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, publicConfig, mergeIncoming, effective, METRIC_KEYS } from './lib/config.js';
import { trBody, requestLang } from './lib/i18n.js';
import { Collector, openDb } from './lib/collector.js';
import { summary, isDal } from './lib/stats.js';
import { flows, heatmap, batteryDay, salderingCompare, jaarnota } from './lib/insights.js';
import { SolarForecast } from './lib/solar.js';
import { HomeySignals } from './lib/signals.js';
import { listHomeyDevices, DongleClient } from './lib/sources.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.SETTINGS_PASSWORD || '';

let config = await loadConfig(DATA_DIR);
const db = openDb(DATA_DIR);
const collector = new Collector(db, () => config);
const solar = new SolarForecast();
const signals = new HomeySignals({
  getSummary: () => summary(db, effective(config), 'dag', new Date(), collector.counters),
  getSolar: () => solar.get(config),
  isDal,
});
collector.listeners.add((live, cfg) => signals.run(live, effective(cfg)));
collector.start();

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8', true],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8', true],
  '/setup': ['setup.html', 'text/html; charset=utf-8', true],
  '/setup.js': ['setup.js', 'text/javascript; charset=utf-8', true],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/lang-en.js': ['lang-en.js', 'text/javascript; charset=utf-8'],
};

function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('Verzoek te groot.');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// Tijdelijke instellingen uit het formulier, aangevuld met opgeslagen geheimen.
function withStoredSecrets(body) {
  const homey = { url: String(body.homey?.url || config.homey.url).replace(/\/+$/, ''), token: body.homey?.token || config.homey.token };
  return { homey, dongle: { url: body.dongle?.url || config.dongle.url } };
}

async function testMetric(body) {
  const { homey, dongle } = withStoredSecrets(body);
  const m = { factor: 1, invert: false, ...body.metric };
  if (!m.auth && body.key && METRIC_KEYS.includes(body.key)) m.auth = config.metrics[body.key].auth;
  if (m.source === 'dongle') {
    const useMain = collector.sources.dongle?.url === dongle.url;
    const client = useMain ? collector.sources.dongle : new DongleClient(dongle.url);
    try {
      const values = await client.waitForTelegram(10_000);
      const v = values[m.field || 'grid_w'];
      if (v == null) throw new Error('De meter levert deze waarde niet.');
      return v * (Number(m.factor) || 1) * (m.invert ? -1 : 1);
    } finally {
      if (!useMain) client.close();
    }
  }
  return collector.sources.readOne({ homey }, { ...m, factor: Number(m.factor) || 1 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const lang = requestLang(config, req);
  const json = (status, body) => send(res, status, trBody(body, lang));
  const p = url.pathname;
  try {
    const needsAuth = STATIC[p]?.[2] || p.startsWith('/api/config') || p.startsWith('/api/homey') || p.startsWith('/api/test') || p.startsWith('/api/dongle') || p.startsWith('/api/signals');
    if (needsAuth && !authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Energie instellingen"' });
      return res.end('Wachtwoord vereist');
    }

    if (req.method === 'GET' && /^\/fonts\/[\w.-]+\.(woff2|css)$/.test(p)) {
      const type = p.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2';
      const body = await readFile(path.join(ROOT, 'public', p)).catch(() => null);
      if (!body) return json(404, { error: 'Niet gevonden' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(body);
    }
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, await readFile(path.join(ROOT, 'public', file)), type);
    }
    if (req.method === 'GET' && p === '/api/ui') {
      return json(200, { language: config.ui.language, country: config.region.country, currency: config.region.currency, setupDone: config.ui.setupDone });
    }
    if (req.method === 'GET' && p === '/api/live') return json(200, collector.live);
    if (req.method === 'GET' && p === '/api/summary') {
      const period = ['dag', 'week', 'maand', 'jaar'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'dag';
      const s = summary(db, effective(config), period, new Date(), collector.counters);
      s.flows = flows(db, s.range.from, s.range.to);
      return json(200, s);
    }
    if (req.method === 'GET' && p === '/api/history') {
      // Na een herstart: vul het begin van het uur aan met de minuutgemiddelden uit de database
      const hist = collector.history;
      const from = Math.floor((Date.now() - 3_600_000) / 1000);
      const until = hist.length ? Math.floor(hist[0].t / 1000) - 60 : Math.floor(Date.now() / 1000);
      const older = db
        .prepare('SELECT ts, solar_w, import_w, export_w, charge_w, discharge_w, house_w, soc FROM minute WHERE ts >= ? AND ts < ? AND solar_w IS NOT NULL ORDER BY ts')
        .all(from, until)
        .map((r) => ({ t: r.ts * 1000 + 30_000, s: Math.round(r.solar_w), g: Math.round(r.import_w - r.export_w), b: Math.round(r.charge_w - r.discharge_w), h: Math.round(r.house_w), soc: r.soc }));
      return json(200, { points: [...older, ...hist] });
    }
    if (req.method === 'GET' && p === '/api/heatmap') return json(200, heatmap(db, url.searchParams.get('metric'), 28));
    if (req.method === 'GET' && p === '/api/battery') return json(200, batteryDay(db, effective(config), url.searchParams.get('date')));
    if (req.method === 'GET' && p === '/api/saldering') return json(200, salderingCompare(db, effective(config)));
    if (req.method === 'GET' && p === '/api/jaarnota') return json(200, jaarnota(db, effective(config)));
    if (req.method === 'GET' && p === '/api/solar') {
      const sol = await solar.get(config);
      // Werkelijke opwek per uur van vandaag, om naast de voorspelling te zetten
      const t = new Date();
      const day = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      sol.actual = db
        .prepare(`SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS h, AVG(solar_w) AS w, SUM(solar_w) / 60000.0 AS kwh
                  FROM minute WHERE ts >= ? GROUP BY h`)
        .all(Math.floor(day / 1000));
      return json(200, sol);
    }
    if (req.method === 'GET' && p === '/api/signals') return json(200, signals.status);
    if (req.method === 'POST' && p === '/api/signals/test') {
      signals.lastRun = 0;
      signals.ids = null;
      await signals.run(collector.live, { ...effective(config), signals: { ...config.signals, enabled: true } });
      return json(200, signals.status);
    }
    if (req.method === 'GET' && p === '/api/config') return json(200, publicConfig(config));
    if (req.method === 'POST' && p === '/api/config') {
      const next = mergeIncoming(config, await readJson(req));
      await saveConfig(DATA_DIR, next);
      config = next;
      collector.reconfigure();
      return json(200, publicConfig(config));
    }
    if (req.method === 'POST' && p === '/api/homey/devices') {
      const { homey } = withStoredSecrets(await readJson(req));
      return json(200, await listHomeyDevices(homey));
    }
    if (req.method === 'POST' && p === '/api/dongle/test') {
      const { dongle } = withStoredSecrets(await readJson(req));
      const useMain = collector.sources.dongle?.url === dongle.url;
      const client = useMain ? collector.sources.dongle : new DongleClient(dongle.url);
      try {
        return json(200, await client.waitForTelegram(10_000));
      } finally {
        if (!useMain) client.close();
      }
    }
    if (req.method === 'POST' && p === '/api/test') return json(200, { value: await testMetric(await readJson(req)) });
    if (req.method === 'GET' && p === '/healthz') return json(200, { ok: true });

    json(404, { error: 'Niet gevonden' });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Bron reageert niet (time-out).' : e.message;
    json(400, { error: msg });
  }
});

server.listen(PORT, () => {
  console.log(`Energie dashboard draait op poort ${PORT}`);
  if (!PASSWORD) console.warn('Let op: SETTINGS_PASSWORD is niet ingesteld. De instellingenpagina (met je Homey-sleutel) is voor iedereen in je netwerk bereikbaar.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    collector.stop();
    db.close();
    process.exit(0);
  });
}
