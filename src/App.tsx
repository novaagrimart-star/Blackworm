import React, { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile } from './lib/auth';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { Language } from './lib/i18n';

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    const saved = localStorage.getItem('blackworm_user_profile');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && parsed.uid) {
          return parsed;
        }
      } catch (e) {
        console.error('Failed to parse saved profile:', e);
      }
      localStorage.removeItem('blackworm_user_profile');
    }
    return null;
  });
  const lang: Language = 'en';
  const [loading, setLoading] = useState(false);

  // Live real-time listener for current logged-in user profile changes
  useEffect(() => {
    if (!profile?.uid) return;
    const unsub = onSnapshot(
      doc(db, 'users', profile.uid),
      (snap) => {
        if (snap.exists()) {
          const freshData = snap.data();
          const merged: UserProfile = {
            ...profile,
            ...freshData,
            uid: profile.uid,
          } as UserProfile;
          setProfile(merged);
          try {
            localStorage.setItem('blackworm_user_profile', JSON.stringify(merged));
          } catch (e) {
            console.warn('Failed to update localStorage profile:', e);
          }
        }
      },
      (err) => {
        console.warn('Real-time profile listener error:', err);
      }
    );
    return () => unsub();
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
    localStorage.setItem('blackworm_user_profile', JSON.stringify(userProfile));
  };

  const handleLogout = () => {
    setProfile(null);
    localStorage.removeItem('blackworm_user_profile');
  };

  return (
    <div className="antialiased">
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
    </div>
  );
}
