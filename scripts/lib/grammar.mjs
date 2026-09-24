// The entry grammar shared by the creature and hazard page parsers (read 2).
//
// A stat block is a sequence of ENTRIES. An entry starts on a line whose first token is a bold label
// and runs until the next entry start. This module turns raw page markdown into lines, recognises
// labels in every form the Archives prints them, and parses the value shapes that both creature and
// hazard pages share (defences, strikes, abilities). Anything it cannot place is handed to the
// caller's `bad(section, heading, line, reason)` so it lands in report/unparsed.json.

import {
  ACTIONS_TAG, ACTIONS_TAG_G, actionStringToActivity, clean, clean1, decodeEntities, splitList,
  splitTopLevel, tableToPipe, num, stripLinks,
} from './text.mjs';

/** Bold labels that continue the current ability rather than starting a new entry. */
export const CLAUSE_LABELS = [
  'Critical Success', 'Critical Failure', 'Success', 'Failure', 'Effect', 'Trigger', 'Requirements',
  'Requirement', 'Frequency', 'Saving Throw', 'Onset', 'Maximum Duration', 'Stage \\d+', 'Cost',
  'Special', 'Prerequisites?', 'Duration', 'Range', 'Area', 'Targets?', 'Heightened \\([^)]*\\)',
  'Activate', 'Critical', 'Secondary Casters', 'Primary Check', 'Secondary Checks?', 'Critical Effect',
];
export const CLAUSE_RE = new RegExp(`^(?:${CLAUSE_LABELS.join('|')})$`, 'i');
/** A clause label anywhere in a body, bold, for turning `**Label** text` into `\nLabel text`. */
const CLAUSE_INLINE_G = new RegExp(`\\s*;?\\s*\\*\\*(${CLAUSE_LABELS.join('|')}):?\\*\\*:?`, 'gi');

const TAGS_LAYOUT = /<\/?(?:column|row|traits|trait|document|image|center|div|span|p|hr)\b[^>]*>/gi;

/**
 * Page markdown -> cleaned-up lines. Asides are lifted out (returned as sidebars), tables become pipe
 * tables, layout tags go, `<br>` and list items become line breaks. Unknown tags are left in place so
 * `clean` reports them where they sit.
 */
export function preprocess(md, bad, section = '') {
  const sidebars = [];
  let s = md;
  s = s.replace(/<aside\b[^>]*>([\s\S]*?)<\/aside>/gi, (_, inner) => {
    const t = sidebarText(inner, bad);
    if (t) sidebars.push(t);
    return '\n\n';
  });
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => `\n\u0001TABLE\u0001${tableToPipe(m, (tag) => bad(section, '', m.slice(0, 80), `unknown tag <${tag}>`)).replace(/\n/g, '\u0002')}\n`);
  // A title inside the stat block heads a sub-block (a mask, an aspect): keep it as a heading line.
  s = s.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_, t) => (clean1(t) ? `\n\n### ${clean1(t)}\n` : '\n'));
  s = s.replace(/<traits>[\s\S]*?<\/traits>/gi, '\n');
  s = s.replace(TAGS_LAYOUT, '\n');
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return '\n' + inner.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `).replace(/<\/li\s*>/gi, '\n') + '\n';
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>/gi, '\n').replace(/<\/?[uo]l\b[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>|<\/br>/gi, '\n');
  const lines = s.split('\n').map((l) => l.trim());
  // A line that starts with a comma was hard-wrapped mid-list: stitch it back.
  const out = [];
  for (const l of lines) {
    if (/^,/.test(l) && out.length) {
      let k = out.length - 1;
      while (k > 0 && out[k] === '') k--;
      out[k] = out[k] + l;
      continue;
    }
    out.push(l);
  }
  return { lines: out, sidebars };
}

/** An `<aside>` block -> plain text: its title line, then its paragraphs. */
export function sidebarText(inner, bad) {
  let t = inner.replace(/\r/g, '');
  const title = t.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  t = t.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '\n');
  t = t.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => '\n' + tableToPipe(m) + '\n');
  t = t.replace(TAGS_LAYOUT, '\n');
  t = t.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>|<\/?[uo]l\b[^>]*>/gi, '\n');
  t = t.replace(/^#{1,6}\s+/gm, '').replace(/^---\s*$/gm, '');
  const body = clean(t, (tag) => bad('flavor', 'aside', inner.slice(0, 80), `unknown tag <${tag}>`));
  const head = title ? clean1(title[1]) : '';
  return [head, body].filter(Boolean).join('\n\n');
}

/**
 * Read the bold label at the start of a line. Returns {name, rawLabel, rest, url} or null.
 * Forms: **Label**, **[Label](url)**, [**Label**](url), **[**Label**](url)**, **[Label](url) (suffix)**,
 * and the unclosed **[Label](url) <actions…/> / **Label <actions…/> **Trigger**.
 */
export function readLabel(line) {
  let m;
  if ((m = line.match(/^\*\*\[\*\*(.+?)\*\*\]\(([^)]*)\)\*\*\s*/))) return fin(m[1], line.slice(m[0].length), m[2]);
  if ((m = line.match(/^\[\*\*(.+?)\*\*\]\(([^)]*)\)\s*/))) return fin(m[1], line.slice(m[0].length), m[2]);
  if (!line.startsWith('**') || line.startsWith('***')) return null;
  const end = line.indexOf('**', 2);
  let inner = end < 0 ? line.slice(2) : line.slice(2, end);
  let rest = end < 0 ? '' : line.slice(end + 2);
  const a = inner.search(/<actions\b/i);
  let unclosed = end < 0;
  if (a >= 0) {
    // The bold never closed before the cost tag: the `**` that follows opens the next bold.
    rest = line.slice(2 + a);
    inner = inner.slice(0, a);
    unclosed = true;
  } else if (end < 0) {
    return { name: clean1(inner).replace(/:$/, ''), rawLabel: inner, rest: '', unclosed: true, broken: true };
  }
  // **[Label](url) suffix** — the suffix is body text (traits, numbers) unless it is more name words.
  const lm = inner.match(/^\s*\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)\)\s*(.*)$/s);
  if (lm && lm[3] && !/^[A-Za-z][A-Za-z'’\- ]*$/.test(lm[3].trim())) return fin(lm[1], `${lm[3]} ${rest}`, lm[2], unclosed);
  if (lm && !lm[3]) return fin(lm[1], rest, lm[2], unclosed);
  return fin(inner, rest, undefined, unclosed);

  function fin(raw, rest2, url, uncl = false) {
    let name = clean1(raw.replace(/\*\*/g, '')).replace(/\s*[:;]$/, '').replace(/^•\s*/, '').trim();
    let lead = '';
    // A cost token printed inside the bold: "Call Glaive or [three-actions]", "Cloak in Embers [reaction".
    const tk = name.match(/\s+((?:or\s+)?\[(?:one-action|two-actions|three-actions|reaction|free-action)\]?(?:\s+or\s+\[[a-z-]+\]?)*)$/i);
    if (tk) { lead = tk[1].replace(/^or\s+/i, '').replace(/\[([a-z-]+)$/i, '[$1]') + ' '; name = name.slice(0, tk.index).replace(/\s+or$/i, '').trim(); }
    // A trait list printed inside the bold: "Wall Blend (concentrate)".
    const tp = name.match(/^(.*?[A-Za-z])\s*(\([a-z][^()]*\))$/);
    if (tp) { lead += tp[2] + ' '; name = tp[1].trim(); }
    // A trait list whose "(" the bold swallowed the wrong side of: "Mental Rebirth curse, incapacitation, …, occult)".
    if (/\)$/.test(name) && !name.includes('(')) {
      const pm = name.match(/^((?:[A-Z][\w'’\-]*\s*)+)\s+([a-z].*)\)$/);
      if (pm) { lead += `(${pm[2]}) `; name = pm[1].trim(); }
    }
    return { name, rawLabel: raw, rest: (lead + rest2.replace(/^\s*[:;]\s*/, '')).trim(), url, unclosed: uncl };
  }
}

/** Unbolded Title Case header immediately followed by an `<actions>` tag or a `(trait)` list. */
export function readUnboldedHeader(line, abilityNames, paragraphStart) {
  const lk = line.match(/^\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*\)\s*/);
  if (lk && abilityNames.has(clean1(lk[1]).toLowerCase())) return { name: clean1(lk[1]), rawLabel: lk[1], rest: line.slice(lk[0].length).trim(), unbolded: true };
  const m = line.match(/^([A-Z][A-Za-z'’\-!]*(?:\s+(?:[A-Za-z'’\-!]+|\d+))*?)\s*(?=<actions\b|\()/);
  if (m) {
    const name = m[1].trim();
    if (abilityNames.has(name.toLowerCase())) return { name, rawLabel: name, rest: line.slice(m[0].length).trim(), unbolded: true };
  }
  // At the start of a paragraph, a line that opens with one of the page's own ability names followed by
  // a capitalised sentence is that ability's header printed without bold ("Ironsense The dragon can…").
  if (paragraphStart) {
    for (const name of abilityNames) {
      if (line.length <= name.length + 2) continue;
      if (line.slice(0, name.length).toLowerCase() !== name) continue;
      if (!/^\s+[A-Z]/.test(line.slice(name.length))) continue;
      if (!/^[A-Z]/.test(line)) continue;
      const nm = line.slice(0, name.length);
      return { name: nm, rawLabel: nm, rest: line.slice(name.length).trim(), unbolded: true };
    }
  }
  return null;
}

/**
 * Group section lines into entries. `classify(name, cur)` returns 'continue' when a bold label
 * continues the current entry, or a kind string for a new entry. Lines before the first entry go
 * to `bad` as stray lines. A blank line is kept as '' so paragraph breaks survive.
 */
export function toEntries(lines, section, classify, bad, abilityNames) {
  const entries = [];
  let cur = null;
  let prevBlank = true;
  // A header printed mid-line with no break before it ("…next turn.**Frightful Presence** (aura…"): a bold
  // run that is exactly one of the page's own ability names starts a new line.
  if (abilityNames.size) {
    const out = [];
    for (const line of lines) {
      let rest = line, cutAt;
      while ((cutAt = findInlineHeader(rest, abilityNames)) > 0) { out.push(rest.slice(0, cutAt).trim()); rest = rest.slice(cutAt); }
      out.push(rest);
    }
    lines = out;
  }
  for (let line of lines) {
    if (line === '') { if (cur) cur.lines.push(''); prevBlank = true; continue; }
    const wasBlank = prevBlank;
    prevBlank = false;
    if (/^#{1,6}\s+\S/.test(line)) {
      const name = clean1(line.replace(/^#{1,6}\s+/, '').replace(/\s*#+$/, ''));
      cur = { section, kind: 'ability', name, rawLabel: name, first: '', lines: [], heading: true };
      entries.push(cur);
      continue;
    }
    let lab = readLabel(line);
    // A header whose opening bold was lost: "Caustic Blood** <actions…>" at the start of a paragraph.
    if (!lab && wasBlank && /^(?:\[[^\]]+\]\((?:[^()\s]|\([^()]*\))*\)|[A-Z][^*<.;:\[]{0,60}?)\*\*(?!\*)\s*(?:<actions\b|\(|$)/.test(line)) lab = readLabel(`**${line}`);
    // An unbolded header carrying a bracket cost token: "Scoff at the Divine [reaction] **Trigger** …".
    if (!lab && wasBlank) {
      const tk = line.match(/^([A-Z][A-Za-z'’\- ]{1,60}?)\s+(\[(?:one-action|two-actions|three-actions|reaction|free-action)\])\s*(.*)$/i);
      if (tk) lab = { name: tk[1].trim(), rawLabel: tk[1], rest: `${tk[2]} ${tk[3]}`, unbolded: true };
    }
    if (line === '**') continue; // a stray bold marker on its own line carries no text
    // An unbolded header starts a paragraph, or follows an ability on its own line (after a <br>); it
    // never interrupts a stat row's value ("**Items**⏎[spiritual rope](…)").
    if (!lab && (wasBlank || !cur || cur.kind === 'ability')) lab = readUnboldedHeader(line, abilityNames, wasBlank || !cur);
    // An unbolded header the facet does not name, on its own line after an ability, with a lowercase trait
    // list and then a range or a sentence: "Glimpse of Stolen Flesh (aura, divine, …, visual) 30 feet. When…".
    if (!lab && cur?.kind === 'ability' && section !== 'top') {
      const th = stripLinks(line).match(TRAIT_HEADER);
      // (an affliction inside an action, "Caustic Nightmare Vapor (acid, poison) … **Saving Throw** DC 38", stays)
      if (th && !/^(?:The|A|An|This|It|Its|If|When|On|In|Melee|Ranged)$/.test(th[1].split(' ')[0]) && line.startsWith(th[1]) && !/Saving Throw/i.test(line)) lab = { name: th[1], rawLabel: th[1], rest: line.slice(th[1].length).trim(), unbolded: true, traitHeader: true };
    }
    if (lab) {
      lab.afterBlank = wasBlank;
      // A bold run that begins lowercase is a word of the sentence around it ("…uses an auditory⏎**action**").
      if (/^[a-z]/.test(lab.name) && cur) { cur.lines.push(line); continue; }
      { const wc = lab.name.split(/\s+/).length; if (wc > 9 || (wc > 6 && /\.(?:\s|$)/.test(lab.name))) splitLongLabel(lab, abilityNames); }
      const kind = classify(lab.name, cur, lab);
      if (kind === 'absorbed') continue;
      if (kind !== 'continue') {
        cur = { section, kind, name: lab.name, rawLabel: lab.rawLabel, first: lab.rest, lines: [], url: lab.url, unclosed: lab.unclosed, unbolded: lab.unbolded };
        if (lab.broken) bad(section, lab.name, line, 'bold label never closed');
        entries.push(cur);
        continue;
      }
    }
    if (cur) cur.lines.push(line);
    else bad(section, '', line, 'text before the first entry');
  }
  for (const e of entries) {
    while (e.lines.length && e.lines[e.lines.length - 1] === '') e.lines.pop();
  }
  return entries;
}

const TRAIT_HEADER = /^([A-Z][A-Za-z'’\-]*(?:\s+(?:[A-Z][A-Za-z'’\-]*|of|the|a|an|and|or|to|in|on|from|with|for|by)){0,5})\s+\((?:[a-z][a-z-]*(?:\s[a-z-]+)?)(?:,\s*[a-z][a-z-]*(?:\s[a-z-]+)?)*\)\s+(?=\d+\s*(?:feet|foot)\b|[A-Z])/;

/**
 * A bold run that covers a whole sentence ("**Terrain Advantage Non-lizardfolk creatures … scout.**"):
 * keep the page's own ability name (from the facet) or the Title Case words before the sentence starts.
 */
function splitLongLabel(lab, abilityNames) {
  const low = lab.name.toLowerCase();
  let best = '';
  for (const n of abilityNames) if (low.startsWith(n + ' ') && n.length > best.length) best = n;
  let cut = best.length;
  if (!cut) {
    const words = lab.name.split(/\s+/);
    for (let k = 1; k < Math.min(words.length, 6); k++) {
      if (!/^[A-Z]/.test(words[k - 1]) && !/^(?:of|the|and|to|in|on|by)$/.test(words[k - 1])) break;
      if (/^(?:The|A|An|This|These|Its|If|When|Each|Every|While|Any|Creatures?|It|They|Their|Non-\S+|Once|Whenever|As|On|In)$/.test(words[k])
        || (/^[a-z]/.test(words[k]) && !/^(?:of|the|and|to|in|on|by|a|an|with|from|for|at)$/.test(words[k]))) {
        // A clause label glued to the name ("Unbalancing Rip Requirements The eron…") stays in the body.
        let k2 = k;
        while (k2 > 1 && /^(?:Requirements?|Trigger|Frequency|Effect)$/.test(words[k2 - 1])) k2--;
        cut = words.slice(0, k2).join(' ').length;
        break;
      }
    }
  }
  if (!cut) return;
  const tail = lab.name.slice(cut).trim();
  lab.name = lab.name.slice(0, cut).trim();
  lab.rest = `${tail} ${lab.rest ?? ''}`.trim();
}

function findInlineHeader(line, abilityNames) {
  for (const m of line.matchAll(/\*\*(\[?[^*\]]{2,60}\]?(?:\([^)]*\))?)\*\*/g)) {
    if (m.index === 0) continue;
    const before = line.slice(0, m.index);
    if (!/[.!?)]\s*$/.test(before)) continue;
    const name = clean1(m[1]).toLowerCase();
    if (abilityNames.has(name) && !CLAUSE_RE.test(clean1(m[1]))) return m.index;
  }
  return -1;
}

/** Entry text as paragraphs: [firstLine + following lines up to the first blank, next paragraph, …]. */
export function paragraphs(e) {
  const out = [];
  let cur = [e.first].filter((x) => x !== '');
  for (const l of e.lines) {
    if (l === '') { if (cur.length) out.push(cur.join('\n')); cur = []; } else cur.push(l);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/** All of an entry's text as one string, lines joined by a space. */
export function flat(e) {
  return [e.first, ...e.lines].filter((x) => x !== '').join(' ').replace(/\u0001TABLE\u0001[^\n]*/g, '').trim();
}

// ─── value parsers shared by creature and hazard pages ─────────────────────────────────────────

/** "cold 10, physical 10 (except magic bludgeoning)" -> [{name, amount, note?}] */
export function parseResWeak(md, unk) {
  const out = [];
  for (const part of splitTopLevel(String(md ?? ''))) {
    const s = clean1(part, unk).replace(/[.;]$/, '').trim();
    if (!s) continue;
    const m = s.match(/^(.+?)\s+(\d+)\s*(?:\((.+?)\)?\.?)?$/);
    if (m) {
      const e = { name: m[1].trim(), amount: num(m[2]) };
      if (m[3]) e.note = m[3].trim();
      out.push(e);
      continue;
    }
    const bare = s.match(/^([^()]+?)\s*(?:\((.+)\))?$/);
    if (bare && /[A-Za-z]/.test(bare[1])) {
      const e = { name: bare[1].trim(), amount: null };
      if (bare[2]) e.note = bare[2].trim();
      out.push(e);
    } else out.push({ name: s, amount: null });
  }
  return out;
}

/**
 * AC row: "16 **Fort** +5 (+7 vs. poison) **Ref** +7 **Will** +3 +1 status to all saves vs. magic".
 * Returns {ac, acNote, fort, ref, will, saveNote, leftover}.
 */
export function parseAcRow(text, unk) {
  const flatT = stripLinks(decodeEntities(text)).replace(/\s+/g, ' ').trim();
  const out = {};
  const tidyNote = (s) => clean1(s, unk).replace(/^[;,.\s]+|[;,\s]+$/g, '').trim();
  const acM = flatT.match(/^(?:\*\*AC\*\*\s*)?(\d+)(.*?)(?=\*\*(?:Fort|Fortitude|Ref|Reflex|Will)\*\*|$)/i);
  let rest = flatT;
  if (acM) {
    out.ac = num(acM[1]);
    const n = tidyNote(acM[2]);
    if (n) out.acNote = n;
    rest = flatT.slice(acM[0].length);
  }
  const parts = [];
  for (const [key, label, re] of [
    ['fort', 'Fort', /\*\*Fort(?:itude)?\*\*:?\s*([+-]?\s*\d+)\s*(\([^)]*\))?[,;]?\s*/i],
    ['ref', 'Ref', /\*\*Ref(?:lex)?\*\*:?\s*([+-]?\s*\d+)\s*(\([^)]*\))?[,;]?\s*/i],
    ['will', 'Will', /\*\*Will\*\*:?\s*([+-]?\s*\d+)\s*(\([^)]*\))?[,;]?\s*/i],
  ]) {
    const m = rest.match(re);
    if (!m) continue;
    out[key] = num(m[1].replace(/\s+/g, ''));
    if (m[2] && /[A-Za-z]/.test(m[2])) parts.push(`${label} ${tidyNote(m[2])}`);
    rest = rest.slice(0, m.index) + ' \u0003 ' + rest.slice(m.index + m[0].length);
  }
  // Text between the saves (other than separators) and after Will is the all-saves note.
  const pieces = rest.split('\u0003').map(tidyNote).filter(Boolean);
  const tail = pieces.join(' ').trim();
  const note = [parts.join(', '), /[A-Za-z]/.test(tail) ? tail : ''].filter(Boolean).join('; ');
  if (note) out.saveNote = note;
  if (tail && !/[A-Za-z]/.test(tail)) out.leftover = tail;
  return out;
}

/** Strike entry text -> attack object, or {error} when no name or no bonus can be read. */
export function parseStrike(range, e, unk) {
  const raw = [e.first, ...e.lines].filter((x) => x !== '').join(' ');
  const ma = raw.match(ACTIONS_TAG);
  let activity = ma ? actionStringToActivity(ma[1]) : undefined;
  let s = raw.replace(ACTIONS_TAG_G, ' ');
  let requirement;
  // "**Requirements** … ; **Effect** pincer +27 (…)" — a strike gated by a requirement.
  const rq = s.match(/^\s*\*\*Requirements?\*\*([\s\S]*?)\*\*Effect\*\*/);
  if (rq) { requirement = clean1(rq[1], unk).replace(/[;,.\s]+$/, ''); s = s.slice(rq[0].length); }
  const tok = s.match(/\[(one|two|three|free|reaction)[- ]actions?\]|\[reaction\]|\[free-action\]/i);
  if (tok && !activity) {
    const w = tok[0].toLowerCase();
    activity = /reaction/.test(w) ? { number: 1, unit: 'reaction' } : /free/.test(w) ? { number: 1, unit: 'free' }
      : { number: /three/.test(w) ? 3 : /two/.test(w) ? 2 : 1, unit: 'action' };
    s = s.replace(tok[0], ' ');
  }
  let dmg = '';
  const dm = s.match(/\*\*Damage\*\*|(?:^|[,;]\s*|\)\s*)Damage\s/);
  let head = s;
  if (dm) { head = s.slice(0, dm.index + (dm[0].startsWith(',') || dm[0].startsWith(')') ? 1 : 0)); dmg = s.slice(dm.index + dm[0].length); }
  let extra = '';
  if (!dm) {
    // Some strikes print an effect clause instead of damage.
    const em = s.match(/\*\*(Effect|Critical Success|Success)\*\*|,\s*(Effect)\s/);
    if (em) { head = s.slice(0, em.index); extra = s.slice(em.index); }
  }
  const h = head.replace(/_/g, '').replace(/\*\*(?:Melee|Ranged)\*\*/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/[,;.\s]+$/, '');
  // Name, the first bonus (optionally a MAP-style "+10/+6/+2" or "[+10/+6]"), then the trait paren.
  const m = h.match(/^(.*?)\s*([+-]\s?\d+)((?:\s*\/\s*[+-]\d+)*|\s*\[[+-]\d+(?:\/[+-]\d+)*\])\s*,?\s*(?:\((.*)\))?\s*[,.]?\s*$/);
  if (!m) return { error: 'strike without an attack bonus', raw: h };
  const name = clean1(m[1], unk).replace(/^[\][(),;:\s]+/, '');
  if (!name || !/[A-Za-z]/.test(name)) return { error: 'strike without a name', raw: h };
  const traits = m[4] ? splitTopLevel(m[4]).map((t) => clean1(t, unk)).filter(Boolean) : [];
  const damage = clean1(dmg || extra, unk).replace(/^[:,]\s*/, '');
  const att = { range, name, attack: num(m[2].replace(/\s+/g, '')), traits, damage, types: [], effects: [] };
  if (activity) att.activity = activity;
  return { attack: att, requirement };
}

/**
 * Ability entry -> {name, activity?, traits, trigger?, entries:[body]}. `issues` collects unparsed
 * rows (a second cost tag on the header line).
 */
export function parseAbility(e, unk, issues) {
  let first = e.first;
  let activity;
  // "(concentrate) <actions…/>" — a trait list the bold carried ahead of the cost: read the cost first.
  const swap = first.match(/^\s*(\([^()]*\))\s*(<actions\s+string="[^"]*"\s*\/?>)/i);
  if (swap) first = `${swap[2]} ${swap[1]}${first.slice(swap[0].length)}`;
  const lead = first.match(/^\s*<actions\s+string="([^"]*)"\s*\/?>/i);
  if (lead) {
    activity = actionStringToActivity(lead[1]);
    first = first.slice(lead[0].length);
    const second = first.match(/^\s*(?:\([^)]*\)\s*)?<actions\s+string="([^"]*)"/i);
    if (second && second[1]) issues.push({ line: e.first, reason: 'second <actions> tag on an ability header' });
  } else {
    const TOK = { 'one-action': 'Single Action', 'two-actions': 'Two Actions', 'three-actions': 'Three Actions', reaction: 'Reaction', 'free-action': 'Free Action' };
    const tok = first.match(/^\s*\[(one-action|two-actions|three-actions|reaction|free-action)\](?:\s+(to|or)\s+\[(one-action|two-actions|three-actions|reaction|free-action)\])?/i);
    if (tok) {
      const str = TOK[tok[1].toLowerCase()] + (tok[3] ? ` ${tok[2]} ${TOK[tok[3].toLowerCase()]}` : '');
      activity = actionStringToActivity(str);
      first = first.slice(tok[0].length);
    }
  }
  // Leading "(trait, trait)" — read over link text so a URL's parentheses do not count.
  let traits = [];
  // A trait list the page never closed before the next clause: "(occult **Trigger** The skaveling …".
  const unclosed = first.match(new RegExp(`^\\s*\\(([^()]*?)\\s*(\\*\\*(?:${CLAUSE_LABELS.join('|')})\\*\\*)`, 'i'));
  if (unclosed && !/\)/.test(stripLinks(unclosed[1])) && (unclosed[1].match(/\[/g) ?? []).length === (unclosed[1].match(/\]/g) ?? []).length) {
    traits = splitTopLevel(stripLinks(unclosed[1])).map((t) => clean1(t, unk)).filter(Boolean);
    first = first.slice(unclosed.index + unclosed[0].length - unclosed[2].length);
  }
  const fl = stripLinks(first).replace(/^\s+/, '');
  const tm = traits.length ? null : fl.match(/^\(([^()]*(?:\([^()]*\)[^()]*)*)\)/);
  if (tm) {
    let items = splitTopLevel(tm[1]).map((t) => clean1(t, unk)).filter(Boolean);
    // A clause label that slid inside the trait list: "(disease **Saving Throw** DC 22 Fortitude)".
    let spill = '';
    const labRe = new RegExp(`\\s(${CLAUSE_LABELS.join('|')})\\s`, '');
    items = items.map((t) => { const k = t.match(labRe); if (k && !spill) { spill = t.slice(k.index).trim(); return t.slice(0, k.index).trim(); } return t; }).filter(Boolean);
    const looksLikeTraits = items.length && items.every((t) => t.length <= 40 && /^[A-Za-z]/.test(t) && !/[.:;]/.test(t));
    if (looksLikeTraits) {
      traits = items;
      // Cut the same parenthesis off the raw text (links and all).
      let depth = 0, i = first.search(/\(/), j = i;
      for (; j < first.length; j++) {
        const ch = first[j];
        if (ch === '[') { const k = first.indexOf('](', j); if (k > 0) { let d = 0, q = k + 1; for (; q < first.length; q++) { if (first[q] === '(') d++; else if (first[q] === ')') { d--; if (d === 0) break; } } j = q; continue; } }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
      }
      first = (spill ? ` **${spill.split(' ')[0]}** ${spill.split(' ').slice(1).join(' ')}` : '') + first.slice(j + 1);
    }
  }
  const paras = [first, ...e.lines];
  let text = paras.join('\n').replace(/\n{2,}/g, '\n').trim();
  // Tables were carried as one line; restore them as blocks.
  text = text.replace(/\u0001TABLE\u0001([^\n]*)/g, (_, t) => `\n\n${t.replace(/\u0002/g, '\n')}\n\n`);
  // Each bold clause label goes to its own line as "Label text".
  text = text.replace(CLAUSE_INLINE_G, (_, lab) => `\n${lab} `);
  let body = clean(text, unk);
  // Unbolded clause labels after a semicolon ("…once per round; Requirements The natbakh's…") get their own line.
  body = body.replace(/;\s+(Requirements?|Trigger|Effect|Frequency)\s+(?=[A-Z])/g, '\n$1 ');
  body = body.split('\n').map((l) => l.replace(/;\s*$/, '').trim()).join('\n').replace(/^\n+/, '').replace(/^[;,:]\s*/, '');
  let trigger;
  const trg = body.match(/(^|\n)Trigger ([^\n]*)/);
  if (trg) {
    let t = trg[2];
    let spilled = '';
    // "Trigger … Strike Effect The skaveling…": the Effect label lost its bold, so the trigger ends there.
    const eff = t.match(/\s(Effect|Requirements?)\s+(?=[A-Z])/);
    if (eff && (t.indexOf(';') < 0 || eff.index < t.indexOf(';'))) { spilled = `\n${t.slice(eff.index + 1)}`; t = t.slice(0, eff.index); }
    const semi = t.indexOf(';');
    trigger = (semi >= 0 ? t.slice(0, semi) : t).trim();
    const leftover = semi >= 0 ? t.slice(semi + 1).trim() : '';
    body = (body.slice(0, trg.index) + (trg[1]) + leftover + spilled + body.slice(trg.index + trg[0].length))
      .replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
  }
  const out = { name: e.name };
  if (activity) out.activity = activity;
  out.traits = traits;
  if (trigger) out.trigger = trigger;
  out.entries = [body.replace(/\n{3,}/g, '\n\n')];
  return out;
}

/** "25 feet, fly 60 feet; air walk" -> {speed, speedNote} */
export function parseSpeed(text, unk) {
  const t = clean1(text, unk);
  const semi = t.indexOf(';');
  const headS = semi >= 0 ? t.slice(0, semi) : t;
  const tailS = semi >= 0 ? t.slice(semi + 1) : '';
  const speed = {};
  // "fly 60 feet", "25 feet", "fly 10 feet (can't ascend…)", "fly 30 feet in dim light" (the qualifier stays in the note).
  const MODE = /^(?:(land|walk|fly|swim|burrow|climb)\s+(?:speed\s+)?)?(\d+)\s*(?:feet|foot|ft\.?)?\.?\s*(\(.*\)|(?:in|while|when|only|underwater|on)\b.*)?$/i;
  const take = (c, allowBare) => {
    const m = c.match(MODE);
    if (!m || (!m[1] && !allowBare)) return false;
    const mode = !m[1] || /land|walk/i.test(m[1]) ? 'walk' : m[1].toLowerCase();
    if (speed[mode] === undefined) speed[mode] = num(m[2]);
    return !m[3]; // a qualified speed ("burrow 20 feet (sand only)") also stays in the note
  };
  const kept = [];
  for (const raw of splitTopLevel(headS)) { const c = raw.trim(); if (c && !take(c, true)) kept.push(c); }
  // AoN sometimes separates movement modes with ";" ("25 feet; climb 30 feet"): read those too.
  const tail = [];
  for (const part of splitTopLevel(tailS, ';')) {
    const keptPart = [];
    for (const raw of splitTopLevel(part)) { const c = raw.trim(); if (c && !take(c, false)) keptPart.push(c); }
    if (keptPart.length) tail.push(keptPart.join(', '));
  }
  const ordered = {};
  for (const k of ['walk', 'fly', 'swim', 'burrow', 'climb']) if (speed[k] !== undefined) ordered[k] = speed[k];
  const note = [kept.join(', '), tail.join('; ')].filter(Boolean).join('; ');
  return { speed: ordered, speedNote: note || undefined };
}

export { splitList };
