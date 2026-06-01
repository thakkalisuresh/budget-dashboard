// Known vendors → MCC. Matched case-insensitively on normalized vendor string.
// More specific keys (e.g. 'ubereats') must appear before shorter prefixes ('uber')
// so the longer match wins. Unknown vendors fall back to CATEGORY_DEFAULT_MCC.
const VENDOR_MCC = {
  // Airlines
  'delta': '4511', 'united': '4511', 'american airlines': '4511',
  'southwest': '4511', 'emirates': '4511', 'british airways': '4511',
  'jetblue': '4511', 'alaska airlines': '4511',

  // Hotels
  'marriott': '7011', 'hilton': '7011', 'hyatt': '7011',
  'ihg': '7011', 'wyndham': '7011', 'airbnb': '7011', 'vrbo': '7011',

  // Chase Travel portal — catch-all for portal-booked travel
  'chase travel': 'CHASE_PORTAL',

  // Wholesale clubs / superstores — Amex 6% excluded, earns base 1%
  'costco': '5300', 'sams club': '5300', 'bjs': '5300',
  'walmart': '5310', 'target': '5310',

  // US supermarkets — Amex 6%
  'kroger': '5411', 'safeway': '5411', 'trader joes': '5411',
  'whole foods': '5411', 'publix': '5411', 'aldi': '5411',
  'heb': '5411', 'wegmans': '5411',

  // Streaming — Amex 6% (must precede any shorter keys that are substrings)
  'netflix': '7372', 'spotify': '7372', 'hulu': '7372',
  'disney plus': '7372', 'disney': '7372', 'apple tv': '7372',
  'youtube premium': '7372', 'amazon prime': '7372',
  'peacock': '7372', 'paramount': '7372', 'hbo': '7372',

  // Gas stations — Amex 3%
  'shell': '5541', 'chevron': '5541', 'bp': '5541',
  'exxon': '5541', 'mobil': '5541', 'citgo': '5541',
  'sunoco': '5541', 'texaco': '5541',

  // Food delivery (before shorter rideshare keys)
  'ubereats': '5812', 'doordash': '5812', 'grubhub': '5812',

  // Rideshare — Amex 3% (after ubereats)
  'uber': '4121', 'lyft': '4121', 'ola': '4121',

  // Pharmacies — CFU 3x
  'cvs': '5912', 'walgreens': '5912', 'rite aid': '5912',

  // Restaurants
  'starbucks': '5812', 'chipotle': '5812', 'zomato': '5812',
  'mcdonalds': '5814', 'subway': '5814', 'dominos': '5814',
};

// App category → MCC fallback when no vendor match is found.
// Entertainment = amusement/misc (NOT streaming); Wi-Fi = telecom (NOT streaming).
const CATEGORY_DEFAULT_MCC = {
  'Eating Out':    '5812',
  'Thakkali':      '5999',
  'Grocery':       '5411',
  'Travel':        '4511',
  'Holiday':       '7011',
  'Health':        '5912',
  'Entertainment': '7996',
  'Wi-Fi':         '4814',
  'Utilities':     '4900',
  'Rent':          '6513',
  'Investment':    '6211',
  'Car Payments':  '5511',
  'Furniture':     '5712',
  'Misc':          '5999',
};

export function resolveMCC(vendor, category) {
  const v = (vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, mcc] of Object.entries(VENDOR_MCC)) {
    if (v.includes(key.replace(/[^a-z0-9]/g, ''))) return mcc;
  }
  return CATEGORY_DEFAULT_MCC[category] || '5999';
}
