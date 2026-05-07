import { getCustomCategories } from './customCategories.js';

const SHEET_ID = import.meta.env.VITE_SHEET_ID;

export const BUILT_IN_SHEET_MAP = {
  'Grocery':       { sheet: 'Grocery',                    descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Misc':          { sheet: 'Misc',                       descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Eating Out':    { sheet: 'Eating Out',                 descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Travel':        { sheet: 'Travel',                     descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Entertainment': { sheet: 'Entertainment',              descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Thakkali':      { sheet: 'Thakkali',                   descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Investment':    { sheet: 'Investment',                 descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Car Payments':  { sheet: 'Car Payments',               descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Utilities':     { sheet: 'Utilities',                  descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Utilties':      { sheet: 'Utilities',                  descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Rent':          { sheet: 'Rent',                       descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Health':        { sheet: 'Health',                     descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Moving Exp':    { sheet: 'Moving Expenses+Furniture',  descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Furniture':     { sheet: 'Moving Expenses+Furniture',  descCol: 10, amtCol: 11, uuidStartCol: 12 },
  'Holiday':       { sheet: 'Holiday',                    descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Wi-Fi':         { sheet: 'Wi-Fi',                      descCol: 2, amtCol: 3,  uuidStartCol: 4  },
};

function getEffectiveSheetMap() {
  return { ...BUILT_IN_SHEET_MAP, ...getCustomCategories() };
}

export const hasDetail = (name) => !!getEffectiveSheetMap()[name];

export async function fetchDetail(name, overrideSheetId) {
  const config = getEffectiveSheetMap()[name];
  if (!config) return [];

  const id  = overrideSheetId || SHEET_ID;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(config.sheet)}`;
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
