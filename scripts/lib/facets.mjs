// Read 1: the structured facets an Archives document carries, flattened into the same vocabulary the
// page-text read (parse-creature.mjs / parse-hazard.mjs) produces, so agreement.mjs can compare the
// two key by key. Nothing here reads `markdown`.

import { clean1, num, splitList, splitTopLevel, stripLinks, toArr } from './text.mjs';
import { parseResWeak } from './grammar.mjs';

/** The Archives' plain facets keep its template tokens: {{skills 17 "Thievery"}} -> Thievery. */
const untemplate = (t) => String(t ?? '').replace(/\{\{\w+\s+\d+\s+"([^"]*)"\}\}/g, '$1').replace(/\{\{[^}]*\}\}/g, ' ');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrUndef = (v) => (isNum(v) ? v : (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim()) ? parseInt(v) : undefined));

export function creatureFacets(doc) {
  const f = {};
  f.level = numOrUndef(doc.level);
  f.hp = numOrUndef(doc.hp);
  f.ac = numOrUndef(doc.ac);
  f.fort = numOrUndef(doc.fortitude_save);
  f.ref = numOrUndef(doc.reflex_save);
  f.will = numOrUndef(doc.will_save);
  f.perception = numOrUndef(doc.perception);
  for (const [k, facet] of [['str', 'strength'], ['dex', 'dexterity'], ['con', 'constitution'], ['int', 'intelligence'], ['wis', 'wisdom'], ['cha', 'charisma']]) {
    f[k] = numOrUndef(doc[facet]);
  }
  const size = toArr(doc.size)[0];
  if (size) f.size = String(size).toLowerCase();
  if (doc.rarity) f.rarity = String(doc.rarity).toLowerCase();
  if (Array.isArray(doc.trait)) f.traits = doc.trait.map(String);
  if (doc.creature_family) f.family = String(doc.creature_family);

  // Skills: the numeric facet, then the markdown facet (which adds Lores).
  const skills = {};
  if (doc.skill_mod && typeof doc.skill_mod === 'object') for (const [k, v] of Object.entries(doc.skill_mod)) skills[k.toLowerCase()] = num(v);
  if (typeof doc.skill_markdown === 'string' && doc.skill_markdown.trim()) {
    for (const part of splitTopLevel(stripLinks(doc.skill_markdown))) {
      const m = clean1(part).match(/^(.+?)\s*([+-]\s?\d+)/);
      if (m) skills[m[1].trim().toLowerCase()] = num(m[2].replace(/\s+/g, ''));
    }
  }
  if (Object.keys(skills).length) f.skills = skills;

  if (doc.speed && typeof doc.speed === 'object' && !Array.isArray(doc.speed)) {
    const sp = {};
    for (const [k, v] of Object.entries(doc.speed)) {
      if (k === 'max' || !isNum(v)) continue;
      sp[k === 'land' ? 'walk' : k] = v;
    }
    if (Object.keys(sp).length) f.speeds = sp;
  }
  f.speedRaw = doc.speed_raw;

  const sm = doc.sense_markdown ?? doc.sense;
  if (typeof sm === 'string' && sm.trim()) {
    const list = splitList(sm);
    if (list.length && list[0].startsWith('(')) {
      const m = list[0].match(/^\(([^)]*)\)\s*[;,]?\s*(.*)$/);
      if (m) { f.perceptionNote = m[1].trim() || undefined; if (m[2].trim()) list[0] = m[2].trim(); else list.shift(); }
    }
    f.senses = list;
  }
  if (typeof doc.language_markdown === 'string' && doc.language_markdown.trim()) {
    const s = stripLinks(doc.language_markdown);
    const semi = s.indexOf(';');
    f.languages = splitList(semi >= 0 ? s.slice(0, semi) : s);
    f.languageAbilities = semi >= 0 ? splitTopLevel(s.slice(semi + 1), ';').flatMap((x) => splitList(x)) : [];
  } else if (doc.language) {
    f.languages = toArr(doc.language).flatMap((x) => splitList(x));
  }
  if (doc.immunity != null) f.immunities = toArr(doc.immunity).flatMap((x) => splitList(x));
  if (typeof doc.weakness_markdown === 'string' && doc.weakness_markdown.trim()) f.weaknesses = parseResWeak(doc.weakness_markdown);
  if (typeof doc.resistance_markdown === 'string' && doc.resistance_markdown.trim()) f.resistances = parseResWeak(doc.resistance_markdown);
  if (doc.item != null) f.items = toArr(doc.item).flatMap((x) => splitList(x));
  if (doc.spell_dc != null) f.spellDC = toArr(doc.spell_dc).map(num);
  if (doc.spell_attack_bonus != null) f.spellAttack = toArr(doc.spell_attack_bonus).map(num);
  if (doc.attack_bonus != null) f.attackBonuses = toArr(doc.attack_bonus).map(num);
  if (Array.isArray(doc.creature_ability)) f.abilityNames = doc.creature_ability.map((x) => String(x).trim()).filter(Boolean);
  if (doc.hardness != null) f.hardness = numOrUndef(doc.hardness);
  f.hpRaw = doc.hp_raw;
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

export function hazardFacets(doc) {
  const f = {};
  f.level = numOrUndef(doc.level);
  if (doc.complexity) f.complexity = String(doc.complexity);
  if (doc.stealth != null) {
    f.stealthText = clean1(untemplate(doc.stealth));
    const m = f.stealthText.match(/^(DC\s*)?([+\-–−]?\s*\d+)/i);
    if (m) {
      const n = num(m[2].replace(/[–−]/, '-').replace(/\s+/g, ''));
      f.stealth = m[1] ? { dc: n } : { bonus: n };
    }
  }
  if (doc.disable != null) f.disable = clean1(untemplate(doc.disable));
  if (doc.reset != null) f.reset = clean1(untemplate(doc.reset));
  f.hardness = numOrUndef(doc.hardness);
  f.hp = numOrUndef(doc.hp);
  f.ac = numOrUndef(doc.ac);
  f.fort = numOrUndef(doc.fortitude_save);
  f.ref = numOrUndef(doc.reflex_save);
  f.will = numOrUndef(doc.will_save);
  if (doc.immunity != null) f.immunities = toArr(doc.immunity).flatMap((x) => splitList(x));
  if (typeof doc.weakness_markdown === 'string' && doc.weakness_markdown.trim()) f.weaknesses = parseResWeak(doc.weakness_markdown);
  if (typeof doc.resistance_markdown === 'string' && doc.resistance_markdown.trim()) f.resistances = parseResWeak(doc.resistance_markdown);
  if (Array.isArray(doc.trait)) f.traits = doc.trait.map(String);
  f.hpRaw = doc.hp_raw;
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}
