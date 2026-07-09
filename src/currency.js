// ════════════════════════════════════════════════════════════════════════════
// currency.js — the list of currencies the app supports, plus a symbol lookup.
// Kept as plain data so Settings can show a dropdown, and the rest of the app can
// turn a currency code (like "USD") into the right symbol to show before amounts.
// ════════════════════════════════════════════════════════════════════════════

// Each entry has: the ISO code, the symbol shown before amounts, a human-readable
// label for the dropdown, and a flag emoji for a quick visual cue.
export const CURRENCIES = [
  { code: 'USD', symbol: '$',    label: 'US Dollar',          flag: '🇺🇸' },
  { code: 'EUR', symbol: '€',    label: 'Euro',               flag: '🇪🇺' },
  { code: 'GBP', symbol: '£',    label: 'British Pound',      flag: '🇬🇧' },
  { code: 'INR', symbol: '₹',    label: 'Indian Rupee',       flag: '🇮🇳' },
  { code: 'CAD', symbol: 'CA$',  label: 'Canadian Dollar',    flag: '🇨🇦' },
  { code: 'AUD', symbol: 'A$',   label: 'Australian Dollar',  flag: '🇦🇺' },
  { code: 'SGD', symbol: 'S$',   label: 'Singapore Dollar',   flag: '🇸🇬' },
  { code: 'AED', symbol: 'د.إ',  label: 'UAE Dirham',         flag: '🇦🇪' },
  { code: 'JPY', symbol: '¥',    label: 'Japanese Yen',       flag: '🇯🇵' },
  { code: 'CNY', symbol: '¥',    label: 'Chinese Yuan',       flag: '🇨🇳' },
  { code: 'CHF', symbol: 'Fr',   label: 'Swiss Franc',        flag: '🇨🇭' },
  { code: 'HKD', symbol: 'HK$',  label: 'Hong Kong Dollar',   flag: '🇭🇰' },
  { code: 'KRW', symbol: '₩',    label: 'South Korean Won',   flag: '🇰🇷' },
  { code: 'MYR', symbol: 'RM',   label: 'Malaysian Ringgit',  flag: '🇲🇾' },
  { code: 'NZD', symbol: 'NZ$',  label: 'New Zealand Dollar', flag: '🇳🇿' },
  { code: 'BRL', symbol: 'R$',   label: 'Brazilian Real',     flag: '🇧🇷' },
  { code: 'MXN', symbol: 'MX$',  label: 'Mexican Peso',       flag: '🇲🇽' },
  { code: 'ZAR', symbol: 'R',    label: 'South African Rand', flag: '🇿🇦' },
  { code: 'SEK', symbol: 'kr',   label: 'Swedish Krona',      flag: '🇸🇪' },
  { code: 'NOK', symbol: 'kr',   label: 'Norwegian Krone',    flag: '🇳🇴' },
];

// Turn a currency code into its symbol. `.find` returns the matching entry (or
// undefined); `?.symbol` reads .symbol only if one was found; and `?? '$'` falls
// back to the dollar sign when the code is unknown.
export function getCurrencySymbol(code) {
  return CURRENCIES.find(c => c.code === code)?.symbol ?? '$';
}
