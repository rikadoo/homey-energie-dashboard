import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const METRIC_KEYS = ['solar_w', 'grid_w', 'battery_w', 'battery_soc', 'gas_m3'];
const SOURCES = ['none', 'homey', 'dongle', 'http'];

const metric = (extra = {}) => ({
  source: 'none',
  deviceId: '',
  capability: '',
  field: '',
  url: '',
  path: '',
  auth: '',
  factor: 1,
  invert: false,
  zeroOnError: false,
  ...extra,
});

export function defaultConfig() {
  return {
    refreshSeconds: 10,
    homey: { url: '', token: '' },
    dongle: { url: '' },
    metrics: {
      solar_w: metric({ capability: 'measure_power', zeroOnError: true }),
      grid_w: metric({ capability: 'measure_power', field: 'grid_w' }),
      battery_w: metric({ capability: 'measure_power' }),
      battery_soc: metric({ capability: 'measure_battery' }),
      gas_m3: metric({ capability: 'meter_gas', field: 'gas_m3' }),
    },
    battery: { name: 'Thuisbatterij', capacityKwh: 5, noExport: true },
    contract: {
      supplier: '',
      description: 'Stroom en gas',
      start: '',
      end: '',
      // Variabele tarieven per kWh/m³, inclusief energiebelasting en btw (0 = nog niet ingevuld)
      leveringNormaal: 0,
      leveringDal: 0,
      dalStart: 23, // uur waarop het daltarief begint (werkdagen)
      dalEnd: 7, // uur waarop het daltarief eindigt
      weekendDal: true, // zaterdag en zondag de hele dag dal
      feestdagenDal: true, // landelijke feestdagen de hele dag dal
      // Teruglevering vóór en vanaf de wisseldatum (= einde saldering)
      terugleverKwh: 0,
      terugleverkostenKwh: 0,
      terugleverKwhNa: 0,
      terugleverkostenKwhNa: 0,
      saldering: true,
      salderingEinde: '2027-01-01', // wettelijk einde van de salderingsregeling
      salderingVolgorde: 'normaal-eerst', // of 'per-telwerk'
      gasM3: 0,
      // Vaste kosten per jaar
      stroomVastJaar: 0,
      stroomNetbeheerJaar: 0,
      gasVastJaar: 0,
      gasNetbeheerJaar: 0,
      verminderingEbJaar: 628.96, // 2026, incl. btw, vastgesteld door de overheid
      termijnbedrag: 0,
      bonus: 0,
      // Meterstanden op de startdatum (bij de netbeheerder op te vragen); 0 = onbekend
      startMeter: { impNormaal: 0, impDal: 0, expNormaal: 0, expDal: 0, gas: 0 },
      // Jaarverbruik van vorig jaar (van de vorige jaarnota); 0 = onbekend
      vorigJaar: { imp: 0, exp: 0, gas: 0 },
    },
    solar: {
      enabled: false,
      lat: 52.09,
      lon: 5.12,
      // Tot twee dakvlakken; kWp 0 = niet gebruikt. Hellingshoek in graden, richting: 0 = zuid, -90 = oost, 90 = west
      planes: [
        { tilt: 35, azimuth: 0, kwp: 0 },
        { tilt: 35, azimuth: 0, kwp: 0 },
      ],
    },
    signals: {
      enabled: false,
      surplusW: 1000, // zonne-overschot vanaf zoveel watt teruglevering
      minutes: 5, // zo lang moet het overschot aanhouden (en wegblijven)
      batteryFull: 98, // % waarboven de batterij als vol geldt
    },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, extra) {
  const out = structuredClone(base);
  if (!isObj(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else if (k in out) out[k] = v;
  }
  return out;
}

const num = (v, fallback, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function sanitize(cfg) {
  const d = defaultConfig();
  cfg.refreshSeconds = num(cfg.refreshSeconds, 10, 3, 300);
  cfg.homey.url = String(cfg.homey.url || '').trim().replace(/\/+$/, '');
  cfg.homey.token = String(cfg.homey.token || '').trim();
  cfg.dongle.url = String(cfg.dongle.url || '').trim();
  for (const k of METRIC_KEYS) {
    const m = cfg.metrics[k];
    if (!SOURCES.includes(m.source)) m.source = 'none';
    for (const f of ['deviceId', 'capability', 'field', 'url', 'path', 'auth']) m[f] = String(m[f] ?? '').trim();
    m.factor = num(m.factor, 1);
    m.invert = Boolean(m.invert);
    m.zeroOnError = Boolean(m.zeroOnError);
  }
  cfg.battery.name = String(cfg.battery.name || d.battery.name);
  cfg.battery.capacityKwh = num(cfg.battery.capacityKwh, 5, 0.1, 1000);
  cfg.battery.noExport = cfg.battery.noExport !== false;
  const c = cfg.contract;
  for (const f of ['leveringNormaal', 'leveringDal', 'terugleverKwh', 'terugleverkostenKwh', 'terugleverKwhNa', 'terugleverkostenKwhNa', 'gasM3']) {
    c[f] = Math.abs(num(c[f], d.contract[f], -100, 100)); // sommige leveranciers tonen vergoedingen negatief; wij rekenen met positieve bedragen
  }
  for (const f of ['stroomVastJaar', 'stroomNetbeheerJaar', 'gasVastJaar', 'gasNetbeheerJaar', 'verminderingEbJaar', 'termijnbedrag', 'bonus']) {
    c[f] = Math.abs(num(c[f], d.contract[f], -100000, 100000));
  }
  c.vorigJaar = c.vorigJaar || {};
  for (const f of ['imp', 'exp', 'gas']) c.vorigJaar[f] = Math.max(0, num(c.vorigJaar[f], 0, 0, 1e6));
  c.startMeter = c.startMeter || {};
  for (const f of ['impNormaal', 'impDal', 'expNormaal', 'expDal', 'gas']) c.startMeter[f] = Math.max(0, num(c.startMeter[f], 0, 0, 1e9));
  const so = cfg.solar;
  so.enabled = Boolean(so.enabled);
  so.lat = num(so.lat, 52.09, -90, 90);
  so.lon = num(so.lon, 5.12, -180, 180);
  so.planes = (Array.isArray(so.planes) ? so.planes : Object.values(so.planes || {})).slice(0, 2).map((p) => ({
    tilt: num(p?.tilt, 35, 0, 90),
    azimuth: num(p?.azimuth, 0, -180, 180),
    kwp: num(p?.kwp, 0, 0, 100),
  }));
  while (so.planes.length < 2) so.planes.push({ tilt: 35, azimuth: 0, kwp: 0 });
  const sg = cfg.signals;
  sg.enabled = Boolean(sg.enabled);
  sg.surplusW = num(sg.surplusW, 1000, 0, 50000);
  sg.minutes = num(sg.minutes, 5, 0, 120);
  sg.batteryFull = num(sg.batteryFull, 98, 0, 100);
  c.dalStart = Math.round(num(c.dalStart, 23, 0, 23));
  c.dalEnd = Math.round(num(c.dalEnd, 7, 0, 23));
  for (const f of ['supplier', 'description', 'start', 'end', 'salderingEinde']) c[f] = String(c[f] ?? '');
  c.saldering = Boolean(c.saldering);
  c.salderingVolgorde = c.salderingVolgorde === 'per-telwerk' ? 'per-telwerk' : 'normaal-eerst';
  c.weekendDal = Boolean(c.weekendDal);
  c.feestdagenDal = Boolean(c.feestdagenDal);
  return cfg;
}

export async function loadConfig(dir) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return sanitize(deepMerge(defaultConfig(), raw));
  } catch {
    const cfg = defaultConfig();
    await saveConfig(dir, cfg);
    return cfg;
  }
}

export async function saveConfig(dir, cfg) {
  const file = path.join(dir, 'config.json');
  await writeFile(file + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

/** Config zonder geheimen, voor de instellingenpagina. */
export function publicConfig(cfg) {
  const out = structuredClone(cfg);
  out.homey.tokenSet = Boolean(cfg.homey.token);
  out.homey.token = '';
  for (const k of METRIC_KEYS) {
    out.metrics[k].authSet = Boolean(cfg.metrics[k].auth);
    out.metrics[k].auth = '';
  }
  return out;
}

/** Nieuwe config uit het formulier; lege geheime velden behouden de oude waarde. */
export function mergeIncoming(current, incoming) {
  const next = deepMerge(defaultConfig(), incoming);
  if (!incoming?.homey?.token) next.homey.token = current.homey.token;
  for (const k of METRIC_KEYS) {
    if (!incoming?.metrics?.[k]?.auth) next.metrics[k].auth = current.metrics[k]?.auth || '';
  }
  return sanitize(next);
}
