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
//
// Header shapes the oracle also reads, each measured on pages where the record parser was right and the
// oracle was not (report/render.json `parse` rows before this change):
//   - a linked header "[Frightful Presence](/MonsterAbilities…) (aura, …)" or "[Attack of Opportunity](…)
//     <actions…/>", with or without a stray "**" after the link, at the start of a paragraph;
//   - an unbolded header before an unlinked trait list "Stench (aura, olfactory) 10 feet" or a bracket cost
//     token "Scoff at the Divine [reaction]", at the start of a paragraph;
//   - an unbolded IWR row "Resistances fire 25" and one glued into the row before it ("cold iron 15,
//     Resistances fire 15", "(Weaknesses fire 2)");
//   - a bold header glued to the end of the sentence before it ("…next turn.**Frightful Presence** (aura…");
//   - a `<title>` inside the stat block (the Mask of Norgorber's aspects) heads an entry of its own.
// Labels are trimmed to the name: a bullet, a cost token, a trait list or a sentence the bold ran on into
// ("**Constrict l 3d10+5 piercing, DC 33**") is not part of the heading. A bold run that starts with a
// digit ("**1.**", "**7 or 11**") or a lowercase letter ("**action**") is a list option or a word of a
// sentence, never an entry. A "Rituals" label followed by prose ("**Green Rituals** A green man…") is an
// ability; followed by a DC or ranks it is the Rituals block.

const CLAUSES = new Set([
  'trigger', 'requirements', 'requirement', 'frequency', 'effect', 'critical success', 'success', 'failure',
  'critical failure', 'saving throw', 'onset', 'maximum duration', 'damage', 'cost', 'duration', 'range',
  'area', 'targets', 'target', 'defense', 'special', 'prerequisites', 'access', 'activate', 'note',
  'heightened', 'secondary casters', 'primary check', 'secondary checks', 'cast', 'amp', 'traditions',
  'lines', 'benefit', 'check', 'level', 'price', 'usage', 'bulk', 'hands', 'craft requirements',
  'critical', 'critical effect',
])
const EMPTYABLE = new Set(['perception', 'languages', 'skills', 'items', 'immunities', 'resistances', 'weaknesses', 'speed', 'stealth', 'disable', 'routine', 'reset'])
const SMALL = "(?:of|the|a|an|and|or|to|in|on|from|with|for)"
const WORD = "[A-Z][\\w'\u2019-]*"
const UNBOLDED = new RegExp(`^(${WORD}(?:\\s+(?:${WORD}|${SMALL}))*)\\s*(?:\\*\\*\\s*)?(?:\\(\\[|<actions\\b|\\[(?:reaction|free-action|one-action|two-actions|three-actions)\\])`)
// "Stench (aura, olfactory) 10 feet": an unlinked lowercase trait list, only at the start of a paragraph
const UNBOLDED_TRAITS = new RegExp(`^(${WORD}(?:\\s+(?:${WORD}|${SMALL}))*)\\s*(?:\\*\\*\\s*)?\\((?!at will|self only|constant|see )[a-z][a-z -]*(?:,\\s*[a-z][a-z -]*)*(?:,|\\))`)
// "[Frightful Presence](/MonsterAbilities.aspx?ID=64) (aura, …)", "[Attack of Opportunity](…)** <actions…/>"
const LINK_HEADER = /^\[([A-Z][^\]]*)\]\(([^)]*)\)\s*(?:\*\*\s*)?(?=<actions\b|\(|$)/
const COST_TOKEN = /\s*(?:or\s+)?\[(?:reaction|free-action|one-action|two-actions|three-actions)\]?(?:\s+or\s+\[[a-z-]+\]?)*\s*$/i
const DEGREE_RUNON = /^(?:critical success|critical failure|success|failure)\s/i
const IWR_UNBOLDED = /(?:^|[,;(]\s*|\*\*\s+)(Immunities|Resistances|Weaknesses)\s+(?=[\[a-z0-9_])/g
const SENTENCE_START = /^(?:The|A|An|This|These|Its|If|When|Each|Every|While|Any|Creatures?|It|They|Their|Once|Whenever|As|Non-\S+)$/
const SMALL_WORD = new RegExp(`^${SMALL}$`)
const RANK = /^(cantrips?|constant|\d+(st|nd|rd|th))\b/i
const STAT_TOP = { perception: 'Perception', languages: 'Languages', skills: 'Skills', items: 'Items' }
const ABILITY_MODS = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const DEF_INLINE = /\*\*(?:\[)?([A-Za-z][A-Za-z' ]*?)(?:\]\([^)]*\))?\*\*/g
const COST_TOKEN_SRC = '\\[(?:reaction|free-action|one-action|two-actions|three-actions)\\]'
// after a header label: an action cost (a trait list may come first: "(concentrate) <actions…/>")
const COST_AFTER = new RegExp(`^\\s*(?:\\*\\*\\s*)?(?:\\([^()]*\\)\\s*)?(?:<actions\\s+string="[^"]+"|${COST_TOKEN_SRC})`, 'i')
const TRAITS_AFTER = /^\s*(?:\*\*\s*)?(?:<actions\b[^>]*>\s*)?\((?:\[|[a-z])/
// "…rolls initiative. Violent Deluge <actions…/>": an unbolded header with a cost run on after a full stop
const RUNON_COST = new RegExp(`([.!?])\\s+(?=(?:[A-Z][\\w'\u2019-]*\\s+(?:(?:of|the|a|an|and|or|to|in|on|from|with|for)\\s+)?){1,5}(?:\\*\\*\\s*)?(?:<actions\\b|${COST_TOKEN_SRC}))`, 'g')
// a Trigger clause, bold or with the page's broken bold ("**Guardian Spirit <actions…/> **Trigger** The…",
// "([occult Trigger The skaveling …](…))")
export const TRIGGER = /(?:^|[^A-Za-z])Trigger\**:?\s+(?:\*\*\s*)?[A-Za-z0-9_\[]/
const HAZ_DEF = 'AC|Fort|Fortitude|Ref|Reflex|Will|HP|Hardness|Immunities|Resistances|Weaknesses'

/**
 * Every defence label a hazard line prints, in order: bold ("**Joint Hardness** 16", "**Fort** +11") or
 * unbolded after a bold component name ("**Reflection** AC 24", "**Spout** HP 32"). Values, not names.
 */
function hazardDefences(line) {
  const out = []
  const re = new RegExp(`\\*\\*\\s*(?:\\[)?((?:[A-Z][\\w'\u2019-]*\\s+)*?)(${HAZ_DEF})(?:\\]\\([^)]*\\))?\\s*\\*\\*(?=\\s*[:(+\\-\u2013\\d\\[a-z])|\\*\\*\\s*[A-Z][\\w'\u2019 -]*?\\*\\*\\s+(${HAZ_DEF})\\s+[+\\-\u2013]?\\d`, 'g')
  for (const m of line.matchAll(re)) {
    const d = defenseLabel((m[2] ?? m[3]).toLowerCase())
    if (d) out.push(d)
  }
  return out
}

/** Plain text of a markdown label: links unwrapped, emphasis and tags dropped. */
export function plainLabel(s) {
  return s
    .replace(/<actions\b[^>]*>.*$/i, '')          // an unclosed `**[X](u) <actions…/>` header
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ').trim()
    .replace(/[:;,]$/, '').trim()
    .replace(/^•\s*/, '')
}

/**
 * The heading name of an ability label: a cost token, a trait list or a sentence the bold ran on into is
 * not part of it ("Wall Blend (concentrate)", "Cloak in Embers [reaction", "Mental Rebirth curse, …,
 * occult)", "Otherworldly Touch A zoog's claw Strike can…", "Trample Large or smaller, hoof, DC 26").
 */
export function headerName(label) {
  // "Mythic Power 3 Mythic Points": a pool size printed inside the bold is a value
  let n = label.replace(COST_TOKEN, '').replace(/\s+\d+\s+[A-Z][A-Za-z ]*Points?$/, '').trim()
  // A name is cut only where the label visibly ran on: a trait list, a DC or damage roll, a clause label,
  // or a whole sentence ending in a full stop ("But Will It Lose Me Votes" and "Mythic Power 3 Mythic
  // Points" are names).
  if (!/\(|\)$|\bDC \d|\d+d\d+|\s(?:Requirements?|Trigger|Effect|Frequency)\s/.test(n) && !(/[a-z)]\.$/.test(n) && n.split(/\s+/).length >= 6)) return n
  const words = n.split(/\s+/)
  let k = 1
  for (; k < words.length; k++) {
    const w = words[k]
    if (/^\(/.test(w) || (/^[\d+\u2013\u2014-]/.test(w) && k < words.length - 1)) break
    if (/^(?:Requirements?|Trigger|Effect|Frequency)$/.test(w) || SENTENCE_START.test(w) || /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)$/.test(w)) break
    if (/^[a-z]/.test(w) && !SMALL_WORD.test(w)) break
  }
  return words.slice(0, k).join(' ').replace(/[,;:]$/, '')
}

/** The bold label a line starts with, or null. Accepts **L**, **[L](u)**, [**L**](u), **[**L**](u)**. */
export function leadingLabel(line) {
  const t = line.trim()
  let m = t.match(/^\*\*\[\*\*(.+?)\*\*\]\([^)]*\)\*\*/) || t.match(/^\[\*\*(.+?)\*\*\]\([^)]*\)/)
  if (m) return { label: plainLabel(m[1]), rest: t.slice(m[0].length) }
  m = t.match(/^\*\*(.+?)\*\*/)
  if (m) return { label: plainLabel(m[1]), rest: t.slice(m[0].length), raw: m[1] }
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
  // A title inside the block (an aspect, a mask) continues it; the next stat block ends it.
  const next = titles.find(t => t.index > pick.index && /right="(?:Creature|Hazard)/.test(t[2]))
  return { pre: md.slice(0, pick.index), body: md.slice(start, next ? next.index : md.length) }
}

function strikeName(lines, i, rest) {
  // "**Melee** <actions/> fangs +28 (…)" — the name may sit on the same line or the next ones.
  let text = rest
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
    const lead = leadingLabel(lines[j])
    if (/\*\*Damage\*\*/.test(lines[j]) || (lead && !/^requirements?$/i.test(lead.label))) break
    text += ' ' + lines[j]
  }
  // "**Requirements** The Bloodstorm is in Demon Shape; **Effect** pincer +27": the strike follows Effect
  text = text.replace(/^[\s\S]*?\*\*Requirements?\*\*[\s\S]*?\*\*Effect\*\*/i, ' ')
  text = plainLabel(text.replace(/<actions\b[^>]*>/gi, ' ')).replace(/^[\s;:,\])]+/, '')
  // the bonus may be "+28", "+ 23" or glued on ("shortsword+12"); a bonus-less strike keeps its words
  const m = text.match(/^(.+?)\s*[+\u2212\u2013-]\s?\d+(?=[\s(,;*]|$)/)
  return (m ? m[1] : text.split(/\s+\(|,/)[0]).trim()
}

export function pageHeadings(markdown, { hazard = false, name = '', abilities = [] } = {}) {
  // The document's creature_ability facet: a name it lists, printed unbolded at the start of a line, is a
  // header (the facet is the Archives' own index of the page, not the record parser's reading of it).
  const facet = [...new Set(abilities.map(a => String(a).replace(/\s+/g, ' ').trim()).filter(a => a.length > 3 && /^[A-Z]/.test(a)))]
    .sort((a, b) => b.length - a.length)
  const full = (markdown || '').replace(/\r\n?/g, '\n')
  // Bold labels the page prints outside the stat block's entries: sidebars and list options inside an
  // entry. They are not headings; they are returned so a record that promoted one can be told apart.
  const boldIn = t => [...t.matchAll(/\*\*(?:\[)?([^*\]]+?)(?:\]\([^)]*\))?\*\*/g)].map(m => plainLabel(m[1])).filter(Boolean)
  const asides = [...full.matchAll(/<aside>([\s\S]*?)<\/aside>/g)].flatMap(m => boldIn(m[1]))
  const listOptions = [...full.matchAll(/<li>\s*(\*\*[^\n]*?\*\*)/g)].flatMap(m => boldIn(m[1]))
  const md = full.replace(/<aside>[\s\S]*?<\/aside>/g, '')
  const { pre, body } = statBlockText(md, hazard, name)
  const headings = []
  // `cost`: the page prints an action cost on the header; `traits`: a trait list; `linked`: the header links
  // the Archives' MonsterAbilities page ("[Troop Defenses](/MonsterAbilities…)"); `trigger`: the entry's own
  // text (before any list) prints a Trigger clause; `focus`: a spell block label or its line prints "N Focus
  // Points". The render check compares these with the record (verdict `value`).
  let last = null
  const push = (label, kind, slot, rest = '', whole = rest) => {
    last = { label, kind, slot }
    if (kind === 'ability') {
      if (COST_AFTER.test(rest)) last.cost = true
      if (TRAITS_AFTER.test(rest)) last.traits = true
    }
    headings.push(last)
    if (kind === 'ability' || kind === 'spells') absorb(whole)
    else last = null
  }
  const absorb = t => {
    if (!last) return
    last.text = (last.text ?? '') + '\n' + t
    const own = last.text.split(/<li\b|<ul\b|\n\s*•/i)[0]
    if (last.kind === 'ability' && TRIGGER.test(own)) last.trigger = true
    if (last.kind === 'spells' && /\d+\s+Focus\s+Points?/i.test(`${last.raw ?? last.label} ${own.split('\n').find(x => x.trim()) ?? ''}`)) last.focus = true
  }

  if (!hazard && /\*\*\[?Recall Knowledge/.test(pre)) push('Recall Knowledge', 'stat', 'pre')

  // `<br />` joins entries on one line ("…DC 34<br />**[Attack of Opportunity](…)**"): a line break. So do
  // the end of a list or a title, and a bold label glued to the end of a sentence.
  const lines = [], starts = []
  let prevBlank = true
  for (const raw of body.split('\n')) {
    const parts = (hazard ? raw : raw.replace(/([.!?])\s*(?=\*\*\[?[A-Z])/g, '$1\u0000')).replace(RUNON_COST, '$1\u0000').split(/<br\s*\/?>|<\/title>|<\/[uo]l>|\u0000/i)
    parts.forEach((p, k) => { lines.push(p); starts.push(k > 0 || prevBlank) })
    prevBlank = !raw.trim() || /^<\/?(row|column)\b/i.test(raw.trim())
  }
  const traits = []
  for (const l of lines) {
    if (leadingLabel(l)) break
    for (const m of l.matchAll(/<trait label="([^"]+)"/g)) traits.push(m[1])
  }

  const sections = ['top', 'mid', 'bot']
  let sec = 0
  let inTable = false
  let sawComplexity = false, sawDescription = false, afterComplexityColumn = false, absorbNext = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const before = headings.length
    step(i, line)
    if (headings.length === before) absorb(line)
  }
  return { traits, headings, asides, listOptions }

  function step(i, line) {
    if (/^<table/i.test(line)) inTable = true
    if (inTable) { if (/<\/table>/i.test(line)) inTable = false; return }
    if (line === '---') { if (!hazard) sec = Math.min(sec + 1, 2); return }
    const slot = hazard ? 'hazard' : sections[sec]

    if (hazard && sawComplexity && !sawDescription) {
      if (/^<\/column>/.test(line)) { afterComplexityColumn = true; return }
      if (afterComplexityColumn && line && !line.startsWith('<') && !leadingLabel(line)) {
        push('Description', 'stat', slot); sawDescription = true; return
      }
    }

    // a title inside the stat block (the Mask of Norgorber's aspects) heads an entry
    const tt = line.match(/^<title\b[^>]*>(.*)$/i)
    if (tt) { if (plainLabel(tt[1])) push(plainLabel(tt[1]), 'ability', slot); return }

    if (hazard) {
      // A component's defences: "**Joint Hardness** 16", "50 (BT 25); **Pipe Hardness** 7, **Pipe HP** 30",
      // "**Reflection** AC 24; **Fort** +11", "**Belimarius Statue AC** 42; …" (inside Disable), "**Spout** HP
      // 32": every defence label on the line is a heading, wherever the line starts.
      const defs = hazardDefences(line)
      const lead0 = leadingLabel(line)
      if (defs.length && (!lead0 || defenseLabel(lead0.label.toLowerCase()) || /^\s*(?:\*\*)?\s*(?:AC|HP|Hardness)\b/.test(lead0.rest))) {
        for (const d of defs) push(d, 'stat', 'hazard')
        return
      }
    }
    if (!leadingLabel(line) && (!hazard || !/^(?:Melee|Ranged)\b/.test(line))) {
      // An unbolded ability header: Title Case words directly followed by a trait list or an action cost.
      const u = line.match(UNBOLDED) || (!hazard && starts[i] && sec > 0 && line.match(UNBOLDED_TRAITS))
      if (u && !/^(The|A|An|This|It|Its|If|When|On|In|Melee|Ranged)$/.test(u[1].split(' ')[0]) && !/^(Immunities|Resistances|Weaknesses|Speed|HP|AC)$/.test(u[1])) {
        push(headerName(u[1]), 'ability', slot, line.slice(u[1].length)); return
      }
      const lk = !hazard && starts[i] && sec > 0 && line.match(LINK_HEADER)
      if (lk && (/MonsterAbilities\.aspx/i.test(lk[2]) || /^\s*<actions\b/.test(line.slice(lk[0].length)))) {
        push(headerName(plainLabel(lk[1])), 'ability', sections[sec], line.slice(lk[0].length))
        if (/MonsterAbilities\.aspx/i.test(lk[2])) last.linked = true
        return
      }
      // A header the facet names, printed without bold at the start of a line ("Whisker Sense A leopard seal…").
      // (not a list item: "<ul><li>**Burial Site Bound** …" is an option the facet also indexes)
      if (!hazard && sec > 0 && facet.length && !valueOfStatRow(lines, i) && !/^(?:<\/?(?:ul|ol|li)\b[^>]*>\s*)+/i.test(line) && !/^\[[^\]]*\]\(\/?(?:Spells|Rituals|Equipment|Weapons|Armor)\.aspx/i.test(line)) {
        // (what follows is the header's body: a cost, a trait list or a new sentence; "Death Gasp lasts as
        // long as…" is prose about the ability, not its header)
        const t = plainLabel(line.replace(/<actions\b[^>]*>/gi, ' ◆ ').replace(/<[^>]+>/g, ' '))
        const f = facet.find(n => t.toLowerCase().startsWith(n.toLowerCase()) && /^(?:$|\s*[(◆\[:]|\s+[A-Z0-9])/.test(t.slice(n.length)) && !/^\s*[+\-\u2013]\d/.test(t.slice(n.length)))
        if (f && /^[A-Z]/.test(t) && !CLAUSES.has(f.toLowerCase())) { push(t.slice(0, f.length), 'ability', sections[sec], line.replace(/^[^<(\[]*?(?=<actions|\(|\[|$)/, '')); return }
      }
      // An unbolded second HP pool on its own line ("(body) <br /> HP 20 (tentacle)").
      if (!hazard && sec === 1 && /^\s*HP\s*(?:\d|\()/.test(plainLabel(line))) { push('HP', 'stat', slot); return }
    }
    if (!hazard && !leadingLabel(line)) {
      // An IWR row printed without its bold ("Resistances fire 25", "cold iron 15, Resistances fire 15").
      if (sec === 1) {
        for (const m of line.matchAll(IWR_UNBOLDED)) push(m[1], 'stat', slot)
        // "…[unconscious](…) **Weaknesses** positive 10": a bold IWR label glued on after a list
        for (const m of line.matchAll(/\S\s*\*\*(Immunities|Resistances|Weaknesses)\*\*/g)) push(m[1], 'stat', slot)
        if (/^\s*(Immunities|Resistances|Weaknesses)\s/.test(line)) return
      }
    }
    const lead = leadingLabel(line)
    if (!lead || !lead.label || line.startsWith('|') || line.startsWith('-')) return
    const label = lead.label
    const low = label.toLowerCase()
    if (low === 'source' || CLAUSES.has(low) || /^stage \d/.test(low) || RANK.test(label)) return
    // "**1.**", "**7 or 11**", "**2, 3, or 12**", "**1—Beauty**", "**20 feet, climb 20 feet**": a numbered
    // or dice option, or a value; "**1,000 Cuts**" is a name
    if (/^\d+(?:$|[.:)\u2013\u2014-]|,?\s+(?:or|and|\d)|,\s|\s*feet\b)/.test(label)) return
    if (/^<sup>/i.test(lead.raw ?? '')) return            // "**<sup>S</sup> Signature spell …**": a legend
    // "**• Recharge** <actions…/> …" under Mythic Power: a list item the page bullets is an option, not an entry
    if (/^\s*•/.test(lead.raw ?? '')) { listOptions.push(label); return }
    if (/^[a-z]/.test(label)) {             // "**action**", "**[paralyzed](…), [poison](…)**": words of a sentence
      if (!hazard && sec === 1) for (const m of lead.rest.trim().matchAll(IWR_UNBOLDED)) push(m[1], 'stat', slot)
      return
    }
    if (DEGREE_RUNON.test(label)) return   // "**Success Kundal** inflicts…": a degree of success run on

    // A stat label with nothing after it ("**Languages**" then the next entry) prints an empty heading.
    // (An ability label with no body, "**[Troop Defenses](…)**", is still an entry.)
    if (absorbNext) { absorbNext = false; if (!/^(?:complexity|stealth|disable|routine|reset|ac|hp|hardness|immunities|resistances|weaknesses|fort|ref|will)$/.test(low)) return }
    if (EMPTYABLE.has(low) && !lead.rest.trim() && emptyEntry(lines, i) && !(hazard && /^(?:disable|routine|reset)$/.test(low) && sectionOpensWithLabel(lines, i))) return

    if (hazard) {
      if (low === 'complexity') { push('Complexity', 'stat', slot); sawComplexity = true; return }
      // "**Speed** 20 feet", "**Reflection Speed** 50 feet": a moving hazard or component
      if (low === 'speed' || / speed$/.test(low)) { push('Speed', 'stat', slot); return }
      if (low === 'stealth') { sawDescription = true; push('Stealth', 'stat', slot); return }
      if (low === 'disable' || low === 'routine' || low === 'reset') {
        push(label[0].toUpperCase() + low.slice(1), 'stat', slot)
        // "**Reset**⏎**Recovery** <actions…/> …", "**Disable**⏎**Thievery** DC 28": the section's own text
        // opens with a bold label, which is part of it
        if (!lead.rest.trim() && sectionOpensWithLabel(lines, i, true)) absorbNext = true
        return
      }
    } else {
      if (STAT_TOP[low]) { push(STAT_TOP[low], 'stat', slot); return }
      if (ABILITY_MODS.has(low)) { if (low === 'str') push('Ability Modifiers', 'stat', slot); return }
      if (low === 'speed') { push('Speed', 'stat', slot); return }
    }

    const defense = defenseLabel(low)
    if (defense) {
      push(defense, 'stat', slot)
      // "**AC** 10, **Fort** +1, **Ref** +1" and "**Hardness** 5, **HP** 20" share one line.
      for (const m of lead.rest.matchAll(DEF_INLINE)) {
        const d = defenseLabel(m[1].trim().toLowerCase())
        if (d) push(d, 'stat', slot)
      }
      if (!hazard) for (const m of lead.rest.replace(/\*\*[^*]*\*\*/g, ' ').matchAll(IWR_UNBOLDED)) push(m[1], 'stat', slot)
      return
    }
    if (low === 'melee' || low === 'ranged') {
      push(`${label[0].toUpperCase()}${low.slice(1)} ${strikeName(lines, i, lead.rest)}`, 'strike', slot)
      return
    }
    // "**Rituals** DC 48", "**Rituals (8th)** DC 37": the block; "**Green Rituals** A green man…": an ability
    if (/\brituals?(\s*\(\d+\w*\))?$/i.test(label) && /^\s*(?:$|DC\b|\d|\(|,|;)/.test(plainLabel(lead.rest) || '')) { push('Rituals', 'stat', slot); return }
    // "**Cleric Domain Spells 1 Focus Point**", "…Spells, 1 Focus Point", "…Spells (2 Focus Points)": the pool size is a value
    const spellLabel = label.replace(/,?\s*\(?\d+\s+focus points?\)?$/i, '').trim()
    if (!/\(/.test(spellLabel) && (/\b(spells|cantrips)$/i.test(spellLabel)
        || /\b(innate|prepared|spontaneous|focus|domain|school|bloodline|order|devotion)\s+spell$/i.test(spellLabel))) {
      push(spellLabel, 'spells', slot, lead.rest); last.raw = label; absorb(''); return
    }
    // a cost the bold swallowed ("**Guardian Spirit <actions…/> **Trigger**", "**Cloak in Embers [reaction**")
    const inLabel = line.slice(0, line.length - lead.rest.length)
    const linked = /\]\([^)]*MonsterAbilities\.aspx/i.test(inLabel)
    push(headerName(label), 'ability', slot, (/<actions\s+string="[^"]+"/.test(inLabel) || /(?:^|\s)\[(?:reaction|free-action|one-action|two-actions|three-actions)\]?$/i.test(label) ? '<actions string="token" /> ' : '') + lead.rest, inLabel.replace(/^[^<]*/, '') + lead.rest)
    if (linked) last.linked = true
  }
}

/** The line is the value of a stat label printed alone on the line before ("**Weaknesses**⏎Magaambya scar"). */
function valueOfStatRow(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim()
    if (!t || /^<\/?(row|column)\b/i.test(t)) continue
    const l = leadingLabel(t)
    return !!l && !l.rest.trim() && /^(?:perception|languages|skills|items|immunities|resistances|weaknesses|speed|hp|ac|hardness)$/i.test(l.label)
  }
  return false
}

function emptyEntry(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim()
    if (!t || /^<\/?(row|column)\b/i.test(t)) continue
    return t === '---' || /^<title\b/i.test(t) || !!leadingLabel(t)
  }
  return true
}

/**
 * The next non-blank line after a hazard section label is a bold label other than a known one (the
 * section's own text opens with it). With `plain`, only a label without an action cost counts: one with a
 * cost ("**Recovery** <actions…/>") is an entry of its own.
 */
function sectionOpensWithLabel(lines, i, plain = false) {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim()
    if (!t || /^<\/?(row|column)\b/i.test(t)) continue
    const l = leadingLabel(t)
    return !!l && !(plain && /^\s*<actions\b/i.test(l.rest)) && !/^(?:complexity|stealth|disable|routine|reset|ac|hp|hardness|immunities|resistances|weaknesses|fort|ref|will|source)$/i.test(l.label)
  }
  return false
}

function defenseLabel(low) {
  if (low === 'ac' || / ac$/.test(low)) return 'AC'
  if (low === 'fort' || low === 'fortitude') return 'Fort'
  if (low === 'ref' || low === 'reflex') return 'Ref'
  if (low === 'will') return 'Will'
  if (low === 'hp' || / hp$/.test(low) || /^hp\s*\(/.test(low)) return 'HP'
  if (low === 'hardness' || / hardness$/.test(low)) return 'Hardness'
  if (low === 'immunities') return 'Immunities'
  if (low === 'resistances') return 'Resistances'
  if (low === 'weaknesses') return 'Weaknesses'
  return null
}

/**
 * Whether the stat block prints `label` at the start of a line without bold ("Ironsense The dragon can…",
 * "<br />Camouflage The dragon can…"). The oracle cannot list these headers itself, because nothing marks
 * where such a name ends; the render check asks this for a record ability the oracle did not list.
 */
export function printsUnboldedHeader(markdown, label, { hazard = false, name = '' } = {}) {
  const md = (markdown || '').replace(/\r\n?/g, '\n').replace(/<aside>[\s\S]*?<\/aside>/g, '')
  const { body } = statBlockText(md, hazard, name)
  const want = label.toLowerCase()
  if (!/^[A-Z]/.test(label)) return false
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // or run on after a full stop, followed by a cost or a new sentence ("…frightened. Reactive Beak The eron…")
  const runOn = new RegExp(`[.!?]\\s+${esc}\\s+(?:[A-Z]|\\[|◆|◇|↺)`)
  for (const raw of body.split(/\n|<br\s*\/?>/i)) {
    const p = plainLabel(raw.replace(/<actions\b[^>]*>/gi, ' ◆ ').replace(/<[^>]+>/g, ' '))
    const t = p.toLowerCase()
    if (t.startsWith(want) && /^(?:$|[\s(.:;,!])/.test(t.slice(want.length))) return true
    if (runOn.test(p)) return true
  }
  return false
}
