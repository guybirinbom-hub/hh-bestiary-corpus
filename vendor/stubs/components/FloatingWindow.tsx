// Stub for tracker/src/components/FloatingWindow.tsx (Heroes-Heaven 41c2b05).
//
// The real module imports CombatantDetail (which imports StatBlock: a cycle), GmWidgets, the dock and
// layout stores and dataStore, and touches document / navigator.clipboard / fetch in handlers. StatBlock,
// TagRenderer and GlossaryTerm only mount PopupPreview inside a Tooltip's hover content, which a static
// render never opens, so rendering nothing here changes no heading and no text of the stat block.
// SpellTooltip is re-exported by TagRenderer and never rendered by StatBlock.
export function PopupPreview(_props: Record<string, unknown>): null { return null }
export function SpellTooltip(_props: Record<string, unknown>): null { return null }
