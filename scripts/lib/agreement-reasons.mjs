// Why the two reads of a document disagree (report/agreement.json `reason`), assigned by rule.
//
// agreementReason(row, {S, T, doc, rows}) -> reason string
//
// Every rule looks only at the two values of the row, the page markdown and the record text read, never
// at the row's id, so a new disagreement lands in an existing reason or in "unexplained". A row whose
// differing items have different reasons gets them joined with " + " (sorted), so byReason stays exact.
//
// Reasons:
//   facet-alias-trait       the facet adds the other name of a renamed trait (Hryngar/Duergar, void/negative)
//   facet-template-residue  the facet holds an unrendered Archives template ("{{creatureabilities 64 …")
//   facet-clause-label      the facet indexes a clause label as an ability (Requirement, Efiect, Saving Throw)
//   facet-runon-label       the facet's name ran on into the text after it ("Slip Trigger", "Constrict 3d6+12…")
//   facet-bold-fragment     the facet indexes a bold run that is a sentence fragment ("action", "visual)")
//   facet-key-or-number     the facet indexes a map key or option number ("C13", "1.", "d5", "I")
//   facet-names-spell-block the facet indexes a spell block or strike label as an ability
//   facet-names-option      the facet indexes an option label the page prints inside another ability
//   facet-bullet            the facet keeps the list bullet ("• Mythic Skill")
//   facet-omits-ability     the page prints an ability header the facet does not list
//   facet-special-movement  the facet files "ice climb 30 feet" / "water glide 30 feet" as a plain mode
//   facet-conditional-speed the facet takes a speed printed as a condition ("(or fly 80 feet when …)")
//   facet-misread-speed     the facet reads a number of the speed line that is not that mode's speed
//   facet-glued-rows        the facet glued the next stat row or an ability onto a list item
//   facet-omits-item        the page prints the item (after a paragraph break or inside bold); the facet drops it
//   facet-omits-note        the facet drops the parenthetical note the page prints after the value
//   facet-truncated-at-break the facet stopped an entry at a paragraph break inside its name ("area⏎⏎damage 5")
//   facet-names-legend      the facet indexes a spell list's legend line ("S Signature spell E emotion spell")
//   facet-spacing           the two differ only in whitespace
//   facet-split-in-parens   the facet split an item on a comma or semicolon inside its parentheses
//   facet-dedups-values     the facet lists each distinct number once; the page prints it per strike/block
//   facet-typo              the facet's number is the page's number with a digit dropped (1 for 11)
//   page-variant-strike     the page prints a strike inside an ability (a form or a granted Strike)
//   facet-omits-strike      the page prints a strike the facet does not count
//   facet-omits-action-glyph the page prints an action cost inside the text; the facet drops it
//   section-trailing-paragraph the two reads end the section at different paragraphs
//   unexplained             no rule applies

import { clean1, normKey, stripLinks } from './text.mjs';

const ALIAS = [
  ['hryngar', 'duergar'], ['kholo', 'gnoll'], ['coatl', 'couatl'], ['vitality', 'positive'], ['void', 'negative'],
  ['aiuvarin', 'half-elf'], ['dromaar', 'half-orc'], ['athamaru', 'locathah'], ['shade', 'petitioner'],
  ['holy', 'good'], ['unholy', 'evil'],
];
const alias = new Map();
for (const [a, b] of ALIAS) { alias.set(a, b); alias.set(b, a); }

const CLAUSE = /^(?:requirements?|prerequisites?|ef+i?ects?|cost|special|saving throw|stage \d+|strike|melee|ranged|trigger|activate\b.*|frequency\b.*|critical (?:success|failure)|success|failure)$/i;
const KEY = /^(?:\d+\.?|[a-z]{1,2}\d+[a-z]?(?:[–-][a-z]{0,2}\d+)?|[ivx]+|d\d+)$/i;
const ROW_LABEL = /\b(?:Immunit(?:y|ies)|Resistances?|Weakness(?:es)?|HP|Hardness)\b/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const join = (set) => set.size ? [...set].sort().join(' + ') : 'unexplained';

function abilityBodies(T) {
  const all = [...T.abilities.top, ...T.abilities.mid, ...T.abilities.bot];
  return all.map((a) => [a.trigger ?? '', ...(a.entries ?? [])].join('\n'));
}

/** The page's own text, links unwrapped and tags dropped, one line per line or `<br>`. */
function pageLines(doc) {
  return String(doc.markdown ?? '').split(/\n|<br\s*\/?>/i).map((l) => clean1(l.replace(/<[^>]+>/g, ' ')));
}

function abilityNamesReason(row, { T, doc }) {
  const nk = (s) => normKey(s);
  const S = row.structured, Tx = row.text;
  const tset = new Set(Tx.map(nk)), sset = new Set(S.map(nk));
  const onlyS = S.filter((x) => !tset.has(nk(x)));
  const onlyT = Tx.filter((y) => !sset.has(nk(y)));
  const bodies = abilityBodies(T).join('\n');
  const spellNames = new Set([...(T.spellcasting ?? []).map((b) => nk(b.name)), ...(T.attacks ?? []).map((a) => nk(a.name))]);
  const lines = pageLines(doc).map((l) => l.toLowerCase());
  const reasons = new Set();
  const explainedT = new Set();
  for (const xs of onlyS) {
    const x = nk(xs);
    let why = 'unexplained';
    const runon = onlyT.find((y) => x.startsWith(nk(y)) && /^[\s:(,]/.test(x.slice(nk(y).length)));
    const bullet = /^•\s*/.test(xs) && onlyT.find((y) => nk(y) === nk(xs.replace(/^•\s*/, '')));
    if (/\{\{|\}\}/.test(xs)) {
      why = 'facet-template-residue';
      const tail = x.replace(/^.*["”]\s*/, '');
      for (const y of onlyT) if (nk(y) === tail) explainedT.add(y);
    } else if (bullet) { why = 'facet-bullet'; explainedT.add(bullet); }
    else if (runon) { why = 'facet-runon-label'; explainedT.add(runon); }
    else if (CLAUSE.test(xs.trim())) why = 'facet-clause-label';
    else if (KEY.test(xs.trim())) why = 'facet-key-or-number';
    else if (/^[a-z]/.test(xs.trim()) || /^[^(]*\)$/.test(xs.trim()) || /^[^a-z]*$/i.test(xs.trim())) why = 'facet-bold-fragment';
    else if (spellNames.has(x)) why = 'facet-names-spell-block';
    else if (/^\S{1,2}\s+\w+ spells?\b.*\b\S{1,2}\s+\w+ spells?$/i.test(xs.trim())) why = 'facet-names-legend';
    else if (new RegExp(`(^|\\n|[.:!?]\\s+)(?:•\\s*)?${esc(xs.trim())}(?=[\\s.:;,(]|$)`, 'i').test(bodies)) why = 'facet-names-option';
    // printed bold inside the text of another ability ("…feed on **Cimurlian** (cold), **Kujiba** …")
    else if (new RegExp(`\\*\\*\\[?_?${esc(xs.trim())}_?\\]?(?:\\([^)]*\\))?\\*\\*`, 'i').test(String(doc.markdown ?? '')) && new RegExp(`\\b${esc(xs.trim())}\\b`, 'i').test(bodies)) why = 'facet-names-option';
    else if (/,/.test(xs) && xs.split(/\s*,\s*/).every((p) => lines.some((l) => l.startsWith(p.toLowerCase())))) why = 'facet-names-option';
    reasons.add(why);
  }
  for (const y of onlyT) {
    if (explainedT.has(y)) continue;
    const yl = nk(y);
    // printed as a header: at a line start, or glued after a list with its trait list ("disease Impossible Stature (aura…")
    const printed = lines.some((l) => { const t = normKey(l).replace(/^•\s*/, ''); return (t.startsWith(yl) && /^(?:$|[\s(.:;,!◆◇↺])/.test(t.slice(yl.length))) || new RegExp(`\\s${esc(yl)}\\s*\\([a-z]`).test(t); });
    reasons.add(printed ? 'facet-omits-ability' : 'unexplained');
  }
  return join(reasons);
}

function speedReason(row, { doc, rows }) {
  const line = clean1((String(doc.markdown ?? '').match(/\*\*Speed\*\*([^\n]*)/) ?? [])[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const parse = (v) => { const m = String(v ?? '').match(/^(\w+) (\d+)$/); return m ? { mode: m[1], n: m[2] } : null; };
  const s = parse(row.structured), t = parse(row.text);
  if (s) {
    const modeWord = s.mode === 'walk' ? '' : s.mode;
    if (modeWord && new RegExp(`\\b(?!(?:and|or|fly|swim|climb|burrow|walk)\\b)[a-z]+ ${modeWord} ${s.n} f(?:ee)?t`).test(line)) return 'facet-special-movement';
    if (new RegExp(`\\b(?:glide|teleport)\\s+${s.n} f(?:ee)?t`).test(line)) return 'facet-special-movement';
    if (new RegExp(`\\([^)]*\\b${s.n} f(?:ee)?t|\\b(?:or|while|with|when)\\b[^,;]*\\b${s.n} f(?:ee)?t|;[^,;]*\\b${s.n} f(?:ee)?t[^,;]*\\b(?:while|when|with|in)\\b|\\b${s.n} f(?:ee)?t\\s*\\((?:battle|swarm|barrier)`).test(line)) return 'facet-conditional-speed';
    if (new RegExp(`\\b${s.n}\\b`).test(line)) return 'facet-misread-speed';
    return 'unexplained';
  }
  if (t) {
    // A mode only the text has: the facet filed the same number under another mode.
    const twin = rows.find((r) => r !== row && r.field === 'speeds' && parse(r.structured)?.n === t.n);
    if (twin) return 'facet-misread-speed';
    return new RegExp(`\\b${t.mode} ${t.n} f(?:ee)?t`).test(line) ? 'facet-omits-item' : 'unexplained';
  }
  return 'unexplained';
}

function listReason(row, ctx) {
  const { doc, rows } = ctx;
  const S = row.structured, Tx = row.text;
  if (Array.isArray(S) && Array.isArray(Tx)) {
    const nk = (s) => normKey(s);
    const tset = new Set(Tx.map(nk)), sset = new Set(S.map(nk));
    const onlyS = S.filter((x) => !tset.has(nk(x)));
    const onlyT = Tx.filter((y) => !sset.has(nk(y)));
    if (squash(S.join('')) === squash(Tx.join(''))) return 'facet-spacing';
    const reasons = new Set();
    const glued = onlyS.some((x) => ROW_LABEL.test(x) || Tx.some((y) => new RegExp(`^${esc(y)}\\s+[A-Z]`).test(x)) || /^[^(]*\)$|^[^)]*\($/.test(x));
    const bare = (x) => squash(x).replace(/[,;]/g, '');
    if (onlyT.some((y) => onlyS.length && bare(onlyS.join('')) === bare(y))) reasons.add('facet-split-in-parens');
    else if (glued) reasons.add('facet-glued-rows');
    else {
      if (onlyS.length) reasons.add('unexplained');
      if (onlyT.length) reasons.add(onlyT.every((y) => stripLinks(doc.markdown ?? '').toLowerCase().includes(String(y).toLowerCase())) ? 'facet-omits-item' : 'unexplained');
    }
    return join(reasons);
  }
  // resistance / weakness entries, one row per entry
  const s = S == null ? '' : String(S), t = Tx == null ? '' : String(Tx);
  const sameField = rows.filter((r) => r.field === row.field);
  const anyGlued = sameField.some((r) => r.structured != null && ROW_LABEL.test(String(r.structured)));
  if (anyGlued) return 'facet-glued-rows';
  if (s && t && t.startsWith(s + ' (')) return 'facet-omits-note';
  // "**Weaknesses**⏎area⏎⏎damage 5, …": the facet stopped at the paragraph break inside an entry name
  if (s && !t && /^[a-z ]+$/i.test(s) && (ctx.T?.fields?.[row.field] ?? []).some((e) => normKey(e.name).startsWith(normKey(s) + ' '))) return 'facet-truncated-at-break';
  if (!s && t) return stripLinks(doc.markdown ?? '').toLowerCase().replace(/\s+/g, ' ').includes(t.toLowerCase()) ? 'facet-omits-item' : 'unexplained';
  return 'unexplained';
}

function numbersReason(row, { doc }) {
  const S = row.structured, Tx = row.text;
  const set = (a) => [...new Set(a)].sort((x, y) => x - y).join(',');
  if (set(S) === set(Tx)) return 'facet-dedups-values';
  const extraT = Tx.filter((v) => !S.includes(v));
  const extraS = S.filter((v) => !Tx.includes(v));
  if (extraS.length === 1 && extraT.length === 1 && String(extraT[0]).includes(String(extraS[0])) && S.length === Tx.length) return 'facet-typo';
  if (extraS.length) return 'unexplained';
  const md = String(doc.markdown ?? '');
  const reasons = new Set();
  for (const v of new Set(extraT)) {
    const m = md.match(new RegExp(`(<br\\s*/?>\\s*)?(?:\\*\\*)?(?:Melee|Ranged)(?:\\*\\*)?\\s*(?:<actions[^>]*>)?[^+\\n]*\\+${v}\\b`));
    reasons.add(m && m[1] ? 'page-variant-strike' : m ? 'facet-omits-strike' : 'unexplained');
  }
  return join(reasons);
}

function textReason(row) {
  const s = String(row.structured ?? ''), t = String(row.text ?? '');
  const noGlyph = (x) => normKey(x.replace(/[◆◇↺]/g, ' '));
  if (noGlyph(s) === noGlyph(t)) return 'facet-omits-action-glyph';
  const p1 = (x) => normKey(x.split(/\n|(?<=\.)\s+(?=Critical Success|Melee|Ranged)/)[0]);
  if (p1(s) === p1(t) || normKey(t).startsWith(normKey(s)) || normKey(s).startsWith(normKey(t))) return 'section-trailing-paragraph';
  return 'unexplained';
}

export function agreementReason(row, ctx) {
  switch (row.field) {
    case 'traits': {
      const nk = (s) => normKey(s);
      const tset = new Set(row.text.map(nk)), sset = new Set(row.structured.map(nk));
      const onlyS = row.structured.map(nk).filter((x) => !tset.has(x));
      const onlyT = row.text.map(nk).filter((x) => !sset.has(x));
      if (!onlyT.length && onlyS.every((x) => alias.has(x) && tset.has(alias.get(x)))) return 'facet-alias-trait';
      return 'unexplained';
    }
    case 'abilityNames': return abilityNamesReason(row, ctx);
    case 'speeds': return speedReason(row, ctx);
    case 'immunities': case 'weaknesses': case 'resistances': case 'items': case 'senses': case 'languages': return listReason(row, ctx);
    case 'attackBonuses': case 'spellDC': case 'spellAttack': return numbersReason(row, ctx);
    case 'disable': case 'reset': return textReason(row);
    default: return 'unexplained';
  }
}
