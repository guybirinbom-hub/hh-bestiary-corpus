// Text normalisers shared by both reads. Everything a record stores passes through `clean`, so HTML,
// bold markers and link syntax never reach a record; anything `clean` does not recognise is reported
// through the `onUnknown` callback instead of being swallowed.

/** Action-cost words as they appear in `<actions string="…">`, measured over the whole corpus. */
const ACTION_WORD = {
  'single action': 1, 'one action': 1, '1 action': 1,
  'two actions': 2, 'two action': 2, '2 actions': 2,
  'three actions': 3, 'three action': 3, '3 actions': 3,
};

/** `<actions string>` value -> the app's Activity object, or undefined for an empty / unknown cost. */
export function actionStringToActivity(s) {
  if (!s) return undefined;
  const l = String(s).trim().toLowerCase();
  if (!l) return undefined;
  if (l === 'reaction') return { number: 1, unit: 'reaction' };
  if (l === 'free action' || l === 'free') return { number: 1, unit: 'free' };
  if (ACTION_WORD[l] !== undefined) return { number: ACTION_WORD[l], unit: 'action' };
  const range = l.match(/^(.+?)\s+(to|or)\s+(.+)$/);
  if (range) {
    const [, lo, sep, hi] = range;
    const loA = actionStringToActivity(lo);
    const hiA = actionStringToActivity(hi);
    if (!loA) return undefined;
    if (!hiA || hiA.unit !== loA.unit) return loA;
    return { ...loA, to: hiA.number, sep };
  }
  return undefined;
}

/** Activity -> the glyph string the app's AbilityText renders (◆ ◆◆ ◆◆◆ ↺ ◇, ranges "◆ to ◆◆◆"). */
export function activityGlyph(a) {
  if (!a) return '';
  if (a.unit === 'reaction') return '↺';
  if (a.unit === 'free') return '◇';
  const pips = (n) => '◆'.repeat(Math.min(Math.max(n, 1), 3));
  return a.to && a.to !== a.number ? `${pips(a.number)} ${a.sep ?? 'to'} ${pips(a.to)}` : pips(a.number);
}

export const ACTIONS_TAG = /<actions\s+string="([^"]*)"\s*\/?>/i;
export const ACTIONS_TAG_G = /<actions\s+string="([^"]*)"\s*\/?>/gi;

/** A markdown link. The URL may itself hold one level of parentheses. */
const LINK_G = /\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(((?:[^()\s]|\([^()]*\))*)\)/g;

/** `[text](url)` -> `text` (an empty `[](url)` goes away), then `_x_` italics, then the whitespace tidy. */
export function stripLinks(t) {
  return tidy(unlink(String(t ?? '')).replace(/_/g, ''));
}

/** Unwrap links until none is left: AoN sometimes nests one link inside another's text. */
export function unlink(s) {
  // The Archives' own template links that escaped rendering: {{conditions 76 "frightened"}} -> frightened.
  s = s.replace(/\{\{\w+\s+\d+\s+"([^"]*)"\}\}/g, '$1');
  let prev;
  let n = 0;
  do { prev = s; s = s.replace(LINK_G, '$1'); } while (s !== prev && ++n < 6);
  return s;
}

/** Horizontal whitespace runs -> one space; no space before , ; . ) or after ( [. Newlines kept. */
export function tidy(t) {
  return String(t)
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+([,;.)])/g, '$1')
    .replace(/([([])[^\S\n]+/g, '$1');
}

export function decodeEntities(t) {
  return String(t)
    .replace(/&(?:amp;)?lt;/g, '<').replace(/&(?:amp;)?gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Tags the cleaner knows how to turn into text. Everything else is reported. */
const KNOWN_INLINE = new Set(['actions', 'sup', 'b', 'i', 'strong', 'em', 'br', 'u']);

/**
 * Remove inline HTML: `<actions string>` becomes its glyph, `<sup>`/`<b>`/`<i>` are unwrapped, `<br>`
 * becomes a newline. Any other tag is reported through onUnknown(tagName, context) and removed.
 */
export function unwrapHtml(t, onUnknown) {
  let s = String(t ?? '');
  s = s.replace(ACTIONS_TAG_G, (_, a) => {
    const g = activityGlyph(actionStringToActivity(a));
    return g ? ` ${g} ` : ' ';
  });
  s = s.replace(/<br\s*\/?>|<\/br>/gi, '\n');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, tag) => {
    if (!KNOWN_INLINE.has(tag.toLowerCase()) && onUnknown) onUnknown(tag, m);
    return '';
  });
  return s;
}

/** The single funnel for every stored string: HTML out, links unwrapped, bold and italics gone, tidied. */
export function clean(t, onUnknown) {
  let s = unwrapHtml(decodeEntities(String(t ?? '')), onUnknown);
  s = unlink(s);
  s = s.replace(/\*\*/g, '');
  // Every underscore in the Archives markdown is an italic marker (the plain-text `text` facet of all
  // 5,454 documents contains none), so they all go, including the ones a link unwrap leaves unpaired.
  s = s.replace(/_/g, '');
  s = tidy(s);
  return s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One-line variant: newlines become spaces. */
export function clean1(t, onUnknown) {
  return clean(t, onUnknown).replace(/\s*\n\s*/g, ' ').trim();
}

/** Split on commas at parenthesis depth 0 (and bracket depth 0, so link text stays whole). */
export function splitTopLevel(str, sep = ',', brackets = true) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(str)) {
    if (ch === '(' || (brackets && ch === '[')) depth++;
    else if (ch === ')' || (brackets && ch === ']')) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Comma list -> cleaned, non-empty items. */
export function splitList(raw, onUnknown) {
  // Links first, so a stray "[" in AoN's text (Rukh's "grim tendrils [4th-rank)") cannot hide a comma.
  return splitTopLevel(unlink(String(raw ?? '')), ',', false)
    .map((t) => clean1(t, onUnknown))
    .filter(Boolean);
}

/** `<table>…</table>` -> GitHub pipe table (first row is the header). */
export function tableToPipe(html, onUnknown) {
  const rows = [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean1(c[1], onUnknown).replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '|' + Array.from({ length: w }, () => '---').join('|') + '|', ...rows.slice(1).map(line)].join('\n');
}

/** Normalised comparison key: links unwrapped, case folded, whitespace collapsed, "feet" -> "ft". */
export function normKey(t) {
  return clean1(String(t ?? ''))
    .toLowerCase()
    .replace(/\bfeet\b|\bfoot\b/g, 'ft')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .trim();
}

export const num = (v, fb = 0) => { const n = parseInt(v); return Number.isNaN(n) ? fb : n; };
export const toArr = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
export const ordSuffix = (n) => (n % 100 >= 11 && n % 100 <= 13) ? 'th'
  : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
