import React, { useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db, getFriendlyErrorMessage, isQuotaExceededError } from '../firebase';
import { UserProfile } from '../lib/auth';
import { User, Lock, ArrowRight, AlertCircle, ShieldCheck, Eye, EyeOff, Loader2, Key } from 'lucide-react';
import {
  isQuotaBlocked,
  setQuotaBlocked,
  trackFirestoreUsage,
  safeFirestoreSet,
  mergeWithLocalData,
  safeLocalStorageSet,
  toTimestampMs,
} from '../lib/dataService';
import { fetchSecondaryCollection, bootstrapCollectionToSecondary } from '../lib/secondaryDb';
import { resolveApiUrl } from '../lib/appVersion';
import { useBranding } from '../lib/branding';

interface LoginProps {
  onLoginSuccess: (profile: UserProfile) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const { logoUrl, logoSize } = useBranding();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);

    try {
      const trimmedId = loginId.trim();
      const trimmedPass = password.trim();

      if (!trimmedId) {
        setError('Please enter Login ID.');
        setLoading(false);
        return;
      }
      if (!trimmedPass) {
        setError('Please enter Password.');
        setLoading(false);
        return;
      }

      const isOnline = typeof navigator === 'undefined' || navigator.onLine;

      // Fast server-side credential verification when online (keeps raw passwords off login responses)
      if (isOnline) {
        const authController = new AbortController();
        const authTimer = setTimeout(() => authController.abort(), 3000);
        try {
          const authResp = await fetch(resolveApiUrl('/api/auth/login'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginId: trimmedId, password: trimmedPass }),
            signal: authController.signal,
          });
          const authJson = await authResp.json().catch(() => null);
          if (authJson?.status === 'verified' && authJson?.profile) {
            onLoginSuccess(authJson.profile as UserProfile);
            return;
          }
          if (authJson?.status === 'inactive') {
            setError('Account is Inactive. Please contact administrator.');
            return;
          }
          // If Secondary DB had the user and password didn't match, still double-check Firestore below ONLY in case password was just changed on Firestore
        } catch {
          // Non-blocking fallback to Firestore + local vault login
        } finally {
          clearTimeout(authTimer);
        }
      }

      const lowerId = trimmedId.toLowerCase();
      const numericDigits = trimmedId.replace(/\D/g, ''); // Extract numbers only
      const last10Digits = numericDigits.length >= 10 ? numericDigits.slice(-10) : numericDigits;

      // 1 & 2. Parallel lookup from Primary (Firebase) + Secondary (SQLite WAL / External Mirror)
      // Always query Secondary even if Firebase isn't flagged as quota-blocked yet, because another device may have written updates only to Secondary DB!
      let fbUsers: any[] = [];
      let secUsers: any[] = [];
      const archivedSet = new Set<string>();
      let firebaseChecked = false;

      await Promise.all([
        (async () => {
          if (!isQuotaBlocked() && isOnline) {
            try {
              const fbPromise = getDocs(collection(db, 'users'));
              const usersSnap = await Promise.race([
                fbPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
              ]);
              if (usersSnap) {
                trackFirestoreUsage('read', Math.max(1, usersSnap.docs.length));
                firebaseChecked = true;
                if (!usersSnap.empty) {
                  usersSnap.docs.forEach((d) => {
                    const data = d.data();
                    if (data?.isArchived) archivedSet.add(d.id);
                    else fbUsers.push({ ...data, uid: d.id, id: d.id });
                  });
                  if (!usersSnap.metadata?.fromCache && fbUsers.length > 0) {
                    bootstrapCollectionToSecondary('users', fbUsers);
                  }
                }
              } else {
                // Background reconcile without stalling login UI
                void fbPromise
                  .then((lateSnap) => {
                    if (lateSnap && !lateSnap.empty && !lateSnap.metadata?.fromCache) {
                      const lateUsers = lateSnap.docs
                        .map((d) => ({ ...d.data(), uid: d.id, id: d.id }))
                        .filter((u: any) => !u.isArchived);
                      if (lateUsers.length > 0) {
                        bootstrapCollectionToSecondary('users', lateUsers);
                      }
                    }
                  })
                  .catch((err) => {
                    if (isQuotaExceededError(err)) setQuotaBlocked(2 * 60 * 1000);
                  });
              }
            } catch (networkErr: any) {
              if (isQuotaExceededError(networkErr)) {
                setQuotaBlocked(2 * 60 * 1000);
              }
              console.warn('Primary login lookup fallback:', networkErr);
            }
          }
        })(),
        (async () => {
          if (isOnline) {
            try {
              const secRes = await fetchSecondaryCollection('users', { limit: 1000 });
              if (secRes.ok) {
                (secRes.archivedIds || []).forEach((id) => archivedSet.add(id));
                secUsers = (secRes.items || [])
                  .filter((u: any) => u && !u.isArchived)
                  .map((u: any) => ({ ...u, uid: u.uid || u.id, id: u.id || u.uid }));
              }
            } catch {}
          }
        })(),
      ]);

      // Merge Firebase + Secondary choosing newest timestamp per user UID
      const userMap = new Map<string, any>();
      const getUserTs = (u: any) =>
        Math.max(Number(u?._syncUpdatedAtMs) || 0, toTimestampMs(u?.updatedAt || u?.createdAt));

      [...fbUsers, ...secUsers].forEach((u) => {
        const uid = String(u?.uid || u?.id || '').trim();
        if (!uid || archivedSet.has(uid) || u?.isArchived) return;
        const prev = userMap.get(uid);
        if (!prev || getUserTs(u) >= getUserTs(prev)) {
          userMap.set(uid, prev ? { ...prev, ...u, uid, id: uid } : { ...u, uid, id: uid });
        }
      });

      let allUsers: any[] = Array.from(userMap.values());
      if (allUsers.length > 0) {
        safeLocalStorageSet('blackworm_cached_users', JSON.stringify(allUsers));
      }

      // 3. Seed initial owner only when BOTH Firebase and Secondary are genuinely empty
      if (allUsers.length === 0 && firebaseChecked && secUsers.length === 0) {
        const initialOwner = {
          uid: 'user_1791302472208',
          userCode: 'EMP-001',
          fullName: 'SHRIDHAR BALKRUSHNA SHINDE',
          designation: 'MANAGING DIRECTOR',
          center: 'SANGLI',
          mobileNumber: '7798716201',
          altPhone: '',
          emailId: 'blackwormagritechpvtltd@gmail.com',
          role: 'owner',
          address: 'SANGLI',
          village: 'SANGLI',
          taluka: 'MIRAJ',
          district: 'SANGLI',
          state: 'Maharashtra',
          pinCode: '416409',
          dateOfBirth: '1985-05-15',
          joiningDate: '2024-01-01',
          aadhaarNo: '',
          panNo: '',
          loginId: 'admin',
          password: 'bw@123',
          status: 'Active',
          allowedModules: ['target', 'user', 'order', 'collection', 'calculator', 'price', 'dealer', 'travel', 'scheme', 'report', 'setting'],
          createdAt: new Date().toISOString(),
        };
        await safeFirestoreSet('users', initialOwner.uid, initialOwner, { merge: true });
        allUsers = [initialOwner];
        safeLocalStorageSet('blackworm_cached_users', JSON.stringify(allUsers));
      }

      // 4. Local cache / LocalStorage fallback (3rd tier offline resilience)
      if (allUsers.length === 0) {
        const localUsers = mergeWithLocalData<any>('users', []);
        if (localUsers.length > 0) {
          allUsers = localUsers;
        } else {
          try {
            const cached = localStorage.getItem('blackworm_cached_users');
            if (cached) {
              allUsers = JSON.parse(cached);
            }
          } catch {}
        }
      }

      // Prioritized matching: exact loginId > userCode > emailId > mobileNumber > owner-alias
      const getMatchRank = (u: any): number => {
        if (!u || u.isArchived || u.is_deleted) return 99;
        const storedLoginId = (u.loginId || '').toString().trim().toLowerCase();
        if (storedLoginId && storedLoginId === lowerId) return 1;
        if (u.userCode && u.userCode.toString().trim().toLowerCase() === lowerId) return 2;
        const storedEmail = (u.emailId || '').toString().trim().toLowerCase();
        if (storedEmail && storedEmail === lowerId) return 3;
        const storedMobile = (u.mobileNumber || '').toString().replace(/\D/g, '').slice(-10);
        if (last10Digits && storedMobile && storedMobile === last10Digits) return 4;
        const storedName = (u.fullName || '').toString().trim().toLowerCase();
        if (storedName && (lowerId === 'shridhar' || lowerId === 'shridhar shinde' || lowerId === 'shinde')) {
          if (u.role === 'owner') return 5;
        }
        return 99;
      };

      const candidates = allUsers
        .map((u: any) => ({ user: u, rank: getMatchRank(u) }))
        .filter((entry) => entry.rank < 99)
        .sort((a, b) => a.rank - b.rank);

      if (candidates.length === 0) {
        setError('Invalid Login ID. Please enter the correct Login ID.');
        return;
      }

      // First try active candidates matching password (handles shared mobile numbers accurately)
      const activeCandidates = candidates.filter((c) => c.user.status !== 'Inactive');
      if (activeCandidates.length === 0) {
        setError('Account is Inactive. Please contact administrator.');
        return;
      }

      const passwordMatched = activeCandidates.find((c) => {
        const storedPass = (
          c.user.password !== undefined &&
          c.user.password !== null &&
          String(c.user.password).trim() !== ''
            ? String(c.user.password)
            : 'bw@123'
        ).trim();
        return trimmedPass === storedPass;
      });

      if (passwordMatched) {
        const { password: _omittedPass, ...safeUser } = passwordMatched.user;
        onLoginSuccess(safeUser as UserProfile);
      } else {
        setError('Incorrect Password. Please check and try again.');
      }
    } catch (err: any) {
      console.error('Login error:', err);
      setError(getFriendlyErrorMessage(err, 'लॉगिन करताना अडचण आली. कृपया पुन्हा प्रयत्न करा.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="min-h-dvh flex flex-col items-center justify-start sm:justify-center bg-slate-50 p-4 sm:p-6 font-sans"
      style={{
        paddingTop: 'max(1.5rem, calc(1rem + env(safe-area-inset-top, 0px)))',
        paddingBottom: 'max(2.5rem, calc(1.5rem + env(safe-area-inset-bottom, 0px)))',
      }}
    >
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-xl p-6 sm:p-8 border border-slate-100 flex flex-col items-center text-center">
        {/* Brand Logo Header */}
        <div className="mb-4 flex items-center justify-center overflow-hidden">
          {logoUrl ? (
            <img 
              src={logoUrl} 
              alt="Blackworm Agritech"
              style={{ width: `${Math.min(logoSize, 90)}px`, height: `${Math.min(logoSize, 90)}px` }}
              className="object-contain drop-shadow-sm"
            />
          ) : (
            <div className="w-16 h-16 bg-rose-50 rounded-2xl flex items-center justify-center shadow-inner">
              <ShieldCheck className="w-9 h-9 text-rose-600" />
            </div>
          )}
        </div>
        
        <h1 className="text-xl sm:text-2xl font-black text-rose-600 tracking-tight leading-tight mb-1 uppercase">
          BLACKWORM AGRITECH
        </h1>
        <p className="text-slate-400 mb-6 text-[10px] font-bold uppercase tracking-[0.2em]">
          Management Information System
        </p>

        {error && (
          <div className="mb-4 w-full p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-start gap-2 text-left">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            <span className="font-semibold leading-tight">{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="w-full space-y-4 text-left">
          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">
              Login ID
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-3.5" />
              <input
                type="text"
                required
                autoComplete="username"
                placeholder="Login ID"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                className="w-full pl-9 pr-3 py-3 border border-slate-200 rounded-xl text-xs sm:text-sm font-medium focus:ring-2 focus:ring-rose-500 focus:outline-none focus:border-rose-500 transition-all bg-slate-50/50"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3.5" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-9 pr-10 py-3 border border-slate-200 rounded-xl text-xs sm:text-sm font-medium focus:ring-2 focus:ring-rose-500 focus:outline-none focus:border-rose-500 transition-all bg-slate-50/50"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-3.5 text-slate-400 hover:text-slate-600 transition"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Glassmorphic Liquid Login Button */}
          <button
            type="submit"
            disabled={loading}
            className="group relative w-full py-3.5 px-6 rounded-2xl text-xs sm:text-sm font-black transition-all duration-500 overflow-hidden shadow-lg border border-slate-200/80 active:scale-95 disabled:opacity-75 disabled:cursor-not-allowed mt-2 cursor-pointer bg-white/70 backdrop-blur-md"
            style={{
              boxShadow: '0 8px 30px rgba(225, 29, 72, 0.15)',
            }}
          >
            {/* Liquid Background Layer that fills up smoothly like liquid on hover / active / loading */}
            <div 
              className={`absolute inset-0 bg-gradient-to-r from-rose-600 via-rose-500 to-indigo-600 transition-all duration-700 ease-out pointer-events-none ${
                loading 
                  ? 'translate-y-0 opacity-100' 
                  : 'translate-y-[102%] group-hover:translate-y-0 opacity-90 group-hover:opacity-100'
              }`}
            >
              {/* Liquid Wave Ripple on the surface */}
              <div className="absolute -top-3 left-0 right-0 h-4 bg-gradient-to-r from-rose-400 via-pink-300 to-indigo-400 opacity-75 blur-[2px] animate-pulse" />
              {/* Shimmer light bar across liquid */}
              <div className="absolute inset-0 bg-gradient-to-b from-white/20 via-transparent to-black/10" />
            </div>

            {/* Glowing liquid ambient blur */}
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-rose-500/20 blur-xl pointer-events-none" />

            {/* Button Label and Icons with smooth color transition */}
            <div className="relative z-10 flex items-center justify-center gap-2.5 transition-colors duration-500 text-slate-800 group-hover:text-white">
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                  <span className="tracking-wide text-white font-black">Logging In...</span>
                </>
              ) : (
                <>
                  <Key className="w-4 h-4 text-rose-600 group-hover:text-white transition-colors duration-300 transform group-hover:rotate-12" />
                  <span className="tracking-wider uppercase font-black text-[13px] sm:text-sm">Login</span>
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white group-hover:translate-x-1 transition-all duration-300" />
                </>
              )}
            </div>
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-slate-100 w-full flex items-center justify-center gap-2 text-[10px] text-slate-400 uppercase tracking-wider font-bold">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
          <span>Secure Enterprise Access</span>
        </div>
      </div>
    </div>
  );
};
