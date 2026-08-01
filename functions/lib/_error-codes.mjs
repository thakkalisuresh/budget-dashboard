/**
 * Error code registry — the single source of truth for "what can break".
 *
 * Every failure mode the app can hit has a stable code here. When something
 * goes wrong you see the code in a log line or a Telegram message, look it up,
 * and know what it is and what to do. docs/ERROR_CODES.md is GENERATED from
 * this file (npm run errdoc), so the catalogue can never drift from the code.
 *
 * Code shape: DOMAIN-NNN
 *   CFG   configuration / secrets        AUTH  authentication & access
 *   SHT   Google Sheets                  DRV   Google Drive
 *   EXTR  receipt & text extraction      LLM   other AI (Groq, agent)
 *   TG    Telegram transport             BOT   bot conversation flows
 *   WAL   wallet webhook                 FX    currency conversion
 *   WEB   frontend / dashboard
 *
 * Numbers are permanent. Retire a code rather than reuse it — a stale code in
 * an old log should still resolve to what it meant at the time.
 *
 * severity:
 *   'fatal'  the user's action did not happen and they must retry
 *   'degraded' the action happened but something was lost or skipped
 *   'config' nothing will work until a human changes a setting or secret
 */

export const ERROR_CODES = {
  /* ── CFG: configuration & secrets ─────────────────────────────────────── */
  'CFG-001': {
    title: 'VITE_TEMPLATE_SHEET_ID not configured',
    severity: 'config',
    cause: 'The functions runtime has no template spreadsheet id, so no month sheet can ever be resolved.',
    fix: 'Set VITE_TEMPLATE_SHEET_ID in the Firebase functions config and redeploy. Everything sheet-related stays broken until this exists.',
  },
  'CFG-002': {
    title: 'Google Drive credentials missing',
    severity: 'config',
    cause: 'One of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN is unset.',
    fix: 'Set all three as Firebase secrets. Note the OAuth client lives in the "Budget Tracker" GCP project, not fundient-dashboard.',
  },
  'CFG-003': {
    title: 'GEMINI_API_KEY not configured',
    severity: 'config',
    cause: 'Receipt extraction has no primary vision model available.',
    fix: 'Set GEMINI_API_KEY. Extraction falls back to Claude, so receipts may still work but slower and at cost.',
  },
  'CFG-004': {
    title: 'ANTHROPIC_API_KEY not configured',
    severity: 'config',
    cause: 'The Claude fallback for extraction and the conversational agent are unavailable.',
    fix: 'Set ANTHROPIC_API_KEY. If GEMINI_API_KEY is also missing, receipt scanning cannot work at all.',
  },
  'CFG-005': {
    title: 'GROQ_API_KEY not configured',
    severity: 'config',
    cause: 'Natural-language queries and LLM category correction fall back or no-op.',
    fix: 'Set GROQ_API_KEY. Not fatal: categorization degrades to the extractor and queries fall back to Claude.',
  },
  'CFG-006': {
    title: 'Telegram bot not configured',
    severity: 'config',
    cause: 'TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET is unset, so the bot cannot receive or reply.',
    fix: 'Set both, then re-register the webhook with Telegram so the secret token matches.',
  },
  'CFG-007': {
    title: 'No Telegram chat mapping for this user',
    severity: 'degraded',
    cause: 'TELEGRAM_EMAIL_MAP has no entry for the email, so nothing can be sent to them.',
    fix: 'Add "email:chatId" to TELEGRAM_EMAIL_MAP. Affects wallet confirmations, duplicate warnings, and all digests.',
  },
  'CFG-008': {
    title: 'ALLOWED_EMAILS not configured',
    severity: 'config',
    cause: 'Scheduled jobs have no user to act for and skip entirely.',
    fix: 'Set ALLOWED_EMAILS. The first entry is treated as the primary household account.',
  },
  'CFG-009': {
    title: 'WALLET_WEBHOOK_SECRET not configured',
    severity: 'config',
    cause: 'The wallet webhook rejects every request because it has nothing to compare the key against.',
    fix: 'Set WALLET_WEBHOOK_SECRET and use the same value in the phone automation.',
  },

  /* ── AUTH: authentication & access ────────────────────────────────────── */
  'AUTH-001': {
    title: 'Google token refresh failed — token revoked or expired',
    severity: 'config',
    cause: 'The Drive/Sheets refresh token is no longer valid. Most often the OAuth consent screen is in Testing mode, which expires refresh tokens after 7 days.',
    fix: 'Regenerate GOOGLE_DRIVE_REFRESH_TOKEN and publish the OAuth consent screen to Production so it stops expiring.',
  },
  'AUTH-002': {
    title: 'Wallet webhook rejected an unauthorized request',
    severity: 'fatal',
    cause: 'Missing or wrong API key on the wallet webhook.',
    fix: 'Expected if someone is probing the endpoint. If it is your own phone, the key in the automation no longer matches WALLET_WEBHOOK_SECRET.',
  },
  'AUTH-003': {
    title: 'Telegram webhook signature rejected',
    severity: 'fatal',
    cause: 'The request did not carry the expected secret token header.',
    fix: 'Expected for random internet traffic. If your own bot stopped working, re-register the webhook so its secret matches TELEGRAM_WEBHOOK_SECRET.',
  },
  'AUTH-004': {
    title: 'Telegram user not on the allow list',
    severity: 'fatal',
    cause: 'A Telegram account not in TELEGRAM_ALLOWED_USERS messaged the bot.',
    fix: 'Expected for strangers. Add the numeric user id to TELEGRAM_ALLOWED_USERS if it should be you.',
  },
  'AUTH-005': {
    title: 'Sheets access denied',
    severity: 'fatal',
    cause: 'The credentials are valid but not permitted on that spreadsheet.',
    fix: 'Share the sheet with the service account / OAuth user, or check ALLOWED_EMAILS.',
  },

  /* ── SHT: Google Sheets ───────────────────────────────────────────────── */
  'SHT-001': {
    title: 'Sheets API returned an error',
    severity: 'fatal',
    cause: 'Generic non-2xx from the Sheets API. Status is in the message: 429 is rate limiting, 5xx is Google-side.',
    fix: 'Retry. If 429 repeats, something is polling too aggressively. If 403, see AUTH-005.',
  },
  'SHT-002': {
    title: 'No sheet found for month',
    severity: 'fatal',
    cause: 'The Months tab has no row for the month a transaction belongs to. Common on the 1st, and for back-dated transactions.',
    fix: 'Create the month in the dashboard, or via the bot. The wallet webhook returns 422 month_not_found for this.',
  },
  'SHT-003': {
    title: 'Unknown category',
    severity: 'fatal',
    cause: 'A category name was used that has no tab in the sheet map — usually a custom category that was renamed or deleted.',
    fix: 'Check the category exists in Totals and in the sheet map. Re-add it, or correct the transaction.',
  },
  'SHT-004': {
    title: 'Row with UUID not found',
    severity: 'fatal',
    cause: 'A delete or edit targeted a transaction that is no longer where it was — already deleted, or moved between tabs.',
    fix: 'Usually benign: the row is already gone. If it persists, the UUID column may be in an unexpected position for that tab.',
  },
  'SHT-005': {
    title: 'Sheet tab not found',
    severity: 'fatal',
    cause: 'A tab named in the sheet map does not exist in this month, typically an older sheet created before a category was added.',
    fix: 'Add the missing tab to that month, or recreate the month from the current template.',
  },
  'SHT-006': {
    title: 'Salary row not found in Totals',
    severity: 'fatal',
    cause: 'The Totals tab does not have the expected salary row.',
    fix: 'The sheet was edited by hand or created from an old template. Restore the Totals layout.',
  },
  'SHT-007': {
    title: 'Totals sheet is full',
    severity: 'fatal',
    cause: 'All 20 category rows (2–21) are used, so no new category can be added.',
    fix: 'Delete an unused category first.',
  },
  'SHT-008': {
    title: 'Category already exists',
    severity: 'fatal',
    cause: 'Tried to create a category whose name is already taken.',
    fix: 'Expected user error. Pick a different name.',
  },
  'SHT-009': {
    title: 'Expense write failed',
    severity: 'fatal',
    cause: 'appendExpense could not write the row. The transaction was NOT recorded.',
    fix: 'Retry from the dashboard. Check SHT-001/SHT-002 in the same window for the underlying cause.',
  },
  'SHT-010': {
    title: 'History append failed',
    severity: 'degraded',
    cause: 'The expense was written but the History log entry was not. Deliberately non-fatal.',
    fix: 'The money is correct; History and anything reading it (Split, Duplicates) will be missing that row.',
  },

  /* ── DRV: Google Drive ────────────────────────────────────────────────── */
  'DRV-001': {
    title: 'Drive API error',
    severity: 'degraded',
    cause: 'Non-2xx from Drive while creating a folder or reading metadata.',
    fix: 'The expense still logs; only the receipt image is affected. Check AUTH-001 for an expired token.',
  },
  'DRV-002': {
    title: 'Receipt upload failed',
    severity: 'degraded',
    cause: 'The receipt image could not be stored. The expense itself is unaffected.',
    fix: 'Re-attach the receipt from the bot with ATTACH if you want the image kept.',
  },
  'DRV-003': {
    title: 'Receipt file move failed',
    severity: 'degraded',
    cause: 'The image uploaded but could not be filed into its category folder.',
    fix: 'The file exists in Drive, just in the wrong folder. Cosmetic.',
  },

  /* ── EXTR: receipt & text extraction ──────────────────────────────────── */
  'EXTR-001': {
    title: 'Vision model API error',
    severity: 'fatal',
    cause: 'Gemini or Claude returned a non-2xx while reading a receipt. 429 means rate limited.',
    fix: 'Retry. The chain falls back gemini-flash → gemini-pro → Claude, so seeing this repeatedly means several providers failed.',
  },
  'EXTR-002': {
    title: 'Model returned no usable JSON',
    severity: 'fatal',
    cause: 'The response could not be parsed into a transaction, usually a blurry or non-receipt image.',
    fix: 'Retake the photo. The bot falls back to asking for the details by text.',
  },
  'EXTR-003': {
    title: 'Extraction produced no transactions',
    severity: 'fatal',
    cause: 'The model parsed the image but found nothing that looks like a purchase.',
    fix: 'Expected for non-receipts. If it is a real receipt, retake it with the total visible.',
  },
  'EXTR-004': {
    title: 'Implausible purchase year corrected',
    severity: 'degraded',
    cause: 'The model returned a date far in the past or future — typically an Amex statement showing MM/DD with no year.',
    fix: 'Informational. repairPurchaseYear already remapped it. Frequent hits mean the date prompt is not landing.',
  },

  'EXTR-005': {
    title: 'All extraction models exhausted',
    severity: 'fatal',
    cause: 'Every model in the fallback chain failed — gemini-flash, then gemini-pro, then Claude. The receipt was not read at all.',
    fix: 'Almost always a key or quota problem across providers at once, or a total outage. Check CFG-003 and CFG-004, then provider status.',
  },

  /* ── LLM: Groq, agent, categorization ─────────────────────────────────── */
  'LLM-001': {
    title: 'Groq API error',
    severity: 'degraded',
    cause: 'Non-2xx from Groq during a query or category check.',
    fix: 'Queries fall back to Claude; categorization falls back to the extractor. No data is lost.',
  },
  'LLM-002': {
    title: 'Agent API error',
    severity: 'fatal',
    cause: 'The conversational agent could not reach Claude.',
    fix: 'The bot cannot answer free-form questions until this clears. Structured commands still work.',
  },
  'LLM-003': {
    title: 'Category suggestion unusable',
    severity: 'degraded',
    cause: 'The model returned a category that is not one of the sheet tabs, so it was discarded.',
    fix: 'Informational. Repeated hits mean the category list sent in the prompt is out of sync with the sheet.',
  },

  /* ── PUSH: web push notifications ─────────────────────────────────────── */
  'PUSH-001': {
    title: 'Push subscription change failed',
    severity: 'degraded',
    cause: 'A browser could not register or remove its push subscription.',
    fix: 'The dashboard still works; only background alerts are affected. Re-enable notifications in Settings.',
  },
  'PUSH-002': {
    title: 'Push notification send failed',
    severity: 'degraded',
    cause: 'A notification could not be delivered, usually an expired browser subscription.',
    fix: 'Expected after a browser clears site data. The subscription is pruned automatically; re-enable in Settings.',
  },

  /* ── MCP: model context protocol server ───────────────────────────────── */
  'MCP-001': {
    title: 'MCP tool call failed',
    severity: 'fatal',
    cause: 'A tool invoked through the MCP server threw.',
    fix: 'Affects external assistants talking to the budget, not the dashboard or bot. The tool name is in the message.',
  },

  /* ── TG: Telegram transport ───────────────────────────────────────────── */
  'TG-001': {
    title: 'Telegram sendMessage failed',
    severity: 'degraded',
    cause: 'The reply could not be delivered. The underlying action usually already happened.',
    fix: 'Check the bot token and that the chat still exists. The expense is likely logged despite the silence.',
  },
  'TG-002': {
    title: 'Telegram file download failed',
    severity: 'fatal',
    cause: 'The receipt photo could not be fetched from Telegram.',
    fix: 'Ask the user to resend the photo. Files expire on Telegram after a while.',
  },

  /* ── BOT: conversation flows ──────────────────────────────────────────── */
  'BOT-001': {
    title: 'Receipt could not be logged',
    severity: 'fatal',
    cause: 'The confirm step failed to write the expense to the sheet.',
    fix: 'See the SHT-* code logged alongside. The receipt stays pending, so confirming again may work.',
  },
  'BOT-002': {
    title: 'Undo failed',
    severity: 'fatal',
    cause: 'The entry to undo could not be found or removed — often already edited or deleted.',
    fix: 'Remove it from the dashboard instead.',
  },
  'BOT-003': {
    title: 'Delete failed',
    severity: 'fatal',
    cause: 'The delete passed its three confirmations but the sheet write failed.',
    fix: 'See SHT-004 if the row had already moved. Retry, or delete from the dashboard.',
  },
  'BOT-004': {
    title: 'Entry has no tracking id',
    severity: 'fatal',
    cause: 'A pre-UUID legacy row cannot be targeted safely, so the bot refuses to delete it.',
    fix: 'Delete it from the dashboard, which can address rows by position.',
  },
  'BOT-005': {
    title: 'Split could not be logged',
    severity: 'fatal',
    cause: 'A category-split receipt failed partway through writing its parts.',
    fix: 'Check the sheet — some categories may have been written already. Reconcile before retrying.',
  },
  'BOT-006': {
    title: 'Daily receipt limit reached',
    severity: 'fatal',
    cause: 'More than 50 receipts in one day from one user.',
    fix: 'Expected guard against a runaway loop. Resets at midnight.',
  },
  'BOT-007': {
    title: 'Parked charge could not be logged',
    severity: 'fatal',
    cause: 'A wallet charge held for category confirmation failed to write when the user tapped.',
    fix: 'The pending record is kept deliberately so tapping again retries. Do not clear it.',
  },

  'BOT-008': {
    title: 'Category move left a duplicate',
    severity: 'fatal',
    cause: 'A weekly-audit recategorization added the row to its new category but could not remove the old one. The expense is now counted twice.',
    fix: 'Delete the old entry in the dashboard. The move deliberately appends before deleting, so a half-failure duplicates rather than destroys.',
  },

  /* ── WAL: wallet webhook ──────────────────────────────────────────────── */
  'WAL-001': {
    title: 'Wallet request rejected as invalid',
    severity: 'fatal',
    cause: 'Missing or unparseable merchant, amount, or email in the webhook body.',
    fix: 'The phone automation is sending the wrong shape — check the field mapping after any OS or app update.',
  },
  'WAL-002': {
    title: 'Wallet transaction write failed',
    severity: 'fatal',
    cause: 'The charge arrived but could not be written to the sheet. It is LOST unless re-entered.',
    fix: 'Add it manually. This is the most important error in the system to act on.',
  },
  'WAL-003': {
    title: 'Wallet text parse failed',
    severity: 'degraded',
    cause: 'The raw notification text could not be parsed, so fields fall back to whatever the automation sent directly.',
    fix: 'Often still logs correctly. Repeated hits mean the bank changed its notification wording.',
  },
  'WAL-004': {
    title: 'Vendor skipped by user rule',
    severity: 'degraded',
    cause: 'The vendor matches a disabled-wallet-vendor rule and was intentionally not logged.',
    fix: 'Working as configured. Remove the rule in Settings if this vendor should be logged.',
  },

  /* ── FX: currency ─────────────────────────────────────────────────────── */
  'FX-001': {
    title: 'Currency conversion failed',
    severity: 'degraded',
    cause: 'The exchange-rate API was unreachable or returned an unusable response.',
    fix: 'The amount is logged in its original currency without conversion. Correct it by hand if it matters.',
  },
  'FX-002': {
    title: 'Unknown currency',
    severity: 'degraded',
    cause: 'The extracted currency code is not one the converter knows.',
    fix: 'Usually a misread symbol on the receipt. Check the logged amount.',
  },

  /* ── WEB: dashboard ───────────────────────────────────────────────────── */
  'WEB-001': {
    title: 'Dashboard render crashed',
    severity: 'fatal',
    cause: 'A React render threw and the error boundary caught it. The user saw a fallback screen.',
    fix: 'Reproduce in the browser console. This is the only class of error the user sees as a blank/fallback page.',
  },
  'WEB-002': {
    title: 'Unhandled promise rejection in the dashboard',
    severity: 'degraded',
    cause: 'An async operation failed with nobody catching it.',
    fix: 'Often a failed fetch during navigation. Harmless individually; a pattern means a missing catch.',
  },
  'WEB-003': {
    title: 'Offline — write refused',
    severity: 'degraded',
    cause: 'A change needing the network was attempted with no connection.',
    fix: 'Expected. Retry when back online; simple expense adds queue offline, category moves do not.',
  },
  'WEB-004': {
    title: 'Receipt file rejected',
    severity: 'fatal',
    cause: 'Unsupported file type, or a PDF over the size limit.',
    fix: 'Expected user error. Send an image, or a screenshot instead of a large PDF.',
  },

  /* ── WHS: BigQuery warehouse ──────────────────────────────────────────────
     Nothing in this domain is 'fatal'. The warehouse is a derived archive
     written strictly AFTER the spreadsheet, so a failure here never costs the
     user their transaction — it costs the archive a row, and the reconciler
     re-emits it on the next pass. The one thing that is genuinely
     unrecoverable is a deletion nobody recorded, which is why WHS-005 and
     WHS-007 exist. */
  'WHS-001': {
    title: 'Warehouse write failed — queued for retry',
    severity: 'degraded',
    cause: 'A BigQuery Storage Write API append errored or blew the hot-path timeout, so the rows went to the Firestore outbox instead.',
    fix: 'Nothing to do immediately — the warehouse cron drains the outbox every 15 minutes. A steady stream of these means BigQuery is unreachable or the table schema drifted.',
  },
  'WHS-002': {
    title: 'Warehouse outbox write failed',
    severity: 'degraded',
    cause: 'BigQuery AND Firestore both failed, so the event was not persisted anywhere. This is the only path where a warehouse row is genuinely dropped.',
    fix: 'The reconciler is the backstop: it diffs the actual sheet and re-emits the row with state_reason=missed_notify on its next pass. Check that Firestore is healthy.',
  },
  'WHS-003': {
    title: 'Warehouse event rejected as malformed',
    severity: 'degraded',
    cause: 'An ingest event was missing a REQUIRED column or carried an unknown one. That is a caller bug, not a transient failure, so it is not queued for retry.',
    fix: 'Look at the reported table and column. A new field needs a NULLABLE column added in _warehouse-schema.mjs before any caller sends it.',
  },
  'WHS-004': {
    title: 'Warehouse outbox entry dead-lettered',
    severity: 'degraded',
    cause: 'An outbox entry exhausted MAX_OUTBOX_ATTEMPTS drains and will not be retried again.',
    fix: 'Read the entry in the warehouse_outbox collection; lastError says why. Usually a schema mismatch. Fix the schema, then clear the dead flag to have it retried.',
  },
  'WHS-005': {
    title: 'Warehouse reconciliation aborted on a partial read',
    severity: 'degraded',
    cause: 'One or more ranges in a month failed to read, so the sheet snapshot was incomplete. Emitting deletes from a partial snapshot would mark live transactions as deleted.',
    fix: 'Usually a transient Sheets 429/500 — the next tick retries the whole month. Persistent failures mean the month sheet was renamed, deleted, or unshared.',
  },
  'WHS-006': {
    title: 'Warehouse backfill gate failed',
    severity: 'degraded',
    cause: 'A staged month did not reconcile against the spreadsheet, so nothing was promoted into the archive.',
    fix: 'Read load_audits for the failing check_name. category_sum and month_sum are exact integer-cent comparisons; a mismatch is a real data problem, not rounding.',
  },
  'WHS-007': {
    title: 'Warehouse dataset has an expiration policy set',
    severity: 'config',
    cause: 'defaultTableExpirationMs or defaultPartitionExpirationMs is set on the archive dataset. Either one silently deletes the archive on a timer, with no error anywhere.',
    fix: 'Unset both immediately: bq update --default_table_expiration 0 --default_partition_expiration 0 <project>:fundient_warehouse',
  },
  'WHS-008': {
    title: 'Warehouse notify rejected an unknown spreadsheet',
    severity: 'degraded',
    cause: 'A client asserted a write against a spreadsheet id that is not in month_dim, so it was refused rather than recorded.',
    fix: 'Expected if a month was created outside the app. Run the month_dim snapshot, or check whether something is calling the notify endpoint with a bad id.',
  },
  'WHS-009': {
    title: 'Warehouse skipped a tab whose header does not match the contract',
    severity: 'degraded',
    cause: 'A category tab has a header row the V2 reader does not recognise — usually a custom category, which addCategory writes with 5 columns and no UUID.',
    fix: 'Not an error by itself; the tab is skipped and excluded from both sides of the month_sum gate. Convert the tab to the V2 shape if you want it archived.',
  },
};

/** Look up a code. Returns null for an unknown one rather than throwing. */
export function describeError(code) {
  return ERROR_CODES[code] || null;
}

/** `CODE — Title` for log lines and digests. */
export function errorLabel(code) {
  const entry = ERROR_CODES[code];
  return entry ? `${code} — ${entry.title}` : code;
}

/** All codes, grouped by domain prefix, for the generated catalogue. */
export function codesByDomain() {
  const out = {};
  for (const [code, entry] of Object.entries(ERROR_CODES)) {
    const domain = code.split('-')[0];
    (out[domain] ||= []).push({ code, ...entry });
  }
  return out;
}

/* ── Lookup: answering "what does this code mean" ─────────────────────────── */

/**
 * Pull an error code out of a message, if it looks like the user is asking
 * about one.
 *
 * Deliberately narrow: the message must be short and mostly the code, or
 * clearly a question about it. Otherwise a receipt whose vendor happens to
 * look like a code ("AMZ-001 STORE") would hijack the reply.
 */
export function findErrorCodeInText(text) {
  const raw = String(text || '').trim();
  if (raw.length > 80) return null;
  const m = /\b([A-Z]{2,4}-\d{3})\b/.exec(raw.toUpperCase());
  if (!m) return null;
  const code = m[1];
  const rest = raw.toUpperCase().replace(code, '').replace(/[^A-Z]/g, '');
  // Just the code, or the code plus question-ish words. Anything else is noise.
  if (rest.length === 0) return code;
  if (/^(WHAT|WHATS|WHATIS|WHATDOES|MEAN|MEANS|ERROR|CODE|IS|DOES|THE|HELP|WITH|ABOUT|HOW|FIX|DO|I|TELL|ME)+$/.test(rest)) return code;
  return null;
}

/** Render a catalogue entry as a Telegram reply. */
export function explainErrorCode(code) {
  const entry = describeError(code);
  if (!entry) {
    return `${code} isn't a known error code. Codes look like SHT-009 or WAL-002 — check the exact letters and digits.`;
  }
  const flag = entry.severity === 'fatal' ? '🔴' : entry.severity === 'config' ? '⚙️' : '🟡';
  return [
    `${flag} ${code} — ${entry.title}`,
    `Severity: ${entry.severity}`,
    '',
    `Why it happens:`,
    entry.cause,
    '',
    `What to do:`,
    entry.fix,
  ].join('\n');
}
