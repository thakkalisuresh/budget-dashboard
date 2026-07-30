// ════════════════════════════════════════════════════════════════════════════
// main.jsx — the ENTRY POINT of the whole app.
// This is the very first JavaScript that runs in the browser. Its job is to take
// our top-level <App /> component and "mount" it into the HTML page, and to set
// up a few app-wide safety nets (crash handling + service-worker auto-reload).
// ════════════════════════════════════════════════════════════════════════════

// React core. `StrictMode` is a dev-only wrapper that surfaces likely bugs;
// `Component` is the base class we extend to build the ErrorBoundary below.
import { StrictMode, Component } from 'react'
// `createRoot` is React 18+'s way of attaching a React app to a real DOM node.
import { createRoot } from 'react-dom/client'
// Provider that makes Google Sign-In available to every component in the tree.
import { GoogleOAuthProvider } from '@react-oauth/google'
// Global stylesheet. Importing CSS here lets Vite (our build tool) bundle it.
import './index.css'
// Our actual application — everything the user sees lives under this component.
import App from './App.jsx'
// Cache/service-worker teardown, shared with the update flow (see useAppUpdate.js)
// so there's only one implementation of "throw everything away and come back fresh".
import { resetAndReload } from './resetAppCaches.js'
// Detects a new deploy and blocks the stale build. Also owns SW registration.
import { UpdateGate } from './UpdateGate.jsx'

// The Google OAuth client ID, read from a build-time environment variable.
// `import.meta.env` is how Vite exposes env vars (only ones prefixed with VITE_).
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// ── Auto-reload when a new service worker takes over ─────────────────────────
// A "service worker" is a background script that caches the app so it works
// offline (this is what makes the site a PWA). When we deploy a new version, the
// new worker activates and fires a 'controllerchange' event. We listen for it and
// reload, so users instantly get fresh code instead of stale cached JavaScript.
if ('serviceWorker' in navigator) {              // feature-check: older browsers lack it
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();                    // hard refresh to pull the new assets
  });
}

// ── Global crash handler — catches unhandled promise rejections ───────────────
// If a Promise rejects and nothing `.catch()`es it, this fires. We log it so
// async errors don't vanish silently. (This handles ASYNC errors; the
// ErrorBoundary below handles errors thrown while React is RENDERING.)
window.addEventListener('unhandledrejection', (e) => {
  // Prefer a code the throwing code already attached; WEB-002 is the generic
  // "nobody caught this" bucket. See docs/ERROR_CODES.md.
  const code = e.reason?.code || 'WEB-002';
  console.error(`[Budget] ${code} — Unhandled rejection:`, e.reason);
});

// ── React Error Boundary ──────────────────────────────────────────────────────
// An Error Boundary is a special component that "catches" errors thrown by the
// components beneath it during rendering, and shows a fallback UI instead of a
// blank white screen. It MUST be a class component — React only supports error
// catching through the two lifecycle methods used below.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);                                // required when extending a React class
    // Component state: have we crashed, and the error object if so.
    this.state = { crashed: false, error: null };
  }

  // Called by React when a child throws. Whatever we return is merged into state,
  // which flips us into the "crashed" view on the next render.
  static getDerivedStateFromError(error) {
    return { crashed: true, error };
  }

  // Also runs on a crash — but this is the place for side effects like logging.
  // `info.componentStack` tells us which part of the tree the error came from.
  componentDidCatch(error, info) {
    // WEB-001 is the only error the user experiences as a fallback screen
    // rather than a message, so it is worth naming on screen as well as here.
    console.error(`[Budget] ${error?.code || 'WEB-001'} — Render crash:`, error, info.componentStack);
  }

  render() {
    // Normal case: no crash, so just render whatever children were passed in.
    if (!this.state.crashed) return this.props.children;

    // Crash case: show a friendly fallback screen. The styles are written inline
    // (as JS objects) on purpose — the stylesheet itself might be part of what
    // failed, so we avoid depending on it here.
    return (
      <div style={{
        minHeight: '100dvh',
        background: '#0f172a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1.5rem',
        fontFamily: 'system-ui, sans-serif',
        color: '#f1f5f9',
        textAlign: 'center',
      }}>
        {/* The ⚠️ icon badge */}
        <div style={{
          width: 56, height: 56,
          borderRadius: 16,
          background: '#1e293b',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28,
        }}>⚠️</div>
        <div>
          <p style={{ fontSize: 18, fontWeight: 900, margin: '0 0 8px' }}>
            Something went wrong{' '}
            <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>
              [{this.state.error?.code || 'WEB-001'}]
            </span>
          </p>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0, maxWidth: 320 }}>
            The app ran into an unexpected error. Try clearing the cache and reloading.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* Recovery button: wipe every cache + unregister service workers, then
              reload. This clears out any corrupted offline state before retrying.
              Same teardown the update gate falls back to when the version poll
              spots a deploy the service worker never noticed. */}
          <button
            onClick={resetAndReload}
            style={{
              padding: '10px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 700,
            }}
          >
            Clear cache &amp; reload
          </button>
          {/* Softer option: just reload without clearing anything. */}
          <button
            onClick={() => window.location.reload(true)}
            style={{
              padding: '10px 20px', borderRadius: 12, cursor: 'pointer',
              background: '#1e293b', border: '1px solid #334155',
              color: '#94a3b8', fontSize: 13, fontWeight: 700,
            }}
          >
            Just reload
          </button>
        </div>
        {/* Show the raw error text at the bottom (only if we actually have one) —
            handy for debugging without scaring the user with a stack trace. */}
        {this.state.error && (
          <p style={{ fontSize: 11, color: '#475569', maxWidth: 400, wordBreak: 'break-word' }}>
            {String(this.state.error)}
          </p>
        )}
      </div>
    );
  }
}

// ── Mount ─────────────────────────────────────────────────────────────────────
// Find the <div id="root"> in index.html and render our app into it. The nesting
// order matters: StrictMode (checks) wraps ErrorBoundary (catches crashes) wraps
// GoogleOAuthProvider (auth context) wraps <App /> (the real app).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={CLIENT_ID}>
        {/* Mounted beside <App /> rather than inside it: this is also what
            registers the service worker, so it must mount exactly once and stay
            mounted across login/logout. */}
        <UpdateGate />
        <App />
      </GoogleOAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
