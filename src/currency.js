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

export function getCurrencySymbol(code) {
  return CURRENCIES.find(c => c.code === code)?.symbol ?? '$';
}
