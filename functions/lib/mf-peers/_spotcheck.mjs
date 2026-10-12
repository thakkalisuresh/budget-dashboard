/**
 * Optional monthly cross-check (validation rule 6): two codes' NAVs from mfapi.in
 * against AMFI's own single-day NAV history report (about 1 MB, one request).
 * Reason-only: a mismatch or an unreachable report never changes a row's status.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toAmfi = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;

/** @param {Array<{code:string, date:string, nav:number}>} samples  all on the same NAV date
 *  @returns {Promise<{checked:number, mismatches:Array<{code,mfapi,amfi}>, note:string}>} */
export async function spotCheck(client, samples) {
  if (samples.length < 2) return { checked: 0, mismatches: [], note: 'spot-check skipped (fewer than 2 samples)' };
  const date = samples[0].date;
  let text;
  try {
    ({ text } = await client.getText(`https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${toAmfi(date)}&todt=${toAmfi(date)}`, { phase: 'spot-check', maxBytes: 6_000_000 }));
  } catch (e) { return { checked: 0, mismatches: [], note: `spot-check unavailable: ${e.message}` }; }
  const want = new Map(samples.map((s) => [s.code, s]));
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(';');
    if (p.length >= 8 && want.has(p[0].trim())) found.set(p[0].trim(), parseFloat(p[6]));
  }
  const mismatches = [];
  for (const s of samples) {
    const a = found.get(s.code);
    if (a != null && Math.abs(a - s.nav) > 1e-4) mismatches.push({ code: s.code, mfapi: s.nav, amfi: a });
  }
  return { checked: found.size, mismatches, note: `spot-check ${date}: ${found.size}/${samples.length} codes found, ${mismatches.length} mismatch(es)` };
}
