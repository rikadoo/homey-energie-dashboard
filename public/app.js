import { renderLive as renderLiveChart, renderSolar, renderSankey, renderBatteryDay, renderHeatmap, renderJaarnota, renderSaldering } from './charts.js';
import { initI18n, applyStatic, t, nf, money, time, dateLong, LOCALE, ui } from './i18n.js';

await initI18n();
// Eerste keer: naar de installatiewizard
if (!ui.setupDone) {
  location.replace('/setup');
  await new Promise(() => {}); // niets meer laden tijdens het doorsturen
}
applyStatic();
const NL = () => ui.country === 'NL';

const $ = (id) => document.getElementById(id);
const kw = (w) => `${nf(w / 1000, 2)} kW`;
const THRESHOLD = 15; // watt; kleinere stromen tonen we niet als actief

let period = 'dag';
let lastSolar = null; // laatste zonnevoorspelling, voor "vol rond"
let has = { battery: true, gas: true, solar: true }; // welke bronnen gekoppeld zijn
let refresh = 10;

$('notice').innerHTML = t('Er zijn nog geen bronnen gekoppeld. <a href="/settings">Open de instellingen</a> om je Homey of Energy Dongle toe te voegen.');
$('notice-tariffs').innerHTML = t('Je energietarieven zijn nog niet ingevuld, dus de kosten staan op 0. <a href="/settings">Vul je contract in</a> bij de instellingen.');
if (!NL()) $('saldering-card').hidden = true;

// Resterende voorspelde opwek vandaag (kWh) en het laatste moment met zon
function solarRestToday() {
  if (!lastSolar?.watts?.length) return null;
  const now = Date.now();
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const pts = lastSolar.watts.map(([tt, w]) => [new Date(tt).getTime(), w]).filter(([tt]) => tt <= +end);
  let kwh = 0;
  let sunset = null;
  for (let i = 1; i < pts.length; i++) {
    const [t0, w0] = pts[i - 1];
    const [t1, w1] = pts[i];
    if (t1 <= now) continue;
    const a = Math.max(t0, now);
    kwh += (((w0 + w1) / 2) * (t1 - a)) / 3.6e9;
  }
  for (const [tt, w] of pts) if (w > 50 && new Date(tt).toDateString() === new Date().toDateString()) sunset = tt;
  return { kwh, sunset };
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setStatus(kind, text, title = '', html = false) {
  $('status-dot').className = `dot ${kind}`;
  $('status-text')[html ? 'innerHTML' : 'textContent'] = text;
  $('status').title = title;
}

function setFlow(name, watts) {
  const on = watts >= THRESHOLD;
  $(`p-${name}`).classList.toggle('on', on);
  $(`t-${name}`).textContent = on ? kw(watts) : '';
}

// ---------- Live ----------

function renderLive(d) {
  $('notice').hidden = d.configured;
  if (d.has) {
    const changed = d.has.battery !== has.battery || d.has.gas !== has.gas;
    has = d.has;
    // Zonder batterij: kaarten verbergen en de batterij in het schema dimmen
    $('batt-card').hidden = !has.battery;
    $('battery-day-card').hidden = !has.battery;
    $('batt-node').style.opacity = has.battery ? '1' : '0.3';
    if (changed) loadSummary();
  }
  refresh = d.refreshSeconds || refresh;
  const errs = Object.keys(d.errors || {});
  if (!d.configured) setStatus('', t('Geen bronnen gekoppeld'));
  else if (!d.ts) setStatus('', t('Wachten op eerste meting'));
  else if (errs.length) {
    const names = { solar_w: t('Zon'), grid_w: t('Net'), battery_w: t('Batterij'), battery_soc: t('Laadtoestand'), gas_m3: t('Gas') };
    const list = errs.map((k) => names[k] || k);
    setStatus('warn', t('Fout bij {list}', { list: list.join(', ') }), errs.map((k) => `${names[k] || k}: ${d.errors[k]}`).join('\n'));
  } else setStatus('ok', t('Live, <span class="hide-sm">bijgewerkt </span>{time}', { time: time(new Date(d.ts)) }), '', true);

  const v = d.values || {};
  const s = Math.max(0, v.solar_w ?? 0);
  const g = v.grid_w ?? 0;
  const b = v.battery_w ?? 0;
  const h = v.house_w ?? 0;
  const imp = Math.max(g, 0), exp = Math.max(-g, 0), chg = Math.max(b, 0), dis = Math.max(-b, 0);

  // Verdeel de stromen: zon gaat eerst naar batterij, dan naar net (teruglevering), rest naar huis.
  const zb = Math.min(s, chg);
  const zn = Math.min(s - zb, exp);
  const zh = Math.max(0, s - zb - zn);
  const bh = Math.max(0, dis - Math.max(0, exp - zn));
  const nh = Math.max(0, imp - Math.max(0, chg - zb));
  setFlow('zh', zh);
  setFlow('zb', zb);
  setFlow('zn', zn);
  setFlow('bh', bh);
  setFlow('nh', nh);

  $('v-solar').textContent = v.solar_w == null ? '–' : kw(s);
  $('v-house').textContent = v.house_w == null ? '–' : kw(h);
  $('v-grid').textContent = v.grid_w == null ? '–' : exp > 0 ? `−${kw(exp)}` : kw(imp);
  $('l-grid').textContent = v.grid_w == null ? t('Net') : exp >= THRESHOLD ? t('Teruglevering') : imp >= THRESHOLD ? t('Afname net') : t('Net');
  $('flow-summary').textContent = h > THRESHOLD ? t('Eigen energie dekt {pct}% van je huis', { pct: Math.round(Math.min(1, (zh + bh) / h) * 100) }) : '';

  // Batterij
  const bat = d.battery || {};
  const cap = bat.capacityKwh || 0;
  const soc = v.battery_soc;
  $('batt-name').textContent = bat.name || t('Thuisbatterij');
  $('batt-cap').textContent = cap ? t('van {kwh} kWh', { kwh: nf(cap, 1) }) : '';
  $('l-batt').textContent = chg >= THRESHOLD ? t('Batterij laadt') : dis >= THRESHOLD ? t('Batterij ontlaadt') : t('Batterij');
  const sign = chg >= THRESHOLD ? '+' : dis >= THRESHOLD ? '−' : '';
  const pw = v.battery_w == null ? '' : `${sign}${kw(Math.abs(b))}`;
  $('v-batt').textContent = [pw, soc != null ? `${Math.round(soc)}%` : ''].filter(Boolean).join(', ') || '–';

  if (soc != null) {
    $('soc').textContent = `${Math.round(soc)}%`;
    $('ring').style.opacity = '1';
    $('ring').setAttribute('stroke-dasharray', `${(2 * Math.PI * 54 * Math.min(100, Math.max(0, soc))) / 100} 340`);
    $('batt-fill').setAttribute('width', String(Math.max(1, (20 * soc) / 100)));
    $('batt-kwh').textContent = cap ? nf((soc / 100) * cap, 1) : `${Math.round(soc)}%`;
  }
  let state = t('In rust'), eta = '';
  if (chg >= THRESHOLD) {
    state = t('Laden, +{kw}', { kw: kw(chg) });
    if (soc != null && cap && soc < 99) {
      const need = ((100 - soc) / 100) * cap;
      const at = Date.now() + (need / (chg / 1000)) * 3.6e6;
      const sun = solarRestToday();
      // Alleen "vol rond" tonen als dat met de resterende zon van vandaag haalbaar is
      const reachable = sun
        ? sun.sunset != null && at <= sun.sunset && need <= sun.kwh * 0.8
        : new Date(at).toDateString() === new Date().toDateString() && new Date(at).getHours() < 19;
      eta = reachable ? t('Vol rond {time}', { time: time(new Date(at)) }) : t('Wordt vandaag waarschijnlijk niet vol');
    }
  } else if (dis >= THRESHOLD) {
    state = t('Ontladen, −{kw}', { kw: kw(dis) });
    if (soc != null && cap && soc > 1) {
      const hrs = ((soc / 100) * cap) / (dis / 1000);
      if (hrs < 24) eta = t('Leeg rond {time}', { time: time(new Date(Date.now() + hrs * 3.6e6)) });
    }
  }
  $('batt-state').textContent = v.battery_w == null ? '' : state + (d.batteryCorrected ? ` (${t('gecorrigeerd')})` : '');
  $('batt-eta').textContent = eta;

  // Laat zien als de batterijgegevens oud zijn (bijv. vertraging van een cloud-koppeling)
  const upd = Math.max(d.updated?.battery_w || 0, d.updated?.battery_soc || 0);
  const stale = $('batt-stale');
  if (upd && Date.now() - upd > 5 * 60_000) {
    stale.textContent = t('Batterijgegevens van {time}', { time: time(new Date(upd)) });
    stale.hidden = false;
  } else stale.hidden = true;
}

async function loadLive() {
  try {
    renderLive(await getJSON('/api/live'));
  } catch {
    setStatus('warn', t('Server niet bereikbaar'));
  } finally {
    setTimeout(loadLive, refresh * 1000);
  }
}

// ---------- Overzicht ----------

function periodLabel(p) {
  const now = new Date();
  if (p === 'week') return t('deze week');
  if (p === 'maand') return now.toLocaleDateString(LOCALE, { month: 'long' });
  if (p === 'jaar') return String(now.getFullYear());
  return t('vandaag');
}

function bucketLabel(p, key, i) {
  if (p === 'dag') return i % 3 === 0 ? key : '';
  if (p === 'week') return new Date(`${key}T12:00:00`).toLocaleDateString(LOCALE, { weekday: 'short' });
  if (p === 'maand') return i === 0 || (i + 1) % 5 === 0 ? String(i + 1) : '';
  return new Date(2000, Number(key) - 1, 1).toLocaleDateString(LOCALE, { month: 'short' });
}

function renderToday(s) {
  const c = s.costs;
  const total = $('today-total');
  total.textContent = money(c.totaal);
  total.classList.toggle('pos', c.totaal < 0);
  $('today-saved').textContent = money(c.bespaard);
  $('today-split').textContent = has.gas
    ? t('Stroom {a}, gas {b}, vaste kosten {c}', { a: money(c.stroom), b: money(c.gas), c: money(c.vast) })
    : t('Stroom {a}, vaste kosten {c}', { a: money(c.stroom), c: money(c.vast) });
}

function kpi(label, value, unit, color, sub) {
  const el = document.createElement('div');
  el.className = 'kpi';
  el.innerHTML = `<div class="kpi-label"><span class="dot"></span><span></span></div><div class="kpi-value"><span></span> <span class="unit"></span></div><div class="muted small"></div>`;
  el.querySelector('.dot').style.background = color;
  el.querySelector('.kpi-label span:last-child').textContent = label;
  el.querySelector('.kpi-value span:first-child').textContent = value;
  el.querySelector('.kpi-value .unit').textContent = unit;
  el.querySelector('.small').textContent = sub;
  return el;
}

function renderSummary(s) {
  const label = periodLabel(s.period);
  $('overview-title').textContent = t('Overzicht {label}', { label });
  const d = s.period === 'maand' || s.period === 'jaar' ? 0 : 1;
  const tot = s.totals;
  const pct = (x) => (x == null ? '–' : String(Math.round(x * 100)));
  const exportSub = NL() && s.contract.salderingActief
    ? t('{a} gesaldeerd, {b} kosten', { a: money(s.costs.teruglevering), b: money(s.costs.terugleverkosten) })
    : s.costs.terugleverkosten > 0
      ? t('{a} vergoeding, {b} kosten', { a: money(s.costs.teruglevering), b: money(s.costs.terugleverkosten) })
      : t('{a} vergoeding', { a: money(s.costs.teruglevering) });

  $('kpis').replaceChildren(
    kpi(t('Opwek'), nf(tot.solar, d), 'kWh', 'var(--sun)', s.selfConsumption == null ? t('Nog geen opwek') : t('Zelf verbruikt {pct}%', { pct: pct(s.selfConsumption) })),
    kpi(t('Verbruik'), nf(tot.house, d), 'kWh', 'var(--house)', has.gas ? t('Gas {m3} m³', { m3: nf(tot.gas, d) }) : t('Stroom in huis')),
    kpi(t('Teruglevering'), nf(tot.exp, d), 'kWh', 'var(--grid)', exportSub),
    kpi(t('Afname net'), nf(tot.imp, d), 'kWh', 'var(--grid)', t('{cost}, waarvan {kwh} kWh dal', { cost: money(s.costs.afname), kwh: nf(tot.impDal, d) })),
    kpi(t('Zelfvoorzienend'), pct(s.selfSufficiency), '%', 'var(--batt)', t('Uit zon en batterij')),
  );

  // Grafiek: opwek omhoog, verbruik omlaag, zelfde schaal.
  const max = Math.max(0.001, ...s.buckets.map((b) => Math.max(b.solar, b.house)));
  const unit = s.period === 'jaar' || s.period === 'maand' ? 0 : 2;
  $('chart').replaceChildren(
    ...s.buckets.map((b, i) => {
      const lbl = bucketLabel(s.period, b.key, i);
      const col = document.createElement('div');
      col.className = 'col';
      col.title = t('{label} opwek {s} kWh, verbruik {h} kWh', { label: lbl, s: nf(b.solar, unit), h: nf(b.house, unit) }).trim();
      col.innerHTML = '<div class="up"><div class="bar sun"></div></div><div class="base"></div><div class="down"><div class="bar use"></div></div><div class="lbl"></div>';
      const hh = (v) => (v > 0 ? `${Math.max(1.5, (v / max) * 96)}%` : '0');
      col.querySelector('.sun').style.height = hh(b.solar);
      col.querySelector('.use').style.height = hh(b.house);
      col.querySelector('.lbl').textContent = lbl;
      return col;
    }),
  );

  $('notice-tariffs').hidden = !(s.contract.leveringNormaal === 0 && s.contract.leveringDal === 0);

  // Energiestromen
  $('sankey-label').textContent = label;
  if (s.flows) renderSankey($('sankey'), s.flows);

  // Contract
  const c = s.contract;
  $('c-supplier').textContent = c.supplier || t('Contract');
  $('c-desc').textContent = c.description ? t(c.description) : '';
  $('c-start').textContent = dateLong(c.start);
  $('c-end').textContent = dateLong(c.end);
  $('c-progress').style.width = c.totalDays ? `${Math.min(100, (c.elapsedDays / c.totalDays) * 100)}%` : '0';
  $('c-days').textContent = c.totalDays ? t('{a} dagen verstreken, nog {b} dagen', { a: c.elapsedDays, b: c.remainingDays }) : t('Vul de looptijd in bij instellingen');

  const parts = [];
  if (c.termijnbedrag) parts.push(t('Termijnbedrag {a} per maand', { a: money(c.termijnbedrag) }));
  if (c.bonus) parts.push(t('bonus {a} op je jaarafrekening', { a: money(c.bonus) }));
  $('c-termijn').textContent = parts.join(', ');

  const fillList = (el, rows) => {
    el.innerHTML = '';
    for (const [lbl, value, cls] of rows) {
      const row = document.createElement('div');
      if (cls) row.className = cls;
      row.innerHTML = '<dt></dt><dd></dd>';
      row.firstChild.textContent = lbl;
      row.lastChild.textContent = value;
      el.append(row);
    }
  };
  const tarief = (v, u = 'kWh') => `${money(v, 5)} /${u}`;
  fillList($('c-tariffs'), [
    [NL() ? t('Levering normaal') : t('Tarief dag'), tarief(c.leveringNormaal), c.dalNu ? '' : 'now'],
    [NL() ? t('Levering dal') : t('Tarief nacht'), tarief(c.leveringDal), c.dalNu ? 'now' : ''],
    [t('Terugleververgoeding'), tarief(c.terugleverNu)],
    NL() || c.terugleverkostenNu > 0 ? [t('Terugleverkosten'), tarief(c.terugleverkostenNu)] : null,
    has.gas ? [t('Gas'), tarief(c.gasM3, 'm³')] : null,
  ].filter(Boolean));

  const k = s.costs;
  $('c-costs-title').textContent = t('Kosten {label}', { label });
  fillList($('c-costs'), [
    [t('Stroom'), money(k.stroom)],
    has.gas ? [t('Gas'), money(k.gas)] : null,
    [k.vastDagen === 1 ? t('Vaste kosten (1 dag)') : t('Vaste kosten ({n} dagen)', { n: k.vastDagen }), money(k.vast)],
    [t('Totaal'), money(k.totaal), 'sum'],
  ].filter(Boolean));

  const sal = $('c-saldering');
  if (NL() && c.saldering && c.salderingActief) {
    sal.innerHTML = `<div><strong>${t('Saldering stopt')}</strong><span class="small"></span><span class="small muted"></span></div><div class="count"></div>`;
    const smalls = sal.querySelectorAll('.small');
    smalls[0].textContent = dateLong(c.salderingEinde);
    const st = c.salderingStand;
    let stand = t('Daarna {a} vergoeding, {b} kosten', { a: tarief(c.terugleverKwhNa), b: tarief(c.terugleverkostenKwhNa) });
    if (st && st.exp > 0) {
      stand = st.bron === 'dashboard'
        ? t('Sinds de eerste meting {a} kWh teruggeleverd tegen {b} kWh afgenomen', { a: nf(st.exp, 0), b: nf(st.imp, 0) })
        : t('Sinds de start {a} kWh teruggeleverd tegen {b} kWh afgenomen', { a: nf(st.exp, 0), b: nf(st.imp, 0) });
      if (st.overschot > 0) stand += '. ' + t('Overschot {a} kWh krijgt {b}', { a: nf(st.overschot, 0), b: tarief(c.terugleverKwh) });
    }
    smalls[1].textContent = stand;
    sal.querySelector('.count').innerHTML = `${c.salderingDaysLeft} <span>${t('dagen')}</span>`;
    sal.hidden = false;
  } else if (NL() && c.saldering) {
    sal.innerHTML = `<div><strong>${t('Saldering is gestopt')}</strong><span class="small">${t('Teruglevering tegen de terugleververgoeding')}</span></div>`;
    sal.hidden = false;
  } else {
    sal.hidden = true;
  }
}

async function loadSummary() {
  try {
    const cur = await getJSON(`/api/summary?period=${period}`);
    renderSummary(cur);
    renderToday(period === 'dag' ? cur : await getJSON('/api/summary?period=dag'));
  } catch (e) {
    console.error(e); // de status toont al of de server bereikbaar is
  }
}

document.querySelectorAll('[data-period]').forEach((btn) => {
  btn.addEventListener('click', () => {
    period = btn.dataset.period;
    document.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    loadSummary();
  });
});

// ---------- Extra grafieken ----------

const safe = async (fn) => {
  try {
    await fn();
  } catch (e) {
    console.error(e);
  }
};

async function loadLiveChart() {
  await safe(async () => renderLiveChart($('live-chart'), (await getJSON('/api/history')).points));
  setTimeout(loadLiveChart, Math.max(10, refresh) * 1000);
}

async function loadSolar() {
  await safe(async () => {
    lastSolar = await getJSON('/api/solar');
    renderSolar($('solar-forecast'), lastSolar);
  });
}

let heatMetric = 'house';
const HEAT_LEGEND = {
  house: [['var(--house)', 'Meer verbruik is lichter']],
  solar: [['var(--sun)', 'Meer opwek is feller']],
  net: [['var(--grid)', 'Afname van het net'], ['var(--sun)', 'Teruglevering']],
};
async function loadHeatmap() {
  await safe(async () => renderHeatmap($('heatmap'), await getJSON(`/api/heatmap?metric=${heatMetric}`)));
  $('heat-legend').innerHTML = HEAT_LEGEND[heatMetric].map(([c, txt]) => `<span><i style="background:${c}"></i>${t(txt)}</span>`).join('');
}
document.querySelectorAll('[data-heat]').forEach((btn) => {
  btn.addEventListener('click', () => {
    heatMetric = btn.dataset.heat;
    document.querySelectorAll('[data-heat]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    loadHeatmap();
  });
});

let bdOffset = 0;
async function loadBatteryDay() {
  const d = new Date();
  d.setDate(d.getDate() + bdOffset);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('bd-date').textContent = bdOffset === 0 ? t('vandaag') : d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  $('bd-next').disabled = bdOffset >= 0;
  await safe(async () => {
    const b = await getJSON(`/api/battery?date=${key}`);
    renderBatteryDay($('battery-day'), b);
    const stat = (v, lbl) => `<div><strong>${v}</strong><span>${lbl}</span></div>`;
    $('battery-stats').innerHTML = [
      stat(`${nf(b.charged, 1)} kWh`, t('geladen')),
      stat(`${nf(b.discharged, 1)} kWh`, t('ontladen')),
      stat(b.cycles == null ? '–' : nf(b.cycles, 2), t('cycli')),
      stat(b.socMin == null ? '–' : `${Math.round(b.socMin)}–${Math.round(b.socMax)}%`, t('bereik')),
    ].join('');
  });
}
$('bd-prev').addEventListener('click', () => {
  bdOffset--;
  loadBatteryDay();
});
$('bd-next').addEventListener('click', () => {
  if (bdOffset < 0) bdOffset++;
  loadBatteryDay();
});

async function loadInsights() {
  await safe(async () => renderJaarnota($('jaarnota'), await getJSON('/api/jaarnota')));
  if (NL()) await safe(async () => renderSaldering($('saldering-compare'), await getJSON('/api/saldering')));
}

loadLiveChart();
loadSolar();
loadHeatmap();
loadBatteryDay();
loadInsights();
setInterval(loadSolar, 10 * 60_000);
setInterval(() => {
  loadHeatmap();
  loadInsights();
  if (bdOffset === 0) loadBatteryDay();
}, 5 * 60_000);

$('today').textContent = new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
loadLive();
loadSummary();
setInterval(loadSummary, 60_000);
