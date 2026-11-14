import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

import { registerSW } from 'virtual:pwa-register';

// Register service worker gracefully without forcing sudden unexpected page reloads
if (typeof window !== 'undefined') {
  // Prevent unhandled promise rejections from killing the app
  window.addEventListener('unhandledrejection', (event) => {
    console.warn('Caught unhandled promise rejection:', event.reason);
    event.preventDefault();
  });

  // Catch global errors safely
  window.addEventListener('error', (event) => {
    console.warn('Caught window error:', event.error || event.message);
  });

  try {
    if (import.meta.env.DEV && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => {
          reg.unregister().catch(() => {});
        });
      }).catch(() => {});
      if ('caches' in window) {
        caches.keys().then((names) => {
          names.forEach((n) => caches.delete(n));
        }).catch(() => {});
      }
    } else if (import.meta.env.PROD) {
      registerSW({
        immediate: true,
        onNeedRefresh() {
          // Log update without forcefully destroying user session
          console.log('New app version available in background');
        },
        onOfflineReady() {
          console.log('App ready for offline use');
        },
      });
    }
  } catch (e) {
    console.warn('PWA registration skipped:', e);
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
