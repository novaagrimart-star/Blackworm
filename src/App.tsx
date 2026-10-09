import React, { useState, useEffect } from 'react';
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
        <Dashboard profile={profile} lang={lang} onLogout={handleLogout} />
      ) : (
        <Login onLoginSuccess={handleLoginSuccess} />
      )}
    </div>
  );
}
