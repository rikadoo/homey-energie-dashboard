// Installatiewizard: stap voor stap van een lege installatie naar een werkend dashboard.
import { initI18n, setLang, applyStatic, t, lang, LOCALE } from './i18n.js';

await initI18n();
applyStatic();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

// ---------- Uitgangssituatie: bestaande instellingen (bij opnieuw starten) ----------

const existing = await api('/api/config');
const c0 = existing.contract;
const used = (k) => existing.metrics[k].source !== 'none';
const pickOf = (k) => (existing.metrics[k].source === 'homey' && existing.metrics[k].deviceId ? `${existing.metrics[k].deviceId}|${existing.metrics[k].capability}` : '');

const st = {
  step: 0,
  lang,
  country: existing.region.country,
  currency: existing.region.currency,
  homeyUrl: existing.homey.url,
  homeyToken: '',
  tokenSet: existing.homey.tokenSet,
  devices: null,
  has: {
    solar: used('solar_w') || !existing.ui.setupDone,
    battery: used('battery_w') || used('battery_soc'),
    gas: used('gas_m3') || !existing.ui.setupDone,
    dongle: Boolean(existing.dongle.url),
  },
  dongleUrl: existing.dongle.url,
  dongleValues: null,
  map: Object.fromEntries(['solar_w', 'grid_w', 'battery_w', 'battery_soc', 'gas_m3'].map((k) => [k, { pick: pickOf(k), invert: existing.metrics[k].invert }])),
  tariffs: { ...c0 },
  monthly: { stroom: Math.round(((c0.stroomVastJaar + c0.stroomNetbeheerJaar) / 12) * 100) / 100, gas: Math.round(((c0.gasVastJaar + c0.gasNetbeheerJaar) / 12) * 100) / 100 },
  solar: { enabled: existing.solar.enabled, lat: existing.solar.lat, lon: existing.solar.lon, ...existing.solar.planes[0] },
  signals: existing.signals.enabled,
  capacity: existing.battery.capacityKwh,
};

// ---------- Hulpjes ----------

const field = (label, input, cls = '') => `<div class="field ${cls}"><label>${label}</label>${input}</div>`;
const num = (bind, step = 'any', extra = '') => {
  const v = get(bind);
  return `<input type="number" step="${step}" inputmode="decimal" data-bind="${bind}" value="${v ?? ''}" ${extra}>`;
};
const text = (bind, placeholder = '', type = 'text') => `<input type="${type}" data-bind="${bind}" value="${esc(get(bind))}" placeholder="${esc(placeholder)}" autocomplete="off">`;
const check = (bind, label, sub = '', rerender = true) =>
  `<label class="choice"><input type="checkbox" data-bind="${bind}" ${get(bind) ? 'checked' : ''} ${rerender ? 'data-rerender' : ''}><div><strong>${label}</strong><span>${sub}</span></div></label>`;

function get(path) {
  return path.split('.').reduce((o, k) => o?.[k], st);
}
function set(path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], st)[last] = v;
}

function msg(kind, txt) {
  $('w-msg').className = `result ${kind}`;
  $('w-msg').textContent = txt;
}

// Waarde van een apparaat-meetwaarde, zoals de lijst hem kent
function valueOf(pick) {
  if (!pick || !st.devices) return null;
  const [id, cap] = pick.split('|');
  const c = st.devices.find((d) => d.id === id)?.caps.find((x) => x.id === cap);
  return c ? `${c.value.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} ${c.units}`.trim() : null;
}

// Slim voorstel: zoek een passend apparaat op naam en type meetwaarde
const GUESS = {
  solar_w: [/solar|zon|omvormer|inverter|\bpv\b|goodwe|sma|growatt|solaredge|enphase|fronius|huawei|sofar|hoymiles|apsystems/i, 'measure_power'],
  grid_w: [/p1|meter|dongle|energy|homewizard|net|grid/i, 'measure_power'],
  battery_w: [/batter|accu|solarbank|zendure|marstek|powerwall|sessy|anker|ecoflow/i, 'measure_power'],
  battery_soc: [/batter|accu|solarbank|zendure|marstek|powerwall|sessy|anker|ecoflow/i, 'measure_battery'],
  gas_m3: [/gas|meter|p1|dongle/i, 'meter_gas'],
};
function guess(key) {
  if (!st.devices || st.map[key].pick) return;
  const [re, capId] = GUESS[key];
  const withCap = st.devices.filter((d) => d.caps.some((c) => c.id === capId));
  const dev = withCap.find((d) => re.test(d.name)) || (withCap.length === 1 ? withCap[0] : null);
  if (dev) st.map[key].pick = `${dev.id}|${capId}`;
}

function deviceSelect(key) {
  const opts = [`<option value="">${t('Kies een apparaat')}</option>`];
  for (const d of st.devices || []) {
    opts.push(`<optgroup label="${esc(d.name)}">`);
    for (const c of d.caps) {
      const v = `${d.id}|${c.id}`;
      const val = `${c.value.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} ${c.units}`.trim();
      opts.push(`<option value="${esc(v)}" ${st.map[key].pick === v ? 'selected' : ''}>${esc(d.name)}: ${esc(c.title)} (${esc(val)})</option>`);
    }
    opts.push('</optgroup>');
  }
  return `<select data-bind="map.${key}.pick" data-rerender>${opts.join('')}</select>`;
}

// ---------- Stappen ----------

const NL = () => st.country === 'NL';

const STEPS = [
  {
    title: () => t('Welkom'),
    render: () => `
      <h2>${t('Welkom bij je energiedashboard')}</h2>
      <p class="help">${t('In een paar stappen koppel je Homey, kies je wat je hebt en vul je je tarieven in. Alles is later nog aan te passen bij de instellingen.')}</p>
      ${field(t('Taal'), `<div class="lang-buttons">
        <button type="button" class="btn" data-lang="nl" aria-pressed="${st.lang === 'nl'}">Nederlands</button>
        <button type="button" class="btn" data-lang="en" aria-pressed="${st.lang === 'en'}">English</button></div>`)}
      <div class="fields">
        ${field(t('Land'), `<select data-bind="country" data-rerender>
          <option value="NL" ${NL() ? 'selected' : ''}>${t('Nederland')}</option>
          <option value="OTHER" ${NL() ? '' : 'selected'}>${t('Ander land')}</option></select>`)}
        ${NL() ? '' : field(t('Valuta'), `<select data-bind="currency">${['EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'USD'].map((c) => `<option ${st.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
      </div>
      <p class="help">${NL()
        ? t('Het dashboard rekent met de Nederlandse regels: saldering tot 2027, terugleverkosten, vermindering energiebelasting en feestdagen in het daltarief.')
        : t('Het dashboard rekent alleen met je eigen tarieven, zonder Nederlandse regelingen.')}</p>`,
  },
  {
    title: () => 'Homey',
    render: () => `
      <h2>${t('Homey Pro koppelen')}</h2>
      <p class="help">${t('Maak in de Homey-webapp (my.homey.app) onder Instellingen → API-sleutels een sleutel met het recht "Apparaten weergeven". Wil je ook signalen terugsturen naar Homey, geef dan ook het recht "Variabelen".')}</p>
      <div class="fields">
        ${field(t('Lokaal adres van je Homey'), text('homeyUrl', 'http://192.168.1.20'))}
        ${field(t('API-sleutel'), text('homeyToken', st.tokenSet ? t('Opgeslagen, laat leeg om te behouden') : '', 'password'))}
      </div>
      <div class="actions"><button type="button" class="btn" id="w-connect">${t('Verbinden en apparaten ophalen')}</button>
        <span class="result ${st.devices ? 'ok' : ''}" id="w-connect-res">${st.devices ? t('{n} apparaten met meetwaarden gevonden.', { n: st.devices.length }) : ''}</span></div>`,
    validate: () => (st.devices ? null : t('Maak eerst verbinding met Homey.')),
  },
  {
    title: () => t('Wat heb je'),
    render: () => `
      <h2>${t('Wat heb je in huis?')}</h2>
      <p class="help">${t('Kies wat je hebt. Wat je niet hebt, slaat het dashboard over.')}</p>
      <div class="choice-grid">
        ${check('has.solar', t('Zonnepanelen'), t('Omvormer in Homey'))}
        ${check('has.battery', t('Thuisbatterij'), t('Laadtoestand en vermogen in Homey'))}
        ${check('has.gas', t('Gas'), t('Gasmeter via de slimme meter of Homey'))}
        ${check('has.dongle', t('Homey Energy Dongle'), t('Slimme meter rechtstreeks uitlezen (nauwkeurigst)'))}
      </div>
      ${st.has.dongle ? `
        <p class="help">${t('Zet in de Homey-app bij de dongle onder Geavanceerde instellingen de Local API aan.')}</p>
        <div class="fields">${field(t('WebSocket-adres'), text('dongleUrl', 'ws://192.168.1.30/ws'), 'wide')}</div>
        <div class="actions"><button type="button" class="btn" id="w-dongle">${t('Verbinding testen')}</button><span class="result" id="w-dongle-res"></span></div>` : ''}`,
    validate: () => (st.has.dongle && !st.dongleUrl ? t('Vul het adres van de dongle in, of zet de dongle uit.') : null),
  },
  {
    title: () => t('Koppelen'),
    render: () => {
      for (const k of Object.keys(GUESS)) guess(k);
      const rows = [];
      const row = (key, title, help, sign) => {
        const v = valueOf(st.map[key].pick);
        rows.push(`<div class="map-row"><div><h3>${title}</h3><p class="help">${help}</p>${deviceSelect(key)}
          ${sign ? `<label class="check"><input type="checkbox" data-bind="map.${key}.invert" ${st.map[key].invert ? 'checked' : ''}> ${t('Omkeren (+/−)')}</label>` : ''}</div>
          <div class="val">${v ? esc(v) : '–'}</div></div>`);
      };
      if (st.has.solar) row('solar_w', t('Zonnepanelen, vermogen'), t('Actueel vermogen van je omvormer in watt.'));
      if (!st.has.dongle) row('grid_w', t('Net, vermogen'), t('Positief bij afname, negatief bij teruglevering. Klopt het teken niet, zet dan Omkeren aan.'), true);
      if (st.has.battery) {
        row('battery_w', t('Batterij, vermogen'), t('Positief bij laden, negatief bij ontladen.'), true);
        row('battery_soc', t('Batterij, laadtoestand'), t('Percentage van 0 tot 100.'));
      }
      if (st.has.gas && !st.has.dongle) row('gas_m3', t('Gasmeter, meterstand'), t('Totale meterstand in m³. Het dashboard rekent zelf het verbruik per periode uit.'));
      const dongleNote = st.has.dongle ? `<p class="help">${t('Net en gas komen rechtstreeks uit de Energy Dongle.')}</p>` : '';
      return `<h2>${t('Apparaten koppelen')}</h2>
        <p class="help">${t('Kies per meetwaarde het juiste apparaat. Rechts zie je de huidige waarde, zodat je kunt controleren of het klopt.')}</p>
        ${dongleNote}<div>${rows.join('')}</div>
        <div class="fields">${st.has.battery ? field(t('Capaciteit van de batterij (kWh)'), num('capacity', '0.1')) : ''}</div>`;
    },
    validate: () => {
      const need = [];
      if (st.has.solar) need.push('solar_w');
      if (!st.has.dongle) need.push('grid_w');
      if (st.has.battery) need.push('battery_w', 'battery_soc');
      if (st.has.gas && !st.has.dongle) need.push('gas_m3');
      return need.every((k) => st.map[k].pick) ? null : t('Kies voor elke meetwaarde een apparaat.');
    },
  },
  {
    title: () => t('Tarieven'),
    render: () => NL()
      ? `<h2>${t('Je energiecontract')}</h2>
        <p class="help">${t('Neem de bedragen over van je contract, inclusief energiebelasting en btw, allemaal als positief getal. Je kunt dit ook later invullen.')}</p>
        <div class="fields">
          ${field(t('Leverancier'), text('tariffs.supplier'))}
          ${field(t('Termijnbedrag (per maand)'), num('tariffs.termijnbedrag', '0.01'))}
          ${field(t('Startdatum'), text('tariffs.start', '', 'date'))}
          ${field(t('Einddatum'), text('tariffs.end', '', 'date'))}
          ${field(t('Normaaltarief (per kWh)'), num('tariffs.leveringNormaal', '0.00001'))}
          ${field(t('Daltarief (per kWh)'), num('tariffs.leveringDal', '0.00001'))}
          ${field(t('Terugleververgoeding tot 2027 (per kWh)'), num('tariffs.terugleverKwh', '0.00001'))}
          ${field(t('Terugleverkosten tot 2027 (per kWh)'), num('tariffs.terugleverkostenKwh', '0.00001'))}
          ${field(t('Terugleververgoeding vanaf 2027 (per kWh)'), num('tariffs.terugleverKwhNa', '0.00001'))}
          ${field(t('Terugleverkosten vanaf 2027 (per kWh)'), num('tariffs.terugleverkostenKwhNa', '0.00001'))}
          ${st.has.gas ? field(t('Gastarief (per m³)'), num('tariffs.gasM3', '0.00001')) : ''}
          ${field(t('Stroom, vaste leveringskosten (per jaar)'), num('tariffs.stroomVastJaar', '0.01'))}
          ${field(t('Stroom, netbeheerkosten (per jaar)'), num('tariffs.stroomNetbeheerJaar', '0.01'))}
          ${st.has.gas ? field(t('Gas, vaste leveringskosten (per jaar)'), num('tariffs.gasVastJaar', '0.01')) : ''}
          ${st.has.gas ? field(t('Gas, netbeheerkosten (per jaar)'), num('tariffs.gasNetbeheerJaar', '0.01')) : ''}
        </div>
        <p class="help">${t('Saldering, de vermindering energiebelasting en de daltijden staan al goed. Die kun je later aanpassen bij de instellingen.')}</p>`
      : `<h2>${t('Je energietarieven')}</h2>
        <p class="help">${t('Vul je tarieven in, inclusief belastingen. Heb je één tarief voor de hele dag, vul dan bij dag en nacht hetzelfde bedrag in. Je kunt dit ook later invullen.')}</p>
        <div class="fields">
          ${field(t('Leverancier'), text('tariffs.supplier'))}
          ${field(t('Termijnbedrag (per maand)'), num('tariffs.termijnbedrag', '0.01'))}
          ${field(t('Tarief dag (per kWh)'), num('tariffs.leveringNormaal', '0.00001'))}
          ${field(t('Tarief nacht (per kWh)'), num('tariffs.leveringDal', '0.00001'))}
          ${field(t('Nachttarief vanaf (uur)'), num('tariffs.dalStart', '1'))}
          ${field(t('Nachttarief tot (uur)'), num('tariffs.dalEnd', '1'))}
          ${field(t('Terugleververgoeding (per kWh)'), num('tariffs.terugleverKwh', '0.00001'))}
          ${field(t('Terugleverkosten (per kWh, optioneel)'), num('tariffs.terugleverkostenKwh', '0.00001'))}
          ${st.has.gas ? field(t('Gastarief (per m³)'), num('tariffs.gasM3', '0.00001')) : ''}
          ${field(t('Vaste kosten stroom (per maand)'), num('monthly.stroom', '0.01'))}
          ${st.has.gas ? field(t('Vaste kosten gas (per maand)'), num('monthly.gas', '0.01')) : ''}
        </div>
        <label class="check"><input type="checkbox" data-bind="tariffs.weekendDal" ${st.tariffs.weekendDal ? 'checked' : ''}> ${t('Zaterdag en zondag de hele dag nachttarief')}</label>`,
  },
  {
    title: () => t('Extra'),
    render: () => `
      <h2>${t('Extra functies')}</h2>
      <div class="choice-grid">
        ${st.has.solar ? check('solar.enabled', t('Zonnevoorspelling'), t('Verwachte opwek voor vandaag en morgen, via forecast.solar')) : ''}
        ${check('signals', t('Signalen naar Homey'), t('Variabelen in Homey voor je flows, zoals zonne-overschot en daltarief'))}
      </div>
      ${st.has.solar && st.solar.enabled ? `
        <p class="help">${t('Richting: 0 = zuid, −90 = oost, 90 = west. Liggen je panelen op twee dakvlakken, vul dan later bij de instellingen het tweede vlak in.')}</p>
        <div class="fields three">
          ${field(t('Vermogen (kWp)'), num('solar.kwp', '0.01'))}
          ${field(t('Hellingshoek (°)'), num('solar.tilt', '1'))}
          ${field(t('Richting (°)'), num('solar.azimuth', '1'))}
          ${field(t('Breedtegraad'), num('solar.lat', '0.01'))}
          ${field(t('Lengtegraad'), num('solar.lon', '0.01'))}
          <div class="field"><label>&nbsp;</label><button type="button" class="btn" id="w-geo">${t('Gebruik mijn locatie')}</button></div>
        </div>` : ''}
      ${st.signals ? `<p class="help">${t('Hiervoor heeft je Homey-API-sleutel ook het recht "Variabelen" nodig.')}</p>` : ''}`,
  },
];

// ---------- Weergave en navigatie ----------

function render() {
  const s = STEPS[st.step];
  $('w-title').textContent = t('Installatie');
  $('w-sub').textContent = t('Stap {a} van {b}: {title}', { a: st.step + 1, b: STEPS.length, title: s.title() });
  $('w-steps').innerHTML = STEPS.map((_, i) => `<li class="${i < st.step ? 'done' : i === st.step ? 'now' : ''}"></li>`).join('');
  $('w-body').innerHTML = s.render();
  $('w-back').textContent = t('Vorige');
  $('w-back').hidden = st.step === 0;
  $('w-next').textContent = st.step === STEPS.length - 1 ? t('Klaar, naar het dashboard') : t('Volgende');
  msg('', '');
  bind();
}

function bind() {
  for (const el of $('w-body').querySelectorAll('[data-bind]')) {
    const handler = () => {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value;
      set(el.dataset.bind, v);
      if (el.hasAttribute('data-rerender')) render();
    };
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', handler);
  }
  for (const b of $('w-body').querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => {
      st.lang = b.dataset.lang;
      setLang(st.lang);
      document.title = st.lang === 'en' ? 'Setup – Energy' : 'Installatie – Energie';
      render();
    });
  }
  $('w-connect')?.addEventListener('click', connect);
  $('w-dongle')?.addEventListener('click', testDongle);
  $('w-geo')?.addEventListener('click', () => {
    if (!navigator.geolocation) return msg('err', t('Je browser kan de locatie niet bepalen. Vul hem zelf in.'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        st.solar.lat = Math.round(p.coords.latitude * 100) / 100;
        st.solar.lon = Math.round(p.coords.longitude * 100) / 100;
        render();
      },
      () => msg('err', t('Locatie niet beschikbaar (werkt alleen via https). Vul hem zelf in.')),
    );
  });
}

async function connect() {
  const out = $('w-connect-res');
  out.className = 'result';
  out.textContent = t('Apparaten ophalen…');
  try {
    st.devices = await api('/api/homey/devices', { homey: { url: st.homeyUrl, token: st.homeyToken } });
    out.className = 'result ok';
    out.textContent = t('{n} apparaten met meetwaarden gevonden.', { n: st.devices.length });
  } catch (e) {
    st.devices = null;
    out.className = 'result err';
    out.textContent = e.message;
  }
}

async function testDongle() {
  const out = $('w-dongle-res');
  out.className = 'result';
  out.textContent = t('Wachten op een meting van de dongle…');
  try {
    const v = await api('/api/dongle/test', { dongle: { url: st.dongleUrl } });
    const f = (x, d) => (x == null ? '–' : x.toLocaleString(LOCALE, { maximumFractionDigits: d }));
    out.className = 'result ok';
    out.textContent = t('Verbonden. Net {w} W, gas {m3} m³.', { w: f(v.grid_w, 0), m3: f(v.gas_m3, 3) });
  } catch (e) {
    out.className = 'result err';
    out.textContent = e.message;
  }
}

function buildConfig() {
  const cfg = structuredClone(existing);
  cfg.ui = { language: st.lang, setupDone: true };
  cfg.region = { country: st.country, currency: NL() ? 'EUR' : st.currency };
  cfg.homey = { url: st.homeyUrl, token: st.homeyToken };
  cfg.dongle = { url: st.has.dongle ? st.dongleUrl : '' };

  const homeyMetric = (k, extra = {}) => {
    const [deviceId = '', capability = ''] = st.map[k].pick.split('|');
    return { ...cfg.metrics[k], source: 'homey', deviceId, capability, invert: st.map[k].invert, ...extra };
  };
  const off = (k) => ({ ...cfg.metrics[k], source: 'none' });
  cfg.metrics.solar_w = st.has.solar ? homeyMetric('solar_w', { zeroOnError: true }) : off('solar_w');
  cfg.metrics.grid_w = st.has.dongle ? { ...cfg.metrics.grid_w, source: 'dongle', field: 'grid_w', invert: false } : homeyMetric('grid_w');
  cfg.metrics.battery_w = st.has.battery ? homeyMetric('battery_w') : off('battery_w');
  cfg.metrics.battery_soc = st.has.battery ? homeyMetric('battery_soc') : off('battery_soc');
  cfg.metrics.gas_m3 = !st.has.gas ? off('gas_m3') : st.has.dongle ? { ...cfg.metrics.gas_m3, source: 'dongle', field: 'gas_m3' } : homeyMetric('gas_m3');

  Object.assign(cfg.contract, st.tariffs);
  if (!NL()) {
    // Buiten Nederland: vaste kosten per maand, één post per energiesoort
    cfg.contract.stroomVastJaar = st.monthly.stroom * 12;
    cfg.contract.stroomNetbeheerJaar = 0;
    cfg.contract.gasVastJaar = st.monthly.gas * 12;
    cfg.contract.gasNetbeheerJaar = 0;
  }
  cfg.battery.capacityKwh = st.capacity;
  cfg.solar.enabled = st.has.solar && st.solar.enabled;
  cfg.solar.lat = st.solar.lat;
  cfg.solar.lon = st.solar.lon;
  cfg.solar.planes[0] = { tilt: st.solar.tilt, azimuth: st.solar.azimuth, kwp: st.solar.kwp };
  cfg.signals.enabled = st.signals;
  return cfg;
}

$('w-back').addEventListener('click', () => {
  st.step = Math.max(0, st.step - 1);
  render();
});
$('w-next').addEventListener('click', async () => {
  const err = STEPS[st.step].validate?.();
  if (err) return msg('err', err);
  if (st.step < STEPS.length - 1) {
    st.step++;
    return render();
  }
  msg('', t('Opslaan…'));
  try {
    await api('/api/config', buildConfig());
    location.href = '/';
  } catch (e) {
    msg('err', t('Opslaan mislukt: {e}', { e: e.message }));
  }
});

render();
