import { getCustomCategories } from './customCategories.js';

const SHEET_ID = import.meta.env.VITE_SHEET_ID;
const API_KEY = import.meta.env.VITE_SHEETS_API_KEY;

export const BUILT_IN_SHEET_MAP = {
  'Grocery':       { sheet: 'Grocery',                    descCol: 2, amtCol: 3 },
  'Misc':          { sheet: 'Misc',                       descCol: 2, amtCol: 3 },
  'Eating Out':    { sheet: 'Eating Out',                  descCol: 2, amtCol: 3 },
  'Travel':        { sheet: 'Travel',                     descCol: 2, amtCol: 3 },
  'Entertainment': { sheet: 'Entertainment',              descCol: 2, amtCol: 3 },
  'Thakkali':      { sheet: 'Thakkali',                   descCol: 2, amtCol: 3 },
  'Investment':    { sheet: 'Investment',                 descCol: 2, amtCol: 3 },
  'Car Payments':  { sheet: 'Car Payments',               descCol: 2, amtCol: 3 },
  'Utilities':     { sheet: 'Utilities',                  descCol: 2, amtCol: 3 },
  'Utilties':      { sheet: 'Utilities',                  descCol: 2, amtCol: 3 },
  'Rent':          { sheet: 'Rent',                       descCol: 2, amtCol: 3 },
  'Health':        { sheet: 'Health',                     descCol: 2, amtCol: 3 },
  'Moving Exp':    { sheet: 'Moving Expenses+Furniture',  descCol: 2, amtCol: 3 },
  'Furniture':     { sheet: 'Moving Expenses+Furniture',  descCol: 10, amtCol: 11 },
  'Holiday':       { sheet: 'Holiday',                    descCol: 2, amtCol: 3 },
  'Wi-Fi':         { sheet: 'Wi-Fi',                      descCol: 2, amtCol: 3 },
};

function getEffectiveSheetMap() {
  return { ...BUILT_IN_SHEET_MAP, ...getCustomCategories() };
}

export const hasDetail = (name) => !!getEffectiveSheetMap()[name];

export async function fetchDetail(name) {
  const config = getEffectiveSheetMap()[name];
  if (!config) return [];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(config.sheet)}?key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { values = [] } = await res.json();

  return values.slice(1).reduce((acc, row) => {
    const desc = row[config.descCol];
    const rawAmt = row[config.amtCol];
    if (!desc || desc.trim() === '' || !rawAmt) return acc;
    const amt = parseFloat(String(rawAmt).replace(/[$,]/g, ''));
    if (!amt || amt <= 0) return acc;
    acc.push({ description: desc, amount: amt });
    return acc;
  }, []);
}
