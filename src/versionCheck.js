// ════════════════════════════════════════════════════════════════════════════
// versionCheck.js — the service-worker-independent half of update detection.
//
// The service worker is the primary mechanism for noticing a new deploy, but it
// is not trustworthy everywhere: installed iOS home-screen PWAs get killed when
// backgrounded and may resume from the page cache without ever re-checking, and
// Safari's registration.update() is the least reliable of the three engines. So
// we also poll a tiny /version.json — emitted at build time — and compare its
// commit against the commit compiled into this bundle.
//
// Everything here is pure and framework-free on purpose: the hook that drives it
// imports a Vite virtual module, which unit tests can't resolve. Keeping the
// logic out here means it stays directly testable.
// ════════════════════════════════════════════════════════════════════════════

/** Where the build writes its version manifest (see vite.config.js). */
export const VERSION_URL = '/version.json';

/** How often to re-check while the tab is visible. Never polls while hidden. */
export const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Normalize whatever /version.json returned into a shape we trust, or null.
 * `commit` is the only field we compare on — version strings are hand-bumped
 * (package.json) and can repeat across deploys, so they can't detect a change.
 */
export function parseVersionPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const commit = typeof raw.commit === 'string' ? raw.commit.trim() : '';
  if (!commit) return null;
  return {
    commit,
    version:   typeof raw.version === 'string' ? raw.version : '',
    buildTime: typeof raw.buildTime === 'string' ? raw.buildTime : '',
  };
}

/**
 * Is the deployed build different from the one we're running?
 *
 * `currentCommit` is __COMMIT_SHA__, which vite.config.js sets to the literal
 * 'dev' outside CI. A dev build must never prompt — the local bundle legitimately
 * differs from whatever is deployed, and prompting would make `vite dev` unusable.
 */
export function isNewerBuild(currentCommit, remote) {
  if (!remote || !remote.commit) return false;
  if (!currentCommit || currentCommit === 'dev') return false;
  return remote.commit !== currentCommit;
}

/**
 * Fetch and parse the version manifest. Never throws and never rejects — a failed
 * poll must be indistinguishable from "no update", or a flaky network would block
 * the app behind an update gate it can't dismiss.
 *
 * `cache: 'no-store'` matters as much as the no-cache header in firebase.json:
 * a cached manifest would report the old commit forever.
 */
export async function fetchRemoteVersion(fetchImpl, url = VERSION_URL) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return null;
  try {
    const res = await doFetch(url, { cache: 'no-store' });
    if (!res || !res.ok) return null;
    return parseVersionPayload(await res.json());
  } catch {
    return null;   // offline, 404 on a dev server, malformed JSON — all "no update"
  }
}
