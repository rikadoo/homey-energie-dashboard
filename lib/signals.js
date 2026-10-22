// Signalen naar Homey: het dashboard houdt een paar Logica-variabelen in Homey bij.
// Die kun je in flows gebruiken ("Als variabele is gewijzigd" of als voorwaarde).

const VARS = {
  overschotW: { nl: 'Energie overschot (W)', en: 'Energy surplus (W)', type: 'number' },
  zonOverschot: { nl: 'Energie zonne-overschot', en: 'Energy solar surplus', type: 'boolean' },
  batterijVol: { nl: 'Energie batterij vol', en: 'Energy battery full', type: 'boolean' },
  batterijPct: { nl: 'Energie batterij (%)', en: 'Energy battery (%)', type: 'number' },
  daltarief: { nl: 'Energie daltarief', en: 'Energy off-peak rate', type: 'boolean' },
  kostenVandaag: { nl: 'Energie kosten vandaag (€)', en: 'Energy cost today', type: 'number' },
  zonMorgen: { nl: 'Energie zon morgen (kWh)', en: 'Energy solar tomorrow (kWh)', type: 'number' },
};

export class HomeySignals {
  constructor({ getSummary, getSolar, isDal }) {
    this.getSummary = getSummary;
    this.getSolar = getSolar;
    this.isDal = isDal;
    this.ids = null; // naam -> id
    this.sent = {}; // laatst verstuurde waarden
    this.state = { surplusSince: null, calmSince: null, surplus: false };
    this.status = { ok: null, message: 'Nog niet gestart', updated: null };
    this.busy = false;
    this.lastRun = 0;
  }

  async api(cfg, method, path, body) {
    const res = await fetch(cfg.homey.url + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.homey.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Homey weigert: geef de API-sleutel ook het recht om Logica (variabelen) te beheren.');
    }
    if (!res.ok) throw new Error(`Homey antwoordt met status ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async ensureVars(cfg) {
    const all = (await this.api(cfg, 'GET', '/api/manager/logic/variable/')) || {};
    const byName = new Map(Object.values(all).map((v) => [v.name, v]));
    this.ids = {};
    const lang = cfg.ui?.language === 'nl' || (!cfg.ui?.language && cfg.region?.country === 'NL') ? 'nl' : 'en';
    for (const [key, def] of Object.entries(VARS)) {
      // Bestaande variabele in een van beide talen hergebruiken, anders aanmaken in de ingestelde taal
      let v = byName.get(def.nl) || byName.get(def.en);
      if (!v) {
        const value = def.type === 'boolean' ? false : 0;
        v = await this.api(cfg, 'POST', '/api/manager/logic/variable/', { variable: { name: def[lang], type: def.type, value } });
      }
      this.ids[key] = v.id;
      this.sent[key] = v.value;
    }
  }

  compute(live, cfg) {
    const v = live.values || {};
    const sg = cfg.signals;
    const exp = Math.max(0, -(v.grid_w ?? 0));
    const now = Date.now();
    const hold = sg.minutes * 60_000;

    // Overschot met vertraging, zodat het niet bij elke wolk aan en uit springt
    if (exp >= sg.surplusW) {
      this.state.calmSince = null;
      this.state.surplusSince ??= now;
      if (!this.state.surplus && now - this.state.surplusSince >= hold) this.state.surplus = true;
    } else {
      this.state.surplusSince = null;
      if (exp < sg.surplusW / 2) {
        this.state.calmSince ??= now;
        if (this.state.surplus && now - this.state.calmSince >= hold) this.state.surplus = false;
      }
    }

    const out = {
      overschotW: Math.round(exp / 10) * 10,
      zonOverschot: this.state.surplus,
      daltarief: this.isDal(cfg.contract, new Date()),
    };
    if (v.battery_soc != null) {
      out.batterijPct = Math.round(v.battery_soc);
      out.batterijVol = v.battery_soc >= sg.batteryFull;
    }
    return out;
  }

  async run(live, cfg) {
    if (!cfg.signals.enabled || !cfg.homey.url || !cfg.homey.token || !live.ts) return;
    if (this.busy || Date.now() - this.lastRun < 30_000) return; // hooguit elke 30 seconden
    this.busy = true;
    this.lastRun = Date.now();
    try {
      if (!this.ids) await this.ensureVars(cfg);
      const values = this.compute(live, cfg);
      try {
        values.kostenVandaag = Math.round(this.getSummary().costs.totaal * 100) / 100;
      } catch {}
      const solar = await this.getSolar();
      if (solar?.days) {
        const t = new Date(Date.now() + 86_400_000);
        const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        if (solar.days[key] != null) values.zonMorgen = Math.round(solar.days[key] * 10) / 10;
      }
      for (const [key, value] of Object.entries(values)) {
        if (this.sent[key] === value || !this.ids[key]) continue;
        await this.api(cfg, 'PUT', `/api/manager/logic/variable/${this.ids[key]}`, { variable: { value } });
        this.sent[key] = value;
      }
      this.status = { ok: true, message: 'Variabelen in Homey zijn bijgewerkt.', updated: Date.now(), values };
    } catch (e) {
      this.ids = null; // bij de volgende keer opnieuw opzoeken
      this.status = { ok: false, message: e.name === 'TimeoutError' ? 'Homey reageert niet.' : e.message, updated: Date.now() };
    } finally {
      this.busy = false;
    }
  }
}
