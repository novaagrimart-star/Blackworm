import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Auto-check for updates and prevent stale service worker caching
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.update();
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A new service worker has taken control, reload to show latest version
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(<App />);
