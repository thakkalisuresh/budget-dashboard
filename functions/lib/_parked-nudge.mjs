/**
 * Daily nudge for wallet charges parked in Telegram and never answered.
 *
 * A parked charge (`category_pending:` / `split_pending:`) is in no sheet until
 * someone taps, so one that goes unanswered is a missing expense. Each run
 * re-sends the prompt from the blob's own data to the chat in its key (the
 * CATFIX / SKIP handlers look blobs up by the tapper's chat id), and repeats
 * daily until resolved. It NEVER logs anything and never edits a blob's charge
 * fields, so a tap resolves through the unchanged original handlers.
 *
 * It deliberately does not go back through walletWebhook: the duplicate guard
 * would skip the re-post and the flow would be wrong.
 */
import { getDb } from './firestore.mjs';
import { createBotStore } from './bot-store.mjs';
import { sendMessage, kbCategoryConfirm } from './_telegram.mjs';
import { CATEGORIES } from './_extraction.mjs';
import { getUserSettingsByEmail } from './_sheets.mjs';
import { tgCategoryNudge, tgSplitNudge } from './_wallet-messages.mjs';

export const NUDGE_AFTER_MS = 12 * 60 * 60 * 1000;
export const GIVE_UP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NUDGES_PER_RUN = 8;
const HOUR = 60 * 60 * 1000;

const chatOf = (key) => key.split(':')[1];

async function loadBlobs(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const out = [];
  for (const { key } of blobs || []) {
    const blob = await store.get(key, { type: 'json' }).catch(() => null);
    if (blob) out.push({ key, chatId: chatOf(key), blob });
  }
  return out;
}

export async function runParkedNudge({ now = new Date(), primaryEmail = '', primaryChatId = '' } = {}) {
  const store = createBotStore(getDb());
  const [cats, splits] = await Promise.all([
    loadBlobs(store, 'category_pending:'),
    loadBlobs(store, 'split_pending:'),
  ]);

  const ageOf = (blob, key) => {
    const t = Date.parse(blob.createdAt);
    if (Number.isNaN(t)) { console.warn(`parked-nudge: ${key} has no readable createdAt; skipping`); return null; }
    return now.getTime() - t;
  };

  const gaveUp = [];
  const units = [];

  for (const it of cats) {
    const age = ageOf(it.blob, it.key);
    if (age == null) continue;
    if (age >= GIVE_UP_AFTER_MS) { if (!it.blob.giveUpNotedAt) gaveUp.push(it); continue; }
    if (age >= NUDGE_AFTER_MS) units.push({ kind: 'cat', age, ...it });
  }

  // Split: group per chat, keeping list() order — the SKIP handler acts on the
  // first key of the chat's prefix, so line 1 of the message must be that one,
  // whatever its age. Sent when at least one is due.
  const byChat = new Map();
  for (const it of splits) {
    if (!byChat.has(it.chatId)) byChat.set(it.chatId, []);
    byChat.get(it.chatId).push(it);
  }
  for (const [chatId, items] of byChat) {
    let oldestDue = null;
    const rows = [];
    for (const it of items) {
      const age = ageOf(it.blob, it.key);
      if (age == null) { rows.push(null); continue; }
      if (age >= GIVE_UP_AFTER_MS) { if (!it.blob.giveUpNotedAt) gaveUp.push(it); }
      else if (age >= NUDGE_AFTER_MS) oldestDue = Math.max(oldestDue ?? 0, age);
      rows.push({ vendor: it.blob.vendor, amount: it.blob.amount, category: it.blob.category || 'Misc', parkedHours: Math.floor(age / HOUR) });
    }
    if (oldestDue != null) units.push({ kind: 'split', age: oldestDue, chatId, items: rows.filter(Boolean) });
  }

  units.sort((a, b) => b.age - a.age); // oldest first

  const settingsCache = new Map();
  const categoriesFor = async (email) => {
    const key = (email || '').toLowerCase();
    if (settingsCache.has(key)) return settingsCache.get(key);
    let list = CATEGORIES;
    for (const e of [email, primaryEmail].filter(Boolean)) {
      try {
        const s = await getUserSettingsByEmail(e);
        list = [...CATEGORIES, ...(s?.customCategories || [])];
        break;
      } catch (err) {
        console.warn(`parked-nudge: settings lookup failed for ${e}:`, err?.message);
      }
    }
    settingsCache.set(key, list);
    return list;
  };

  let nudged = 0;
  let splitNudged = 0;
  const toSend = units.slice(0, MAX_NUDGES_PER_RUN);
  for (const u of toSend) {
    try {
      if (u.kind === 'cat') {
        const b = u.blob;
        const from = b.email && b.email.toLowerCase() !== primaryEmail.toLowerCase() ? b.email : '';
        await sendMessage(
          u.chatId,
          tgCategoryNudge({
            vendor: b.vendor, amount: b.amount, card: b.paymentMethod, monthName: b.monthName, txDate: b.txDate,
            suggested: b.suggested, parkedHours: Math.floor(u.age / HOUR), fromEmail: from,
          }),
          kbCategoryConfirm(b.id, await categoriesFor(b.email), b.suggested)
        );
        nudged += 1;
      } else {
        await sendMessage(u.chatId, tgSplitNudge(u.items), [[{ text: '⏭ SKIP (log as one expense)', callback_data: 'SKIP' }]]);
        splitNudged += 1;
      }
    } catch (e) {
      console.error('parked-nudge: send failed', e?.message);
    }
  }

  const over = units.length - toSend.length;
  if (over > 0 && primaryChatId) {
    try {
      await sendMessage(primaryChatId, `⏰ …and ${over} more still waiting — they'll come up tomorrow.`);
    } catch (e) {
      console.error('parked-nudge: summary send failed', e?.message);
    }
  }

  let gaveUpCount = 0;
  if (gaveUp.length && primaryChatId) {
    try {
      await sendMessage(
        primaryChatId,
        `🗑 Giving up on ${gaveUp.length} parked charge${gaveUp.length === 1 ? '' : 's'} older than 30 days — not logged, no more reminders.`
      );
      gaveUpCount = gaveUp.length;
      for (const it of gaveUp) {
        try { await store.setJSON(it.key, { ...it.blob, giveUpNotedAt: now.toISOString() }); }
        catch (e) { console.warn('parked-nudge: could not stamp giveUpNotedAt', e?.message); }
      }
    } catch (e) {
      console.error('parked-nudge: give-up send failed', e?.message);
    }
  }

  return { nudged, splitNudged, over: Math.max(over, 0), gaveUp: gaveUpCount };
}
