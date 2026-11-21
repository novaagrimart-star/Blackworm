import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

import { registerSW } from 'virtual:pwa-register';
import { startAutoVersionControl } from './lib/appVersion';
import { safeClearTransientCaches } from './lib/localVault';

// Register service worker & remote version control gracefully so Website UI/feature updates reach APK automatically
if (typeof window !== 'undefined') {
  startAutoVersionControl();

  // Prevent unhandled promise rejections from killing the app
  window.addEventListener('unhandledrejection', (event) => {
    const reasonMsg = String((event.reason as any)?.message || event.reason || '').toLowerCase();
    if (
      reasonMsg.includes('dynamically imported module') ||
      reasonMsg.includes('chunkloaderror') ||
      reasonMsg.includes('loading chunk')
    ) {
      try {
        const lastReload = Number(sessionStorage.getItem('blackworm_chunk_reload_at') || '0');
        if (Date.now() - lastReload > 15000) {
          sessionStorage.setItem('blackworm_chunk_reload_at', String(Date.now()));
          void safeClearTransientCaches().finally(() => {
            window.location.reload();
          });
          return;
        }
      } catch {}
    }
    console.warn('Caught unhandled promise rejection:', event.reason);
    event.preventDefault();
  });

  // Automatically recover once if Vite preload / chunk error triggers
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    try {
      const lastReload = Number(sessionStorage.getItem('blackworm_chunk_reload_at') || '0');
      if (Date.now() - lastReload > 15000) {
        sessionStorage.setItem('blackworm_chunk_reload_at', String(Date.now()));
        void safeClearTransientCaches().finally(() => {
          window.location.reload();
        });
      }
    } catch {}
  });

  // Catch global errors safely without leaking uncaught crashes
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
      let lastSwCheckAt = 0;
      const hadControllerAtBoot = Boolean('serviceWorker' in navigator && navigator.serviceWorker.controller);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadControllerAtBoot) return;
          try {
            const lastReload = Number(sessionStorage.getItem('blackworm_sw_reload_at') || '0');
            if (Date.now() - lastReload > 60000) {
              sessionStorage.setItem('blackworm_sw_reload_at', String(Date.now()));
              window.location.reload();
            }
          } catch {}
        });
      }
      const updateSW = registerSW({
        immediate: true,
        onRegisteredSW(_swUrl, registration) {
          if (!registration) return;
          const checkForUpdate = () => {
            if (document.visibilityState === 'hidden') return;
            const now = Date.now();
            if (now - lastSwCheckAt < 30 * 1000) return;
            lastSwCheckAt = now;
            registration.update().catch(() => {});
          };
          checkForUpdate();
          window.addEventListener('online', checkForUpdate);
          window.addEventListener('focus', checkForUpdate);
          document.addEventListener('visibilitychange', checkForUpdate);
          setInterval(checkForUpdate, 60 * 1000);
        },
        onNeedRefresh() {
          try {
            const lastReload = Number(sessionStorage.getItem('blackworm_sw_reload_at') || '0');
            if (Date.now() - lastReload > 60000) {
              sessionStorage.setItem('blackworm_sw_reload_at', String(Date.now()));
              void updateSW(true);
              setTimeout(() => {
                void safeClearTransientCaches().finally(() => {
                  window.location.reload();
                });
              }, 1500);
            }
          } catch {}
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
