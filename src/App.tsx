import React, { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, testFirestoreConnection } from './firebase';
import { UserProfile } from './lib/auth';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { Language } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startBackgroundSync, isQuotaBlocked, setQuotaBlocked, trackFirestoreUsage, toTimestampMs } from './lib/dataService';
import { subscribeSecondaryCollection, fetchSecondaryCollection, autoHydrateServerFromLocalCache } from './lib/secondaryDb';

function sanitizeSessionProfile(p: Record<string, any>): UserProfile {
  const { password: _omittedPassword, ...safe } = p;
  return safe as UserProfile;
}

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('blackworm_user_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && parsed.uid) {
          const sanitized = sanitizeSessionProfile(parsed);
          if ('password' in parsed) {
            try { localStorage.setItem('blackworm_user_profile', JSON.stringify(sanitized)); } catch {}
          }
          return sanitized;
        }
        localStorage.removeItem('blackworm_user_profile');
      }
    } catch (e) {
      console.error('Failed to parse saved profile:', e);
      try { localStorage.removeItem('blackworm_user_profile'); } catch {}
    }
    return null;
  });
  const lang: Language = 'en';
  const [loading, setLoading] = useState(false);

  // Initialize background sync & check Firestore connectivity once on app load
  useEffect(() => {
    startBackgroundSync();
    if (!isQuotaBlocked()) {
      void testFirestoreConnection();
    }
  }, []);

  // Live real-time listener for current logged-in user profile changes (Primary + Secondary DB)
  useEffect(() => {
    const currentUid = profile?.uid;
    if (!currentUid) return;

    const getProfileTs = (obj: any) =>
      Math.max(Number(obj?._syncUpdatedAtMs) || 0, toTimestampMs(obj?.updatedAt || obj?.createdAt));

    const applyFreshProfile = (freshData: Record<string, any>, authoritativeServer = false) => {
      setProfile((prev) => {
        if (prev && !authoritativeServer) {
          const prevTs = getProfileTs(prev);
          const nextTs = getProfileTs(freshData);
          if (prevTs > 0 && nextTs > 0 && prevTs > nextTs + 500) {
            return prev; // Keep newer local/secondary profile update
          }
        }
        const merged = sanitizeSessionProfile({
          ...(prev || {}),
          ...freshData,
          uid: currentUid,
        });
        try {
          localStorage.setItem('blackworm_user_profile', JSON.stringify(merged));
        } catch (e) {
          console.warn('Failed to update localStorage profile:', e);
        }
        return merged;
      });
    };

    const pullProfileFromSecondary = () => {
      void fetchSecondaryCollection('users', { limit: 1000 }).then((res) => {
        if (!res.ok) return;
        const found = res.items.find((it) => it && (it.id === currentUid || it.uid === currentUid) && !it.isArchived);
        if (found) applyFreshProfile(found, false);
      });
    };

    // Always pull latest user profile from Secondary on mount and hydrate server if cold
    pullProfileFromSecondary();
    void autoHydrateServerFromLocalCache(false);

    let unsubFb: (() => void) | null = null;
    const attachProfileListener = () => {
      if (unsubFb || isQuotaBlocked()) return;
      try {
        unsubFb = onSnapshot(
          doc(db, 'users', currentUid),
          (snap) => {
            trackFirestoreUsage('read', 1);
            if (snap.exists() && !snap.metadata?.fromCache) {
              applyFreshProfile(snap.data(), true);
            }
          },
          (err) => {
            if (unsubFb) {
              try { unsubFb(); } catch {}
              unsubFb = null;
            }
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('resource_exhausted')) {
              setQuotaBlocked(15 * 60 * 1000);
            }
            pullProfileFromSecondary();
            console.warn('Real-time profile listener error:', err);
          }
        );
      } catch {
        unsubFb = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        pullProfileFromSecondary();
        attachProfileListener();
      }
    };
    const handleQuotaCleared = () => {
      attachProfileListener();
    };
    window.addEventListener('focus', pullProfileFromSecondary);
    window.addEventListener('blackworm_data_refresh', pullProfileFromSecondary);
    window.addEventListener('blackworm_secondary_resync', pullProfileFromSecondary);
    window.addEventListener('blackworm_quota_blocked', pullProfileFromSecondary);
    window.addEventListener('blackworm_quota_cleared', handleQuotaCleared);
    document.addEventListener('visibilitychange', handleVisibility);

    const unsubSec = subscribeSecondaryCollection('users', (events) => {
      events.forEach((evt) => {
        if (evt.id === currentUid && evt.doc && !evt.deleted) {
          applyFreshProfile({ ...evt.doc, ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}) }, false);
        }
      });
    });

    attachProfileListener();

    return () => {
      unsubSec();
      if (unsubFb) unsubFb();
      window.removeEventListener('focus', pullProfileFromSecondary);
      window.removeEventListener('blackworm_data_refresh', pullProfileFromSecondary);
      window.removeEventListener('blackworm_secondary_resync', pullProfileFromSecondary);
      window.removeEventListener('blackworm_quota_blocked', pullProfileFromSecondary);
      window.removeEventListener('blackworm_quota_cleared', handleQuotaCleared);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile?.uid]);

  const handleUpdateProfile = (updatedProfile: UserProfile) => {
    const safe = sanitizeSessionProfile(updatedProfile);
    setProfile(safe);
    try {
      localStorage.setItem('blackworm_user_profile', JSON.stringify(safe));
    } catch (e) {}
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-rose-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const handleLoginSuccess = (userProfile: UserProfile) => {
    const safe = sanitizeSessionProfile(userProfile);
    setProfile(safe);
    try {
      localStorage.setItem('blackworm_user_profile', JSON.stringify(safe));
    } catch {}
  };

  const handleLogout = () => {
    setProfile(null);
    try {
      localStorage.removeItem('blackworm_user_profile');
    } catch {}
  };

  return (
    <div className="antialiased">
      <ErrorBoundary>
        {profile ? (
          <Dashboard 
            profile={profile} 
            lang={lang} 
            onLogout={handleLogout}
            onProfileUpdate={handleUpdateProfile} 
          />
        ) : (
          <Login onLoginSuccess={handleLoginSuccess} />
        )}
      </ErrorBoundary>
    </div>
  );
}
