// The render check's oracle: the ordered list of stat-block headings an Archives page prints.
//
// Deliberately simple and independent of the record parser (scripts/lib/parse-creature.mjs): it reads
// only bold entry labels at the start of a line, in page order, and names each one. It never builds a
// record, so a parser defect cannot hide itself by agreeing with its own oracle.
//
//   pageHeadings(markdown, { hazard, name }) -> { traits, headings: Heading[], asides, listOptions }
//   Heading = { label, kind, slot }
//     kind: 'stat'     fixed vocabulary (Recall Knowledge, Perception, Languages, Skills, Ability Modifiers,
//                      Items, AC, Fort, Ref, Will, HP, Hardness, Immunities, Resistances, Weaknesses,
//                      Speed, Rituals; hazards: Complexity, Description, Stealth, Disable, Routine, Reset)
//           'strike'   "Melee <name>" / "Ranged <name>"
//           'spells'   the spell block label ("Arcane Innate Spells")
//           'ability'  any other bold entry label
//     slot: 'top' | 'mid' | 'bot' (creatures: the `---` section it sits in), 'pre' (Recall Knowledge),
//           'hazard' for hazards.
//
// A stat label (Languages, Skills, ...) with no text before the next entry is an empty heading and is not listed.
// An unbolded ability header is seen only in its unambiguous shape: Title Case words directly followed by
// a linked trait list "([" or an <actions> tag. Known simplification (the oracle stays simple on purpose):
// a bold label that starts a line inside an ability body and is not a known clause label (Trigger,
// Effect, Critical Success, ...) is read as its own entry.

const CLAUSES = new Set([
  'trigger', 'requirements', 'requirement', 'frequency', 'effect', 'critical success', 'success', 'failure',
  'critical failure', 'saving throw', 'onset', 'maximum duration', 'damage', 'cost', 'duration', 'range',
  'area', 'targets', 'target', 'defense', 'special', 'prerequisites', 'access', 'activate', 'note',
  'heightened', 'secondary casters', 'primary check', 'secondary checks', 'cast', 'amp', 'traditions',
  'lines', 'benefit', 'check', 'level', 'price', 'usage', 'bulk', 'hands', 'craft requirements',
])
const EMPTYABLE = new Set(['perception', 'languages', 'skills', 'items', 'immunities', 'resistances', 'weaknesses', 'speed', 'stealth', 'disable', 'routine', 'reset'])
const SMALL = "(?:of|the|a|an|and|or|to|in|on|from|with|for)"
const WORD = "[A-Z][\\w'\u2019-]*"
const UNBOLDED = new RegExp(`^(${WORD}(?:\\s+(?:${WORD}|${SMALL}))*)\\s+(?:\\(\\[|<actions\\b)`)
const RANK = /^(cantrips?|constant|\d+(st|nd|rd|th))\b/i
const STAT_TOP = { perception: 'Perception', languages: 'Languages', skills: 'Skills', items: 'Items' }
const ABILITY_MODS = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const DEF_INLINE = /\*\*(?:\[)?([A-Za-z][A-Za-z' ]*?)(?:\]\([^)]*\))?\*\*/g

/** Plain text of a markdown label: links unwrapped, emphasis and tags dropped. */
export function plainLabel(s) {
  return s
    .replace(/<actions\b[^>]*>.*$/i, '')          // an unclosed `**[X](u) <actions…/>` header
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ').trim()
    .replace(/[:;,]$/, '').trim()
}

/** The bold label a line starts with, or null. Accepts **L**, **[L](u)**, [**L**](u), **[**L**](u)**. */
export function leadingLabel(line) {
  const t = line.trim()
  let m = t.match(/^\*\*\[\*\*(.+?)\*\*\]\([^)]*\)\*\*/) || t.match(/^\[\*\*(.+?)\*\*\]\([^)]*\)/)
  if (m) return { label: plainLabel(m[1]), rest: t.slice(m[0].length) }
  m = t.match(/^\*\*(.+?)\*\*/)
  if (m) return { label: plainLabel(m[1]), rest: t.slice(m[0].length) }
  // `**[Label](url) <actions …/>` with the closing ** missing
  m = t.match(/^\*\*(\[[^\]]+\]\([^)]*\))/)
  if (m) return { label: plainLabel(m[1]), rest: t.slice(m[0].length) }
  return null
}

function statBlockText(md, hazard, name) {
  const titles = [...md.matchAll(/<title level="(\d)"([^>]*)>(.*?)<\/title>/g)]
  const want = hazard ? /right="Hazard/ : /right="Creature/
  const blocks = titles.filter(t => want.test(t[2]))
  if (!blocks.length) return { pre: '', body: '' }
  const norm = s => plainLabel(s).toLowerCase()
  const pick = blocks.find(t => norm(t[3]) === (name || '').toLowerCase()) || blocks[0]
  const start = pick.index + pick[0].length
  const next = titles.find(t => t.index > pick.index)
  return { pre: md.slice(0, pick.index), body: md.slice(start, next ? next.index : md.length) }
}

function strikeName(lines, i, rest) {
  // "**Melee** <actions/> fangs +28 (…)" — the name may sit on the same line or the next ones.
  let text = rest
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
    if (/\*\*Damage\*\*/.test(lines[j]) || leadingLabel(lines[j])) break
    text += ' ' + lines[j]
  }
  text = plainLabel(text.replace(/<actions\b[^>]*>/gi, ' '))
  // the bonus may be "+28", "+ 23" or glued on ("shortsword+12"); a bonus-less strike keeps its words
  const m = text.match(/^(.+?)\s*[+\u2212\u2013-]\s?\d+(?=[\s(,;*]|$)/)
  return (m ? m[1] : text.split(/\s+\(|,/)[0]).trim()
}

export function pageHeadings(markdown, { hazard = false, name = '' } = {}) {
  const full = (markdown || '').replace(/\r\n?/g, '\n')
  // Bold labels the page prints outside the stat block's entries: sidebars and list options inside an
  // entry. They are not headings; they are returned so a record that promoted one can be told apart.
  const boldIn = t => [...t.matchAll(/\*\*(?:\[)?([^*\]]+?)(?:\]\([^)]*\))?\*\*/g)].map(m => plainLabel(m[1])).filter(Boolean)
  const asides = [...full.matchAll(/<aside>([\s\S]*?)<\/aside>/g)].flatMap(m => boldIn(m[1]))
  const listOptions = [...full.matchAll(/<li>\s*(\*\*[^\n]*?\*\*)/g)].flatMap(m => boldIn(m[1]))
  const md = full.replace(/<aside>[\s\S]*?<\/aside>/g, '')
  const { pre, body } = statBlockText(md, hazard, name)
  const headings = []
  const push = (label, kind, slot) => headings.push({ label, kind, slot })

  if (!hazard && /\*\*\[?Recall Knowledge/.test(pre)) push('Recall Knowledge', 'stat', 'pre')

  // `<br />` joins entries on one line ("…DC 34<br />**[Attack of Opportunity](…)**"): a line break.
  const lines = body.split(/\n|<br\s*\/?>/i)
  const traits = []
  for (const l of lines) {
    if (leadingLabel(l)) break
    for (const m of l.matchAll(/<trait label="([^"]+)"/g)) traits.push(m[1])
  }

  const sections = ['top', 'mid', 'bot']
  let sec = 0
  let inTable = false
  let sawComplexity = false, sawDescription = false, afterComplexityColumn = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^<table/i.test(line)) inTable = true
    if (inTable) { if (/<\/table>/i.test(line)) inTable = false; continue }
    if (line === '---') { if (!hazard) sec = Math.min(sec + 1, 2); continue }
    const slot = hazard ? 'hazard' : sections[sec]

    if (hazard && sawComplexity && !sawDescription) {
      if (/^<\/column>/.test(line)) { afterComplexityColumn = true; continue }
      if (afterComplexityColumn && line && !line.startsWith('<') && !leadingLabel(line)) {
        push('Description', 'stat', slot); sawDescription = true; continue
      }
    }

    if (!hazard && !leadingLabel(line)) {
      // An unbolded ability header: Title Case words directly followed by a trait list or an action cost.
      const u = line.match(UNBOLDED)
      if (u && !/^(The|A|An|This|It|Its|If|When|On|In)\b/.test(u[1])) { push(u[1], 'ability', sections[sec]); continue }
    }
    const lead = leadingLabel(line)
    if (!lead || !lead.label || line.startsWith('|') || line.startsWith('-')) continue
    const label = lead.label
    const low = label.toLowerCase()
    if (low === 'source' || CLAUSES.has(low) || /^stage \d/.test(low) || RANK.test(label)) continue
    if (/^\d+\s*[\u2014\u2013-]/.test(label)) continue          // "**1—Beauty**": a numbered table option

    // A stat label with nothing after it ("**Languages**" then the next entry) prints an empty heading.
    // (An ability label with no body, "**[Troop Defenses](…)**", is still an entry.)
    if (EMPTYABLE.has(low) && !lead.rest.trim() && emptyEntry(lines, i)) continue

    if (hazard) {
      if (low === 'complexity') { push('Complexity', 'stat', slot); sawComplexity = true; continue }
      if (low === 'stealth') { sawDescription = true; push('Stealth', 'stat', slot); continue }
      if (low === 'disable') { push('Disable', 'stat', slot); continue }
      if (low === 'routine') { push('Routine', 'stat', slot); continue }
      if (low === 'reset') { push('Reset', 'stat', slot); continue }
    } else {
      if (STAT_TOP[low]) { push(STAT_TOP[low], 'stat', slot); continue }
      if (ABILITY_MODS.has(low)) { if (low === 'str') push('Ability Modifiers', 'stat', slot); continue }
      if (low === 'speed') { push('Speed', 'stat', slot); continue }
    }

    const defense = defenseLabel(low)
    if (defense) {
      push(defense, 'stat', slot)
      // "**AC** 10, **Fort** +1, **Ref** +1" and "**Hardness** 5, **HP** 20" share one line.
      for (const m of lead.rest.matchAll(DEF_INLINE)) {
        const d = defenseLabel(m[1].trim().toLowerCase())
        if (d) push(d, 'stat', slot)
      }
      continue
    }
    if (low === 'melee' || low === 'ranged') {
      push(`${label[0].toUpperCase()}${low.slice(1)} ${strikeName(lines, i, lead.rest)}`, 'strike', slot)
      continue
    }
    if (/\brituals?$/i.test(label)) { push('Rituals', 'stat', slot); continue }
    if (!/\(/.test(label) && (/\b(spells|cantrips)(\s+\d+\s+focus points?)?$/i.test(label)
        || /\b(innate|prepared|spontaneous|focus|domain|school|bloodline|order|devotion)\s+spell$/i.test(label))) {
      // "**Cleric Domain Spells 1 Focus Point**": the pool size is a value, not part of the name
      push(label.replace(/\s+\d+\s+focus points?$/i, ''), 'spells', slot); continue
    }
    push(label, 'ability', slot)
  }
  return { traits, headings, asides, listOptions }
}

function emptyEntry(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim()
    if (!t || /^<\/?(row|column)\b/i.test(t)) continue
    return t === '---' || /^<title\b/i.test(t) || !!leadingLabel(t)
  }
  return true
}

function defenseLabel(low) {
  if (low === 'ac') return 'AC'
  if (low === 'fort' || low === 'fortitude') return 'Fort'
  if (low === 'ref' || low === 'reflex') return 'Ref'
  if (low === 'will') return 'Will'
  if (low === 'hp' || / hp$/.test(low)) return 'HP'
  if (low === 'hardness' || / hardness$/.test(low)) return 'Hardness'
  if (low === 'immunities') return 'Immunities'
  if (low === 'resistances') return 'Resistances'
  if (low === 'weaknesses') return 'Weaknesses'
  return null
}
