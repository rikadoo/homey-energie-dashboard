import { addDays, ymd, daysBetween, parseDate, energyRows, stroomCosts } from './stats.js';

const sec = (d) => Math.floor(d / 1000);
const years = (a, b) => {
  const out = [];
  for (let y = a.getFullYear(); y <= b.getFullYear(); y++) out.push(y);
  return out;
};

// ---------- Energiestromen (Sankey) ----------
// Per minuut: zon gaat eerst naar de batterij, dan naar het net, de rest naar het huis.
// Laden uit het net is begrensd door wat er werkelijk van het net komt; zo sluit de balans altijd.
const FLOW_SQL = `
  WITH a AS (
    SELECT solar_w AS s, import_w AS i, export_w AS e, charge_w AS c, discharge_w AS d,
           MIN(solar_w, charge_w) AS zb
    FROM minute WHERE ts >= ? AND ts < ? AND solar_w IS NOT NULL
  ), b AS (
    SELECT *, MIN(s - zb, e) AS zn, MIN(MAX(0, c - zb), i) AS nb FROM a
  ), c AS (
    SELECT *, MAX(0, s - zb - zn) AS zh, MAX(0, MIN(d, e - zn)) AS bn FROM b
  )
  SELECT SUM(zh) / 60000.0 AS zh, SUM(zb) / 60000.0 AS zb, SUM(zn) / 60000.0 AS zn,
         SUM(MAX(0, i - nb)) / 60000.0 AS nh, SUM(nb) / 60000.0 AS nb,
         SUM(MAX(0, d - bn)) / 60000.0 AS bh, SUM(bn) / 60000.0 AS bn
  FROM c`;

export function flows(db, from, to) {
  const r = db.prepare(FLOW_SQL).get(sec(from), sec(to)) || {};
  const out = {};
  for (const k of ['zh', 'zb', 'zn', 'nh', 'nb', 'bh', 'bn']) out[k] = Math.max(0, r[k] || 0);
  return out;
}

// ---------- Heatmap: kWh per uur per dag ----------

export function heatmap(db, metric, days = 28, now = new Date()) {
  const end = addDays(now, 1);
  const start = addDays(now, -(days - 1));
  const expr = {
    house: 'SUM(house_w)',
    solar: 'SUM(solar_w)',
    net: 'SUM(import_w) - SUM(export_w)',
  }[metric] || 'SUM(house_w)';
  const rows = db
    .prepare(`
      SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS d,
             CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS h,
             ${expr} / 60000.0 AS v
      FROM minute WHERE ts >= ? AND ts < ? GROUP BY d, h`)
    .all(sec(start), sec(end));
  const map = new Map(rows.map((r) => [`${r.d} ${r.h}`, r.v]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = ymd(addDays(start, i));
    out.push({ day: d, values: Array.from({ length: 24 }, (_, h) => map.get(`${d} ${h}`) ?? null) });
  }
  return { metric, days: out };
}

// ---------- Batterijdag: laadtoestand en laden/ontladen per 10 minuten ----------

export function batteryDay(db, cfg, dateStr) {
  const d = parseDate(dateStr) || new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const from = sec(day);
  const rows = db
    .prepare(`
      SELECT (ts - ?) / 600 AS slot, AVG(soc) AS soc,
             SUM(charge_w) / 60000.0 AS chg, SUM(discharge_w) / 60000.0 AS dis
      FROM minute WHERE ts >= ? AND ts < ? GROUP BY slot`)
    .all(from, from, sec(addDays(day, 1)));
  const slots = Array.from({ length: 144 }, () => ({ soc: null, chg: 0, dis: 0 }));
  let chg = 0, dis = 0;
  for (const r of rows) {
    if (r.slot < 0 || r.slot > 143) continue;
    slots[r.slot] = { soc: r.soc, chg: r.chg || 0, dis: r.dis || 0 };
    chg += r.chg || 0;
    dis += r.dis || 0;
  }
  const socs = slots.map((s) => s.soc).filter((v) => v != null);
  const cap = cfg.battery.capacityKwh || 0;
  return {
    date: ymd(day),
    slots,
    charged: chg,
    discharged: dis,
    cycles: cap ? dis / cap : null,
    efficiency: chg > 0.2 ? dis / chg : null,
    socMin: socs.length ? Math.min(...socs) : null,
    socMax: socs.length ? Math.max(...socs) : null,
  };
}

// ---------- Wat kost het einde van de saldering? ----------

export function salderingCompare(db, cfg, now = new Date()) {
  const c = cfg.contract;
  const from = addDays(now, -30);
  const rows = energyRows(db, cfg, "'x'", from, now);
  const t = rows.reduce(
    (a, r) => ({ n: a.n + (r.n || 0), impN: a.impN + (r.impN || 0), impD: a.impD + (r.impD || 0), exp: a.exp + (r.expN || 0) + (r.expD || 0), expD: a.expD + (r.expD || 0) }),
    { n: 0, impN: 0, impD: 0, exp: 0, expD: 0 },
  );
  const days = t.n / 1440;
  if (days < 1) return { ok: false, days };
  const f = flows(db, from, now);
  const scale = 30 / days;
  const impN = t.impN * scale;
  const impD = t.impD * scale;
  const exp = t.exp * scale;
  const zb = f.zb * scale;
  const bh = f.bh * scale;
  const importCost = impN * c.leveringNormaal + impD * c.leveringDal;

  const expD = t.expD * scale;
  const salderWaarde = c.salderingVolgorde === 'per-telwerk' ? (exp - expD) * c.leveringNormaal + expD * c.leveringDal : exp * c.leveringNormaal;
  const met = importCost - salderWaarde + exp * c.terugleverkostenKwh;
  const zonder = importCost - exp * c.terugleverKwhNa + exp * c.terugleverkostenKwhNa;
  // Zonder batterij: wat de batterij uit zon laadde, was teruggeleverd; wat hij aan het huis gaf, kwam van het net
  const exp2 = exp + zb;
  const zonderBatt = importCost + bh * c.leveringNormaal - exp2 * c.terugleverKwhNa + exp2 * c.terugleverkostenKwhNa;
  return {
    ok: true,
    days,
    perMonth: { metSaldering: met, zonderSaldering: zonder, zonderSalderingZonderBatterij: zonderBatt },
    kwh: { imp: impN + impD, exp, zb, bh },
  };
}

// ---------- Jaarnota-voorspelling ----------

const norm = (a) => {
  const s = a.reduce((x, y) => x + y, 0);
  return a.map((v) => v / s);
};
// Globale seizoensprofielen per maand (jan–dec) voor een woning met zonnepanelen en batterij
const PROFILE = {
  imp: norm([14, 12, 9, 6, 4, 3.5, 3.5, 4, 6, 9, 12, 14]),
  exp: norm([2, 4, 8, 11.5, 13, 13, 13, 11.5, 9, 6, 3, 2]),
  gas: norm([16.5, 14, 12, 8, 4.5, 2.5, 2, 2, 3.5, 7.5, 11.5, 15.5]),
};
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const dayWeight = (p, d) => p[d.getMonth()] / dim(d.getFullYear(), d.getMonth());

export function jaarnota(db, cfg, now = new Date()) {
  const c = cfg.contract;
  const start = parseDate(c.start);
  const end = parseDate(c.end);
  const sw = parseDate(c.salderingEinde) || new Date(9e15);
  if (!start || !end || end <= start) return { ok: false, reason: 'Vul de start- en einddatum van je contract in.' };
  const totalDays = daysBetween(start, end);
  const until = new Date(Math.min(+now, +end));

  // 1. Live gemeten door het dashboard (meterstanden waar mogelijk), per maand voor de seizoensgewichten
  const rows = energyRows(db, cfg, '%Y-%m', start, until);
  const k = { 1: { n: 0, d: 0, e: 0, eD: 0 }, 2: { n: 0, d: 0, e: 0, eD: 0 } };
  const W = { imp: 0, exp: 0, gas: 0 };
  let liveMinutes = 0;
  for (const r of rows) {
    const [y, m] = r.k.split('-').map(Number);
    const days = (r.n || 0) / 1440;
    liveMinutes += r.n || 0;
    for (const key of ['imp', 'exp', 'gas']) W[key] += (days * PROFILE[key][m - 1]) / dim(y, m - 1);
    const t = k[r.na ? 2 : 1];
    t.n += r.impN || 0;
    t.d += r.impD || 0;
    t.e += (r.expN || 0) + (r.expD || 0);
    t.eD += r.expD || 0;
  }
  const gasRow = db
    .prepare(`
      WITH g AS (SELECT ts, gas_m3 - LAG(gas_m3) OVER (ORDER BY ts) AS d FROM minute WHERE gas_m3 IS NOT NULL AND ts >= ? AND ts < ?)
      SELECT SUM(d) AS gas FROM g WHERE d > 0 AND d < 2`)
    .get(Math.floor(start / 1000), Math.floor(until / 1000));
  let gasKnown = gasRow?.gas || 0;
  const liveDays = liveMinutes / 1440;

  // 2. Van contractstart tot de eerste meting: exact uit de meterstanden, als die zijn ingevuld
  const sm = c.startMeter || {};
  const first = db.prepare('SELECT * FROM day_counters ORDER BY day LIMIT 1').get();
  let readingDays = 0;
  if (first && sm.impNormaal > 0 && sm.impDal > 0) {
    const firstDay = parseDate(first.day);
    const gap = {
      n: first.imp_normaal - sm.impNormaal,
      d: first.imp_dal - sm.impDal,
      e: first.exp_normaal - (sm.expNormaal || 0) + (first.exp_dal - (sm.expDal || 0)),
      eD: first.exp_dal - (sm.expDal || 0),
      g: sm.gas > 0 && first.gas != null ? first.gas - sm.gas : null,
    };
    if (firstDay > start && firstDay <= now && gap.n >= 0 && gap.d >= 0 && gap.e >= 0) {
      const t = firstDay < sw ? k[1] : k[2];
      t.n += gap.n;
      t.d += gap.d;
      t.e += gap.e;
      t.eD += gap.eD;
      if (gap.g != null && gap.g >= 0) gasKnown += gap.g;
      for (let d = new Date(start); d < firstDay; d = addDays(d, 1)) {
        W.imp += dayWeight(PROFILE.imp, d);
        W.exp += dayWeight(PROFILE.exp, d);
        if (gap.g != null) W.gas += dayWeight(PROFILE.gas, d);
      }
      readingDays = daysBetween(start, firstDay);
    }
  }
  const measuredDays = readingDays + liveDays;
  if (measuredDays < 7) {
    return { ok: false, reason: `Nog te weinig gegevens (${Math.floor(measuredDays)} van de 7 dagen). Vul de meterstanden bij contractstart in, of wacht een week.`, measuredDays };
  }

  // 3. Jaartempo: gemeten deel, gemengd met het verbruik van vorig jaar zolang er weinig van het jaar gemeten is
  const impKnown = k[1].n + k[1].d + k[2].n + k[2].d;
  const expKnown = k[1].e + k[2].e;
  const fDal = impKnown > 0 ? (k[1].d + k[2].d) / impKnown : 0.4;
  const fExpDal = expKnown > 0 ? (k[1].eD + k[2].eD) / expKnown : 0.25;
  const vj = c.vorigJaar || {};
  const blend = (known, w, prev) => {
    const measured = w > 0 ? known / w : 0;
    if (!(prev > 0)) return measured;
    const wt = Math.min(1, w); // aandeel van het jaar dat gemeten is, naar seizoensgewicht
    return wt * measured + (1 - wt) * prev;
  };
  const annual = { imp: blend(impKnown, W.imp, vj.imp), exp: blend(expKnown, W.exp, vj.exp), gas: blend(gasKnown, W.gas, vj.gas) };

  // 4. Rest van het contractjaar schatten met het seizoensprofiel
  const rest = { 1: { imp: 0, exp: 0 }, 2: { imp: 0, exp: 0 }, gas: 0 };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayFrac = today >= start && today < end ? 1 - (now - today) / 86_400_000 : 0;
  const addDay = (d, frac) => {
    const t = d < sw ? 1 : 2;
    rest[t].imp += annual.imp * dayWeight(PROFILE.imp, d) * frac;
    rest[t].exp += annual.exp * dayWeight(PROFILE.exp, d) * frac;
    rest.gas += annual.gas * dayWeight(PROFILE.gas, d) * frac;
  };
  if (todayFrac > 0) addDay(today, todayFrac);
  for (let d = today > start ? addDays(today, 1) : start; d < end; d = addDays(d, 1)) addDay(d, 1);

  const p1 = { n: k[1].n + rest[1].imp * (1 - fDal), d: k[1].d + rest[1].imp * fDal, e: k[1].e + rest[1].exp };
  const p2 = { n: k[2].n + rest[2].imp * (1 - fDal), d: k[2].d + rest[2].imp * fDal, e: k[2].e + rest[2].exp };

  // Tot de wisseldatum: salderen over de hele periode, eerst met normaal, dan met dal; overschot krijgt vergoeding
  let stroom1;
  if (c.saldering) {
    let offN, offD;
    if (c.salderingVolgorde === 'per-telwerk') {
      const eD = p1.e * fExpDal, eN = p1.e - eD;
      offN = Math.min(eN, p1.n);
      offD = Math.min(eD, p1.d);
      // Wat over is van het ene telwerk, verrekenen met het andere
      const restE = p1.e - offN - offD;
      const extraN = Math.min(restE, p1.n - offN);
      offN += extraN;
      offD += Math.min(restE - extraN, p1.d - offD);
    } else {
      offN = Math.min(p1.e, p1.n);
      offD = Math.min(p1.e - offN, p1.d);
    }
    const overschot = p1.e - offN - offD;
    stroom1 = (p1.n - offN) * c.leveringNormaal + (p1.d - offD) * c.leveringDal - overschot * c.terugleverKwh + p1.e * c.terugleverkostenKwh;
  } else {
    stroom1 = stroomCosts(c, { impN: p1.n, impD: p1.d, expN: p1.e, na: 0 });
    stroom1 = stroom1.afname - stroom1.terugWaarde + stroom1.terugKosten;
  }
  const s2 = stroomCosts(c, { impN: p2.n, impD: p2.d, expN: p2.e, na: 1 });
  const stroom2 = s2.afname - s2.terugWaarde + s2.terugKosten;
  const gasM3 = gasKnown + rest.gas;
  const gas = gasM3 * c.gasM3;
  const vast = ((c.stroomVastJaar + c.stroomNetbeheerJaar + c.gasVastJaar + c.gasNetbeheerJaar) / 365) * totalDays;
  const eb = (c.verminderingEbJaar / 365) * totalDays;
  const total = stroom1 + stroom2 + gas + vast - eb;
  const months = Math.round(totalDays / 30.44);
  const termijnen = months * c.termijnbedrag;

  return {
    ok: true,
    total,
    parts: { stroom: stroom1 + stroom2, gas, vast, eb },
    kwh: { imp: p1.n + p1.d + p2.n + p2.d, exp: p1.e + p2.e, gas: gasM3 },
    termijnen,
    months,
    bonus: c.bonus,
    saldo: termijnen + c.bonus - total,
    measuredDays,
    readingDays,
    liveDays,
    totalDays,
    elapsedDays: Math.min(totalDays, Math.max(0, daysBetween(start, today))),
    usedReadings: readingDays > 0,
    usedLastYear: vj.imp > 0 || vj.gas > 0,
    gasOnlySummer: W.gas < 0.25, // nog geen stookseizoen gemeten
  };
}
