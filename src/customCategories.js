// Persists user-created categories to localStorage so SHEET_MAP stays in sync
// across sessions without touching the source code.

const KEY = 'budget_custom_categories';

export function getCustomCategories() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { return {}; }
}

export function addCustomCategory(name) {
  const cats = getCustomCategories();
  cats[name] = { sheet: name, descCol: 2, amtCol: 3, uuidStartCol: 4 };
  localStorage.setItem(KEY, JSON.stringify(cats));
}

export function removeCustomCategory(name) {
  const cats = getCustomCategories();
  delete cats[name];
  localStorage.setItem(KEY, JSON.stringify(cats));
}

export function upsertCustomCategory(name, config) {
  const cats = getCustomCategories();
  cats[name] = config;
  localStorage.setItem(KEY, JSON.stringify(cats));
}
