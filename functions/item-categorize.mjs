/**
 * Cloud Function — categorize receipt line items in one batched LLM call.
 *
 * HTTP surface for the dashboard's split-receipt screen. The prompting,
 * batching and confidence rules live in lib/_item-llm.mjs, shared with the
 * Telegram bot so both surfaces answer the same receipt the same way.
 *
 * This function only authenticates, sanitizes and forwards. Answers are
 * advisory: above the confidence threshold the review screen pre-selects a
 * category, below it the item stays blank and the user picks. Nothing here
 * writes to a sheet.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, GROQ_API_KEY } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { categorizeItemsBatch } from './lib/_item-llm.mjs';

export const itemCategorize = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS, GROQ_API_KEY], cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    const { vendor, items, categories, examples } = req.body || {};
    if (!Array.isArray(items) || !items.length || !Array.isArray(categories) || !categories.length) {
      sendJson(res, 400, { error: 'items and categories are required' }, corsOrigin);
      return;
    }

    // categorizeItemsBatch never throws — a bad day at Groq comes back as
    // nulls, which the split screen reads as "ask the user".
    const { results, reason } = await categorizeItemsBatch({ vendor, items, categories, examples });
    sendJson(res, 200, reason ? { results, reason } : { results }, corsOrigin);
  }
);
