# Corpus design

Goal: every creature and hazard on the Archives of Nethys, in the Heroes Heaven tracker's record shape,
with every number verified two ways and every unplaced piece of text reported. The live Archives is the
only source. Nothing is invented: a value the page does not print stays absent and is reported.

## Pipeline (`npm run build` = `scripts/build.mjs`, each stage its own script)

| stage | script | reads | writes |
|---|---|---|---|
| 1 fetch | `scripts/fetch-aon.mjs` | elasticsearch.aonprd.com | `cache/aon/{creature,hazard}.jsonl` (gitignored) |
| 2 records | `scripts/build-records.mjs` | cache | `data/bestiary/*.json`, `data/hazards.json`, `data/index.json`, `report/agreement.json`, `report/unparsed.json`, `report/coverage.json` |
| 3 render | `scripts/render.mjs` | data + vendored StatBlock | `report/render.json` |
| 4 sample | `scripts/sample.mjs` | data + cache | `SAMPLE.md` |
| 5 status | `scripts/status.mjs` | reports | `STATUS.md` (only when every gate is green; otherwise it exits 1 and says which gate) |

All scripts are plain Node ESM (`.mjs`), no build step, no TypeScript outside `vendor/`.

## The two reads of a creature

**Read 1, structured:** the facets the Archives document carries: `level, hp, hp_raw, ac, fortitude_save,
reflex_save, will_save, perception, strength…charisma, size, rarity, creature_family, trait,
skill_mod, skill_markdown, speed, speed_raw, sense_markdown, language_markdown, immunity,
weakness_markdown, resistance_markdown, item, spell_dc, spell_attack_bonus, attack_bonus, creature_ability,
hardness`. These are read by `scripts/lib/facets.mjs` into a flat object with the same vocabulary the
text read uses, so the two can be compared key by key.

**Read 2, page text:** `markdown` parsed by `scripts/lib/parse-creature.mjs` with a real grammar, not a
line-by-line fold:

1. `flavor` = everything before `<title level="2">`, minus the Recall Knowledge sidebar (kept separately
   as `recall: {type, skills, dc, unspecificLoreDc, specificLoreDc}` and compared with nothing, because
   no facet carries it).
2. The stat block after `<title level="2" right="Creature N">` is split on `---` lines into exactly three
   sections, **top / mid / bot**. A block with another count is an unparsed row (`heading: "---"`).
3. Each section is a sequence of *entries*. An entry starts on a line whose first token is a bold label
   (`**Label**`, `**[Label](url)**`, `[**Label**](url)`, `**[**Label**](url)**`, `**[Label](url) (suffix)**`,
   or `**[Label](url) <actions…/>` with the closing `**` missing) and runs until the next entry start.
   The label decides the entry kind:
   - **top**: `Source`, `Perception`, `Languages`, `Skills`, `Str`…`Cha` (one row), `Items`; anything else
     is a top ability.
   - **mid**: `AC` (with `Fort/Ref/Will` on the same row and an optional trailing note), `HP` (with an
     optional note and additional pools), `Hardness`, `Immunities`, `Resistances`, `Weaknesses`;
     anything else is a mid ability.
   - **bot**: `Speed`, `Melee`/`Ranged` strikes, spellcasting headers (`… Spells`, `… Cantrips`,
     `Spells`, `Focus Spells`, `… Rituals`, `Rituals`), `Signature Spells`; anything else is a bot ability.
   - An ability header may be unbolded Title Case only when the line is immediately followed by an
     `<actions>` tag or a `(trait)` list, and the name is in the document's `creature_ability` facet.
     After a line break or a list inside another ability, an unbolded header is also read when it is a
     MonsterAbilities link, Title Case words before a cost tag or trait list (a stray `**` allowed), a
     facet name, or Title Case words before a sentence about the creature ("Whisker Sense A leopard seal
     can…"); after a full stop inside a line, Title Case words before a cost tag or such a sentence start
     a header too ("…rolls initiative. Violent Deluge <actions…/>"). Otherwise the line is prose of the
     previous entry.
   - `<aside>…</aside>` blocks are lifted out first and appended to `flavor` as sidebars; `<table>`
     blocks are converted to pipe tables and attached to the entry they sit in.
4. An ability entry: `name`, `activity` (from the first `<actions string>` tag; a second tag on the header
   line is an unparsed row), `traits` (leading parenthesis after the header, comma split, links
   unwrapped), `trigger` (text after `**Trigger**` to the first `;` or `**Effect**`), and `entries: [body]`
   where the body keeps `**Label**` clauses (`Trigger, Requirements, Frequency, Effect, Critical Success,
   Success, Failure, Critical Failure, Saving Throw, Onset, Maximum Duration, Stage N`) each on its own
   line as `Label text`, exactly as the old records did, so the app's `AbilityText` still styles them.
   HTML never reaches a record: `<actions string="X" />` inside a body becomes the glyph (◆ ◆◆ ◆◆◆ ↺ ◇),
   `<sup>`, `<b>`, `<i>`, `<br>` are unwrapped. A tag the cleaner does not know is an unparsed row.
5. A strike: `range`, `activity`, `name`, `attack` (first bonus), `traits` (all items of the trailing
   parenthesis, linked or not), `damage` (everything after `**Damage**`, links unwrapped, riders such as
   `plus Grab` kept in the string; `types` and `effects` stay `[]` because the app renders both from
   `damage`). A strike with no bonus or no name is an unparsed row, never a guessed record.
6. A spell block: `name`, `tradition` (any of arcane/divine/occult/primal appearing in the name),
   `type` (Innate/Prepared/Spontaneous/Focus/Cantrips from the name, else `Innate`), `DC`, `attack`,
   `focusPoints`, `entry` keyed `"0"`, `"N"`, `"constant-N"`. Ranks may be bullets or inline
   (`; **1st** …`); a rank's spells may span several lines until the next rank or entry. Spell links
   may point at Spells, Rituals or Mythic pages; an unlinked spell name is kept as a name. A repeated
   rank key is an unparsed row, not an overwrite.
7. Rituals: `dc`, `casts[{rank, level, names}]`; a ritual header followed by prose instead of ranks is
   an ability.
8. **Anything the grammar cannot place** (a bold label no rule claims, a stray line between entries,
   a strike without a bonus, a second `<actions>` tag, an unknown HTML tag, a fourth section) is a row
   in `report/unparsed.json`: `{id, name, section, heading, line, reason}`. Rows are grouped by
   `reason` so each survivor can be explained once.

## Agreement (`scripts/lib/agreement.mjs`)

For every key both reads produce, compare and write a row when they differ:
`{id, name, field, structured, text}`. Keys: `level, hp, ac, fort, ref, will, perception, str, dex, con,
int, wis, cha, size, rarity, traits, skills (per skill), speeds (per mode), senses, languages, immunities,
weaknesses (per entry), resistances (per entry), items, spellDC, spellAttack, attackBonuses (the list),
abilityNames (facet creature_ability vs parsed names, order-insensitive), hardness`. Comparison is on
normalised values (case, whitespace, link text). A field present in only one read is not a disagreement;
it is counted in `report/coverage.json` under `onlyStructured` / `onlyText`.

Which value goes into the record when they disagree: **the page text**, because that is what the printed
stat block says and what the app must render; the structured value sits in the report beside it.

## Index dedup

Shard files and `hazards.json` keep every copy. `index.json` keeps one row per name:
1. A legacy document whose `remaster_id` names a document in the corpus is dropped in favour of the
   remaster twin (newest printing wins where the Archives link one). Legacy-only creatures stay.
2. Remaining same-name collisions are resolved by the app's source-priority table, copied verbatim
   from `scripts/build-bestiary.mjs` in Heroes-Heaven at commit 41c2b05, including its tie-break.
Both steps are counted in `report/coverage.json`.

## Hazards

Read 1: `level, complexity, stealth, disable, hardness, hp, ac, fortitude_save, reflex_save, will_save,
immunity, weakness_markdown, resistance_markdown, reset, trait`. Read 2: the same grammar over the hazard
page (`Complexity`, description prose, `Stealth`, `Disable`, AC/saves, Hardness/HP/BT, IWR, actions,
`Routine`, `Reset`). The record fills the app's structured hazard fields (`stealth {dc|bonus, minProf}`,
`disable.entries`, `routine`, `reset`, `complex`, `defenses.bt`, `actions` as Ability objects) AND keeps
`description[0]` as the flattened page text, because the tracker's adapter parses hazard strikes from
that text only. That adapter limitation is recorded in `report/render.json`, not patched in the data.

## Render check (`scripts/render.mjs`)

`vendor/` holds `tracker/src/components/StatBlock.tsx`, the adapter `utils/parseCreature.ts`,
`utils/parseHazardText.ts` and every pure module they import, copied from Heroes-Heaven at the commit
recorded in `vendor/PIN` (`41c2b05733f19e69b4a366a178a8c9d76718d4c7`; StatBlock last changed in
`97c0cf5`). They are compiled with esbuild and rendered by react-dom/server into jsdom with the settings
store reset to defaults, `hideHP={false}`, `hideTraits={false}`, no `edit`, and a `ResizeObserver` stub.

Expected headings come from the page markdown (the entry labels of the grammar, in page order). Rendered
headings come from the DOM (`.stat-label` texts, `.stat-bar` titles, `.def-box-label` texts, attack and
ability names). Every difference is a row `{id, name, heading, expected, rendered, json, verdict}` where
`verdict` is `parse` (the JSON lacks it), `render` (the JSON has it, the component did not show it),
`adapter` (the app's parseCreature/parseHazard dropped it before the component), `order` or `merged`.
Known renderer facts from the contract read: hazard AC is never rendered; the adapter drops
`languages.abilities` and creature `hardness`; ability top/mid/bot order is flattened; Recall Knowledge is
computed when absent. These are reported as `render`/`adapter`, never hidden by changing the data.

## Serialization

`JSON.stringify` with no indentation and no trailing newline, UTF-8, raw non-ASCII, key order as the app
files: creature `name, source, page?, level, traits, perception, perceptionNote?, senses, languages,
skills, abilityMods, items, speed, speedNote?, attacks, spellcasting, rituals?, abilities, defenses,
flavor?, family?, _aon`; hazard `name, source, page?, level, traits, stealth?, description, disable,
routine, reset, complex, defenses, actions, _aon`; index rows as in the app. `_aon.markdown` keeps the raw
page byte for byte.
