// ════════════════════════════════════════════════════════════════════════════
// useExpense.js — a tiny "re-export" (a.k.a. barrel) file.
// It adds no logic of its own; it just forwards `addOrUpdateExpense` from
// sheetsApi so other files can import it from this stable, intention-revealing
// path. If the real implementation ever moves, callers importing from here don't
// have to change. (Note: despite the `use` name, this isn't a React hook.)
// ════════════════════════════════════════════════════════════════════════════
export { addOrUpdateExpense } from './sheetsApi.js';
