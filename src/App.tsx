import React, { useState, useEffect, useRef, useCallback } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile } from './lib/auth';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { Language } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startBackgroundSync, isQuotaBlocked, setQuotaBlocked, trackFirestoreUsage, toTimestampMs, isRecordDeleted } from './lib/dataService';
import { subscribeSecondaryCollection, fetchSecondaryCollection, autoHydrateServerFromLocalCache, pullSecondaryChanges, initSecondaryStream } from './lib/secondaryDb';
import { hydrateAllChannelsFromSecondary } from './lib/realtimeStore';
import { isPackagedApkShell } from './lib/appVersion';

const PROFILE_STORAGE_KEY = 'blackworm_user_profile';
const SESSION_BC_NAME = 'blackworm_session_channel';

function sanitizeSessionProfile(p: Record<string, any>): UserProfile {
  const { password: _omittedPassword, ...safe } = p;
  return safe as UserProfile;
}

function readStoredProfile(): UserProfile | null {
  try {
    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === 'object' && parsed.uid) {
      const sanitized = sanitizeSessionProfile(parsed);
      if ('password' in parsed) {
        try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(sanitized)); } catch {}
      }
      return sanitized;
    }
    localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch (e) {
    console.error('Failed to parse saved profile:', e);
    try { localStorage.removeItem(PROFILE_STORAGE_KEY); } catch {}
  }
  return null;
}

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => readStoredProfile());
  const lang: Language = 'en';
  const [loading] = useState(false);

  // Authoritative session refs prevent any stale async fetch / listener / tab callback
  // from resurrecting a logged-out session or overwriting a newly logged-in user.
  const activeSessionUidRef = useRef<string | null>(profile?.uid || null);
  const sessionGenerationRef = useRef<number>(1);
  const sessionChannelRef = useRef<BroadcastChannel | null>(null);

  const broadcastSessionEvent = useCallback((type: 'logout' | 'login', uid?: string | null) => {
    try {
      if (!sessionChannelRef.current && typeof BroadcastChannel !== 'undefined') {
        sessionChannelRef.current = new BroadcastChannel(SESSION_BC_NAME);
      }
      sessionChannelRef.current?.postMessage({ type, uid: uid || null, at: Date.now() });
    } catch {}
  }, []);

  // Reconcile React session state with authoritative localStorage across tabs, reloads, and Android WebView bfcache
  const reconcileSessionFromStorage = useCallback(() => {
    const stored = readStoredProfile();
    const currentActiveUid = activeSessionUidRef.current;

    if (!stored) {
      if (currentActiveUid !== null) {
        activeSessionUidRef.current = null;
        sessionGenerationRef.current += 1;
        setProfile(null);
      }
      return;
    }

    if (stored.uid !== currentActiveUid) {
      activeSessionUidRef.current = stored.uid;
      sessionGenerationRef.current += 1;
      setProfile(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(SESSION_BC_NAME);
        sessionChannelRef.current = channel;
        channel.onmessage = (evt) => {
          const msg = evt?.data;
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'logout') {
            if (activeSessionUidRef.current !== null) {
              activeSessionUidRef.current = null;
              sessionGenerationRef.current += 1;
              setProfile(null);
            }
          } else if (msg.type === 'login') {
            reconcileSessionFromStorage();
          }
        };
      }
    } catch {}

    const handleStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PROFILE_STORAGE_KEY) {
        reconcileSessionFromStorage();
      }
    };
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        reconcileSessionFromStorage();
      }
    };
    const handleFocusReconcile = () => {
      reconcileSessionFromStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleFocusReconcile);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleFocusReconcile);
      try {
        channel?.close();
      } catch {}
      if (sessionChannelRef.current === channel) {
        sessionChannelRef.current = null;
      }
    };
  }, [reconcileSessionFromStorage]);

  // Initialize background sync + Sync on Start once on app load
  useEffect(() => {
    initSecondaryStream();
    void startBackgroundSync();
    void pullSecondaryChanges(true);
    void hydrateAllChannelsFromSecondary(true);
  }, []);

  // Live real-time listener for current logged-in user profile changes (Primary + Secondary DB)
  useEffect(() => {
    const currentUid = profile?.uid;
    if (!currentUid) return;

    let cancelled = false;
    const effectGen = sessionGenerationRef.current;

    const isSessionStillValid = () =>
      !cancelled &&
      activeSessionUidRef.current === currentUid &&
      sessionGenerationRef.current === effectGen;

    const getProfileTs = (obj: any) =>
      Math.max(Number(obj?._syncUpdatedAtMs) || 0, toTimestampMs(obj?.updatedAt || obj?.createdAt));

    const applyFreshProfile = (freshData: Record<string, any>, authoritativeServer = false) => {
      if (!isSessionStillValid()) return;
      const incomingUid = String(freshData?.uid || freshData?.id || currentUid).trim();
      if (incomingUid && incomingUid !== currentUid) return;

      setProfile((prev) => {
        if (!isSessionStillValid() || !prev || prev.uid !== currentUid) {
          return prev;
        }
        try {
          const currentStored = localStorage.getItem(PROFILE_STORAGE_KEY);
          if (!currentStored) {
            // Explicit logout already cleared storage
            return prev;
          }
          const parsedStored = JSON.parse(currentStored);
          if (!parsedStored?.uid || parsedStored.uid !== currentUid) {
            return prev;
          }
        } catch {}

        if (!authoritativeServer) {
          const prevTs = getProfileTs(prev);
          const nextTs = getProfileTs(freshData);
          if (prevTs > 0 && nextTs > 0 && prevTs > nextTs + 500) {
            return prev; // Keep newer local/secondary profile update
          }
        }
        const merged = sanitizeSessionProfile({
          ...prev,
          ...freshData,
          uid: currentUid,
        });
        try {
          if (JSON.stringify(prev) === JSON.stringify(merged)) {
            return prev;
          }
        } catch {}
        try {
          if (isSessionStillValid()) {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
          }
        } catch (e) {
          console.warn('Failed to update localStorage profile:', e);
        }
        return merged;
      });
    };

    const pullProfileFromSecondary = () => {
      if (!isSessionStillValid()) return;
      void fetchSecondaryCollection('users', { limit: 2000 }).then((res) => {
        if (!isSessionStillValid() || !res.ok) return;
        const found = res.items.find((it) => it && (it.id === currentUid || it.uid === currentUid) && !isRecordDeleted(it));
        if (found) applyFreshProfile(found, false);
      });
    };

    // Always pull latest user profile & server deltas on start / login without blocking UI
    pullProfileFromSecondary();
    void autoHydrateServerFromLocalCache(false);
    void pullSecondaryChanges(false);
    void hydrateAllChannelsFromSecondary(true);

    let unsubFb: (() => void) | null = null;
    const attachProfileListener = () => {
      if (!isSessionStillValid() || unsubFb || isQuotaBlocked()) return;
      try {
        unsubFb = onSnapshot(
          doc(db, 'users', currentUid),
          (snap) => {
            if (!isSessionStillValid()) return;
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
            if (!isSessionStillValid()) return;
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('resource_exhausted')) {
              setQuotaBlocked(2 * 60 * 1000);
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
      if (document.visibilityState === 'visible' && isSessionStillValid()) {
        pullProfileFromSecondary();
        attachProfileListener();
      }
    };
    const handleQuotaCleared = () => {
      if (isSessionStillValid()) attachProfileListener();
    };
    const handleLocalMutation = (e: any) => {
      if (!isSessionStillValid()) return;
      const d = e?.detail;
      if (d?.collection === 'users' && d?.id === currentUid && d?.doc && !d?.deleted) {
        applyFreshProfile({ ...d.doc, ...(d.updatedAtMs ? { _syncUpdatedAtMs: d.updatedAtMs } : {}) }, false);
      }
    };
    window.addEventListener('blackworm_local_record_mutation', handleLocalMutation);
    window.addEventListener('focus', pullProfileFromSecondary);
    window.addEventListener('online', pullProfileFromSecondary);
    window.addEventListener('blackworm_data_refresh', pullProfileFromSecondary);
    window.addEventListener('blackworm_secondary_resync', pullProfileFromSecondary);
    window.addEventListener('blackworm_quota_blocked', pullProfileFromSecondary);
    window.addEventListener('blackworm_quota_cleared', handleQuotaCleared);
    document.addEventListener('visibilitychange', handleVisibility);

    const unsubSec = subscribeSecondaryCollection('users', (events) => {
      if (!isSessionStillValid()) return;
      events.forEach((evt) => {
        if (evt.id === currentUid && evt.doc && !evt.deleted) {
          applyFreshProfile({ ...evt.doc, ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}) }, false);
        }
      });
    });

    attachProfileListener();

    return () => {
      cancelled = true;
      unsubSec();
      if (unsubFb) {
        try { unsubFb(); } catch {}
        unsubFb = null;
      }
      window.removeEventListener('blackworm_local_record_mutation', handleLocalMutation);
      window.removeEventListener('focus', pullProfileFromSecondary);
      window.removeEventListener('online', pullProfileFromSecondary);
      window.removeEventListener('blackworm_data_refresh', pullProfileFromSecondary);
      window.removeEventListener('blackworm_secondary_resync', pullProfileFromSecondary);
      window.removeEventListener('blackworm_quota_blocked', pullProfileFromSecondary);
      window.removeEventListener('blackworm_quota_cleared', handleQuotaCleared);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile?.uid]);

  const handleUpdateProfile = (updatedProfile: UserProfile) => {
    if (!updatedProfile?.uid || activeSessionUidRef.current !== updatedProfile.uid) {
      return;
    }
    const safe = sanitizeSessionProfile(updatedProfile);
    setProfile(safe);
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(safe));
    } catch {}
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-rose-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const clearStoredActiveTabs = () => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('blackworm_active_tab_')) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => sessionStorage.removeItem(k));
    } catch {}
  };

  const handleLoginSuccess = (userProfile: UserProfile) => {
    clearStoredActiveTabs();
    const safe = sanitizeSessionProfile(userProfile);
    activeSessionUidRef.current = safe.uid;
    sessionGenerationRef.current += 1;
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(safe));
    } catch {}
    setProfile(safe);
    broadcastSessionEvent('login', safe.uid);
    // Sync on Start immediately after login
    void startBackgroundSync();
    void pullSecondaryChanges(true);
    void hydrateAllChannelsFromSecondary(true);
  };

  const handleLogout = () => {
    clearStoredActiveTabs();
    activeSessionUidRef.current = null;
    sessionGenerationRef.current += 1;
    try {
      localStorage.removeItem(PROFILE_STORAGE_KEY);
    } catch {}
    try {
      const proto = String(window.location.protocol || '').toLowerCase();
      if (proto === 'http:' || proto === 'https:') {
        const logoutTarget = isPackagedApkShell() ? (window.location.pathname || '/') : '/';
        window.history.replaceState({ loggedOut: true }, '', logoutTarget);
      } else {
        window.history.replaceState({ loggedOut: true }, '');
      }
    } catch {}
    setProfile(null);
    broadcastSessionEvent('logout', null);
  };

  return (
    <div className="antialiased">
      <ErrorBoundary key={profile?.uid || 'logged-out'} resetKey={profile?.uid || 'logged-out'}>
        {profile ? (
          <Dashboard
            key={profile.uid}
            profile={profile}
            lang={lang}
            onLogout={handleLogout}
            onProfileUpdate={handleUpdateProfile}
          />
        ) : (
          <Login key={`login-${sessionGenerationRef.current}`} onLoginSuccess={handleLoginSuccess} />
        )}
      </ErrorBoundary>
    </div>
  );
}
