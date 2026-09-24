# What the app itself gets wrong (measured, not fixed here)

These are the rows in `report/render.json` whose verdict is `adapter`, `render` or `order`. The corpus
data is correct on each of them; the loss happens inside Heroes-Heaven (`tracker/src/utils/parseCreature.ts`
or `tracker/src/components/StatBlock.tsx` at commit 41c2b05). The data is not bent to hide them.

| where | what | records | fix in the app |
|---|---|---|---|
| adapter | ability placement: `abilities.top/mid/bot` are flattened into one list, so top and mid abilities render after Attacks and Spellcasting instead of where the page prints them | 3,608 | keep the three slots in `Creature` and render top after Items, mid after HP/IWR, bot after strikes |
| adapter | `languages.abilities` (telepathy, truespeech, …) is dropped | 1,049 | append them to the Languages line after `;` |
| adapter | constant spells: the adapter reads only a nested `entry.constant`; the old builder wrote `constant-N` keys, so constant spells never rendered. The corpus writes the nested shape the adapter reads | 595 (now render) | none needed with this corpus; the old data needs regenerating |
| adapter | creature `defenses.hardness` is dropped | 54 | carry it as for hazards |
| adapter | only `defenses.hp[0]` is kept, so second HP pools (body/head, components) vanish | 20+ | render every pool |
| adapter | hazard strikes have no structured field; the adapter regex-parses them from `description[0]` and misses those printed after a line break | 97 of 140 hazards with a strike | add `attacks` to `RawHazard` and read it |
| render | hazard AC is never drawn (`StatBlock.tsx` L1181 pushes AC only for creatures) | 315 | drop the `!isHazard` guard |
| render | hazard saves: all three are shown once any is non-zero, so a save the page does not print shows as +0 | 291 | show only saves present on the record |
| render | Recall Knowledge is computed and shown when the page prints none | 47 | show only when the record has one |
| render | spell block `type` decides whether the focus pool shows; class-named blocks (Bloodline, Domain, Composition, …) must be `Focus`. The corpus sets it; the old data had `Innate` | 33 | none needed with this corpus |
| order | Speed is drawn inside the Defense strip, before HP and IWR; the page prints it at the start of the bottom section | 4,783 | move Speed after the defences, or accept as a layout choice |
| order | hazard Stealth is drawn before the description; the page prints it after | 661 | swap, or accept |
| order | Hardness is drawn in the Defense strip before HP | 246 | accept, or draw with HP |

Everything else the page prints is on the record, or is a row in `report/unparsed.json` with a reason.
