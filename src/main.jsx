import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './index.css'
import App from './App.jsx'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// ── Auto-reload when a new service worker takes over ─────────────────────────
// Fires after skipWaiting + clientsClaim — ensures fresh JS is served immediately
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

// ── Global crash handler — catches unhandled promise rejections ───────────────
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Budget] Unhandled rejection:', e.reason);
});

// ── React Error Boundary ──────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { crashed: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[Budget] Render crash:', error, info.componentStack);
  }

  render() {
    if (!this.state.crashed) return this.props.children;

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
        <div style={{
          width: 56, height: 56,
          borderRadius: 16,
          background: '#1e293b',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28,
        }}>⚠️</div>
        <div>
          <p style={{ fontSize: 18, fontWeight: 900, margin: '0 0 8px' }}>
            Something went wrong
          </p>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0, maxWidth: 320 }}>
            The app ran into an unexpected error. Try clearing the cache and reloading.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={async () => {
              try {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
              } catch { /* ignore */ }
              window.location.reload(true);
            }}
            style={{
              padding: '10px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 700,
            }}
          >
            Clear cache &amp; reload
          </button>
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
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={CLIENT_ID}>
        <App />
      </GoogleOAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
