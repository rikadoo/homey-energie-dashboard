import { renderLive as renderLiveChart, renderSolar, renderSankey, renderBatteryDay, renderHeatmap, renderJaarnota, renderSaldering } from './charts.js';

const $ = (id) => document.getElementById(id);
const nf = (n, d) => n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const kw = (w) => `${nf(w / 1000, 2)} kW`;
const eur = (v) => `${v < -0.004 ? '−' : ''}€ ${nf(Math.abs(v), 2)}`;
const time = (d) => d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const dateLong = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return y ? new Date(y, m - 1, d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
};
const THRESHOLD = 15; // watt; kleinere stromen tonen we niet als actief

let period = 'dag';
let lastSolar = null; // laatste zonnevoorspelling, voor "vol rond"
let has = { battery: true, gas: true, solar: true }; // welke bronnen gekoppeld zijn

// Resterende voorspelde opwek vandaag (kWh) en het laatste moment met zon
function solarRestToday() {
  if (!lastSolar?.watts?.length) return null;
  const now = Date.now();
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const pts = lastSolar.watts.map(([t, w]) => [new Date(t).getTime(), w]).filter(([t]) => t <= +end);
  let kwh = 0;
  let sunset = null;
  for (let i = 1; i < pts.length; i++) {
    const [t0, w0] = pts[i - 1];
    const [t1, w1] = pts[i];
    if (t1 <= now) continue;
    const a = Math.max(t0, now);
    kwh += (((w0 + w1) / 2) * (t1 - a)) / 3.6e9;
  }
  for (const [t, w] of pts) if (w > 50 && new Date(t).toDateString() === new Date().toDateString()) sunset = t;
  return { kwh, sunset };
}
let refresh = 10;

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
  if (!d.configured) setStatus('', 'Geen bronnen gekoppeld');
  else if (!d.ts) setStatus('', 'Wachten op eerste meting');
  else if (errs.length) {
    const names = { solar_w: 'Zon', grid_w: 'Net', battery_w: 'Batterij', battery_soc: 'Laadtoestand', gas_m3: 'Gas' };
    const list = errs.map((k) => names[k] || k);
    setStatus('warn', `Fout bij ${list.join(', ')}`, errs.map((k) => `${names[k] || k}: ${d.errors[k]}`).join('\n'));
  }
  else setStatus('ok', `Live, <span class="hide-sm">bijgewerkt </span>${time(new Date(d.ts))}`, '', true);

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
  $('l-grid').textContent = v.grid_w == null ? 'Net' : exp >= THRESHOLD ? 'Teruglevering' : imp >= THRESHOLD ? 'Afname net' : 'Net';
  $('flow-summary').textContent = h > THRESHOLD ? `Eigen energie dekt ${Math.round(Math.min(1, (zh + bh) / h) * 100)}% van je huis` : '';

  // Batterij
  const bat = d.battery || {};
  const cap = bat.capacityKwh || 0;
  const soc = v.battery_soc;
  $('batt-name').textContent = bat.name || 'Thuisbatterij';
  $('batt-cap').textContent = cap ? `van ${nf(cap, 1)} kWh` : '';
  $('l-batt').textContent = chg >= THRESHOLD ? 'Batterij laadt' : dis >= THRESHOLD ? 'Batterij ontlaadt' : 'Batterij';
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
  let state = 'In rust', eta = '';
  if (chg >= THRESHOLD) {
    state = `Laden, +${kw(chg)}`;
    if (soc != null && cap && soc < 99) {
      const need = ((100 - soc) / 100) * cap;
      const at = Date.now() + (need / (chg / 1000)) * 3.6e6;
      const sun = solarRestToday();
      // Alleen "vol rond" tonen als dat met de resterende zon van vandaag haalbaar is
      const reachable = sun
        ? sun.sunset != null && at <= sun.sunset && need <= sun.kwh * 0.8
        : new Date(at).toDateString() === new Date().toDateString() && new Date(at).getHours() < 19;
      eta = reachable ? `Vol rond ${time(new Date(at))}` : 'Wordt vandaag waarschijnlijk niet vol';
    }
  } else if (dis >= THRESHOLD) {
    state = `Ontladen, −${kw(dis)}`;
    if (soc != null && cap && soc > 1) {
      const hrs = ((soc / 100) * cap) / (dis / 1000);
      if (hrs < 24) eta = `Leeg rond ${time(new Date(Date.now() + hrs * 3.6e6))}`;
    }
  }
  $('batt-state').textContent = v.battery_w == null ? '' : state + (d.batteryCorrected ? ' (gecorrigeerd)' : '');
  $('batt-eta').textContent = eta;

  // Laat zien als de batterijgegevens oud zijn (bijv. vertraging van een cloud-koppeling)
  const upd = Math.max(d.updated?.battery_w || 0, d.updated?.battery_soc || 0);
  const stale = $('batt-stale');
  if (upd && Date.now() - upd > 5 * 60_000) {
    stale.textContent = `Batterijgegevens van ${time(new Date(upd))}`;
    stale.hidden = false;
  } else stale.hidden = true;
}

async function loadLive() {
  try {
    renderLive(await getJSON('/api/live'));
  } catch {
    setStatus('warn', 'Server niet bereikbaar');
  } finally {
    setTimeout(loadLive, refresh * 1000);
  }
}

// ---------- Overzicht ----------

function renderToday(s) {
  const c = s.costs;
  const total = $('today-total');
  total.textContent = eur(c.totaal);
  total.classList.toggle('pos', c.totaal < 0);
  $('today-saved').textContent = eur(c.bespaard);
  $('today-split').textContent = has.gas ? `Stroom ${eur(c.stroom)}, gas ${eur(c.gas)}, vaste kosten ${eur(c.vast)}` : `Stroom ${eur(c.stroom)}, vaste kosten ${eur(c.vast)}`;
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
  $('overview-title').textContent = `Overzicht ${s.label}`;
  const d = s.period === 'maand' || s.period === 'jaar' ? 0 : 1;
  const t = s.totals;
  const pct = (x) => (x == null ? '–' : String(Math.round(x * 100)));

  $('kpis').replaceChildren(
    kpi('Opwek', nf(t.solar, d), 'kWh', 'var(--sun)', s.selfConsumption == null ? 'Nog geen opwek' : `Zelf verbruikt ${pct(s.selfConsumption)}%`),
    kpi('Verbruik', nf(t.house, d), 'kWh', 'var(--house)', has.gas ? `Gas ${nf(t.gas, d)} m³` : 'Stroom in huis'),
    kpi('Teruglevering', nf(t.exp, d), 'kWh', 'var(--grid)', `${eur(s.costs.teruglevering)} ${s.contract.salderingActief ? 'gesaldeerd' : 'vergoeding'}, ${eur(s.costs.terugleverkosten)} kosten`),
    kpi('Afname net', nf(t.imp, d), 'kWh', 'var(--grid)', `${eur(s.costs.afname)}, waarvan ${nf(t.impDal, d)} kWh dal`),
    kpi('Zelfvoorzienend', pct(s.selfSufficiency), '%', 'var(--batt)', 'Uit zon en batterij'),
  );

  // Grafiek: opwek omhoog, verbruik omlaag, zelfde schaal.
  const max = Math.max(0.001, ...s.buckets.map((b) => Math.max(b.solar, b.house)));
  const unit = s.period === 'jaar' || s.period === 'maand' ? 0 : 2;
  $('chart').replaceChildren(
    ...s.buckets.map((b) => {
      const col = document.createElement('div');
      col.className = 'col';
      col.title = `${b.label || ''} opwek ${nf(b.solar, unit)} kWh, verbruik ${nf(b.house, unit)} kWh`.trim();
      col.innerHTML = '<div class="up"><div class="bar sun"></div></div><div class="base"></div><div class="down"><div class="bar use"></div></div><div class="lbl"></div>';
      const h = (v) => (v > 0 ? `${Math.max(1.5, (v / max) * 96)}%` : '0');
      col.querySelector('.sun').style.height = h(b.solar);
      col.querySelector('.use').style.height = h(b.house);
      col.querySelector('.lbl').textContent = b.label;
      return col;
    }),
  );

  $('notice-tariffs').hidden = !(s.contract.leveringNormaal === 0 && s.contract.leveringDal === 0);

  // Energiestromen
  $('sankey-label').textContent = s.label;
  if (s.flows) renderSankey($('sankey'), s.flows);

  // Contract
  const c = s.contract;
  $('c-supplier').textContent = c.supplier || 'Contract';
  $('c-desc').textContent = c.description || '';
  $('c-start').textContent = dateLong(c.start);
  $('c-end').textContent = dateLong(c.end);
  $('c-progress').style.width = c.totalDays ? `${Math.min(100, (c.elapsedDays / c.totalDays) * 100)}%` : '0';
  $('c-days').textContent = c.totalDays ? `${c.elapsedDays} dagen verstreken, nog ${c.remainingDays} dagen` : 'Vul de looptijd in bij instellingen';

  const parts = [];
  if (c.termijnbedrag) parts.push(`Termijnbedrag ${eur(c.termijnbedrag)} per maand`);
  if (c.bonus) parts.push(`loyaliteitsbonus ${eur(c.bonus)} op je jaarnota`);
  $('c-termijn').textContent = parts.join(', ');

  const fillList = (el, rows) => {
    el.innerHTML = '';
    for (const [label, value, cls] of rows) {
      const row = document.createElement('div');
      if (cls) row.className = cls;
      row.innerHTML = '<dt></dt><dd></dd>';
      row.firstChild.textContent = label;
      row.lastChild.textContent = value;
      el.append(row);
    }
  };
  const tarief = (v, unit = 'kWh') => `€ ${nf(v, 5)} /${unit}`;
  fillList($('c-tariffs'), [
    ['Levering normaal', tarief(c.leveringNormaal), c.dalNu ? '' : 'now'],
    ['Levering dal', tarief(c.leveringDal), c.dalNu ? 'now' : ''],
    ['Terugleververgoeding', tarief(c.terugleverNu)],
    ['Terugleverkosten', tarief(c.terugleverkostenNu)],
    ['Gas', tarief(c.gasM3, 'm³')],
  ]);

  const k = s.costs;
  $('c-costs-title').textContent = `Kosten ${s.label}`;
  fillList($('c-costs'), [
    ['Stroom', eur(k.stroom)],
    ['Gas', eur(k.gas)],
    [`Vaste kosten (${k.vastDagen} ${k.vastDagen === 1 ? 'dag' : 'dagen'})`, eur(k.vast)],
    ['Totaal', eur(k.totaal), 'sum'],
  ]);

  const sal = $('c-saldering');
  if (c.saldering && c.salderingActief) {
    sal.innerHTML = '<div><strong>Saldering stopt</strong><span class="small"></span><span class="small muted"></span></div><div class="count"></div>';
    const smalls = sal.querySelectorAll('.small');
    smalls[0].textContent = dateLong(c.salderingEinde);
    const st = c.salderingStand;
    let stand = `Daarna ${tarief(c.terugleverKwhNa)} vergoeding, ${tarief(c.terugleverkostenKwhNa)} kosten`;
    if (st && st.exp > 0) {
      stand = `Sinds de start ${nf(st.exp, 0)} kWh teruggeleverd tegen ${nf(st.imp, 0)} kWh afgenomen${st.bron === 'dashboard' ? ' (sinds de eerste meting)' : ''}`;
      if (st.overschot > 0) stand += `. Overschot ${nf(st.overschot, 0)} kWh krijgt ${tarief(c.terugleverKwh)}`;
    }
    smalls[1].textContent = stand;
    sal.querySelector('.count').innerHTML = `${c.salderingDaysLeft} <span>dagen</span>`;
    sal.hidden = false;
  } else if (c.saldering) {
    sal.innerHTML = '<div><strong>Saldering is gestopt</strong><span class="small">Teruglevering tegen de terugleververgoeding</span></div>';
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
  } catch {
    /* status-pill toont al of de server bereikbaar is */
  }
}

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    period = btn.dataset.period;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
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
  $('heat-legend').innerHTML = HEAT_LEGEND[heatMetric].map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
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
  $('bd-date').textContent = bdOffset === 0 ? 'vandaag' : d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  $('bd-next').disabled = bdOffset >= 0;
  await safe(async () => {
    const b = await getJSON(`/api/battery?date=${key}`);
    renderBatteryDay($('battery-day'), b);
    const stat = (v, label) => `<div><strong>${v}</strong><span>${label}</span></div>`;
    $('battery-stats').innerHTML = [
      stat(`${nf(b.charged, 1)} kWh`, 'geladen'),
      stat(`${nf(b.discharged, 1)} kWh`, 'ontladen'),
      stat(b.cycles == null ? '–' : nf(b.cycles, 2), 'cycli'),
      stat(b.socMin == null ? '–' : `${Math.round(b.socMin)}–${Math.round(b.socMax)}%`, 'bereik'),
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
  await safe(async () => renderSaldering($('saldering-compare'), await getJSON('/api/saldering')));
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

$('today').textContent = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
loadLive();
loadSummary();
setInterval(loadSummary, 60_000);
