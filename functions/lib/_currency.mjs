/**
 * Currency conversion via open.er-api.com.
 * Returns USD amount + the rate used so users see the conversion details.
 * Files in lib/ are shared modules, not standalone deployed functions.
 */

const RATES_URL    = 'https://open.er-api.com/v6/latest/USD';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;

async function loadRates() {
  if (cache && cache.expiresAt > Date.now()) {
    return cache;
  }
  const res = await fetch(RATES_URL);
  if (!res.ok) throw new Error(`Currency API failed: ${res.status}`);
  const data = await res.json();
  if (!data.rates) throw new Error('Invalid currency API response');
  cache = {
    rates: data.rates,
    // open.er-api reports when the rates were last refreshed upstream.
    updatedAt: new Date(data.time_last_update_unix ? data.time_last_update_unix * 1000 : Date.now()).toISOString(),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return cache;
}

async function fetchRates() {
  return (await loadRates()).rates;
}

/** Units of `currency` per 1 USD, plus when the rate was last updated (ISO). */
export async function getRate(currency) {
  const code = String(currency || '').toUpperCase();
  const { rates, updatedAt } = await loadRates();
  const rate = rates[code];
  if (!rate || rate <= 0) throw new Error(`Unknown currency: ${code}`);
  return { rate, updatedAt };
}

export function _resetRatesCache() { cache = null; }

export async function convertToUSD(amount, fromCurrency) {
  const currency = (fromCurrency || 'USD').toUpperCase();
  if (currency === 'USD') {
    return { amount, rate: 1, original: amount, originalCurrency: 'USD' };
  }

  const rates = await fetchRates();
  const rate = rates[currency];
  if (!rate || rate <= 0) throw new Error(`Unknown currency: ${currency}`);

  const usdAmount = amount / rate;
  return {
    amount: Math.round(usdAmount * 100) / 100,
    rate,
    original: amount,
    originalCurrency: currency,
  };
}
