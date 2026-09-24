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
  const bad = (section, heading, line, reason) => unparsed.push({ section, heading, line: String(line).slice(0, 1000), reason });
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
  let lastHardnessComp = '';

  // Every strike the page prints, wherever it sits (its own entry, or after a <br> inside an action or the
  // Routine): the hazard shape has no strike field, so each is an unparsed row carrying the strike and the
  // rules text printed with it; description[0] keeps it for the app's own hazard text parser.
  sections.forEach((secLines, si) => {
    for (let i = 0; i < secLines.length; i++) {
      // at a line start, or glued after the sentence before it ("…as a single attack. **Ranged** darts +12")
      const at = secLines[i].search(/(?:^|(?<=[.!?)]\s*))(?:\*\*(?:Melee|Ranged)\*\*|(?:Melee|Ranged)(?=\s*<actions\b))/);
      if (at < 0 || (at > 0 && !/\*\*(?:Melee|Ranged)\*\*/.test(secLines[i].slice(at, at + 12)))) continue;
      const m = secLines[i].slice(at).match(/^(?:\*\*(Melee|Ranged)\*\*|(Melee|Ranged))/);
      const parts = [secLines[i].slice(at)];
      for (let j = i + 1; j < secLines.length; j++) {
        const l = secLines[j];
        if (!l || /^-{3,}$/.test(l)) break;
        const lab = l.match(/^\*\*\[?([^*\]]+)/);
        if (lab && !/^(?:Damage|Critical Success|Success|Failure|Critical Failure|Effect)\b/i.test(lab[1].trim())) break;
        if (!lab && /^[A-Z][\w'’ -]{1,40}\s*(?:<actions\b|\()/.test(l)) break;
        parts.push(l);
      }
      bad(`s${si + 1}`, m[1] ?? m[2], clean1(parts.join(' ')), 'hazard strike: no field in hazard shape; kept in description[0] which the app parses');
    }
  });

  sections.forEach((secLines, si) => {
    const section = `s${si + 1}`;
    const entries = toEntries(secLines, section, classify, bad, abilityNames);
    for (const e of entries) {
      headings.push({ section, label: e.name, kind: e.kind });
      handle(e, section);
    }
  });

  function handle(e, section) {
      const unk = (tag, ctx) => bad(section, e.name, ctx, `unknown tag <${tag}>`);
      let text = flat(e);
      let paras = paragraphs(e);
      const later = [];
      // A defence row that runs into the next: "**Web Hardness** 5; **Web HP** 20; **Immunities** …".
      if (['hardness', 'hp', 'immunities', 'resistances', 'weaknesses'].includes(e.kind)) {
        const cuts = [...text.matchAll(/\s*[;,]?\s*\*\*((?:[A-Z][\w'’-]*\s+)*?(?:Hardness|HP|Immunities|Resistances|Weaknesses))\*\*/g)].filter((m) => m.index > 0);
        if (cuts.length) {
          const whole = text;
          text = whole.slice(0, cuts[0].index);
          paras = [text];
          for (let k = 0; k < cuts.length; k++) {
            const lab = cuts[k][1];
            const val = whole.slice(cuts[k].index + cuts[k][0].length, k + 1 < cuts.length ? cuts[k + 1].index : whole.length);
            const kind = /Hardness$/.test(lab) ? 'hardness' : /HP$/.test(lab) ? 'hp' : lab.toLowerCase();
            later.push({ section, kind, name: lab, rawLabel: lab, first: val.trim(), lines: [] });
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
        case 'complexity': {
          const [first, ...rest] = paras;
          fields.complexity = clean1(first ?? '', unk);
          description.push(...rest.map((p) => clean(p, unk)).filter(Boolean));
          break;
        }
        case 'stealth': {
          const [first, ...rest] = paras;
          const s = clean1(first ?? '', unk).replace(/^Stealth\s+/i, '');
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
        case 'disable': {
          // "…disables the hazard.<br />**Belimarius Statue AC** 42; … **Hardness** 31; **HP** 120 (BT 60)": a
          // component's own defences printed inside the Disable text stay there; the shape has no field.
          for (const line of text.split('\n')) {
            if (!/\*\*(?:[A-Z][\w'’-]*\s+)+(?:AC|Hardness|HP)\*\*/.test(line)) continue;
            for (const m of line.matchAll(/\*\*((?:[A-Z][\w'’-]*\s+)*(?:AC|Hardness|HP|Immunities|Resistances|Weaknesses|Fort|Ref|Will))\*\*[^*]*/g)) bad(section, m[1], clean1(m[0], unk), 'component defences inside Disable with no field');
          }
          disable = paras.map((p) => clean(p, unk)).filter(Boolean).join('\n') || undefined;
          break;
        }
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
          // "**Spout Hardness** 8; Spout HP 32 (BT 16)": the HP row lost its bold.
          const hpm = m[2].match(/^\s*[;,]\s*((?:[A-Z][\w'’-]*\s+)*HP)\s+(\d.*)$/);
          if (hpm) { m[2] = ''; later.push({ section, kind: 'hp', name: hpm[1], rawLabel: hpm[1], first: hpm[2], lines: [] }); }
          lastHardnessComp = e.name.replace(/\s*Hardness$/i, '').trim();
          if (fields.hardness === undefined) fields.hardness = num(m[1]);
          else bad(section, e.name, s, 'second hardness with no field');
          if (m[2].replace(/[,;.\s]/g, '')) bad(section, e.name, s, 'hardness note with no field');
          break;
        }
        case 'hp': {
          const s = clean1(text, unk);
          const m = s.match(/^(?:(\([^)]*\))\s*)?(\d+)\s*(.*)$/);
          if (!m) { bad(section, e.name, s, 'HP without a number'); break; }
          let note = [m[1], m[3]].filter(Boolean).join(' ');
          const value = num(m[2]);
          // The Broken Threshold: "(BT 32)", or a bare "(44)" right after the HP, smaller than it ("Hammer HP 88 (44)").
          let btv;
          const bt = note.match(/\(?\s*BT\s*(\d+)\s*\)?/i) ?? (m[3].match(/^\(\s*(\d+)\s*\)/) && num(m[3].match(/^\(\s*(\d+)\s*\)/)[1]) < value ? m[3].match(/^\(\s*(\d+)\s*\)/) : null);
          if (bt) { btv = num(bt[1]); note = note.replace(bt[0], ''); }
          // Only the first (or only) pool's BT is the hazard's; a later component's BT stays on its pool.
          if (btv !== undefined && !hp.length && fields.bt === undefined) fields.bt = btv;
          note = note.replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/^\(\s*\)$/, '');
          // A bare "HP" row under a component's hardness ("**Blade Hardness** 30, **HP** 30 each") is that component's.
          const comp = e.name.replace(/\s*HP\b.*$/i, '').trim() || (!hp.length ? lastHardnessComp : '');
          const qual = (e.name.match(/HP\s*(\(.*\))/i) ?? [])[1];
          hp.push({ hp: value, head: [comp, qual].filter(Boolean).join(' ').trim(), note, bt: btv });
          break;
        }
        case 'immunities': case 'resistances': case 'weaknesses': {
          // A second IWR row belongs to a component ("**Web Hardness** 5; **Web HP** 20; **Immunities** …"):
          // the hazard shape has one list, so the component's row is reported, not merged into the hazard's.
          if (fields[e.kind] !== undefined) { bad(section, e.name, clean1(text, unk), 'component IWR row with no field'); break; }
          fields[e.kind] = e.kind === 'immunities' ? splitList(text.replace(/\.$/, ''), unk) : parseResWeak(text, unk);
          break;
        }
        case 'routine': {
          const t = [paras.map((p) => clean(p, unk)).join('\n'), ...(e.sub ?? [])].filter(Boolean).join('\n');
          routine = routine ? `${routine}\n${t}` : t;
          break;
        }
        case 'reset': reset = paras.map((p) => clean(p, unk)).filter(Boolean).join('\n') || undefined; break;
        case 'strike': {
          // (reported once, with its rules text, by the strike scan above)
          const r = parseStrike(e.name === 'Ranged' ? 'Ranged' : 'Melee', { first: paras.join('\n'), lines: [] }, unk);
          if (!r.error) attacks.push(r.attack);
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
      for (const x of later) handle(x, section);
  }
  // One pool per component, named by it; with several components each carries its own BT in its name
  // ("Joint (BT 32)"), since defenses.bt holds only the first pool's.
  if (hp.length) fields.hp = hp.map((p) => {
    const head = p.head + (p.head && hp.length > 1 && p.bt !== undefined ? ` (BT ${p.bt})` : '');
    const name = [head, p.note].filter(Boolean).join(', ');
    return name ? { hp: p.hp, name } : { hp: p.hp };
  });
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
    // A dice-table option ("**1–2: Acid Rain** (acid) A torrent…") belongs to the entry that rolls it.
    if (cur && /^\d+(?:\s*[–-]\s*\d+)?\s*:/.test(n) && !startsAbility) return 'continue';
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
