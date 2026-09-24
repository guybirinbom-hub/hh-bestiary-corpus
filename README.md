# Heroes Heaven bestiary corpus

Every creature and hazard stat block on the [Archives of Nethys](https://2e.aonprd.com), fetched from the
Archives' public search endpoint and written in the exact record shape the Heroes Heaven initiative
tracker reads (`data/bestiary/*.json` per source book, `data/hazards.json`, `data/index.json`).

The live Archives is the only source. Every record is read twice, once from the structured fields the
document carries and once from the page text, and every disagreement is reported rather than resolved
by guessing. `report/` holds the agreement, unparsed, coverage and render reports; `SAMPLE.md` shows
fifty creatures rendered from the corpus beside the wording of their Archives page; `STATUS.md` holds the
numbers of the last complete build.

    npm run build     # fetch (cached), parse, verify, render, report — everything from a clean checkout

## License notice

Game rules content is from Pathfinder Second Edition (Remaster) by [Paizo Inc.](https://paizo.com), used
under the ORC License. This is an unofficial, fan-made tool and is not affiliated with or endorsed by
Paizo.
