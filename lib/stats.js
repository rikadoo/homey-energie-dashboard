const DAY = 86_400_000;
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const WEEKDAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function layout(period, now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());
  if (period === 'week') {
    const start = addDays(today, -((now.getDay() + 6) % 7));
    return {
      start, end: addDays(start, 7), fmt: '%Y-%m-%d', label: 'deze week',
      buckets: WEEKDAYS.map((l, i) => ({ key: ymd(addDays(start, i)), label: l })),
    };
  }
  if (period === 'maand') {
    const start = new Date(y, m, 1);
    const days = new Date(y, m + 1, 0).getDate();
    return {
      start, end: new Date(y, m + 1, 1), fmt: '%Y-%m-%d', label: MONTHS_LONG[m],
      buckets: Array.from({ length: days }, (_, i) => ({
        key: ymd(new Date(y, m, i + 1)),
        label: i === 0 || (i + 1) % 5 === 0 ? String(i + 1) : '',
      })),
    };
  }
  if (period === 'jaar') {
    return {
      start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), fmt: '%m', label: String(y),
      buckets: MONTHS.map((l, i) => ({ key: pad(i + 1), label: l })),
    };
  }
  return {
    start: today, end: addDays(today, 1), fmt: '%H', label: 'vandaag',
    buckets: Array.from({ length: 24 }, (_, h) => ({ key: pad(h), label: h % 3 === 0 ? pad(h) : '' })),
  };
}

export const daysBetween = (a, b) => Math.round((b - a) / DAY);
export const parseDate = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

// Nederlandse feestdagen waarop het daltarief geldt (bij de meeste netbeheerders)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
export function holidays(y) {
  const e = easter(y);
  const koning = new Date(y, 3, 27).getDay() === 0 ? new Date(y, 3, 26) : new Date(y, 3, 27);
  return [new Date(y, 0, 1), addDays(e, 1), koning, addDays(e, 39), addDays(e, 50), new Date(y, 11, 25), new Date(y, 11, 26)].map(ymd);
}

export function dalCondition(c, years = []) {
  const h = "CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER)";
  const s = Number(c.dalStart) | 0;
  const e = Number(c.dalEnd) | 0;
  let hours = '0';
  if (s > e) hours = `(${h} >= ${s} OR ${h} < ${e})`;
  else if (s < e) hours = `(${h} >= ${s} AND ${h} < ${e})`;
  const weekend = c.weekendDal ? "strftime('%w', ts, 'unixepoch', 'localtime') IN ('0', '6')" : '0';
  const days = c.feestdagenDal ? years.flatMap(holidays) : [];
  const feest = days.length ? `strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') IN (${days.map((d) => `'${d}'`).join(', ')})` : '0';
  return `(${weekend} OR ${feest} OR ${hours})`;
}

export function isDal(c, d) {
  const h = d.getHours();
  const s = c.dalStart;
  const e = c.dalEnd;
  if (c.weekendDal && (d.getDay() === 0 || d.getDay() === 6)) return true;
  if (c.feestdagenDal && holidays(d.getFullYear()).includes(ymd(d))) return true;
  if (s > e) return h >= s || h < e;
  if (s < e) return h >= s && h < e;
  return false;
}

/**
 * Energie per periode-vak en per tijdvak (voor/na de tariefwissel).
 * Afname en teruglevering komen bij voorkeur uit de meterstanden van de slimme meter
 * (verschil tussen opeenvolgende minuten, met dal/normaal zoals de meter het telt).
 * Zonder meterstanden vallen we terug op het gemeten vermogen en de daltijden uit het contract.
 * Een minuut zonder metingen telt nergens mee: er wordt nooit over een gat heen gerekend.
 */
export function energyRows(db, cfg, fmt, from, to) {
  const c = cfg.contract;
  const sw = parseDate(c.salderingEinde);
  const switchTs = sw ? Math.floor(sw / 1000) : 9e12;
  const f = Math.floor(from / 1000);
  const t = Math.floor(to / 1000);
  const dal = dalCondition(c, [new Date(from).getFullYear(), new Date(to).getFullYear()]);
  return db
    .prepare(`
      WITH m AS (
        SELECT ts, solar_w, house_w, charge_w, discharge_w, import_w, export_w,
               imp_norm - LAG(imp_norm) OVER w AS d_in, imp_dal - LAG(imp_dal) OVER w AS d_id,
               exp_norm - LAG(exp_norm) OVER w AS d_en, exp_dal - LAG(exp_dal) OVER w AS d_ed
        FROM minute WHERE ts >= ? AND ts < ? WINDOW w AS (ORDER BY ts)
      ), v AS (
        SELECT *, ${dal} AS dal,
               (d_in IS NOT NULL AND d_id IS NOT NULL AND d_en IS NOT NULL AND d_ed IS NOT NULL
                AND d_in >= 0 AND d_id >= 0 AND d_en >= 0 AND d_ed >= 0 AND d_in + d_id + d_en + d_ed < 50) AS ok
        FROM m WHERE ts >= ?
      )
      SELECT strftime(?, ts, 'unixepoch', 'localtime') AS k, (ts >= ?) AS na,
             COUNT(import_w) AS n, SUM(ok) AS nMeter,
             SUM(solar_w) / 60000.0 AS solar,
             SUM(house_w) / 60000.0 AS house,
             SUM(CASE WHEN dal THEN house_w ELSE 0 END) / 60000.0 AS houseDal,
             SUM(charge_w) / 60000.0 AS chg,
             SUM(discharge_w) / 60000.0 AS dis,
             SUM(CASE WHEN ok THEN d_in WHEN dal THEN 0 ELSE IFNULL(import_w, 0) / 60000.0 END) AS impN,
             SUM(CASE WHEN ok THEN d_id WHEN dal THEN IFNULL(import_w, 0) / 60000.0 ELSE 0 END) AS impD,
             SUM(CASE WHEN ok THEN d_en WHEN dal THEN 0 ELSE IFNULL(export_w, 0) / 60000.0 END) AS expN,
             SUM(CASE WHEN ok THEN d_ed WHEN dal THEN IFNULL(export_w, 0) / 60000.0 ELSE 0 END) AS expD
      FROM v GROUP BY k, na`)
    .all(f - 2 * 86400, t, f, fmt, switchTs);
}

/** Variabele stroomkosten voor één rij uit energyRows. */
export function stroomCosts(c, r) {
  const impN = r.impN || 0, impD = r.impD || 0;
  const exp = (r.expN || 0) + (r.expD || 0);
  const salderen = c.saldering && !r.na;
  const vergoeding = r.na ? c.terugleverKwhNa : c.terugleverKwh;
  const kosten = r.na ? c.terugleverkostenKwhNa : c.terugleverkostenKwh;
  const houseN = (r.house || 0) - (r.houseDal || 0);
  return {
    afname: impN * c.leveringNormaal + impD * c.leveringDal,
    // Tijdens salderen is teruggeleverde stroom het leveringstarief waard. Veel leveranciers verrekenen eerst
    // met het normaalverbruik ('normaal-eerst'); anderen per telwerk (normaal tegen normaal, dal tegen dal).
    terugWaarde: salderen
      ? c.salderingVolgorde === 'per-telwerk'
        ? (r.expN || 0) * c.leveringNormaal + (r.expD || 0) * c.leveringDal
        : exp * c.leveringNormaal
      : exp * vergoeding,
    terugKosten: exp * kosten,
    bespaard: Math.max(0, houseN - impN) * c.leveringNormaal + Math.max(0, (r.houseDal || 0) - impD) * c.leveringDal,
  };
}

export function summary(db, cfg, period, now = new Date(), counters = null) {
  const L = layout(period, now);
  const c = cfg.contract;
  const from = Math.floor(L.start / 1000);
  const to = Math.floor(L.end / 1000);
  const switchDate = parseDate(c.salderingEinde);
  const switchTs = switchDate ? Math.floor(switchDate / 1000) : 9e12;

  const rows = energyRows(db, cfg, L.fmt, L.start, Math.min(+L.end, +now + 60_000));

  // Gas: som van opeenvolgende meterstand-verschillen; sprongen (meterwissel, andere bron) tellen niet mee.
  const gasRows = db
    .prepare(`
      WITH g AS (
        SELECT ts, gas_m3 - LAG(gas_m3) OVER (ORDER BY ts) AS d
        FROM minute WHERE gas_m3 IS NOT NULL AND ts >= ? - 86400 AND ts < ?
      )
      SELECT strftime(?, ts, 'unixepoch', 'localtime') AS k, SUM(d) AS gas
      FROM g WHERE ts >= ? AND d > 0 AND d < 2 GROUP BY k`)
    .all(from, to, L.fmt, from);

  const byKey = new Map();
  const totals = { solar: 0, imp: 0, exp: 0, house: 0, chg: 0, dis: 0, gas: 0, impDal: 0, impNormaal: 0, expDal: 0, expNormaal: 0, minutes: 0, meterMinutes: 0 };
  const k = { afname: 0, terugWaarde: 0, terugKosten: 0, bespaard: 0 };

  for (const r of rows) {
    const b = byKey.get(r.k) || { solar: 0, house: 0 };
    b.solar += r.solar || 0;
    b.house += r.house || 0;
    byKey.set(r.k, b);
    for (const [f, src] of [['solar', 'solar'], ['house', 'house'], ['chg', 'chg'], ['dis', 'dis'], ['impNormaal', 'impN'], ['impDal', 'impD'], ['expNormaal', 'expN'], ['expDal', 'expD'], ['minutes', 'n'], ['meterMinutes', 'nMeter']]) {
      totals[f] += r[src] || 0;
    }
    const sc = stroomCosts(c, r);
    for (const key of Object.keys(k)) k[key] += sc[key];
  }
  totals.imp = totals.impNormaal + totals.impDal;
  totals.exp = totals.expNormaal + totals.expDal;
  for (const g of gasRows) totals.gas += g.gas || 0;
  const gasByKey = new Map(gasRows.map((g) => [g.k, g.gas]));

  const buckets = L.buckets.map((b) => {
    const r = byKey.get(b.key) || {};
    return { key: b.key, label: b.label, solar: r.solar || 0, house: r.house || 0, gas: gasByKey.get(b.key) || 0 };
  });

  // Vaste kosten per dag, voor de dagen in deze periode sinds de eerste meting (t/m vandaag)
  const first = db.prepare('SELECT MIN(ts) AS t FROM minute').get()?.t;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let vastDagen = 0;
  if (first != null) {
    const f = new Date(first * 1000);
    const firstDay = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    const startDay = firstDay > L.start ? firstDay : L.start;
    const lastDay = addDays(L.end, -1) < today ? addDays(L.end, -1) : today;
    vastDagen = Math.max(0, daysBetween(startDay, lastDay) + 1);
  }
  const daysInYear = daysBetween(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1));
  const vastStroom = ((c.stroomVastJaar + c.stroomNetbeheerJaar - c.verminderingEbJaar) / daysInYear) * vastDagen;
  const vastGas = ((c.gasVastJaar + c.gasNetbeheerJaar) / daysInYear) * vastDagen;

  // Saldering tot nu: alles sinds contractstart tot de wisseldatum.
  // Met meterstanden bij de start en een live meterstand is dit exact.
  let saldering = null;
  if (c.saldering) {
    const sm = c.startMeter || {};
    const cs = parseDate(c.start);
    if (counters && sm.impNormaal > 0 && sm.impDal > 0 && now < (switchDate || Infinity)) {
      const impN = counters.impNormaal - sm.impNormaal;
      const imp = impN + counters.impDal - sm.impDal;
      const exp = counters.expNormaal + counters.expDal - (sm.expNormaal || 0) - (sm.expDal || 0);
      saldering = { exp, imp, impNormaal: impN, overschot: Math.max(0, exp - imp), bron: 'meter' };
    } else {
      const rs = energyRows(db, cfg, "'x'", cs || new Date(0), Math.min(+now, switchDate ? +switchDate : Infinity));
      const t = rs.filter((r) => !r.na).reduce((a, r) => ({ imp: a.imp + (r.impN || 0) + (r.impD || 0), impN: a.impN + (r.impN || 0), exp: a.exp + (r.expN || 0) + (r.expD || 0) }), { imp: 0, impN: 0, exp: 0 });
      saldering = { exp: t.exp, imp: t.imp, impNormaal: t.impN, overschot: Math.max(0, t.exp - t.imp), bron: 'dashboard' };
    }
  }

  const stroom = k.afname - k.terugWaarde + k.terugKosten;
  const gas = totals.gas * c.gasM3;
  const salderingActief = c.saldering && (!switchDate || now < switchDate);
  const na = switchDate && now >= switchDate;
  const start = parseDate(c.start);
  const end = parseDate(c.end);

  return {
    period,
    label: L.label,
    range: { from: +L.start, to: Math.min(+L.end, +now) },
    buckets,
    totals,
    selfConsumption: totals.solar > 0 ? Math.max(0, (totals.solar - totals.exp) / totals.solar) : null,
    selfSufficiency: totals.house > 0 ? Math.max(0, (totals.house - totals.imp) / totals.house) : null,
    costs: {
      stroom,
      gas,
      netto: stroom + gas,
      vastStroom,
      vastGas,
      vast: vastStroom + vastGas,
      vastDagen,
      totaal: stroom + gas + vastStroom + vastGas,
      bespaard: k.bespaard,
      afname: k.afname,
      teruglevering: k.terugWaarde,
      terugleverkosten: k.terugKosten,
    },
    contract: {
      ...c,
      dalNu: isDal(c, now),
      terugleverNu: na ? c.terugleverKwhNa : c.terugleverKwh,
      terugleverkostenNu: na ? c.terugleverkostenKwhNa : c.terugleverkostenKwh,
      totalDays: start && end ? daysBetween(start, end) : null,
      elapsedDays: start ? Math.max(0, daysBetween(start, today)) : null,
      remainingDays: end ? Math.max(0, daysBetween(today, end)) : null,
      salderingActief,
      salderingDaysLeft: switchDate ? Math.max(0, daysBetween(today, switchDate)) : null,
      salderingStand: saldering,
    },
  };
}
