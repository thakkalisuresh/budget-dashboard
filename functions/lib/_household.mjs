/**
 * Household primary: the one person whose Telegram chat receives every wallet
 * prompt (category asks, split asks, duplicate notes), regardless of whose
 * card was charged.
 *
 * Source, in order: HOUSEHOLD_PRIMARY_EMAIL env (override / tests), then the
 * Firestore doc config/household.primaryEmail. The repo is public, so the
 * address is never committed; the Firestore path also needs no redeploy.
 * Returns '' when neither is set or the read fails — callers then keep the
 * old per-request-email routing, so an unset value changes nothing.
 */
import { getDb } from './firestore.mjs';
import { resolveTelegramChatId } from './_telegram.mjs';

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { value, at }

export function resetHouseholdCache() { cache = null; }

export async function getPrimaryEmail() {
  const fromEnv = (process.env.HOUSEHOLD_PRIMARY_EMAIL || '').trim();
  if (fromEnv) return fromEnv;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const snap = await getDb().collection('config').doc('household').get();
    const value = snap.exists ? String(snap.data()?.primaryEmail || '').trim() : '';
    cache = { value, at: Date.now() };
    return value;
  } catch (e) {
    // Not cached: retry next time. Never blocks the write.
    console.warn('household: primary email lookup failed (using request email):', e.message);
    return '';
  }
}

/** Chat id for wallet prompts: the household primary's, else the requester's. */
export async function resolvePromptChatId(email) {
  const primary = await getPrimaryEmail();
  if (primary) {
    const id = resolveTelegramChatId(primary);
    if (id) return id;
    console.warn(`HOUSEHOLD_PRIMARY_EMAIL ${primary} has no TELEGRAM_EMAIL_MAP entry; using chat for ${email}.`);
  } else {
    console.warn('HOUSEHOLD_PRIMARY_EMAIL / config/household not set; prompting the requesting email\'s chat.');
  }
  return resolveTelegramChatId(email);
}
