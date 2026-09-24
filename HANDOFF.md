# Handoff to the Heroes Heaven main session

Read this first, then `STATUS.md`, `docs/APP-DEFECTS.md`, `docs/DESIGN.md`. Everything below was measured
on 2026-09-24 against Heroes-Heaven commit `41c2b05` (v0.1.40) and the live Archives.

## What this repository is

The complete, verified bestiary for the tracker: 4,791 creatures and 663 hazards, every one on the
Archives of Nethys, in the exact record shape `tracker/src/utils/parseCreature.ts` reads. It replaces
`public/data/bestiary/*.json`, `public/data/hazards.json` and `public/data/index.json`, which were built
from an export on the owner's PC by `scripts/build-bestiary.mjs`, a parser that folded every line it could
not place into the previous ability (the `---` separator sits inside 24% of the shipped abilities; immunity
lists are glued into ability bodies on 1,520 records; constant spells were written under a key the app
never reads, so they never rendered).

`npm install && npm run build` regenerates everything from the live Archives in about 90 seconds. A fresh
clone reproduces the committed files byte for byte.

## What is verified, and how

- Every record was read twice, from the Archives' structured fields and from the page text; the 359
  disagreements are in `report/agreement.json`, each with a rule-assigned reason, all of them errors in
  the Archives' own facets. The record holds the page value.
- 100 records were compared by hand against their pages in two adversarial rounds: zero wrong numbers.
- Every record was rendered through a pinned copy of `StatBlock.tsx` in jsdom (`vendor/`, sha1-checked by
  `npm run vendor:verify`) and compared heading by heading with the page: `report/render.json`.
- Every piece of page text with no field in the record shape is a row in `report/unparsed.json` with a
  reason (415 rows; the biggest groups are hazard stealth notes and hazard strikes, see below).

## How to bring it into the app (do this on a branch)

1. Copy `data/bestiary/*.json`, `data/hazards.json`, `data/index.json` over `public/data/…`.
   Delete the old shard files first; the file set is the same 147 names but do not assume it.
2. `scripts/bestiary-fields-check.mjs` will fail on **orphan shards**: nine shard files (Core Rulebook,
   Dark Archive, Pathfinder #187–189, #196–199) are named by no index row because every creature in them
   has a linked remaster twin that wins the index. The records stay in the shards (the corpus keeps every
   printing). Either relax that check to accept a shard whose every record has a `remaster_id` twin in the
   index, or add the legacy rows back to the index. This is the owner's call; the corpus took the rule
   "newest printing wins where the Archives link a remaster, legacy-only creatures stay".
3. Retire `scripts/build-bestiary.mjs`, `scripts/lib/creature-markdown.mjs` and
   `scripts/check-creature-parse.mjs`, or point them at this repository's `data/`. Running the old builder
   again over an export will overwrite the verified files with the old parser's output.
4. Apply the app fixes in `docs/APP-DEFECTS.md`. Two of them are cured by the data alone (constant spells,
   focus-point pools on class spell blocks). The rest are edits in `parseCreature.ts` and `StatBlock.tsx`:
   keep `abilities.top/mid/bot` instead of flattening, keep `languages.abilities`, keep creature
   `hardness`, render every HP pool not only `hp[0]`, draw hazard AC, show only the saves a hazard prints,
   stop computing Recall Knowledge when the record has none.
5. After each fix, rerun `npm run render` here with `--data <path to public/data>` and watch the
   `adapter` and `render` counts in `report/render.json` drop. That is the regression test for the
   tracker's stat block from now on.

## Conventions the data follows (do not "fix" these)

- Spellcasting ranks: `entry["0"]` cantrips (level = heighten rank), `entry["N"]`, and constant spells
  nested under `entry.constant["N"]` because that is what the adapter reads.
- Hazards: `description[0]` is the flattened page text on purpose, because `parseHazard` regex-parses
  hazard strikes from it and `RawHazard` has no `attacks` field. The structured fields (`stealth`,
  `disable.entries`, `routine`, `reset`, `complex`, `defenses.bt`, `actions`) are also filled and win in
  the adapter's merge. A hazard with several components has one HP pool per component, named, with the
  component's BT in the pool name; its other defences are unparsed rows, not invented fields.
- Ability bodies keep clause labels as plain lines (`Trigger …`, `Effect …`, `Critical Success …`) with no
  markup; `AbilityText` styles them. Action costs inside a body are the glyphs ◆ ◆◆ ◆◆◆ ↺ ◇.
- `flavor` is absent on 147 creatures whose page prints only the Archives' "no description" placeholder,
  and is never borrowed from a twin. Sidebars (`<aside>`) are appended to `flavor`.
- Index dedup: remaster-link rule first, then the app's source-priority table copied verbatim.
- `_aon.markdown` is the raw page, byte for byte; it is the only field allowed to contain markup.

## Things nobody should redo

- Do not rerun the 100-record hand verification to trust the data; rerun `npm run check` and
  `npm run render` instead, they are the gates.
- Do not extend the render oracle (`scripts/lib/page-headings.mjs`) to make rows disappear. Round 2 of the
  verification caught it accepting 16 real losses; it now refuses to accept a heading the Archives'
  `creature_ability` facet lists or that carries a cost or trait list.
- Do not add `types`/`effects` to strikes; the app renders both from the `damage` string and would
  duplicate them.

## Licence

Content is Pathfinder Second Edition by Paizo Inc., used under the ORC License; unofficial, not endorsed
by Paizo. The notice lives in `README.md` and must travel with the data.
