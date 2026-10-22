// Alle grafieken als SVG, zonder externe bibliotheken.

const C = { sun: '#F4B740', batt: '#5ED3B0', grid: '#7AA7FF', house: '#D8D3CB', line: '#232A31', strong: '#3A434D', muted: '#9AA3AC' };
const nf = (n, d) => n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (v) => `${v < -0.004 ? '−' : ''}€ ${nf(Math.abs(v), 2)}`;
const hhmm = (t) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function linePath(pts) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}

// ---------- Live: laatste uur ----------

export function renderLive(el, points) {
  if (!points || points.length < 2) {
    el.innerHTML = '<p class="empty">De grafiek vult zich automatisch, zodra er een paar metingen binnen zijn.</p>';
    return;
  }
  const W = el.clientWidth && el.clientWidth < 600 ? 520 : 1000;
  const H = 260, L = 48, R = 12, T = 12, B = 26;
  const now = Date.now();
  const t0 = now - 3_600_000;
  const pts = points.filter((p) => p.t >= t0);
  const vals = pts.flatMap((p) => [p.s, p.h, p.g, p.b]);
  const hi = niceMax(Math.max(100, ...vals));
  const loRaw = Math.min(0, ...vals);
  const lo = loRaw < 0 ? -niceMax(-loRaw) : 0;
  const x = (t) => L + ((t - t0) / 3_600_000) * (W - L - R);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);

  const series = [
    ['s', C.sun, 'Zon'],
    ['h', C.house, 'Huis'],
    ['g', C.grid, 'Net'],
    ['b', C.batt, 'Batterij'],
  ];
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Vermogen van het laatste uur">`;
  // Rasterlijnen en labels
  const step = niceMax((hi - lo) / 4);
  for (let v0 = Math.ceil(lo / step) * step; v0 <= hi + 1; v0 += step) {
    const v = Math.round(v0) || 0; // geen "-0" als label
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? C.strong : C.line}" stroke-width="1"/>`;
    svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">${nf(v / 1000, v % 1000 ? 1 : 0)}</text>`;
  }
  for (let m = 0; m <= 60; m += 10) {
    const t = t0 + m * 60_000;
    svg += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle" class="axis">${hhmm(t)}</text>`;
  }
  // Zon als zacht vlak
  const sun = pts.map((p) => [x(p.t), y(p.s)]);
  svg += `<path d="${linePath(sun)} L${x(pts.at(-1).t)} ${y(0)} L${x(pts[0].t)} ${y(0)} Z" fill="${C.sun}" opacity="0.12"/>`;
  for (const [k, col] of series) {
    svg += `<path d="${linePath(pts.map((p) => [x(p.t), y(p[k])]))}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  svg += `<line class="hover-line" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${C.muted}" stroke-dasharray="3 4" visibility="hidden"/>`;
  svg += `<rect class="hover-area" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  svg += `<text x="4" y="${T + 4}" class="axis">kW</text></svg><div class="tip" hidden></div>`;
  el.innerHTML = svg;

  const svgEl = el.querySelector('svg');
  const tip = el.querySelector('.tip');
  const line = el.querySelector('.hover-line');
  const move = (ev) => {
    const r = svgEl.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((vx - L) / (W - L - R)) * 3_600_000;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    line.setAttribute('x1', x(best.t));
    line.setAttribute('x2', x(best.t));
    line.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<strong>${hhmm(best.t)}</strong>` + series.map(([k, col, name]) => `<span><i style="background:${col}"></i>${name} ${nf(best[k] / 1000, 2)} kW</span>`).join('');
    const px = (x(best.t) / W) * r.width;
    tip.style.left = `${Math.min(Math.max(px - 80, 0), r.width - 170)}px`;
  };
  svgEl.addEventListener('pointermove', move);
  svgEl.addEventListener('pointerleave', () => {
    tip.hidden = true;
    line.setAttribute('visibility', 'hidden');
  });
}

// ---------- Zonnevoorspelling ----------

export function renderSolar(el, d) {
  if (!d.enabled) {
    el.innerHTML = '<p class="empty">Zet de zonnevoorspelling aan in de <a href="/settings">instellingen</a> en vul de gegevens van je panelen in.</p>';
    return;
  }
  if (!d.watts) {
    el.innerHTML = `<p class="empty">${esc(d.error || 'Voorspelling wordt opgehaald…')}</p>`;
    return;
  }
  const now = new Date();
  const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = ymd(now);
  const tomorrowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrow = ymd(tomorrowDate);
  const actualKwh = (d.actual || []).reduce((s, r) => s + (r.kwh || 0), 0);
  const pts = d.watts.map(([t, w]) => [new Date(t).getTime(), w]);
  const tPts = pts.filter(([t]) => ymd(new Date(t)) === tomorrow);
  let best = '';
  if (tPts.length) {
    const peak = Math.max(...tPts.map(([, w]) => w));
    const good = tPts.filter(([, w]) => w >= peak * 0.6);
    if (good.length && peak > 0) best = `${hhmm(good[0][0])}–${hhmm(good.at(-1)[0])}`;
  }

  const W = 420, H = 130, L = 4, R = 4, T = 8, B = 20;
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t1 = t0 + 2 * 86_400_000;
  const max = niceMax(Math.max(100, ...pts.map(([, w]) => w), ...(d.actual || []).map((r) => r.w || 0)));
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const inRange = pts.filter(([t]) => t >= t0 && t <= t1);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Voorspelde opwek vandaag en morgen">`;
  svg += `<line x1="${x(t0 + 86_400_000)}" x2="${x(t0 + 86_400_000)}" y1="${T}" y2="${H - B}" stroke="${C.line}"/>`;
  if (inRange.length) {
    svg += `<path d="${linePath(inRange.map(([t, w]) => [x(t), y(w)]))} L${x(inRange.at(-1)[0])} ${y(0)} L${x(inRange[0][0])} ${y(0)} Z" fill="${C.sun}" opacity="0.22"/>`;
    svg += `<path d="${linePath(inRange.map(([t, w]) => [x(t), y(w)]))}" fill="none" stroke="${C.sun}" stroke-width="2" stroke-dasharray="5 4"/>`;
  }
  const act = (d.actual || []).filter((r) => r.w != null).map((r) => [x(t0 + (r.h + 0.5) * 3_600_000), y(r.w)]);
  if (act.length > 1) svg += `<path d="${linePath(act)}" fill="none" stroke="${C.sun}" stroke-width="2.5"/>`;
  svg += `<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" stroke="${C.muted}" stroke-width="1"/>`;
  svg += `<text x="${x(t0 + 43_200_000)}" y="${H - 5}" text-anchor="middle" class="axis">vandaag</text>`;
  svg += `<text x="${x(t0 + 129_600_000)}" y="${H - 5}" text-anchor="middle" class="axis">morgen</text></svg>`;

  el.innerHTML = `
    <div class="solar-days">
      <div><div class="muted small">Vandaag verwacht</div><div class="display mid">${nf(d.days?.[today] ?? 0, 1)} <span class="unit">kWh</span></div><div class="muted small">tot nu ${nf(actualKwh, 1)} kWh</div></div>
      <div><div class="muted small">Morgen verwacht</div><div class="display mid sun-text">${nf(d.days?.[tomorrow] ?? 0, 1)} <span class="unit">kWh</span></div><div class="muted small">${best ? `beste uren ${best}` : ''}</div></div>
    </div>
    ${svg}
    <div class="legend small"><span><i class="dash"></i>Voorspelling</span><span><i style="background:${C.sun}"></i>Werkelijk</span></div>
    ${d.error ? `<p class="muted small">${esc(d.error)}</p>` : ''}`;
}

// ---------- Sankey: waar ging de energie heen ----------

export function renderSankey(el, f) {
  const left = [
    ['Zon', C.sun, [['huis', f.zh], ['batt', f.zb], ['net', f.zn]]],
    ['Batterij', C.batt, [['huis', f.bh], ['net', f.bn]]],
    ['Net', C.grid, [['huis', f.nh], ['batt', f.nb]]],
  ];
  const right = { huis: ['Huis', C.house], batt: ['Batterij', C.batt], net: ['Net', C.grid] };
  const rTot = { huis: f.zh + f.bh + f.nh, batt: f.zb + f.nb, net: f.zn + f.bn };
  const lTot = left.map(([, , links]) => links.reduce((s, [, v]) => s + v, 0));
  const total = Math.max(lTot.reduce((a, b) => a + b, 0), Object.values(rTot).reduce((a, b) => a + b, 0));
  if (total < 0.05) {
    el.innerHTML = '<p class="empty">Nog geen energiestromen in deze periode.</p>';
    return;
  }
  const W = 700, H = 320, NW = 14, GAP = 22, LX = 150, RX = W - 150 - NW;
  const scale = (H - GAP * 2) / total;
  // Posities van de knopen
  let yy = 0;
  const lPos = lTot.map((v) => {
    const p = { y: yy, h: v * scale, off: 0 };
    yy += v * scale + (v > 0 ? GAP : 0);
    return p;
  });
  yy = 0;
  const rPos = {};
  for (const k of ['huis', 'batt', 'net']) {
    rPos[k] = { y: yy, h: rTot[k] * scale, off: 0 };
    yy += rTot[k] * scale + (rTot[k] > 0 ? GAP : 0);
  }
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Energiestromen in deze periode">`;
  left.forEach(([, col, links], i) => {
    for (const [to, v] of links) {
      if (v * scale < 0.5) continue;
      const h = v * scale;
      const y0 = lPos[i].y + lPos[i].off + h / 2;
      const y1 = rPos[to].y + rPos[to].off + h / 2;
      lPos[i].off += h;
      rPos[to].off += h;
      const mx = (LX + NW + RX) / 2;
      svg += `<path d="M${LX + NW} ${y0} C${mx} ${y0}, ${mx} ${y1}, ${RX} ${y1}" fill="none" stroke="${col}" stroke-opacity="0.42" stroke-width="${h.toFixed(1)}"><title>${left[i][0]} → ${right[to][0]}: ${nf(v, 1)} kWh</title></path>`;
    }
  });
  left.forEach(([name, col], i) => {
    if (lTot[i] <= 0) return;
    const p = lPos[i];
    svg += `<rect x="${LX}" y="${p.y}" width="${NW}" height="${Math.max(2, p.h)}" rx="3" fill="${col}"/>`;
    svg += `<text x="${LX - 12}" y="${p.y + p.h / 2 - 2}" text-anchor="end" class="s-name">${name}</text>`;
    svg += `<text x="${LX - 12}" y="${p.y + p.h / 2 + 16}" text-anchor="end" class="s-val">${nf(lTot[i], 1)} kWh</text>`;
  });
  for (const k of ['huis', 'batt', 'net']) {
    if (rTot[k] <= 0) continue;
    const p = rPos[k];
    const [name, col] = right[k];
    const label = k === 'net' ? 'Teruglevering' : k === 'batt' ? 'Batterij laden' : name;
    svg += `<rect x="${RX}" y="${p.y}" width="${NW}" height="${Math.max(2, p.h)}" rx="3" fill="${col}"/>`;
    svg += `<text x="${RX + NW + 12}" y="${p.y + p.h / 2 - 2}" class="s-name">${label}</text>`;
    svg += `<text x="${RX + NW + 12}" y="${p.y + p.h / 2 + 16}" class="s-val">${nf(rTot[k], 1)} kWh</text>`;
  }
  el.innerHTML = svg + '</svg>';
}

// ---------- Batterijdag ----------

export function renderBatteryDay(el, d) {
  const W = 700, H = 230, L = 36, R = 8, T = 10, SOC_H = 140, BAR_T = 165, BAR_H = 40;
  const x = (i) => L + (i / 144) * (W - L - R);
  const ySoc = (v) => T + (1 - v / 100) * SOC_H;
  const maxBar = Math.max(0.05, ...d.slots.map((s) => Math.max(s.chg, s.dis)));
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Laadtoestand en laden of ontladen over de dag">`;
  for (const v of [0, 50, 100]) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${ySoc(v)}" y2="${ySoc(v)}" stroke="${C.line}"/>`;
    svg += `<text x="${L - 6}" y="${ySoc(v) + 4}" text-anchor="end" class="axis">${v}%</text>`;
  }
  // Laadtoestand: doorlopende stukken lijn met een vlak eronder
  let seg = [];
  const flush = () => {
    if (seg.length > 1) {
      svg += `<path d="${linePath(seg)} L${seg.at(-1)[0]} ${ySoc(0)} L${seg[0][0]} ${ySoc(0)} Z" fill="${C.batt}" opacity="0.14"/>`;
      svg += `<path d="${linePath(seg)}" fill="none" stroke="${C.batt}" stroke-width="2.2"/>`;
    }
    seg = [];
  };
  d.slots.forEach((s, i) => (s.soc == null ? flush() : seg.push([x(i + 0.5), ySoc(s.soc)])));
  flush();
  // Laden (groen, omhoog) en ontladen (licht, omlaag) per 10 minuten
  const mid = BAR_T + BAR_H / 2;
  svg += `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" stroke="${C.strong}"/>`;
  const bw = (W - L - R) / 144 - 0.6;
  d.slots.forEach((s, i) => {
    if (s.chg > 0.001) svg += `<rect x="${x(i)}" y="${mid - (s.chg / maxBar) * (BAR_H / 2)}" width="${bw}" height="${(s.chg / maxBar) * (BAR_H / 2)}" fill="${C.batt}"/>`;
    if (s.dis > 0.001) svg += `<rect x="${x(i)}" y="${mid}" width="${bw}" height="${(s.dis / maxBar) * (BAR_H / 2)}" fill="${C.house}"/>`;
  });
  for (let h = 0; h <= 24; h += 3) svg += `<text x="${x(h * 6)}" y="${H - 2}" text-anchor="middle" class="axis">${String(h).padStart(2, '0')}</text>`;
  el.innerHTML = svg + '</svg>';
}

// ---------- Heatmap ----------

export function renderHeatmap(el, data) {
  const days = data.days;
  const vals = days.flatMap((d) => d.values).filter((v) => v != null);
  if (!vals.length) {
    el.innerHTML = '<p class="empty">Nog geen gegevens voor de afgelopen weken.</p>';
    return;
  }
  const max = Math.max(0.05, ...vals.map(Math.abs));
  const CW = 50, CH = 20, L = 84, T = 22;
  const W = L + 24 * CW, H = T + days.length * CH;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg heat" role="img" aria-label="Energie per uur over de afgelopen weken">`;
  for (let h = 0; h < 24; h += 3) svg += `<text x="${L + h * CW + 2}" y="${T - 6}" class="axis">${String(h).padStart(2, '0')}</text>`;
  days.forEach((d, r) => {
    const dt = new Date(`${d.day}T12:00:00`);
    const label = dt.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
    const weekend = dt.getDay() === 0 || dt.getDay() === 6;
    svg += `<text x="${L - 10}" y="${T + r * CH + CH - 6}" text-anchor="end" class="axis${weekend ? ' strong' : ''}">${label}</text>`;
    d.values.forEach((v, h) => {
      let fill = C.line, op = 0.5;
      if (v != null) {
        const col = data.metric === 'solar' ? C.sun : data.metric === 'net' ? (v >= 0 ? C.grid : C.sun) : C.house;
        fill = col;
        op = 0.07 + 0.93 * Math.min(1, Math.abs(v) / max);
      }
      const unit = data.metric === 'net' ? (v >= 0 ? 'afname' : 'teruglevering') : 'kWh';
      const tip = v == null ? 'geen data' : `${nf(Math.abs(v), 2)} kWh ${data.metric === 'net' ? unit : ''}`;
      svg += `<rect x="${L + h * CW + 1}" y="${T + r * CH + 1}" width="${CW - 2}" height="${CH - 2}" rx="3" fill="${fill}" fill-opacity="${op.toFixed(2)}"><title>${label} ${String(h).padStart(2, '0')}:00, ${tip}</title></rect>`;
    });
  });
  el.innerHTML = svg + '</svg>';
}

// ---------- Jaarnota-voorspelling ----------

export function renderJaarnota(el, d) {
  if (!d.ok) {
    el.innerHTML = `<p class="empty">${esc(d.reason || 'Nog geen voorspelling mogelijk.')}</p>`;
    return;
  }
  const terug = d.saldo >= 0;
  const paid = d.termijnen + d.bonus;
  const noTerm = !(d.termijnen > 0);
  const max = Math.max(paid, d.total);
  const pct = (v) => `${Math.max(0, (v / max) * 100).toFixed(1)}%`;
  const costParts = [
    ['Stroom', d.parts.stroom, C.grid],
    ['Gas', d.parts.gas, C.sun],
    ['Vaste kosten', d.parts.vast - d.parts.eb, C.house],
  ];
  el.innerHTML = `
    ${noTerm
      ? `<div class="big-result"><div class="display huge">${eur(d.total)}</div><div>verwachte kosten van je contractjaar</div><div class="muted small">Vul je termijnbedrag in bij de instellingen om te zien of je moet bijbetalen of terugkrijgt.</div></div>`
      : `<div class="big-result ${terug ? 'pos' : 'neg'}">
      <div class="display huge">${eur(Math.abs(d.saldo))}</div>
      <div>${terug ? 'verwacht terug bij je jaarnota' : 'verwacht bijbetalen bij je jaarnota'}</div>
    </div>`}
    <div class="stack-bars">
      <div class="sb-label"><span>Verwachte kosten</span><span>${eur(d.total)}</span></div>
      <div class="sb-track">${costParts.map(([n, v, col]) => `<span title="${n}: ${eur(v)}" style="width:${pct(Math.max(0, v))};background:${col}"></span>`).join('')}</div>
      ${noTerm ? '' : `<div class="sb-label"><span>Betaald (${d.months} × termijn${d.bonus ? ' + bonus' : ''})</span><span>${eur(paid)}</span></div>
      <div class="sb-track"><span style="width:${pct(d.termijnen)};background:${C.batt}"></span><span style="width:${pct(d.bonus)};background:${C.batt};opacity:.55"></span></div>`}
    </div>
    <dl class="tariffs">
      ${costParts.map(([n, v, col]) => `<div><dt><i class="sw" style="background:${col}"></i>${n}</dt><dd>${eur(v)}</dd></div>`).join('')}
      <div><dt>Verbruik</dt><dd>${nf(d.kwh.imp, 0)} kWh, ${nf(d.kwh.gas, 0)} m³</dd></div>
      <div><dt>Teruglevering</dt><dd>${nf(d.kwh.exp, 0)} kWh</dd></div>
    </dl>
    ${d.gasOnlySummer && !d.usedLastYear ? '<p class="warn-note">Er is nog geen stookseizoen gemeten, dus het gasverbruik is waarschijnlijk te laag ingeschat. Vul je jaarverbruik van vorig jaar in bij de instellingen voor een betere schatting.</p>' : ''}
    <p class="muted small">Gebaseerd op ${d.readingDays ? `${d.readingDays} dagen uit meterstanden en ` : ''}${nf(d.liveDays, 1)} ${d.liveDays === 1 ? 'dag' : 'dagen'} live meting, van de ${d.totalDays} contractdagen. De rest is geschat met een seizoensprofiel${d.usedLastYear ? ' en je verbruik van vorig jaar' : ''}.${d.usedReadings ? '' : ' Vul de meterstanden bij contractstart in voor een exacte start.'}</p>`;
}

// ---------- Einde saldering ----------

export function renderSaldering(el, d) {
  if (!d.ok) {
    el.innerHTML = '<p class="empty">Na een dag meten zie je hier wat het einde van de saldering voor jou betekent.</p>';
    return;
  }
  const p = d.perMonth;
  const rows = [
    ['Nu, met saldering', p.metSaldering, C.batt],
    ['Vanaf 2027', p.zonderSaldering, C.sun],
    ['Vanaf 2027 zonder batterij', p.zonderSalderingZonderBatterij, C.house],
  ];
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  const extra = p.zonderSaldering - p.metSaldering;
  const batt = p.zonderSalderingZonderBatterij - p.zonderSaldering;
  el.innerHTML = `
    <div class="hbars">
      ${rows.map(([n, v, col]) => `
        <div class="hb"><div class="hb-label"><span>${n}</span><span>${eur(v)} /mnd</span></div>
        <div class="hb-track"><span style="width:${((Math.max(0, v) / max) * 100).toFixed(1)}%;background:${col}"></span></div></div>`).join('')}
    </div>
    <p>Vanaf 1 januari betaal je voor stroom naar schatting <strong>${eur(Math.max(0, extra))}</strong> per maand meer. Zonder je batterij zou dat ${eur(Math.max(0, extra + batt))} zijn: de batterij scheelt je dan ongeveer <strong class="sun-text">${eur(Math.max(0, batt))}</strong> per maand.</p>
    <p class="muted small">Alleen variabele stroomkosten, op basis van de laatste ${nf(Math.min(30, d.days), 0)} dagen. In de zomer, met meer teruglevering, is het verschil groter.</p>`;
}
