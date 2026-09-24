# Status

Last complete green build: 2026-09-24 (Archives fetched 2026-09-24T12:58:59.886Z).
Every gate below passed when this file was written; a build whose gates fail does not rewrite it.

## Coverage

| category | live on the Archives | in the corpus | match |
|---|---|---|---|
| creature | 4791 | 4791 | yes |
| hazard | 663 | 663 | yes |

Shard files: 147. Index rows: 4339 (3780 creatures, 559 hazards); 1055 legacy twins dropped where the Archives link a remaster, 60 same-name twins dropped by the app's source-priority rule. 9 shard files are named by no index row because every record in them is superseded by a linked remaster (listed in report/coverage.json).

## Agreement (structured fields vs page text)

359 disagreements, every one carrying a reason. The record holds the page-text value; the structured value sits beside it in report/agreement.json.

| reason | rows |
|---|---|
| facet-alias-trait | 77 |
| facet-omits-ability | 56 |
| facet-runon-label | 35 |
| facet-clause-label | 29 |
| facet-names-option | 26 |
| facet-special-movement | 25 |
| facet-key-or-number | 21 |
| facet-glued-rows | 16 |
| facet-template-residue | 14 |
| facet-conditional-speed | 11 |
| facet-spacing | 6 |
| facet-omits-item | 6 |
| facet-misread-speed | 5 |
| facet-dedups-values | 4 |
| facet-bold-fragment | 4 |
| facet-split-in-parens | 3 |
| page-variant-strike | 2 |
| facet-names-option + facet-runon-label | 2 |
| facet-clause-label + facet-omits-ability | 2 |
| facet-names-spell-block | 2 |
| section-trailing-paragraph | 2 |
| facet-names-option + facet-omits-ability | 1 |
| facet-names-legend | 1 |
| facet-bold-fragment + facet-omits-ability + facet-runon-label | 1 |
| facet-typo | 1 |
| facet-omits-strike | 1 |
| facet-names-option + facet-omits-ability + facet-runon-label | 1 |
| facet-omits-note | 1 |
| facet-truncated-at-break | 1 |
| facet-key-or-number + facet-omits-ability | 1 |
| facet-omits-action-glyph | 1 |
| component-defences-in-disable | 1 |

| field | rows |
|---|---|
| abilityNames | 196 |
| traits | 77 |
| speeds | 41 |
| weaknesses | 13 |
| immunities | 8 |
| attackBonuses | 7 |
| items | 7 |
| resistances | 3 |
| disable | 3 |
| languages | 2 |
| spellAttack | 1 |
| reset | 1 |

## Unparsed (page content with no home in the record shape)

415 rows, every one carrying a reason.

| reason | rows |
|---|---|
| stealth note with no field | 178 |
| hazard strike: no field in hazard shape; kept in description[0] which the app parses | 144 |
| hazard component defences: no field | 31 |
| strike without an attack bonus | 14 |
| hazard speed: no field | 11 |
| spell header text with no field | 8 |
| text in the ability-modifier row | 4 |
| ritual header text with no rank | 4 |
| activity in time units, no field | 4 |
| IWR row printed twice; the record merges both | 3 |
| strike without a name | 3 |
| trait qualifier with no field | 1 |
| repeated spell rank | 1 |
| spell legend line with no field | 1 |
| strike requirement with no field | 1 |
| text in a spell rank | 1 |
| HP pool without a number | 1 |
| paragraph after a stat row | 1 |
| spell block without ranks | 1 |
| ability header glued to the Immunities row; the page prints no body | 1 |
| stealth without a number | 1 |
| hazard component HP printed twice; the record keeps one pool | 1 |

## Render check (every record through the pinned StatBlock, 41c2b05733f19e69b4a366a178a8c9d76718d4c7)

5454 records rendered, 1 with no rows, 11418 rows. Page headings matched without a row: 58 option lines and 39 unbolded headers, each listed in report/render.json under `accepted`.

| verdict | rows | meaning |
|---|---|---|
| parse | 66 | the record lacks the heading (each row explained in its note) |
| merged | 0 | two page headings became one (each row explained in its note) |
| value | 0 | the heading matches but a value the page prints on it (action cost, Trigger, focus pool) is not on the record (each row explained in its note) |
| adapter | 4965 | the app's parseCreature/parseHazard dropped it before the component |
| render | 654 | the component did not show a value the adapter passed |
| order | 5733 | present, but not in the page's order |

The adapter, render and order rows are the app's own defects and are reported, not hidden by changing the data.
