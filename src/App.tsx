import React, { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile } from './lib/auth';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { Language } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startBackgroundSync, isQuotaBlocked, setQuotaBlocked, trackFirestoreUsage } from './lib/dataService';
import { subscribeSecondaryCollection } from './lib/secondaryDb';

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('blackworm_user_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && parsed.uid) {
          return parsed;
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

  // Initialize background sync once on app load
  useEffect(() => {
    startBackgroundSync();
  }, []);

  // Live real-time listener for current logged-in user profile changes (Primary + Secondary DB)
  useEffect(() => {
    const currentUid = profile?.uid;
    if (!currentUid) return;

    const applyFreshProfile = (freshData: Record<string, any>) => {
      setProfile((prev) => {
        const merged: UserProfile = {
          ...(prev || {}),
          ...freshData,
          uid: currentUid,
        } as UserProfile;
        try {
          localStorage.setItem('blackworm_user_profile', JSON.stringify(merged));
        } catch (e) {
          console.warn('Failed to update localStorage profile:', e);
        }
        return merged;
      });
    };

    const unsubSec = subscribeSecondaryCollection('users', (events) => {
      events.forEach((evt) => {
        if (evt.id === currentUid && evt.doc && !evt.deleted) {
          applyFreshProfile(evt.doc);
        }
      });
    });

    let unsubFb: (() => void) | null = null;
    if (!isQuotaBlocked()) {
      unsubFb = onSnapshot(
        doc(db, 'users', currentUid),
        (snap) => {
          trackFirestoreUsage('read', 1);
          if (snap.exists()) {
            applyFreshProfile(snap.data());
          }
        },
        (err) => {
          const msg = String(err?.message || '').toLowerCase();
          if (msg.includes('quota') || msg.includes('resource_exhausted')) {
            setQuotaBlocked(15 * 60 * 1000);
          }
          console.warn('Real-time profile listener error:', err);
        }
      );
    }

    return () => {
      unsubSec();
      if (unsubFb) unsubFb();
    };
  }, [profile?.uid]);

  const handleUpdateProfile = (updatedProfile: UserProfile) => {
    setProfile(updatedProfile);
    try {
      localStorage.setItem('blackworm_user_profile', JSON.stringify(updatedProfile));
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
    setProfile(userProfile);
    try {
      localStorage.setItem('blackworm_user_profile', JSON.stringify(userProfile));
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
