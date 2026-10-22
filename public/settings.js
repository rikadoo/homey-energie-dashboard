const $ = (id) => document.getElementById(id);
const form = $('form');

const METRICS = [
  { key: 'solar_w', title: 'Zonnepanelen, vermogen', help: 'Actueel vermogen van je omvormer in watt.' },
  { key: 'grid_w', title: 'Net, vermogen', help: 'Positief bij afname, negatief bij teruglevering. Klopt het teken niet, zet dan Omkeren aan.', dongle: [['grid_w', 'Netvermogen (afname min teruglevering)']] },
  { key: 'battery_w', title: 'Batterij, vermogen', help: 'Positief bij laden, negatief bij ontladen.' },
  { key: 'battery_soc', title: 'Batterij, laadtoestand', help: 'Percentage van 0 tot 100.' },
  { key: 'gas_m3', title: 'Gasmeter, meterstand', help: 'Totale meterstand in m³. Het dashboard rekent zelf het verbruik per periode uit.', dongle: [['gas_m3', 'Gasmeterstand']] },
];

let devices = null;
let config = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function result(el, kind, text) {
  el.className = `result ${kind}`;
  el.textContent = text;
}

// ---------- Meetwaarden opbouwen ----------

function metricRow(def) {
  const k = def.key;
  const n = (f) => `metrics.${k}.${f}`;
  const id = (f) => `m-${k}-${f}`;
  const el = document.createElement('div');
  el.className = 'metric';
  el.innerHTML = `
    <h3></h3>
    <p class="help"></p>
    <div class="fields three">
      <div class="field"><label for="${id('source')}">Bron</label>
        <select id="${id('source')}" name="${n('source')}">
          <option value="none">Niet gebruikt</option>
          <option value="homey">Homey-apparaat</option>
          ${def.dongle ? '<option value="dongle">Energy Dongle</option>' : ''}
          <option value="http">HTTP JSON-URL</option>
        </select>
      </div>
      <div class="field"><label for="${id('factor')}">Factor</label><input id="${id('factor')}" name="${n('factor')}" type="number" step="any" inputmode="decimal"></div>
      <div class="field"><label class="check" for="${id('invert')}"><input id="${id('invert')}" name="${n('invert')}" type="checkbox"> Omkeren (+/−)</label></div>
      <div class="field wide"><label class="check" for="${id('zero')}"><input id="${id('zero')}" name="${n('zeroOnError')}" type="checkbox"> Geen waarde betekent 0, geen foutmelding (bijv. omvormer die 's nachts uit staat)</label></div>
    </div>
    <div class="fields src" data-src="homey">
      <div class="field wide"><label for="${id('pick')}">Apparaat en meetwaarde</label><select id="${id('pick')}" data-pick="${k}"></select></div>
    </div>
    ${def.dongle ? `<div class="fields src" data-src="dongle">
      <div class="field wide"><label for="${id('field')}">Waarde uit de meter</label>
        <select id="${id('field')}" name="${n('field')}">${def.dongle.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </div></div>` : ''}
    <div class="fields src" data-src="http">
      <div class="field wide"><label for="${id('url')}">URL</label><input id="${id('url')}" name="${n('url')}" placeholder="http://192.168.1.40/api/v1/data" autocomplete="off"></div>
      <div class="field"><label for="${id('path')}">Pad in JSON</label><input id="${id('path')}" name="${n('path')}" placeholder="active_power_w" autocomplete="off"></div>
      <div class="field"><label for="${id('auth')}">Authorization-header (optioneel)</label><input id="${id('auth')}" name="${n('auth')}" type="password" autocomplete="off"></div>
    </div>
    <div class="actions">
      <button type="button" class="btn">Testen</button>
      <span class="result" role="status"></span>
    </div>`;
  el.querySelector('h3').textContent = def.title;
  el.querySelector('.help').textContent = def.help;

  const source = el.querySelector('select[name$=".source"]');
  const sync = () => el.querySelectorAll('.src').forEach((s) => (s.hidden = s.dataset.src !== source.value));
  source.addEventListener('change', sync);
  el.sync = sync;

  const out = el.querySelector('.actions .result');
  el.querySelector('.actions .btn').addEventListener('click', async () => {
    result(out, '', 'Bezig met testen…');
    try {
      const body = collect();
      const r = await api('/api/test', { key: k, metric: body.metrics[k], homey: body.homey, dongle: body.dongle });
      result(out, 'ok', r.value == null ? 'Deze meetwaarde staat uit.' : `Waarde: ${r.value.toLocaleString('nl-NL', { maximumFractionDigits: 3 })}`);
    } catch (e) {
      result(out, 'err', e.message);
    }
  });
  return el;
}

function fillPick(select, m) {
  select.innerHTML = '';
  const add = (value, label) => select.add(new Option(label, value));
  add('', devices ? 'Kies een apparaat' : 'Haal eerst de apparaten op');
  if (devices) {
    for (const d of devices) {
      const group = document.createElement('optgroup');
      group.label = d.name;
      for (const c of d.caps) {
        const val = `${c.value.toLocaleString('nl-NL', { maximumFractionDigits: 2 })} ${c.units}`.trim();
        group.append(new Option(`${c.title} (${val})`, `${d.id}|${c.id}`));
      }
      select.append(group);
    }
  }
  if (m.deviceId && m.capability) {
    const want = `${m.deviceId}|${m.capability}`;
    if (![...select.options].some((o) => o.value === want)) add(want, `Opgeslagen: ${m.capability}`);
    select.value = want;
  }
}

// ---------- Formulier lezen en vullen ----------

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

function collect() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    setPath(out, el.name, v);
  }
  for (const sel of form.querySelectorAll('[data-pick]')) {
    const [deviceId = '', capability = ''] = sel.value.split('|');
    setPath(out, `metrics.${sel.dataset.pick}.deviceId`, deviceId);
    setPath(out, `metrics.${sel.dataset.pick}.capability`, capability);
  }
  return out;
}

function fill(cfg) {
  config = cfg;
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = getPath(cfg, el.name);
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  }
  $('homey-token').placeholder = cfg.homey.tokenSet ? 'Opgeslagen, laat leeg om te behouden' : '';
  for (const def of METRICS) {
    const m = cfg.metrics[def.key];
    const auth = form.elements[`metrics.${def.key}.auth`];
    auth.placeholder = m.authSet ? 'Opgeslagen, laat leeg om te behouden' : '';
    fillPick(form.querySelector(`[data-pick="${def.key}"]`), m);
  }
  form.querySelectorAll('.metric').forEach((el) => el.sync());
}

// ---------- Acties ----------

async function loadDevices() {
  const out = $('homey-result');
  result(out, '', 'Apparaten ophalen…');
  try {
    const body = collect();
    devices = await api('/api/homey/devices', { homey: body.homey });
    const current = collect().metrics;
    for (const def of METRICS) fillPick(form.querySelector(`[data-pick="${def.key}"]`), current[def.key]);
    result(out, 'ok', `${devices.length} apparaten met meetwaarden gevonden.`);
  } catch (e) {
    result(out, 'err', `Apparaten ophalen mislukt: ${e.message}`);
  }
}
$('homey-load').addEventListener('click', loadDevices);

$('dongle-test').addEventListener('click', async () => {
  const out = $('dongle-result');
  result(out, '', 'Wachten op een meting van de dongle…');
  try {
    const v = await api('/api/dongle/test', { dongle: collect().dongle });
    const f = (x, d) => (x == null ? '–' : x.toLocaleString('nl-NL', { maximumFractionDigits: d }));
    result(out, 'ok', `Verbonden. Net ${f(v.grid_w, 0)} W, gas ${f(v.gas_m3, 3)} m³.`);
  } catch (e) {
    result(out, 'err', e.message);
  }
});

$('sg-test').addEventListener('click', async () => {
  const out = $('sg-result');
  result(out, '', 'Bezig… sla eerst je instellingen op als je ze net hebt gewijzigd.');
  try {
    const st = await api('/api/signals/test', {});
    result(out, st.ok ? 'ok' : 'err', st.message);
  } catch (e) {
    result(out, 'err', e.message);
  }
});
api('/api/signals')
  .then((st) => st.updated && result($('sg-result'), st.ok ? 'ok' : 'err', `${st.message} (${new Date(st.updated).toLocaleTimeString('nl-NL')})`))
  .catch(() => {});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = $('save-result');
  try {
    fill(await api('/api/config', collect()));
    result(out, 'ok', 'Instellingen opgeslagen.');
  } catch (e) {
    result(out, 'err', `Opslaan mislukt: ${e.message}`);
  }
});

$('metrics').append(...METRICS.map(metricRow));
api('/api/config')
  .then((cfg) => {
    fill(cfg);
    // Apparatenlijst direct laden als Homey al is ingesteld
    if (cfg.homey.url && cfg.homey.tokenSet) loadDevices();
  })
  .catch((e) => result($('save-result'), 'err', `Instellingen laden mislukt: ${e.message}`));
