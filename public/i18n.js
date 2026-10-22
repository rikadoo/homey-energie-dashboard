// Vertalingen: de Nederlandse tekst is de sleutel, EN bevat de Engelse vertaling.
// Ontbreekt een vertaling, dan blijft de Nederlandse tekst staan.
import EN from './lang-en.js';

export let lang = 'nl';
export let LOCALE = 'nl-NL';
export let CURRENCY = 'EUR';
export let ui = { country: 'NL', setupDone: true };

export async function initI18n() {
  try {
    const res = await fetch('/api/ui', { cache: 'no-store' });
    if (res.ok) ui = await res.json();
  } catch {}
  const browser = (navigator.language || '').toLowerCase();
  lang = ui.language || (browser.startsWith('nl') ? 'nl' : 'en');
  setLang(lang);
  CURRENCY = ui.currency || 'EUR';
  return ui;
}

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'nl';
  LOCALE = lang === 'nl' ? 'nl-NL' : 'en-GB';
  document.documentElement.lang = lang;
}

/** Vertaal een tekst; {naam} wordt vervangen door vars.naam. */
export function t(s, vars) {
  let out = lang === 'nl' ? s : EN[s] ?? s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}

/** Vertaal vaste teksten in de HTML (tekstknopen en een paar attributen). */
export function applyStatic(root = document.body) {
  if (lang === 'nl') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const key = raw.trim();
    if (key && EN[key]) n.nodeValue = raw.replace(key, EN[key]);
  }
  for (const el of root.querySelectorAll('[aria-label],[placeholder],[title],optgroup[label]')) {
    for (const a of ['aria-label', 'placeholder', 'title', 'label']) {
      const v = el.getAttribute(a);
      if (v && EN[v]) el.setAttribute(a, EN[v]);
    }
  }
  if (EN[document.title]) document.title = EN[document.title];
}

// ---------- Opmaak van getallen, geld en tijden ----------

export const nf = (n, d) => Number(n || 0).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = (v, digits = 2) => {
  const x = Math.abs(v) < 0.005 ? 0 : v;
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
};
export const time = (d) => d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
export const dateLong = (s) => {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return y ? new Date(y, m - 1, d).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
};
