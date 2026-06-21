// ════════════════════════════════════════════════════════════════════════════
// customCategories.js — store categories the USER creates, in their browser.
// The app ships with a fixed set of built-in categories (SHEET_MAP). When a user
// adds their own, we save it to localStorage — a small key/value store the
// browser keeps even after the page reloads — so their categories persist
// without anyone editing source code.
// ════════════════════════════════════════════════════════════════════════════

// The single localStorage key under which we keep the whole custom-category map.
const KEY = 'budget_custom_categories';

// Read all custom categories back as an object, e.g. { "Gym": { sheet, ... } }.
export function getCustomCategories() {
  try {
    // localStorage only stores strings, so JSON.parse turns it back into an
    // object. The `|| '{}'` provides an empty object the first time (nothing saved yet).
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { return {}; }   // if the stored text is somehow corrupt, fall back to empty
}

// Add a new category by name, with default column positions describing where its
// description / amount / UUID columns live in the spreadsheet.
export function addCustomCategory(name) {
  const cats = getCustomCategories();              // load what's already saved
  cats[name] = { sheet: name, descCol: 2, amtCol: 3, uuidStartCol: 4 };
  localStorage.setItem(KEY, JSON.stringify(cats)); // save back (object → string)
}

// Remove a category by name.
export function removeCustomCategory(name) {
  const cats = getCustomCategories();
  delete cats[name];                               // drop that one key
  localStorage.setItem(KEY, JSON.stringify(cats));
}

// "Upsert" = UPdate if it exists, inSERT if it doesn't. Lets a caller overwrite a
// category's entire config object in a single call.
export function upsertCustomCategory(name, config) {
  const cats = getCustomCategories();
  cats[name] = config;
  localStorage.setItem(KEY, JSON.stringify(cats));
}
