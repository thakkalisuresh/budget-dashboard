/**
 * Cloud Function — weekly category audit.
 *
 * Samples recently-logged expenses, asks Groq whether each looks miscategorized,
 * and sends ONE Telegram digest of the suspects. Nothing is ever rewritten
 * automatically: each suspect is a button, and the user's tap is what moves it.
 *
 * This is the second half of the categorizer. The add-path layer catches
 * mistakes before they land; this catches the ones that got through — including
 * anything written while Groq was down or below the confidence threshold with
 * no Telegram mapping to ask through.
 *
 * Deployment note: this is a scheduled function, so deploying it needs BOTH
 * the cloudscheduler.googleapis.com API enabled on the project AND
 * roles/cloudscheduler.admin on the deploying principal (github-ci-deploy).
 * Without the role the function itself deploys fine but its Cloud Scheduler
 * job is never created — it goes ACTIVE and simply never fires, which looks
 * identical to "working" until you notice the digest never arrives.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { currentMonthName } from './lib/_time.mjs';
import {
  getCurrentMonthSheetId, getRecentExpenses, getUserSettings,
} from './lib/_sheets.mjs';
import { CATEGORIES } from './lib/_extraction.mjs';
import { categorizeWithGroq, applySmartRules } from './lib/_categorize.mjs';
import { sendMessage, resolveTelegramChatId } from './lib/_telegram.mjs';
import {
  GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP, SHEETS_DRIVE_SECRETS,
} from './lib/secrets.mjs';

/** How many recent expenses to pull, and how many of those to actually check. */
const SAMPLE_POOL = 40;
const SAMPLE_SIZE = 15;

/**
 * Only flag a disagreement the model is sure about. The add path can afford to
 * ask on a hunch because the user is already mid-transaction; a weekly digest
 * that cries wolf just gets ignored, so the bar here is deliberately higher.
 */
const AUDIT_THRESHOLD = 0.85;

/** Fisher-Yates over a copy — random coverage, so repeat runs check different rows. */
function sample(items, n) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * Core audit, exported separately from the schedule wrapper so it can be tested
 * without standing up the scheduler. Returns a small summary for the logs.
 */
export async function runCategoryAudit({ email }) {
  const chatId = resolveTelegramChatId(email);
  if (!chatId) {
    console.warn('category-audit: no Telegram mapping; nothing to report to');
    return { checked: 0, flagged: 0, reason: 'no_chat_id' };
  }

  const monthName = currentMonthName();
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    console.warn(`category-audit: no sheet for ${monthName}`);
    return { checked: 0, flagged: 0, reason: 'no_sheet' };
  }

  const settings = await getUserSettings().catch(() => ({}));
  if (settings.llmCategorize === false) {
    return { checked: 0, flagged: 0, reason: 'disabled' };
  }

  const categories = [...CATEGORIES, ...(settings.customCategories || [])];
  const recent = await getRecentExpenses(sheetId, SAMPLE_POOL).catch(() => []);
  const candidates = sample(recent.filter(e => e.vendor && e.uuid), SAMPLE_SIZE);

  const flagged = [];
  for (const expense of candidates) {
    // A smart rule is the user's own instruction — if one covers this vendor,
    // the logged category isn't the model's business.
    if (applySmartRules(expense.vendor, settings.smartRules)) continue;

    const guess = await categorizeWithGroq(expense.vendor, expense.amount, categories);
    if (!guess) continue;
    if (guess.category === expense.category) continue;
    if (guess.confidence < AUDIT_THRESHOLD) continue;

    flagged.push({ ...expense, suggested: guess.category, confidence: guess.confidence });
  }

  console.log(`category-audit: checked ${candidates.length}, flagged ${flagged.length}`);
  if (flagged.length === 0) return { checked: candidates.length, flagged: 0 };

  // One digest, not one message per suspect.
  const lines = [
    `🔍 Weekly category check — ${flagged.length} to review:`,
    '',
    ...flagged.map((f, i) =>
      `${i + 1}. ${f.vendor} · $${Number(f.amount).toFixed(2)}\n   ${f.category} → ${f.suggested}?`
    ),
    '',
    'Tap to move one, or ignore this message to keep everything as-is.',
  ];

  // callback_data is capped at 64 bytes; uuid + category already fills most of
  // that, so each suspect gets its own single-button row.
  const keyboard = flagged.map(f => ([{
    text: `${f.vendor} → ${f.suggested}`,
    callback_data: `AUDITFIX:${f.uuid}:${f.suggested}`,
  }]));

  await sendMessage(chatId, lines.join('\n'), keyboard);
  return { checked: candidates.length, flagged: flagged.length };
}

export const categoryAudit = onSchedule(
  {
    // Monday morning: a week's worth of spending, before the new week's starts.
    schedule: 'every monday 09:00',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
    secrets: [GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP, ...SHEETS_DRIVE_SECRETS],
    timeoutSeconds: 300,
  },
  async () => {
    const email = (process.env.ALLOWED_EMAILS || '').split(',')[0]?.trim();
    if (!email) {
      console.warn('category-audit: ALLOWED_EMAILS not configured; skipping');
      return;
    }
    try {
      await runCategoryAudit({ email });
    } catch (e) {
      console.error('category-audit: run failed', e.message);
    }
  }
);
