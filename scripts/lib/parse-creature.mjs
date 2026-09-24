// Read 2 of a creature: the page markdown, parsed with the entry grammar of docs/DESIGN.md.
//
// parseCreaturePage(doc) -> {fields, attacks, spellcasting, rituals, abilities:{top,mid,bot}, flavor,
// recall, headings, unparsed:[{section, heading, line, reason}]}
//
// `fields` uses the same vocabulary as facets.mjs so agreement.mjs can compare the two key by key.

import { clean, clean1, decodeEntities, num, ordSuffix, splitList, splitTopLevel, stripLinks } from './text.mjs';
import {
  CLAUSE_RE, flat, paragraphs, parseAbility, parseAcRow, parseResWeak, parseSpeed, parseStrike,
  preprocess, sidebarText, toEntries,
} from './grammar.mjs';

const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];
const RARITIES = ['uncommon', 'rare', 'unique'];
const ONE_PARAGRAPH = new Set(['source', 'perception', 'languages', 'skills', 'items', 'immunities', 'resistances', 'weaknesses', 'hardness', 'speed']);
const LIST_KINDS = new Set(['immunities', 'resistances', 'weaknesses', 'items', 'languages', 'skills']);
const STAT_ROW_KINDS = new Set(['hp', 'immunities', 'resistances', 'weaknesses', 'hardness']);

/** Spellcasting header names: "Arcane Prepared Spells", "Hex Cantrips", "Spells", "Occult Spells Known". */
const SPELL_HEADER = /^(?:[A-Za-z'’\-]+\s+)*?(?:Spells?|Spels|Cantrips|Hexes)(?:\s+(?:Known|Prepared))?(?:,?\s*\(?\s*\d+\s+Focus\s+Points?\)?)?\s*[,;]?$|^Spells\s+.*Spellcasting$/i;
const RANK_RE_PLAIN = /(?:^|;|,|\s)\s*(Cantrips?\s*\((\d+)(?:st|nd|rd|th)\)|Constant\s*\((\d+)(?:st|nd|rd|th)\)|(\d+)(?:st|nd|rd|th)(?:\s+rank)?(?:\s*\((\d+)\s+slots?\))?)(?=\s+(?:\[|_|[A-Za-z]))/g;
/** The spell attack in a header: "attack +26", "spell attack +26", "attack roll +26", "+25 attack", "DC 38, +30". */
const ATTACK_RE = /\b(?:spell\s+)?attack(?:\s+(?:roll|modifier))?\s*([+-]\s?\d+)|([+-]\s?\d+)\s*(?:spell\s+)?attack\b|DC\s*\d+\s*,\s*([+-]\d+)(?!\s*\w)/i;
const RITUAL_HEADER = /^(?:[A-Za-z]+\s+)?Rituals?(?:\s*\(\d+(?:st|nd|rd|th)\))?$/i;
const STAT_LABEL = /^(?:Source|Perception|Languages?|Skills|Str|Dex|Con|Int|Wis|Cha|Items|AC|Fort|Fortitude|Ref|Reflex|Will|HP|Hardness|Immunit(?:ies|y)|Resistances?|Weakness(?:es)?|Speed|Melee|Ranged)$/i;
/** A spell-rank marker inside a spell block. */
const RANK_RE = /(?:^|\n|;|\s)-?\s*\*\*\s*(Cantrips?(?:\s*\((\d+)(?:st|nd|rd|th)\))?|Constant\s*\((\d+)(?:st|nd|rd|th)\)|(\d+)(?:st|nd|rd|th)(?:\s+(?:rank|level))?(?:\s*\((\d+)\s+slots?\))?)\s*:?\*\*/gi;

export function parseCreaturePage(doc) {
  const unparsed = [];
  const bad = (section, heading, line, reason) => unparsed.push({ section, heading, line: String(line).slice(0, 300), reason });
  const md = String(doc.markdown ?? '').replace(/\r\n?/g, '\n');
  const abilityNames = new Set((Array.isArray(doc.creature_ability) ? doc.creature_ability : []).map((n) => String(n).toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));

  let cut = md.search(/<title level="2"[^>]*right="Creature\s+-?\d+"[^>]*>/i);
  if (cut < 0) cut = md.search(/<title level="2"[^>]*>/i);
  const head = cut >= 0 ? md.slice(0, cut) : '';
  let body = cut >= 0 ? md.slice(cut) : md;
  if (cut < 0) bad('', '', md.slice(0, 120), 'no stat-block title');

  // ── flavour and Recall Knowledge (before the stat-block title) ─────────────────────────────────
  const recall = parseRecall(head);
  const { text: flavorHead, sidebars: headSidebars, placeholder: placeholderFlavor } = parseFlavorHead(head, bad);

  // ── stat block title, traits ───────────────────────────────────────────────────────────────────
  const fields = {};
  const tm = body.match(/^<title level="2"[^>]*?right="Creature\s+(-?\d+)"[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) { fields.level = num(tm[1]); fields.name = clean1(tm[2]); body = body.slice(tm[0].length); }
  else bad('', '', body.slice(0, 120), 'stat-block title without a creature level');
  const trBlock = body.match(/<traits>([\s\S]*?)<\/traits>/i);
  if (trBlock) {
    const traits = [...trBlock[1].matchAll(/<trait\s+label="([^"]*)"/gi)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
    fields.traits = traits;
    const size = traits.find((t) => SIZES.includes(t.toLowerCase()));
    if (size) fields.size = size.toLowerCase();
    const rar = traits.find((t) => RARITIES.includes(t.toLowerCase()));
    fields.rarity = rar ? rar.toLowerCase() : 'common';
    body = body.replace(trBlock[0], '\n');
  }

  const { lines, sidebars } = preprocess(body, bad, 'body');
  // ── sections ───────────────────────────────────────────────────────────────────────────────────
  const sections = [[]];
  for (const l of lines) { if (/^-{3,}$/.test(l)) sections.push([]); else sections[sections.length - 1].push(l); }
  if (sections.length !== 3) {
    bad('', '---', `${sections.length} sections`, `stat block has ${sections.length} sections, not 3`);
    while (sections.length > 3) { const extra = sections.pop(); sections[sections.length - 1].push('', ...extra); }
    while (sections.length < 3) sections.push([]);
  }
  const SECTION_NAMES = ['top', 'mid', 'bot'];

  const attacks = [], spellcasting = [], ritualBlocks = [];
  const abilities = { top: [], mid: [], bot: [] };
  const headings = [];
  const hpTexts = [];

  for (let si = 0; si < 3; si++) {
    const section = SECTION_NAMES[si];
    const entries = toEntries(sections[si], section, classify, bad, abilityNames);
    for (const e of entries) {
      headings.push({ section, label: e.name, kind: e.kind });
      handleEntry(e, section);
    }
  }
  // Every HP row of the block is read together: a second `**HP**` row is a part pool (a hydra's head).
  if (hpTexts.length) {
    const pools = parseHp(hpTexts.join(' HP '), (tag, ctx) => bad('mid', 'HP', ctx, `unknown tag <${tag}>`));
    if (pools.length) fields.hp = pools; else bad('mid', 'HP', hpTexts.join(' | '), 'HP without a number');
  }

  let rituals;
  if (ritualBlocks.length) {
    rituals = { ...(ritualBlocks[0].dc !== undefined ? { dc: ritualBlocks[0].dc } : {}), casts: ritualBlocks.flatMap((r) => r.casts) };
    if (ritualBlocks.length > 1) {
      const dcs = new Set(ritualBlocks.map((r) => r.dc));
      if (dcs.size > 1) bad('bot', 'Rituals', [...dcs].join(', '), 'several ritual blocks with different DCs');
    }
  }

  const flavorParts = [flavorHead, ...headSidebars, ...sidebars].filter(Boolean);
  const flavor = flavorParts.length ? flavorParts.join('\n\n') : undefined;
  return { fields, attacks, spellcasting, rituals, abilities, flavor, recall, headings, unparsed, placeholderFlavor };


  function handleEntry(e, section) {
      const unk = (tag, ctx) => bad(section, e.name, ctx, `unknown tag <${tag}>`);
      let text = flat(e);
      // A one-paragraph stat row: a further paragraph under it is not its value.
      if (ONE_PARAGRAPH.has(e.kind)) {
        const paras = paragraphs(e);
        text = (paras[0] ?? '').replace(/\n/g, ' ');
        for (const p of paras.slice(1)) {
          const flatP = p.replace(/\n/g, ' ');
          // The list simply carried on past a blank line ("critical hits, death effects⏎⏎[disease](…), …").
          if (LIST_KINDS.has(e.kind) && /^(?:\*\*)?(?:[a-z(]|\[[a-z_])/.test(flatP)) {
            // "area⏎⏎damage 5, …" is one entry broken in two; "death effects⏎⏎[disease](…)" is the next item.
            const glue = /^\(/.test(flatP) || ((e.kind === 'resistances' || e.kind === 'weaknesses') && !/\d\)?\s*[,;]?\s*$/.test(text)) ? ' ' : ', ';
            text += glue + flatP;
            continue;
          }
          // A defence row whose bold was lost: "Weaknesses [cold](…) 25".
          const sl = flatP.match(/^(Immunities|Resistances|Weaknesses)\s+(.*)$/);
          if (sl) { handleEntry({ section, kind: sl[1].toLowerCase(), name: sl[1], rawLabel: sl[1], first: sl[2], lines: [] }, section); continue; }
          // Otherwise it is the next ability, printed without its bold.
          const h = inferHeader(p, doc.name);
          if (h) {
            headings.push({ section, label: h.name, kind: 'ability' });
            handleEntry({ section, kind: 'ability', name: h.name, rawLabel: h.name, first: h.rest, lines: [], unbolded: true }, section);
            continue;
          }
          bad(section, e.name, p, 'paragraph after a stat row');
        }
      }
      // A defence row that swallowed the next one: "**HP** 400 ((body); **Resistances** poison 15" or
      // "cold iron 15, Resistances fire 15". A capitalised row label inside a defence row starts that row.
      // A second HP row opens a part's own stat line ("**HP** 30 (head), deceptive regrowth; **Immunities** area
      // damage; **Weakness** cold iron 10"): all of it describes the part, so it stays on that pool.
      // An HP row runs to the end of its paragraph; a later paragraph that opens with an ability header
      // ("**HP** 20⏎⏎[Buck](/MonsterAbilities…) <actions…/> DC 17") is that ability, not part of the pool.
      if (e.kind === 'hp') {
        const paras = paragraphs(e);
        const keep = [paras[0] ?? ''];
        for (const p of paras.slice(1)) {
          const h = inferHeader(p, doc.name);
          if (h && /^(?:\[|[A-Z])/.test(p) && !/^\(/.test(p)) {
            // one header per line: "[Attack of Opportunity](…) <actions…/><br />[Shield Block](…) <actions…/>"
            let cur = null;
            const flush = () => { if (cur) { headings.push({ section, label: cur.name, kind: 'ability' }); handleEntry(cur, section); } };
            for (const l of p.split('\n')) {
              const lh = inferHeader(l, doc.name);
              if (lh || !cur) { flush(); const hh = lh ?? h; cur = { section, kind: 'ability', name: hh.name, rawLabel: hh.name, first: lh ? lh.rest : h.rest, lines: [], unbolded: true }; }
              else cur.lines.push(l);
            }
            flush();
          } else keep.push(p);
        }
        text = keep.join(' ').replace(/\n/g, ' ');
      }
      if (e.kind === 'hp' && hpTexts.length) { hpTexts.push(text); return; }
      // An AC row that ran on into an unbolded IWR row ("**Will** +13⏎⏎Immunities cold").
      if (e.kind === 'ac') {
        const m = text.match(/(?:^|\s)(Immunities|Resistances|Weaknesses)\s+(?=[\[a-z0-9_])/);
        if (m) {
          const rest = text.slice(m.index + m[0].length);
          text = text.slice(0, m.index);
          handleEntry({ section, kind: m[1].toLowerCase(), name: m[1], rawLabel: m[1], first: rest, lines: [] }, section);
        }
      }
      if (STAT_ROW_KINDS.has(e.kind)) {
        const re = /\s*[;,]?\s*(?:\*\*(Immunities|Resistances|Weaknesses|Hardness|HP)\*\*|\b(Immunities|Resistances|Weaknesses)\b(?=\s)|\b(HP)\b(?=\s*(?:\(|\d)))/g;
        const cuts = [...text.matchAll(re)].filter((m) => m.index > 0);
        if (cuts.length) {
          const whole = text;
          text = whole.slice(0, cuts[0].index);
          for (let k = 0; k < cuts.length; k++) {
            const lab = cuts[k][1] ?? cuts[k][2] ?? cuts[k][3];
            const val = whole.slice(cuts[k].index + cuts[k][0].length, k + 1 < cuts.length ? cuts[k + 1].index : whole.length);
            if (lab === 'HP' && e.kind === 'hp') { text += ' HP ' + val; continue; }
            const kind = { Immunities: 'immunities', Resistances: 'resistances', Weaknesses: 'weaknesses', Hardness: 'hardness', HP: 'hp' }[lab];
            handleEntry({ section, kind, name: lab, rawLabel: lab, first: val, lines: [] }, section);
          }
        }
      }
      switch (e.kind) {
        case 'source': {
          const s = clean1(text, unk);
          const m = s.match(/^(.+?)\s+pg\.\s*(\d+)/i);
          fields.source = m ? m[1].trim() : s;
          if (m) fields.page = num(m[2]);
          break;
        }
        case 'perception': parsePerception(text, fields, (l) => bad(section, e.name, l, 'perception line not read'), unk); break;
        case 'languages': {
          const s = stripLinks(text);
          // the first ";" outside parentheses ("one spoken in life (typically Common; can't speak any language)")
          const parts = splitTopLevel(s, ';', false);
          const langs = parts[0];
          const abil = parts.slice(1).join(';');
          fields.languages = splitList(langs, unk);
          fields.languageAbilities = splitTopLevel(abil, ';').flatMap((x) => splitList(x, unk));
          break;
        }
        case 'skills': {
          fields.skills = fields.skills ?? {};
          for (const part of splitTopLevel(stripLinks(text))) {
            const p = clean1(part, unk);
            if (!p) continue;
            const m = p.match(/^(.+?)\s*([+-]\s?\d+)\s*(.*)$/);
            if (!m) { bad(section, e.name, p, 'skill without a modifier'); continue; }
            fields.skills[m[1].trim().toLowerCase()] = num(m[2].replace(/\s+/g, ''));
            if (m[3]) bad(section, e.name, p, 'skill qualifier with no field');
          }
          break;
        }
        case 'abilityMods': {
          fields.abilityMods = fields.abilityMods ?? {};
          const s = [`**${e.rawLabel}**`, text].join(' ');
          for (const m of s.matchAll(/\*\*(Str|Dex|Con|Int|Wis|Cha)\*\*\s*([+-–—]?\s*\d+|—|–)/gi)) {
            fields.abilityMods[m[1].toLowerCase()] = /\d/.test(m[2]) ? num(m[2].replace(/[–—]/, '-').replace(/\s+/g, '')) : 0;
          }
          const left = s.replace(/\*\*(Str|Dex|Con|Int|Wis|Cha)\*\*\s*([+-–—]?\s*\d+|—|–)[,;]?/gi, '').trim();
          if (left) bad(section, e.name, left, 'text in the ability-modifier row');
          break;
        }
        case 'items': fields.items = [...(fields.items ?? []), ...splitList(text, unk)]; break;
        case 'ac': {
          const r = parseAcRow(`${e.name === 'AC' ? '' : `**${e.name}**`} ${text}`.trim(), unk);
          Object.assign(fields, pick(r, ['ac', 'acNote', 'fort', 'ref', 'will', 'saveNote']));
          if (r.leftover) bad(section, e.name, r.leftover, 'text in the AC row');
          break;
        }
        case 'hp': {
          if (!/\d/.test(text)) { bad(section, e.name, text, 'HP without a number'); break; }
          hpTexts.push(text);
          break;
        }
        case 'hardness': {
          const s = clean1(text, unk);
          const m = s.match(/^(\d+)(.*)$/);
          if (m) { fields.hardness = num(m[1]); if (m[2].replace(/[,;.\s]/g, '')) bad(section, e.name, s, 'hardness note with no field'); }
          else bad(section, e.name, s, 'hardness without a number');
          break;
        }
        case 'immunities': case 'resistances': case 'weaknesses': {
          // The same row printed twice (inline in the HP row and again as its own row): both are merged,
          // and the repeat is reported so the page's duplication is visible.
          if (fields[e.kind]?.length) bad(section, e.name, text, "IWR row printed twice; the record merges both");
          // An ability header glued to the end of the row with no body ("[disease](…) Impossible Stature (aura,
          // divine, illusion, mental)"): the header becomes its ability, and the missing body is reported.
          {
            const flatRow = stripLinks(text);
            const g = flatRow.match(/^(.*?\S)\s+((?:[A-Z][\w'’-]*)(?:\s+(?:[A-Z][\w'’-]*|of|the|and))*)\s*\(([a-z][a-z ,-]*)\)\s*$/);
            if (g && g[2].includes(" ")) {
              text = g[1];
              abilities[section].push({ name: g[2], traits: g[3].split(/\s*,\s*/).filter(Boolean), entries: [''] });
              headings.push({ section, label: g[2], kind: 'ability' });
              bad(section, g[2], flatRow.slice(g[1].length).trim(), `ability header glued to the ${e.name} row; the page prints no body`);
            }
          }
          if (e.kind === 'immunities') fields.immunities = mergeList(fields.immunities, splitList(text.replace(/\.$/, ''), unk));
          else fields[e.kind] = mergeRW(fields[e.kind], parseResWeak(text, unk));
          break;
        }
        case 'speed': {
          const r = parseSpeed(text, unk);
          fields.speed = r.speed;
          if (r.speedNote) fields.speedNote = r.speedNote;
          break;
        }
        case 'strike': {
          const paras = paragraphs(e);
          // The strike runs until its Damage clause; AoN sometimes puts a blank line before it.
          let k = 1;
          while (k < paras.length && !/Damage/.test(paras.slice(0, k).join(' '))) k++;
          const r = parseStrike(e.name === 'Ranged' ? 'Ranged' : 'Melee', { first: paras.slice(0, k).join('\n'), lines: [] }, unk);
          if (r.error) bad(section, e.name, r.raw, r.error);
          else attacks.push(r.attack);
          if (r.requirement) bad(section, e.name, r.requirement, 'strike requirement with no field');
          for (const p of paras.slice(k)) bad(section, e.name, p, 'paragraph after a strike');
          break;
        }
        case 'spells': {
          const r = parseSpellBlock(e, unk, (l, why) => bad(section, e.name, l, why));
          if (r) spellcasting.push(r);
          break;
        }
        case 'rituals': {
          const r = parseRitualBlock(e, unk, (l, why) => bad(section, e.name, l, why));
          if (r) ritualBlocks.push(r);
          break;
        }
        default: {
          const issues = [];
          const ab = parseAbility(e, unk, issues);
          for (const i of issues) bad(section, e.name, i.line, i.reason);
          if (!ab.name) { bad(section, '', e.first, 'ability without a name'); break; }
          abilities[section].push(ab);
        }
      }
  }

  /** The facet names this label, exactly or inside one of its (sometimes template-mangled) entries. */
  function facetMentions(n) {
    const l = n.toLowerCase();
    if (abilityNames.has(l)) return true;
    for (const a of abilityNames) if (a.includes(l)) return true;
    return false;
  }

  function classify(name, cur, lab) {
    const n = name.replace(/\s+/g, ' ').trim();
    if (cur && CLAUSE_RE.test(n)) return 'continue';
    // A bulleted bold option ("**• Recharge** <actions…/> … **Cost** 1 Mythic Point") belongs to the ability above.
    if (cur?.kind === 'ability' && /^\s*•/.test(lab?.rawLabel ?? '')) return 'continue';
    // "**<sup>S</sup> Signature spell <sup>E</sup> emotion spell**": the spell list's legend, not an entry
    if (/^\s*<sup>/i.test(lab?.rawLabel ?? '')) { bad(cur?.section ?? '', n, lab.rawLabel, 'spell legend line with no field'); return 'absorbed'; }
    // Numbered or dice-result sub-labels ("**1**", "**7 or 11**") belong to the ability they list.
    if (cur?.kind === 'ability' && /^\d/.test(n)) return 'continue';
    // A degree of success whose bold ran on into the next word ("**Success Kundal** inflicts…").
    if (cur?.kind === 'ability' && /^(?:Critical Success|Critical Failure|Success|Failure)\s/.test(n) && !abilityNames.has(n.toLowerCase())) return 'continue';
    // An option label inside an ability ("**Ally** …", "**Enemy** …" under Angry Rant): printed on the
    // next line of the same paragraph, with no cost, and not one of the page's own ability names. An
    // affliction ("**Putrid Plague** (disease) … **Saving Throw** …") is an entry even when the facet omits it.
    if (cur?.kind === 'ability' && !lab.afterBlank && !lab.traitHeader && abilityNames.size && !/MonsterAbilities\.aspx/i.test(lab.url ?? '') && !facetMentions(n)
      && !/^\s*<actions\b/i.test(lab.rest ?? '') && !(/^\s*\((?:\[|[a-z])/.test(lab.rest ?? '') && /\*\*Saving Throw\*\*/i.test(lab.rest ?? '')) && !STAT_LABEL.test(n) && !SPELL_HEADER.test(n) && !RITUAL_HEADER.test(n)) return 'continue';
    if (cur?.kind === 'strike' && /^Damage$/i.test(n)) return 'continue';
    if (cur?.kind === 'spells' && /^(?:Cantrips?(?:\s*\(\d+\w*\))?|Constant\s*\(\d+\w*\)|\d+(?:st|nd|rd|th)(?:\s+rank)?)$/i.test(n)) return 'continue';
    if (cur?.kind === 'rituals' && /^\d+(?:st|nd|rd|th)$/i.test(n)) return 'continue';
    if (/^(?:Str|Dex|Con|Int|Wis|Cha)$/i.test(n)) return cur?.kind === 'abilityMods' ? 'continue' : 'abilityMods';
    if (/^(?:Fort|Fortitude|Ref|Reflex|Will)$/i.test(n)) return cur?.kind === 'ac' ? 'continue' : 'ac';
    if (/^Source$/i.test(n)) return 'source';
    if (/^Perception$/i.test(n)) return 'perception';
    if (/^Languages?$/i.test(n)) return 'languages';
    if (/^Skills$/i.test(n)) return 'skills';
    if (/^Items$/i.test(n)) return 'items';
    if (/^AC$/i.test(n)) return 'ac';
    if (/^HP$/i.test(n)) return 'hp';
    if (/^Hardness$/i.test(n)) return 'hardness';
    if (/^Immunit(?:ies|y)$/i.test(n)) return 'immunities';
    if (/^Resistances?$/i.test(n)) return 'resistances';
    if (/^Weakness(?:es)?$/i.test(n)) return 'weaknesses';
    if (/^Speed$/i.test(n)) return 'speed';
    if (/^(?:Melee|Ranged)$/i.test(n)) return 'strike';
    if (RITUAL_HEADER.test(n) && ritualShaped(lab.rest)) return 'rituals';
    if (SPELL_HEADER.test(n) && !/^Signature Spells$/i.test(n) && spellShaped(lab)) return 'spells';
    return 'ability';
  }
}

/**
 * The header of an ability printed without bold, at the start of a paragraph that cannot belong to the
 * stat row above it. Recognised shapes: a MonsterAbilities link ("[Troop Defenses](…)"), a name before a
 * cost tag or trait list ("Frightful Presence (aura, …)", "[Attack of Opportunity](…) <actions…>"), and
 * a Title Case name before the first sentence ("Axe Vulnerability An arboreal tar tree takes…").
 */
function inferHeader(p, creatureName) {
  const line = p.split('\n')[0];
  const restOf = (i) => [line.slice(i).trim(), ...p.split('\n').slice(1)].join('\n').trim();
  let m = line.match(/^\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*\)\s*/);
  if (m && (/MonsterAbilities\.aspx/i.test(m[0]) || /^\s*(?:<actions\b|\(|$)/.test(line.slice(m[0].length)))) {
    return { name: clean1(m[1]), rest: restOf(m[0].length) };
  }
  const TITLE = "(?:[A-Z][\\w'’\\-!]*)(?:\\s+(?:of|the|and|to|in|on|by|a|an|[A-Z][\\w'’\\-!]*))*";
  m = line.match(new RegExp(`^(${TITLE})\\s*(?=<actions\\b|\\((?:[a-z]|\\[))`));
  if (m) return { name: m[1].trim(), rest: restOf(m[0].length) };
  m = line.match(new RegExp(`^(${TITLE})\\s+(?=\\d)`));
  if (m && m[1].split(/\s+/).length <= 5) return { name: m[1].trim(), rest: restOf(m[0].length) };
  const words = line.split(/\s+/);
  const first = String(creatureName ?? '').split(/\s+/)[0];
  for (let k = 1; k < Math.min(words.length, 6); k++) {
    const head = words.slice(0, k);
    if (!head.every((w, i) => /^[A-Z]/.test(w) || (i > 0 && /^(?:of|the|and|to|in|on|by)$/.test(w)))) break;
    const next = words[k];
    if (/^(?:The|A|An|This|These|Its|If|When|Each|Every|While|Any|Creatures?|It|They|Their)$/.test(next) || (first && next === first)) {
      return { name: head.join(' '), rest: restOf(head.join(' ').length) };
    }
  }
  return null;
}

/** A ritual header is a ritual block when a DC or rank follows, not prose ("Green Rituals A green man…"). */
function ritualShaped(rest) {
  const r = String(rest ?? '').trim();
  return !r || /^DC\s*\d+/i.test(r) || /^[;,]?\s*-?\s*\*\*\d+(?:st|nd|rd|th)\*\*/.test(r);
}

/** A spell header is a spell block when a DC, attack, focus pool or rank follows; otherwise it is prose. */
function spellShaped(lab) {
  const rest = stripLinks(String(lab.rest ?? '')).replace(/^[\s,;:]+/, '');
  if (/^(?:DC\s*\d|(?:spell\s+)?attack\b|[+-]\s?\d|\(?\s*\d+\s+Focus\s+Points?|-?\s*\*\*\s*(?:\d+(?:st|nd|rd|th)|Cantrips|Constant))/i.test(rest)) return true;
  return !rest && /Spells|Cantrips|Hexes|Focus|Domain|Innate|Prepared|Spontaneous|Revelation|School|Bloodline|Composition|Devotion|Order/i.test(lab.name);
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }
function mergeList(a, b) { const out = [...(a ?? [])]; for (const x of b) if (!out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x); return out; }
function mergeRW(a, b) { const out = [...(a ?? [])]; for (const x of b) if (!out.some((y) => JSON.stringify(y) === JSON.stringify(x))) out.push(x); return out; }

/** "+20; darkvision, scent (imprecise) 30 feet" / "+27 (+29 to detect lies); …" */
function parsePerception(text, fields, report, unk) {
  const s = clean1(text, unk);
  const m = s.match(/^([+-]\s?\d+)\s*(?:\(([^)]*)\))?\s*[;,]?\s*(.*)$/s);
  if (!m) { report(s); return; }
  fields.perception = num(m[1].replace(/\s+/g, ''));
  let rest = m[3].trim();
  let note = m[2]?.trim();
  // AoN sometimes prints the qualifier after the semicolon: "+26; (+28 vs. traps) darkvision".
  const lead = rest.match(/^\(([^)]*)\)\s*[;,]?\s*(.*)$/s);
  if (!note && lead) { note = lead[1].trim(); rest = lead[2]; }
  if (note) fields.perceptionNote = note;
  fields.senses = splitList(rest, unk);
}

/**
 * HP entry text -> pools [{hp, name?}]. The first pool is the creature's; any further `HP` inside the
 * same entry ("HP (head) 60", "**HP** 15 ((head), head regrowth)") is a part pool named by its
 * parenthesised part.
 */
function parseHp(text, unk) {
  const s = clean1(text, unk);
  const segs = s.split(/(?:^|[\s;,])HP\b\s*:?/).map((x) => x.trim()).filter((x) => x !== '');
  const pools = [];
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i];
    let part;
    // "(head) 60" or "60 ((head), …" / "60 (head)"
    let m = seg.match(/^\(\s*([a-z][a-z ]{1,19}?)\s*\)\s*(\d+)\s*(.*)$/s);
    let hp, rest;
    if (m) { part = m[1]; hp = num(m[2]); rest = m[3]; }
    else {
      m = seg.match(/^(\d+)\s*(.*)$/s);
      if (!m) continue;
      hp = num(m[1]); rest = m[2];
      const multi = segs.length > 1;
      const pm = rest.match(/^\(\(\s*([a-z][a-z ]{1,19}?)\s*\)\s*(.*)$/s) || (i > 0 ? rest.match(/^\(\s*([a-z][a-z ]{1,19}?)\s*\)(.*)$/s) : null)
        || (multi ? rest.match(/^\(\(?\s*([a-z][a-z ]{1,19}?)\s*,\s*(.*)$/s) : null);
      if (pm) {
        part = pm[1];
        rest = pm[2];
        if (rest.trim().endsWith(')') && pm[0].startsWith('((')) rest = rest.trim().slice(0, -1);
        else if (pm[0].startsWith('((')) rest = rest.replace(/\)\s*$/, '');
      }
    }
    // Inline defence labels spilled into the HP row are read by their own entries; drop them here.
    if (i === 0) rest = rest.replace(/\b(?:Immunities|Resistances|Weaknesses|Hardness)\b[\s\S]*$/, (x) => (/[A-Za-z]/.test(x) ? '' : x));
    let note = rest.replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
    if (/^\(\s*\)$/.test(note) || note === ')' || note === '(') note = '';
    note = balanceParens(note);
    if (/^\(\s*\)$/.test(note)) note = '';
    const name = part ? [part, note].filter(Boolean).join(', ') : note;
    pools.push(name ? { hp, name } : { hp });
  }
  return pools;
}

/** Drop parentheses that have no partner ("body, head regrowth), regeneration" -> "body, head regrowth, regeneration"). */
function balanceParens(t) {
  const chars = [...t];
  const open = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '(') open.push(i);
    else if (chars[i] === ')') { if (open.length) open.pop(); else chars[i] = ''; }
  }
  for (const i of open) chars[i] = '';
  return chars.join('').replace(/\s+([,;])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/** Spell block entry -> Spellcasting object. */
function parseSpellBlock(e, unk, report) {
  const name = e.name.replace(/,?\s*\(?\s*\d+\s+Focus\s+Points?\s*\)?\s*[,;]?\s*$/i, '').replace(/[,;]\s*$/, '').trim();
  const low = name.toLowerCase();
  const tradition = ['arcane', 'divine', 'occult', 'primal'].find((t) => low.includes(t)) ?? '';
  const type = /innate/.test(low) ? 'Innate' : /prepared/.test(low) ? 'Prepared' : /spontaneous/.test(low) ? 'Spontaneous'
    : /focus|composition|domain|devotion|hex|order|revelation|school|conflux|warden|monk|ki/.test(low) ? 'Focus'
    : /cantrips/.test(low) ? 'Cantrips' : 'Innate';
  const all = [e.first, ...e.lines].join('\n');
  let ranks = [...all.matchAll(RANK_RE)];
  // Ranks written without bold after the DC: "DC 24 7th [interplanar teleport](…)", alone or ahead of
  // bold ranks ("DC 37 2nd invisibility (at will, self only)" then "- **Cantrips (9th)**").
  const firstBold = ranks.length ? ranks[0].index : all.length;
  const plain = [...all.slice(0, firstBold).matchAll(RANK_RE_PLAIN)];
  if (plain.length) ranks = [...plain, ...ranks];
  const headerText = ranks.length ? all.slice(0, ranks[0].index) : all;
  const block = { name, tradition, type };
  const hflat = stripLinks(headerText).replace(/\s+/g, ' ');
  const lflat = stripLinks(e.rawLabel);
  const dcm = hflat.match(/\bDC\s*(\d+)/i);
  if (dcm) block.DC = num(dcm[1]);
  const atm = hflat.match(ATTACK_RE);
  if (atm) block.attack = num((atm[1] ?? atm[2] ?? atm[3]).replace(/\s+/g, ''));
  const fpm = (lflat + ' ' + hflat).match(/(\d+)\s*Focus\s*Points?/i);
  if (fpm) block.focusPoints = num(fpm[1]);
  const leftover = clean1(hflat.replace(ATTACK_RE, (m) => (m.match(/^DC\s*\d+/i) ? '' : '')).replace(/\bDC\s*\d+/i, '').replace(/\(?\s*\d+\s*Focus\s*Points?\s*\)?/i, ''), unk)
    .replace(/^[\s,;.]+|[\s,;.]+$/g, '');
  if (leftover) report(leftover, 'spell header text with no field');
  const entry = {};
  const constants = [];
  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i];
    const seg = all.slice(r.index + r[0].length, i + 1 < ranks.length ? ranks[i + 1].index : all.length);
    const label = r[1];
    let key, level;
    if (/^cantrip/i.test(label)) { key = '0'; level = r[2] ? num(r[2]) : 0; }
    else if (/^constant/i.test(label)) { key = `constant:${num(r[3])}`; level = num(r[3]); }
    else { key = String(num(r[4])); level = num(r[4]); }
    const h = harvestSpells(seg, unk);
    if (r[5]) h.slots = num(r[5]);
    if (!h.spells.length) { report(`${label} ${clean1(seg)}`.trim(), 'spell rank without spells'); continue; }
    if (entry[key] || constants.some((c) => c[0] === key)) { report(`${label} ${clean1(seg)}`, 'repeated spell rank'); continue; }
    const rank = { level, spells: h.spells };
    if (h.slots !== undefined) rank.slots = h.slots;
    if (h.leftover) report(h.leftover, 'text in a spell rank');
    if (key.startsWith('constant:')) constants.push([key, rank]); else entry[key] = rank;
  }
  // Constant spells nest under entry.constant = {"<rank>": {level, spells}}: the shape the app's adapter reads.
  if (constants.length) {
    entry.constant = {};
    for (const [k, v] of constants) entry.constant[k.slice('constant:'.length)] = v;
  }
  block.entry = entry;
  if (!ranks.length && block.focusPoints === undefined) {
    const rest = clean1(all, unk);
    if (rest) report(rest, 'spell block without ranks');
  }
  return block;
}

const SPELL_TARGET = /^(?:https?:\/\/[^/]+)?\/?(?:Mythic)?(?:Spells|Rituals)\.aspx/i;

/**
 * One rank's spell list -> {spells:[{name, atWill?, amount?, note?}], slots?, leftover?}. The list is
 * split on top-level commas; each item is a name (linked or not) followed by usage parentheticals.
 */
export function harvestSpells(seg, unk) {
  let s = seg.replace(/<sup>[^<]*<\/sup>/gi, '').replace(/\n/g, ' ').trim().replace(/^[;:,\s]+|[;,\s.]+$/g, '');
  const spells = [];
  let slots;
  const leftovers = [];
  for (const itemRaw of splitTopLevel(s)) {
    const item = itemRaw.trim();
    if (!item) continue;
    const m = item.match(/^((?:_?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\((?:[^()\s]|\([^()]*\))*\)_?\**)|[^()\[]+)\s*((?:\((?:[^()]|\([^()]*\))*\)\s*)*)\s*(.*)$/s);
    if (!m) { leftovers.push(item); continue; }
    const name = clean1(m[1], unk).replace(/\*+$/, '').trim();
    const parens = m[2];
    if (m[3] && m[3].replace(/[*\s]/g, '')) leftovers.push(m[3].trim());
    const slotOnly = name.match(/^\(?(\d+)\s+slots?\)?$/i);
    if (slotOnly) { slots = num(slotOnly[1]); continue; }
    if (!name || !/[A-Za-z]/.test(name)) { if (parens) leftovers.push(item); continue; }
    const sp = { name };
    for (const p of parens.matchAll(/\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const parts = p[1].split(/\s*([;,])\s*/);
      const kept = [];
      for (let t = 0; t < parts.length; t += 2) {
        const tok = parts[t].trim();
        if (!tok || /^\*+$/.test(tok)) continue;
        if (/^at[-\s]?will$/i.test(tok)) { sp.atWill = true; continue; }
        const times = tok.match(/^[x×]\s*(\d+)$|^(\d+)$/i);
        if (times) { sp.amount = num(times[1] ?? times[2]); continue; }
        const sl = tok.match(/^\*?(\d+)\s+slots?$/i);
        if (sl) { slots = num(sl[1]); continue; }
        kept.push({ tok, sep: parts[t + 1] ?? '' });
      }
      const note = clean1(kept.map((x, n) => (n < kept.length - 1 ? x.tok + (x.sep || ';') + ' ' : x.tok)).join(''), unk);
      if (note) sp.note = sp.note ? `${sp.note}; ${note}` : note;
    }
    spells.push(sp);
  }
  const out = { spells };
  if (slots !== undefined) out.slots = slots;
  if (leftovers.length) out.leftover = clean1(leftovers.join(', '), unk);
  return out;
}

/** Ritual block entry -> {dc?, casts:[{rank, level, names}]}. */
function parseRitualBlock(e, unk, report) {
  const all = [e.first, ...e.lines].join('\n');
  const ranks = [...all.matchAll(/(?:^|\n|;|\s)-?\s*\*\*\s*(\d+)(?:st|nd|rd|th)\s*\*\*/gi)];
  const headerText = ranks.length ? all.slice(0, ranks[0].index) : all;
  const out = {};
  const dcm = stripLinks(headerText).match(/\bDC\s*(\d+)/i);
  if (dcm) out.dc = num(dcm[1]);
  const left = clean1(stripLinks(headerText).replace(/\bDC\s*\d+/i, ''), unk).replace(/^[\s,;.]+|[\s,;.]+$/g, '');
  if (left) report(left, 'ritual header text with no rank');
  out.casts = [];
  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i];
    const seg = all.slice(r.index + r[0].length, i + 1 < ranks.length ? ranks[i + 1].index : all.length);
    const level = num(r[1]);
    const h = harvestSpells(seg, unk);
    if (!h.spells.length) { report(`${r[1]} ${clean1(seg)}`, 'ritual rank without rituals'); continue; }
    if (h.leftover) report(h.leftover, 'text in a ritual rank');
    out.casts.push({ rank: `${level}${ordSuffix(level)}`, level, names: h.spells.map((s) => (s.note ? `${s.name} (${s.note})` : s.name)) });
  }
  return out;
}

/** Recall Knowledge sidebar -> {type, skills, dc, unspecificLoreDc, specificLoreDc} */
function parseRecall(head) {
  const s = stripLinks(head.replace(/\r/g, '')).replace(/\*\*/g, '');
  const m = s.match(/Recall Knowledge\s*-\s*([^\n(]+?)\s*\n?\s*\(([^)]*)\)\s*:?\s*DC\s*(\d+)/i);
  if (!m) return undefined;
  const r = { type: m[1].trim(), skills: m[2].split(/,|\bor\b/).map((x) => x.trim()).filter(Boolean), dc: num(m[3]) };
  const u = s.match(/Unspecific Lore\s*:?\s*DC\s*(\d+)/i);
  if (u) r.unspecificLoreDc = num(u[1]);
  const sp = s.match(/Specific Lore\s*:?\s*DC\s*(\d+)/i);
  const sp2 = [...s.matchAll(/(?<!Un)Specific Lore\s*:?\s*DC\s*(\d+)/gi)];
  if (sp2.length) r.specificLoreDc = num(sp2[0][1]); else if (sp) r.specificLoreDc = num(sp[1]);
  return r;
}

/** Everything before the stat-block title, minus the title and the Recall Knowledge column. */
function parseFlavorHead(head, bad) {
  const sidebars = [];
  let h = head.replace(/<aside\b[^>]*>([\s\S]*?)<\/aside>/gi, (_, inner) => { const t = sidebarText(inner, bad); if (t) sidebars.push(t); return '\n'; });
  // The page title (level 1) is the creature's name; a section title ("Campaign Role", "Plot Hooks") stays
  // as its own plain line so its paragraphs do not run into the section before.
  h = h.replace(/<title level="1"[\s\S]*?<\/title>/gi, '');
  h = h.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_, t) => { const x = clean1(t); return x ? `\n\n${x}\n\n` : '\n'; });
  h = h.replace(/<column gap="tiny">(?:(?!<column)[\s\S])*?Recall Knowledge[\s\S]*?<\/column>/gi, '');
  h = h.replace(/<\/?(?:column|row|image|document|traits|trait)\b[^>]*>/gi, '\n');
  h = h.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>|<\/?[uo]l\b[^>]*>/gi, '\n');
  h = h.split('\n').filter((l) => !/^\s*\**\[?(Recall Knowledge|Unspecific Lore|Specific Lore)\b/i.test(l.trim())).join('\n');
  let t = clean(h, (tag, ctx) => bad('flavor', '', ctx, `unknown tag <${tag}>`));
  // The Archives' "Nethys Note: No description has been provided for this creature." is a placeholder, not
  // flavor: the sentence goes, and so does a Note left with nothing else to say.
  let placeholder = false;
  t = t.replace(/No description (?:has been|is) (?:provided|provied|given) for (?:this|these|them|his)\b[^.,\n]*[.,]?[ \t]*/gi, () => { placeholder = true; return ''; });
  if (placeholder) t = t.replace(/^[ \t]*Nethys Notes?:?[ \t]*$/gim, '').replace(/(Nethys Notes?:)[ \t]+/gi, '$1 ');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return { text: t || undefined, sidebars, placeholder };
}
