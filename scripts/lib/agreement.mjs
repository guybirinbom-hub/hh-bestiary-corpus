// Compare the two reads of one document (docs/DESIGN.md, "Agreement").
//
// compareCreature(structured, text) / compareHazard(structured, text) ->
//   { rows: [{field, structured, text}], onlyStructured: [field…], onlyText: [field…] }
// Values are compared after normalisation (case, whitespace, link text, "feet" vs "ft", ordering for
// set-like fields). A field present in only one read is not a disagreement; it is returned in
// onlyStructured / onlyText for report/coverage.json.

import { normKey } from './text.mjs';

const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
  && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function ctx() {
  const rows = [], onlyStructured = [], onlyText = [];
  return {
    rows, onlyStructured, onlyText,
    /** Scalar comparison. */
    scalar(field, s, t, norm = (x) => x) {
      if (!has(s) && !has(t)) return;
      if (!has(t)) { onlyStructured.push(field); return; }
      if (!has(s)) { onlyText.push(field); return; }
      if (norm(s) !== norm(t)) rows.push({ field, structured: s, text: t });
    },
    /** Set comparison (order-insensitive, normalised); one row per differing field holding both lists. */
    set(field, s, t) {
      if (!has(s) && !has(t)) return;
      if (!has(t)) { onlyStructured.push(field); return; }
      if (!has(s)) { onlyText.push(field); return; }
      const a = [...new Set(s.map(normKey))].sort();
      const b = [...new Set(t.map(normKey))].sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ field, structured: s, text: t });
    },
    /** Multiset of numbers, order-insensitive. */
    numbers(field, s, t) {
      if (!has(s) && !has(t)) return;
      if (!has(t)) { onlyStructured.push(field); return; }
      if (!has(s)) { onlyText.push(field); return; }
      const a = [...s].sort((x, y) => x - y), b = [...t].sort((x, y) => x - y);
      if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ field, structured: s, text: t });
    },
    /** Keyed map compared per key: {name: value}. One row per differing key. */
    map(field, s, t) {
      if (!has(s) && !has(t)) return;
      if (!has(t)) { onlyStructured.push(field); return; }
      if (!has(s)) { onlyText.push(field); return; }
      const keys = new Set([...Object.keys(s), ...Object.keys(t)]);
      for (const k of keys) {
        if (s[k] !== t[k]) rows.push({ field, structured: s[k] === undefined ? null : `${k} ${s[k]}`, text: t[k] === undefined ? null : `${k} ${t[k]}` });
      }
    },
    /** Resistance / weakness entries matched by normalised name. */
    resweak(field, s, t) {
      if (!has(s) && !has(t)) return;
      if (!has(t)) { onlyStructured.push(field); return; }
      if (!has(s)) { onlyText.push(field); return; }
      const fmt = (e) => `${e.name}${e.amount != null ? ` ${e.amount}` : ''}${e.note ? ` (${e.note})` : ''}`;
      const key = (e) => normKey(e.name);
      const tm = new Map(t.map((e) => [key(e), e]));
      const sm = new Map(s.map((e) => [key(e), e]));
      for (const [k, e] of sm) {
        const o = tm.get(k);
        if (!o) rows.push({ field, structured: fmt(e), text: null });
        else if (e.amount !== o.amount || normKey(e.note ?? '') !== normKey(o.note ?? '')) rows.push({ field, structured: fmt(e), text: fmt(o) });
      }
      for (const [k, e] of tm) if (!sm.has(k)) rows.push({ field, structured: null, text: fmt(e) });
    },
  };
}

export function compareCreature(S, T) {
  const c = ctx();
  const tf = T.fields;
  c.scalar('level', S.level, tf.level);
  c.scalar('hp', S.hp, tf.hp?.[0]?.hp);
  c.scalar('ac', S.ac, tf.ac);
  c.scalar('fort', S.fort, tf.fort);
  c.scalar('ref', S.ref, tf.ref);
  c.scalar('will', S.will, tf.will);
  c.scalar('perception', S.perception, tf.perception);
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) c.scalar(k, S[k], tf.abilityMods?.[k]);
  c.scalar('size', S.size, tf.size, normKey);
  c.scalar('rarity', S.rarity, tf.rarity, normKey);
  c.set('traits', S.traits, tf.traits);
  c.map('skills', S.skills, tf.skills);
  c.map('speeds', S.speeds, tf.speed);
  c.set('senses', S.senses, tf.senses);
  c.set('languages', [...(S.languages ?? []), ...(S.languageAbilities ?? [])], [...(tf.languages ?? []), ...(tf.languageAbilities ?? [])]);
  c.set('immunities', S.immunities, tf.immunities);
  c.resweak('weaknesses', S.weaknesses, tf.weaknesses);
  c.resweak('resistances', S.resistances, tf.resistances);
  c.set('items', S.items, tf.items);
  c.numbers('spellDC', S.spellDC, T.spellcasting.map((b) => b.DC).filter((x) => x !== undefined));
  c.numbers('spellAttack', S.spellAttack, T.spellcasting.map((b) => b.attack).filter((x) => x !== undefined));
  c.numbers('attackBonuses', S.attackBonuses, T.attacks.map((a) => a.attack));
  const names = [...T.abilities.top, ...T.abilities.mid, ...T.abilities.bot].map((a) => a.name);
  c.set('abilityNames', S.abilityNames, names);
  c.scalar('hardness', S.hardness, tf.hardness);
  return c;
}

export function compareHazard(S, T) {
  const c = ctx();
  const tf = T.fields;
  c.scalar('level', S.level, tf.level);
  c.scalar('complexity', S.complexity, tf.complexity, normKey);
  c.scalar('stealth', S.stealth ? JSON.stringify(S.stealth) : undefined, tf.stealth ? JSON.stringify({ ...tf.stealth, minProf: undefined }) : undefined);
  c.scalar('disable', S.disable, T.disable, normKey);
  c.scalar('reset', S.reset, T.reset, normKey);
  c.scalar('hardness', S.hardness, tf.hardness);
  c.scalar('hp', S.hp, tf.hp?.[0]?.hp);
  c.scalar('ac', S.ac, tf.ac);
  c.scalar('fort', S.fort, tf.fort);
  c.scalar('ref', S.ref, tf.ref);
  c.scalar('will', S.will, tf.will);
  c.set('immunities', S.immunities, tf.immunities);
  c.resweak('weaknesses', S.weaknesses, tf.weaknesses);
  c.resweak('resistances', S.resistances, tf.resistances);
  c.set('traits', S.traits, tf.traits);
  return c;
}
