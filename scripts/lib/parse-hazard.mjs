// Read 2 of a hazard: the page markdown, parsed with the same entry grammar as creatures.
//
// parseHazardPage(doc) -> {fields, attacks, abilities:{top,mid,bot}, description, disable, routine,
// reset, headings, unparsed:[{section, heading, line, reason}]}
//
// A hazard page has no fixed section count: Complexity and the description, then Stealth/Disable and
// the defences, then actions, Routine and Reset, split by `---` wherever the book put a rule. Entries
// are read across the whole page; a `---` ends a Routine, which otherwise swallows its own sub-labels
// ("Turn 2", "Turn 4+").

import { clean, clean1, decodeEntities, num } from './text.mjs';
import {
  CLAUSE_RE, flat, paragraphs, parseAbility, parseAcRow, parseResWeak, parseSpeed, parseStrike, preprocess,
  splitList, toEntries,
} from './grammar.mjs';

const PROF = /^(untrained|trained|expert|master|legendary)$/i;

export function parseHazardPage(doc) {
  const unparsed = [];
  const bad = (section, heading, line, reason) => unparsed.push({ section, heading, line: String(line).slice(0, 300), reason });
  let md = String(doc.markdown ?? '').replace(/\r\n?/g, '\n');
  const fields = {};
  const tm = md.match(/<title level="1"[^>]*?right="Hazard\s+(-?\d+)"[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) { fields.level = num(tm[1]); fields.name = clean1(tm[2]); md = md.replace(tm[0], '\n'); }
  else bad('', '', md.slice(0, 120), 'hazard title without a level');
  const trBlock = md.match(/<traits>([\s\S]*?)<\/traits>/i);
  if (trBlock) {
    fields.traits = [...trBlock[1].matchAll(/<trait\s+label="([^"]*)"/gi)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
    md = md.replace(trBlock[0], '\n');
  }
  const { lines, sidebars } = preprocess(md, bad, 'body');
  const sections = [[]];
  for (const l of lines) { if (/^-{3,}$/.test(l)) sections.push([]); else sections[sections.length - 1].push(l); }

  const abilityNames = new Set();
  const actions = [];
  const attacks = [];
  const headings = [];
  const description = [];
  let disable, routine, reset;
  const hp = [];

  sections.forEach((secLines, si) => {
    const section = `s${si + 1}`;
    const entries = toEntries(secLines, section, classify, bad, abilityNames);
    for (const e of entries) {
      headings.push({ section, label: e.name, kind: e.kind });
      const unk = (tag, ctx) => bad(section, e.name, ctx, `unknown tag <${tag}>`);
      const text = flat(e);
      const paras = paragraphs(e);
      switch (e.kind) {
        case 'source': {
          const s = clean1(text, unk);
          const m = s.match(/^(.+?)\s+pg\.\s*(\d+)/i);
          fields.source = m ? m[1].trim() : s;
          if (m) fields.page = num(m[2]);
          break;
        }
        case 'complexity': {
          const [first, ...rest] = paras;
          fields.complexity = clean1(first ?? '', unk);
          description.push(...rest.map((p) => clean(p, unk)).filter(Boolean));
          break;
        }
        case 'stealth': {
          const [first, ...rest] = paras;
          const s = clean1(first ?? '', unk);
          const m = s.match(/^(DC\s*)?([+\-–−]?\s*\d+)\s*(?:\(([^)]*)\))?\s*(.*)$/i);
          if (m) {
            const n = num(m[2].replace(/[–−]/, '-').replace(/\s+/g, ''));
            const st = m[1] ? { dc: n } : { bonus: n };
            if (m[3] && PROF.test(m[3].trim())) st.minProf = m[3].trim().toLowerCase();
            else if (m[3]) bad(section, e.name, s, 'stealth note with no field');
            if (m[4] && m[4].replace(/[;,.\s]/g, '') && !(m[3] && !PROF.test(m[3].trim()))) bad(section, e.name, s, 'stealth note with no field');
            fields.stealth = st;
          } else bad(section, e.name, s, 'stealth without a number');
          fields.stealthText = s;
          for (const p of rest) description.push(clean(p, unk));
          break;
        }
        case 'disable': disable = paras.map((p) => clean(p, unk)).filter(Boolean).join('\n') || undefined; break;
        case 'ac': {
          const r = parseAcRow(`${e.name === 'AC' ? '' : `**${e.name}**`} ${text}`.trim(), unk);
          for (const k of ['ac', 'acNote', 'fort', 'ref', 'will', 'saveNote']) if (r[k] !== undefined) fields[k] = r[k];
          if (r.leftover) bad(section, e.name, r.leftover, 'text in the AC row');
          break;
        }
        case 'hardness': {
          const s = clean1(text, unk);
          const m = s.match(/^(\d+)(.*)$/);
          if (!m) { bad(section, e.name, s, 'hardness without a number'); break; }
          if (fields.hardness === undefined) fields.hardness = num(m[1]);
          else bad(section, e.name, s, 'second hardness with no field');
          if (m[2].replace(/[,;.\s]/g, '')) bad(section, e.name, s, 'hardness note with no field');
          break;
        }
        case 'hp': {
          const s = clean1(text, unk);
          const m = s.match(/^(\d+)\s*(.*)$/);
          if (!m) { bad(section, e.name, s, 'HP without a number'); break; }
          let note = m[2];
          const bt = note.match(/\(?\s*BT\s*(\d+)\s*\)?/i);
          if (bt) {
            if (fields.bt === undefined) fields.bt = num(bt[1]);
            note = note.replace(bt[0], '');
          }
          note = note.replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/^\(\s*\)$/, '');
          const comp = e.name.replace(/\s*HP\b.*$/i, '').trim();
          const qual = (e.name.match(/HP\s*(\(.*\))/i) ?? [])[1];
          const name = [comp, qual, note].filter(Boolean).join(' ').trim();
          hp.push(name ? { hp: num(m[1]), name } : { hp: num(m[1]) });
          break;
        }
        case 'immunities': fields.immunities = [...(fields.immunities ?? []), ...splitList(text.replace(/\.$/, ''), unk)]; break;
        case 'resistances': fields.resistances = [...(fields.resistances ?? []), ...parseResWeak(text, unk)]; break;
        case 'weaknesses': fields.weaknesses = [...(fields.weaknesses ?? []), ...parseResWeak(text, unk)]; break;
        case 'routine': {
          const t = [paras.map((p) => clean(p, unk)).join('\n'), ...(e.sub ?? [])].filter(Boolean).join('\n');
          routine = routine ? `${routine}\n${t}` : t;
          break;
        }
        case 'reset': reset = paras.map((p) => clean(p, unk)).filter(Boolean).join('\n') || undefined; break;
        case 'strike': {
          const r = parseStrike(e.name === 'Ranged' ? 'Ranged' : 'Melee', { first: paras.join('\n'), lines: [] }, unk);
          if (r.error) bad(section, e.name, r.raw, r.error);
          else attacks.push(r.attack);
          break;
        }
        case 'speed': {
          const r = parseSpeed(text, unk);
          fields.speed = r.speed;
          if (r.speedNote) fields.speedNote = r.speedNote;
          break;
        }
        default: {
          const issues = [];
          const ab = parseAbility(e, unk, issues);
          for (const i of issues) bad(section, e.name, i.line, i.reason);
          if (!ab.name) { bad(section, '', e.first, 'ability without a name'); break; }
          actions.push(ab);
        }
      }
    }
  });
  if (hp.length) fields.hp = hp;
  return {
    fields, attacks, actions,
    description: description.filter(Boolean),
    disable, routine, reset, sidebars, headings, unparsed,
  };

  function classify(name, cur, lab) {
    const n = name.replace(/\s+/g, ' ').trim();
    const startsAbility = /^\s*<actions\b/i.test(lab.rest ?? '');
    // Inside a Routine, bold sub-labels ("Turn 2") are part of the routine unless they carry a cost.
    if (cur?.kind === 'routine' && !startsAbility && !/^(?:Reset|Routine)$/i.test(n)) {
      cur.lines.push(`${n} ${lab.rest ?? ''}`.trim());
      return 'absorbed';
    }
    if (cur && CLAUSE_RE.test(n) && !startsAbility) return 'continue';
    // A bold word on the line right under Disable/Stealth/Reset is part of its value ("**Thievery** DC 28").
    if (['disable', 'stealth', 'reset'].includes(cur?.kind) && !lab.afterBlank && !startsAbility) return 'continue';
    if (cur?.kind === 'strike' && /^Damage$/i.test(n)) return 'continue';
    if (/^(?:Fort|Fortitude|Ref|Reflex|Will)$/i.test(n)) return cur?.kind === 'ac' ? 'continue' : 'ac';
    if (/^Source$/i.test(n)) return 'source';
    if (/^Complexity$/i.test(n)) return 'complexity';
    if (/^Stealth$/i.test(n)) return 'stealth';
    if (/^Disable$/i.test(n)) return 'disable';
    if (/^AC$/i.test(n)) return 'ac';
    if (/(?:^|\s)HP(?:\s*\(.*\))?$/.test(n)) return 'hp';
    if (/(?:^|\s)Hardness$/i.test(n)) return 'hardness';
    if (/^Immunit(?:ies|y)$/i.test(n)) return 'immunities';
    if (/^Resistances?$/i.test(n)) return 'resistances';
    if (/^Weakness(?:es)?$/i.test(n)) return 'weaknesses';
    if (/^Routine$/i.test(n)) return 'routine';
    if (/^Reset$/i.test(n)) return 'reset';
    if (/^Speed$/i.test(n)) return 'speed';
    if (/^(?:Melee|Ranged)$/i.test(n)) return 'strike';
    return 'ability';
  }
}
