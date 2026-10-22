import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Sources } from './sources.js';

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'energie.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS minute (
      ts          INTEGER PRIMARY KEY,  -- begin van de minuut (unix seconden)
      solar_w     REAL,                 -- gemiddeld vermogen in watt
      import_w    REAL,
      export_w    REAL,
      charge_w    REAL,
      discharge_w REAL,
      house_w     REAL,
      soc         REAL,                 -- laatste laadtoestand in %
      gas_m3      REAL                  -- laatste gasmeterstand
    );
    -- Meterstanden van de slimme meter, eerste stand van elke dag
    CREATE TABLE IF NOT EXISTS day_counters (
      day         TEXT PRIMARY KEY,     -- YYYY-MM-DD (lokale tijd)
      imp_dal     REAL,
      imp_normaal REAL,
      exp_dal     REAL,
      exp_normaal REAL,
      gas         REAL
    );
  `);
  // Versie 2: meterstanden per minuut, zodat afname en teruglevering uit de meter zelf komen
  const cols = db.prepare('PRAGMA table_info(minute)').all().map((c) => c.name);
  for (const c of ['imp_dal', 'imp_norm', 'exp_dal', 'exp_norm']) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE minute ADD COLUMN ${c} REAL`);
  }
  // Versie 3: eerder opgeslagen onmogelijke batterijwaarden eenmalig corrigeren
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 3) {
    const rows = db.prepare('SELECT ts, solar_w, import_w, export_w, charge_w, discharge_w FROM minute WHERE solar_w IS NOT NULL').all();
    const upd = db.prepare('UPDATE minute SET charge_w = ?, discharge_w = ?, house_w = ? WHERE ts = ?');
    db.exec('BEGIN');
    for (const r of rows) {
      const fixed = plausibleBattery(r.solar_w, (r.import_w || 0) - (r.export_w || 0), (r.charge_w || 0) - (r.discharge_w || 0));
      const house = Math.max(0, r.solar_w + (r.import_w || 0) - (r.export_w || 0) - fixed.batt);
      upd.run(Math.max(0, fixed.batt), Math.max(0, -fixed.batt), house, r.ts);
    }
    db.exec('COMMIT; PRAGMA user_version = 3');
  }
  return db;
}

const MIN_HOUSE_W = 50; // een huis verbruikt altijd iets

/**
 * Corrigeert batterijwaarden die natuurkundig niet kunnen (bijv. een verouderde waarde uit een cloud-koppeling):
 * - laden kan niet met meer vermogen dan er van zon en net binnenkomt;
 * - bij een batterij met nul-op-de-meter-regeling (noExport) levert de batterij niet terug aan het net.
 * grid: + = afname, − = teruglevering. batt: + = laden, − = ontladen.
 */
export function plausibleBattery(solar, grid, batt, noExport = true) {
  let b = batt;
  if (b > 0) {
    const available = Math.max(0, solar + grid - MIN_HOUSE_W);
    if (b > available) b = available;
  } else if (b < 0 && noExport) {
    const exp = Math.max(0, -grid);
    const fromBattery = Math.max(0, exp - solar); // teruglevering die niet uit de zon kan komen
    b = Math.min(0, b + fromBattery);
  }
  return { batt: b, corrected: Math.abs(b - batt) > 30 };
}

const pos = (v) => (v != null && v > 0 ? v : 0);

export class Collector {
  constructor(db, getConfig) {
    this.db = db;
    this.getConfig = getConfig;
    this.sources = new Sources();
    this.gen = 0;
    this.bucket = null;
    this.live = { ts: null, values: {}, errors: {}, configured: false };
    this.insert = db.prepare(`INSERT OR REPLACE INTO minute
      (ts, solar_w, import_w, export_w, charge_w, discharge_w, house_w, soc, gas_m3, imp_dal, imp_norm, exp_dal, exp_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertCounters = db.prepare('INSERT OR IGNORE INTO day_counters VALUES (?, ?, ?, ?, ?, ?)');
    this.history = []; // live metingen van het laatste uur
    this.counters = null;
    this.listeners = new Set();
  }

  start() {
    this.reconfigure();
  }

  reconfigure() {
    clearTimeout(this.timer);
    this.sources.configure(this.getConfig());
    this.loop(++this.gen);
  }

  async loop(gen) {
    const cfg = this.getConfig();
    try {
      await this.tick(cfg);
    } catch (e) {
      console.error('Meting mislukt:', e);
    }
    if (gen === this.gen) this.timer = setTimeout(() => this.loop(gen), cfg.refreshSeconds * 1000);
  }

  async tick(cfg) {
    const { values: v, errors, updated } = await this.sources.readAll(cfg);
    const configured = Object.values(cfg.metrics).some((m) => m.source !== 'none');
    const hasData = v.solar_w != null || v.grid_w != null;

    const solar = pos(v.solar_w);
    const grid = v.grid_w ?? 0;
    const fix = plausibleBattery(solar, grid, v.battery_w ?? 0, cfg.battery.noExport);
    const batt = fix.batt;
    const house = Math.max(0, solar + grid - batt);

    this.live = {
      ts: Date.now(),
      configured,
      refreshSeconds: cfg.refreshSeconds,
      values: {
        solar_w: v.solar_w != null ? solar : null,
        grid_w: v.grid_w ?? null,
        battery_w: v.battery_w != null ? batt : null,
        battery_w_raw: v.battery_w ?? null,
        battery_soc: v.battery_soc ?? null,
        gas_m3: v.gas_m3 ?? null,
        house_w: hasData ? house : null,
      },
      errors,
      updated, // per meetwaarde: wanneer de bron hem voor het laatst wijzigde
      batteryCorrected: v.battery_w != null && fix.corrected,
      has: {
        battery: cfg.metrics.battery_w.source !== 'none' || cfg.metrics.battery_soc.source !== 'none',
        gas: cfg.metrics.gas_m3.source !== 'none',
        solar: cfg.metrics.solar_w.source !== 'none',
      },
      battery: cfg.battery,
    };

    // Meterstanden uit de Energy Dongle (alleen bij een directe dongle-verbinding)
    const d = this.sources.dongle;
    let meter = null;
    if (d?.latest && Date.now() - d.latestAt < 60_000 && d.latest.import_normaal_kwh != null) {
      const l = d.latest;
      meter = { impDal: l.import_dal_kwh, impNormaal: l.import_normaal_kwh, expDal: l.export_dal_kwh, expNormaal: l.export_normaal_kwh, gas: l.gas_m3 };
      this.counters = meter;
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      this.insertCounters.run(day, l.import_dal_kwh, l.import_normaal_kwh, l.export_dal_kwh, l.export_normaal_kwh, l.gas_m3);
    }

    if (hasData || v.gas_m3 != null || meter) this.accumulate({ solar, grid, batt, house, soc: v.battery_soc, gas: v.gas_m3, hasData, meter });

    if (hasData) {
      this.history.push({ t: this.live.ts, s: Math.round(solar), g: Math.round(grid), b: Math.round(batt), h: Math.round(house), soc: v.battery_soc ?? null });
      const cutoff = Date.now() - 3_600_000;
      while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    }

    for (const fn of this.listeners) {
      Promise.resolve()
        .then(() => fn(this.live, cfg))
        .catch((e) => console.error('Listener fout:', e.message));
    }
  }

  accumulate(s) {
    const minute = Math.floor(Date.now() / 60_000) * 60;
    if (this.bucket && this.bucket.ts !== minute) this.flush();
    if (!this.bucket) this.bucket = { ts: minute, n: 0, solar: 0, imp: 0, exp: 0, chg: 0, dis: 0, house: 0, soc: null, gas: null, meter: null };
    const b = this.bucket;
    if (s.hasData) {
      b.n++;
      b.solar += s.solar;
      b.imp += pos(s.grid);
      b.exp += pos(-s.grid);
      b.chg += pos(s.batt);
      b.dis += pos(-s.batt);
      b.house += s.house;
    }
    if (s.soc != null) b.soc = s.soc;
    if (s.gas != null) b.gas = s.gas;
    if (s.meter) b.meter = s.meter;
  }

  flush() {
    const b = this.bucket;
    this.bucket = null;
    if (!b) return;
    const avg = (x) => (b.n ? x / b.n : null);
    const m = b.meter || {};
    this.insert.run(b.ts, avg(b.solar), avg(b.imp), avg(b.exp), avg(b.chg), avg(b.dis), avg(b.house), b.soc, b.gas,
      m.impDal ?? null, m.impNormaal ?? null, m.expDal ?? null, m.expNormaal ?? null);
  }

  stop() {
    this.gen++;
    clearTimeout(this.timer);
    this.flush();
    this.sources.close();
  }
}
