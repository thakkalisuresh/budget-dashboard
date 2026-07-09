/**
 * Currency conversion via open.er-api.com.
 * Returns USD amount + the rate used so users see the conversion details.
 * Files in lib/ are shared modules, not standalone deployed functions.
 */

const RATES_URL    = 'https://open.er-api.com/v6/latest/USD';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;

async function fetchRates() {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.rates;
  }
  const res = await fetch(RATES_URL);
  if (!res.ok) throw new Error(`Currency API failed: ${res.status}`);
  const data = await res.json();
  if (!data.rates) throw new Error('Invalid currency API response');
  cache = {
    rates: data.rates,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return cache.rates;
}

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
