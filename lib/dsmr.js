// Leest een DSMR-telegram (P1) uit en geeft de waarden terug die het dashboard nodig heeft.

const LINE = /^(\d+-\d+:\d+\.\d+\.\d+)((?:\([^)]*\))+)/;

function lastNumber(groups) {
  const parts = groups.match(/\(([^)]*)\)/g) || [];
  const last = parts[parts.length - 1]?.slice(1, -1) ?? '';
  const n = parseFloat(last.split('*')[0]);
  return Number.isFinite(n) ? n : null;
}

export function parseTelegram(text) {
  const obis = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(LINE);
    if (m) obis[m[1]] = lastNumber(m[2]);
  }
  const get = (code) => obis[code] ?? null;
  const sum = (...codes) => {
    const vals = codes.map(get).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  const importKw = get('1-0:1.7.0');
  const exportKw = get('1-0:2.7.0');
  let gas = null;
  for (const [code, v] of Object.entries(obis)) {
    if (/^0-\d:24\.2\.[13]$/.test(code) && v != null) gas = v;
  }

  const values = {
    grid_w: importKw != null || exportKw != null ? ((importKw ?? 0) - (exportKw ?? 0)) * 1000 : null,
    import_w: importKw != null ? importKw * 1000 : null,
    export_w: exportKw != null ? exportKw * 1000 : null,
    import_kwh: sum('1-0:1.8.1', '1-0:1.8.2') ?? get('1-0:1.8.0'),
    export_kwh: sum('1-0:2.8.1', '1-0:2.8.2') ?? get('1-0:2.8.0'),
    gas_m3: gas,
    // Telwerken: tarief 1 = dal, tarief 2 = normaal (Nederlandse meters)
    import_dal_kwh: get('1-0:1.8.1'),
    import_normaal_kwh: get('1-0:1.8.2'),
    export_dal_kwh: get('1-0:2.8.1'),
    export_normaal_kwh: get('1-0:2.8.2'),
  };
  return Object.values(values).some((v) => v != null) ? values : null;
}
