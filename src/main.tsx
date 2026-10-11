import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import { registerSW } from 'virtual:pwa-register';

// Auto-check for updates and prevent stale service worker caching
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    updateSW(true);
  },
  onOfflineReady() {
    console.log('App ready for offline use');
  },
});

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    updateSW();
  });
  window.addEventListener('online', () => {
    updateSW();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateSW();
    }
  });
  // Auto-check for updates every 60 seconds so users always have latest build automatically
  setInterval(() => {
    updateSW();
  }, 60 * 1000);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.update();
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(<App />);
