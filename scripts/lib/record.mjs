// Assemble the Heroes Heaven record shapes (contract-records.md §2, §3, §4) from the two reads.
//
// The page text wins where both reads have a value; the structured facet fills a field only when the
// page did not print one; a value neither read has stays absent. Key order is the app's.

import { num, toArr } from './text.mjs';

/** Record `source` / `page` from the document's primary source ("Bestiary pg. 178"). */
export function docSource(doc) {
  if (doc.primary_source_raw) return doc.primary_source_raw;
  if (Array.isArray(doc.source) && doc.source.length) return doc.source[0];
  if (typeof doc.source === 'string') return doc.source;
  return '';
}
export function sourceAndPage(doc) {
  const src = docSource(doc);
  const m = src.match(/^(.+?)\s+pg?\.\s*(\d+)$/i);
  return { source: m ? m[1].trim() : src, page: m ? parseInt(m[2]) : undefined };
}
/** Shard file key (contract §1): the source name without "pg. N", slugged. */
export function fileKey(doc) {
  const raw = docSource(doc) || 'unknown';
  const m = raw.match(/^(.+?)\s+pg?\./i);
  const srcName = (m ? m[1] : raw).trim();
  return { srcName, key: srcName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '') };
}

const pick = (t, s) => (t !== undefined && t !== null ? t : s);
const aon = (doc) => ({
  id: doc.id,
  ...(doc.url ? { url: doc.url.startsWith('http') ? doc.url : `https://2e.aonprd.com${doc.url}` } : {}),
  markdown: doc.markdown ?? doc.text ?? '',
});
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

export function creatureRecord(doc, S, T) {
  const tf = T.fields;
  const { source, page } = sourceAndPage(doc);
  let traits = tf.traits ?? [...(S.traits ?? [])];
  if (!tf.traits) {
    if (S.rarity && S.rarity !== 'common' && !traits.some((t) => t.toLowerCase() === S.rarity)) traits.unshift(cap(S.rarity));
    if (S.size && !traits.some((t) => t.toLowerCase() === S.size)) traits.unshift(cap(S.size));
  }
  const mods = {};
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) mods[k] = pick(tf.abilityMods?.[k], S[k]) ?? 0;
  const senses = tf.senses ?? S.senses ?? [];
  const perceptionNote = tf.perception !== undefined ? tf.perceptionNote : S.perceptionNote;
  const skills = tf.skills ?? S.skills ?? {};
  let speed = tf.speed, speedNote = tf.speedNote;
  if (!speed) { speed = {}; for (const k of ['walk', 'fly', 'swim', 'burrow', 'climb']) if (S.speeds?.[k] !== undefined) speed[k] = S.speeds[k]; }

  const hp = tf.hp ?? (S.hp !== undefined ? [{ hp: S.hp }] : []);
  const defenses = {
    ac: pick(tf.ac, S.ac) !== undefined ? { std: pick(tf.ac, S.ac) } : {},
    ...(tf.acNote ? { acNote: tf.acNote } : {}),
    savingThrows: {
      fort: pick(tf.fort, S.fort) !== undefined ? { std: pick(tf.fort, S.fort) } : {},
      ref: pick(tf.ref, S.ref) !== undefined ? { std: pick(tf.ref, S.ref) } : {},
      will: pick(tf.will, S.will) !== undefined ? { std: pick(tf.will, S.will) } : {},
      ...(tf.saveNote ? { note: tf.saveNote } : {}),
    },
    hp,
    immunities: tf.immunities ?? S.immunities ?? [],
    resistances: tf.resistances ?? S.resistances ?? [],
    weaknesses: tf.weaknesses ?? S.weaknesses ?? [],
    ...(pick(tf.hardness, S.hardness) !== undefined ? { hardness: { std: pick(tf.hardness, S.hardness) } } : {}),
  };
  const spellcasting = T.spellcasting.map((b) => ({
    name: b.name, tradition: b.tradition, type: b.type,
    ...(b.DC !== undefined ? { DC: b.DC } : {}),
    ...(b.focusPoints !== undefined ? { focusPoints: b.focusPoints } : {}),
    ...(b.attack !== undefined ? { attack: b.attack } : {}),
    entry: b.entry,
  }));
  const rec = {
    name: doc.name,
    source,
    ...(page !== undefined ? { page } : {}),
    level: pick(tf.level, S.level) ?? 0,
    traits,
    perception: { std: pick(tf.perception, S.perception) ?? 0 },
    ...(perceptionNote ? { perceptionNote } : {}),
    senses: senses.map((name) => ({ name })),
    languages: { languages: tf.languages ?? S.languages ?? [], abilities: tf.languageAbilities ?? S.languageAbilities ?? [] },
    skills,
    abilityMods: mods,
    items: tf.items ?? S.items ?? [],
    speed,
    ...(speedNote ? { speedNote } : {}),
    attacks: T.attacks,
    spellcasting,
    ...(T.rituals && T.rituals.casts.length ? { rituals: T.rituals } : {}),
    abilities: T.abilities,
    defenses,
    ...(T.flavor ? { flavor: T.flavor } : {}),
    ...(doc.creature_family ? { family: String(doc.creature_family) } : {}),
    _aon: aon(doc),
  };
  return rec;
}

export function hazardRecord(doc, S, T) {
  const tf = T.fields;
  const { source, page } = sourceAndPage(doc);
  const stealth = tf.stealth ?? S.stealth;
  const def = {
    ac: pick(tf.ac, S.ac) !== undefined ? { std: pick(tf.ac, S.ac) } : {},
    ...(tf.acNote ? { acNote: tf.acNote } : {}),
    savingThrows: {
      fort: pick(tf.fort, S.fort) !== undefined ? { std: pick(tf.fort, S.fort) } : {},
      ref: pick(tf.ref, S.ref) !== undefined ? { std: pick(tf.ref, S.ref) } : {},
      will: pick(tf.will, S.will) !== undefined ? { std: pick(tf.will, S.will) } : {},
      ...(tf.saveNote ? { note: tf.saveNote } : {}),
    },
    hp: tf.hp ?? (S.hp !== undefined ? [{ hp: S.hp }] : []),
    immunities: tf.immunities ?? S.immunities ?? [],
    resistances: tf.resistances ?? S.resistances ?? [],
    weaknesses: tf.weaknesses ?? S.weaknesses ?? [],
    ...(pick(tf.hardness, S.hardness) !== undefined ? { hardness: { std: pick(tf.hardness, S.hardness) } } : {}),
    ...(tf.bt !== undefined ? { bt: { std: tf.bt } } : {}),
  };
  const disable = T.disable ?? S.disable;
  const reset = T.reset ?? S.reset;
  const complexity = tf.complexity ?? S.complexity ?? '';
  return {
    name: doc.name,
    source,
    ...(page !== undefined ? { page } : {}),
    level: pick(tf.level, S.level) ?? 0,
    traits: tf.traits ?? S.traits ?? [],
    ...(stealth ? { stealth } : {}),
    description: doc.text ? [doc.text] : [],
    disable: { entries: disable ? [disable] : [] },
    routine: T.routine ? [T.routine] : [],
    reset: reset ? [reset] : [],
    complex: /complex/i.test(complexity),
    defenses: def,
    actions: T.actions,
    _aon: aon(doc),
  };
}

// ─── index ───────────────────────────────────────────────────────────────────────────────────────

const cleanDefenseValue = (raw) => {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 40) return null;
  if (/[;{}<>]/.test(s)) return null;
  if (/\b(immunit|weakness|resistance|hardness|hp\b|aura|see\b)/i.test(s)) return null;
  if (/^and\s/i.test(s)) return null;
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const cleanArr = (arr) => {
  const out = [], seen = new Set();
  for (const v of toArr(arr)) {
    const c = cleanDefenseValue(v);
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  }
  return out;
};

function spellIndex(rec) {
  let lvl = 0;
  const types = new Set();
  for (const b of rec.spellcasting ?? []) {
    for (const v of Object.values(b.entry ?? {})) if (v.level > lvl) lvl = v.level;
    const name = (b.name || '').toLowerCase();
    const trad = b.tradition ? b.tradition.charAt(0).toUpperCase() + b.tradition.slice(1) : '';
    const kind = /focus/.test(name) ? 'Focus' : /innate/.test(name) ? 'Innate' : /prepared/.test(name) ? 'Prepared' : /spontaneous/.test(name) ? 'Spontaneous' : '';
    if (kind && trad) types.add(`${kind} ${trad}`); else if (kind) types.add(kind); else if (trad) types.add(trad);
  }
  return { spellLvl: lvl, spellTypes: [...types] };
}

export function creatureIndexRow(doc, rec) {
  const { srcName, key } = fileKey(doc);
  const sp = rec.speed ?? {};
  const speedTypes = [];
  if (sp.fly !== undefined) speedTypes.push('Fly');
  if (sp.swim !== undefined) speedTypes.push('Swim');
  if (sp.burrow !== undefined) speedTypes.push('Burrow');
  if (sp.climb !== undefined) speedTypes.push('Climb');
  if (sp.walk !== undefined) speedTypes.push('Walk');
  const dcs = (rec.spellcasting ?? []).map((b) => b.DC).filter((x) => x !== undefined);
  const { spellLvl, spellTypes } = spellIndex(rec);
  return {
    name: doc.name,
    level: rec.level,
    traits: Array.isArray(doc.trait) ? doc.trait : [],
    source: srcName,
    file: `creatures-${key}.json`,
    isNpc: !!doc.npc,
    immunities: cleanArr(rec.defenses.immunities),
    weaknesses: cleanArr(rec.defenses.weaknesses.map((w) => w.name)),
    resistances: cleanArr(rec.defenses.resistances.map((r) => r.name)),
    speedTypes,
    maxSpeed: Math.max(0, ...Object.values(sp).filter((v) => typeof v === 'number')),
    traditions: Array.isArray(doc.tradition) ? doc.tradition : [],
    spellDC: dcs.length ? Math.max(0, ...dcs) : 0,
    spellLvl, spellTypes,
  };
}

export function hazardIndexRow(doc, rec) {
  return {
    name: doc.name,
    level: rec.level,
    traits: Array.isArray(doc.trait) ? doc.trait : [],
    source: docSource(doc),
    file: '../hazards.json',
    isHazard: true,
    immunities: cleanArr(rec.defenses.immunities),
    weaknesses: cleanArr(rec.defenses.weaknesses.map((w) => w.name)),
    resistances: cleanArr(rec.defenses.resistances.map((r) => r.name)),
    speedTypes: [], maxSpeed: 0, traditions: [], spellDC: 0, spellLvl: 0, spellTypes: [],
  };
}

// The app's source-priority table, copied verbatim from Heroes-Heaven scripts/build-bestiary.mjs @ 41c2b05.
const priorityRules = [
  [0,  /^Monster Core 2/i], [0,  /^Monster Core/i],
  [1,  /^NPC Core/i], [1, /^GM Core/i],
  [1,  /^Player Core 2/i], [1, /^Player Core/i],
  [10, /^Bestiary 3/i],
  [11, /^Battlecry/i], [11, /^Howl of the Wild/i],
  [11, /^Rage of Elements/i], [11, /^Tian Xia Bestiary/i],
  [12, /^Book of the Dead/i], [12, /^Dark Archive/i],
  [12, /^Secrets of Magic/i], [12, /^Guns ?(?:&|and) ?Gears/i],
  [20, /^Bestiary 2/i], [21, /^Bestiary\b/i],
  [22, /^Gamemastery Guide/i], [22, /^Core Rulebook/i],
  [22, /^Absalom, City of Lost Omens/i],
  [30, /^The Mwangi Expanse/i], [30, /^Lost Omens/i],
  [30, /^Impossible Lands/i],
];
const priorityOf = (s) => {
  const t = String(s || '');
  for (const [r, re] of priorityRules) if (re.test(t)) return r;
  if (/^Pathfinder #?\d/i.test(t)) return 60;
  if (/(Hardcover|One-Shot|Adventure)/i.test(t)) return 70;
  return 50;
};

/**
 * rows: [{row, doc}] in build order (creatures in id order, then hazards). Returns
 * {index, droppedByRemasterLink, droppedByPriority}.
 */
export function dedupIndex(rows) {
  const ids = new Set(rows.map((r) => r.doc.id));
  // 1. A legacy document whose remaster_id names a document in the corpus gives way to its remaster.
  const kept = [];
  let droppedByRemasterLink = 0;
  for (const r of rows) {
    const rem = toArr(r.doc.remaster_id);
    if (rem.some((id) => ids.has(id))) { droppedByRemasterLink++; continue; }
    kept.push(r.row);
  }
  // 2. Remaining same-name collisions: the app's priority table, then localeCompare of source.
  const byName = new Map();
  for (const e of kept) {
    const k = e.name.toLowerCase().trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const deduped = [];
  let droppedByPriority = 0;
  for (const [, arr] of byName) {
    if (arr.length === 1) { deduped.push(arr[0]); continue; }
    arr.sort((a, b) => {
      const pa = priorityOf(a.source), pb = priorityOf(b.source);
      return pa !== pb ? pa - pb : String(a.source).localeCompare(String(b.source));
    });
    deduped.push(arr[0]);
    droppedByPriority += arr.length - 1;
  }
  deduped.sort((a, b) => a.name.localeCompare(b.name));
  return { index: deduped, droppedByRemasterLink, droppedByPriority };
}

export { num };
