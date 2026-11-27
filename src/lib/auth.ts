import { useEffect, useState } from 'react';

export interface UserProfile {
  uid: string;
  fullName: string;
  emailId: string | null;
  role: 'admin' | 'owner' | 'staff' | 'dealer' | 'asm' | 'sr_sales_exec' | 'sales_exec' | 'sales_officer' | 'dev_officer' | 'sr_dev_officer' | 'field_officer' | string;
  mobileNumber?: string;
  address?: string;
  center?: string;
  designation?: string;
  loginId?: string;
  userCode?: string;
  password?: string;
  allowedModules?: string[];
  createdAt: string;
  bankName?: string;
  bankAddress?: string;
  accountNumber?: string;
  ifscCode?: string;
  hasSecurityCheque?: boolean;
  securityChequeNumber?: string;
}

/**
 * Checks if a user has Admin or Owner designation/role privileges.
 * Supports:
 * - role: 'admin' or 'owner'
 * - designation containing 'admin', 'administrator', 'owner', 'md', 'managing director' (case-insensitive)
 * - loginId: 'admin', 'owner', 'superadmin'
 * Any future user added with 'Admin' designation or role will automatically get full access.
 */
export function isAdmin(user?: Partial<UserProfile> | null): boolean {
  if (!user) return false;
  const role = (user.role || '').toLowerCase().trim();
  const designation = (user.designation || '').toLowerCase().trim();
  const loginId = (user.loginId || '').toLowerCase().trim();

  if (role === 'admin' || role === 'owner') return true;
  if (
    designation.includes('admin') || 
    designation.includes('administrator') || 
    designation.includes('owner') || 
    /\bmd\b/i.test(designation) || 
    designation.includes('managing director')
  ) {
    return true;
  }
  if (loginId === 'admin' || loginId === 'owner' || loginId === 'superadmin') return true;
  return false;
}

export function isGodownIncharge(user?: Partial<UserProfile> | null): boolean {
  if (!user) return false;
  const role = (user.role || '').toLowerCase().trim();
  const designation = (user.designation || '').toLowerCase().trim();
  return (
    role === 'godown_incharge' ||
    role === 'warehouse_incharge' ||
    designation.includes('godown') ||
    designation.includes('warehouse') ||
    designation.includes('store incharge') ||
    designation.includes('store in-charge')
  );
}

export function isOfficeOrFactoryStaff(user?: Partial<UserProfile> | null): boolean {
  if (!user) return false;
  const role = (user.role || '').toLowerCase().trim();
  const designation = (user.designation || '').toLowerCase().trim();
  return (
    role === 'office_staff' ||
    role === 'factory_staff' ||
    designation.includes('office staff') ||
    designation.includes('factory staff')
  );
}

/**
 * True for non-admin Godown Incharge / Office Staff / Factory Staff logins
 * who should receive Admin-approved orders strictly in the dispatch image-slip format
 * (Product Name, Packing, Quantity in Box/Nos only — no rates/money).
 */
export function isGodownOrOfficeStaff(user?: Partial<UserProfile> | null): boolean {
  if (!user || isAdmin(user)) return false;
  return isGodownIncharge(user) || isOfficeOrFactoryStaff(user);
}

/**
 * Checks if a user is permitted to access a given module ID.
 * Admins/Owners get access to all modules.
 * Other users strictly get access ONLY if the module was granted by Admin in allowedModules.
 */
export function canAccessModule(user: Partial<UserProfile> | null | undefined, moduleId: string): boolean {
  if (!user) return false;
  if (isAdmin(user)) return true;
  // User data should be visible to every user as requested
  if (moduleId === 'user') return true;
  // Godown Incharge / Office Staff Attendance icon: ONLY Admin & Godown Incharge (or explicitly granted)
  if (moduleId === 'office_staff') {
    if (isGodownIncharge(user)) return true;
    return Boolean(Array.isArray(user.allowedModules) && user.allowedModules.includes('office_staff'));
  }
  if (!user.allowedModules || !Array.isArray(user.allowedModules)) return false;
  if (moduleId === 'location') {
    return user.allowedModules.includes('location') || user.allowedModules.includes('dealer');
  }
  return user.allowedModules.includes(moduleId);
}

/**
 * Checks if a data record belongs to the logged-in user.
 * Admins can see all records.
 * Non-admin users strictly see only their own data (by uid, loginId, userCode, fullName, or phone).
 */
export function isUserRecord(record: any, user?: Partial<UserProfile> | null): boolean {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (!record) return false;

  const userUid = (user.uid || '').trim().toLowerCase();
  const userLoginId = (user.loginId || '').trim().toLowerCase();
  const userCode = (user.userCode || '').trim().toLowerCase();
  const userName = (user.fullName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const userMobile = (user.mobileNumber || '').replace(/\D/g, '').slice(-10);

  // 1. UID Check (Exact match)
  const recUid = (record.userId || record.ownerId || record.created_by_user_id || record.createdByUid || record.collectedByUid || record.uid || '').toString().trim().toLowerCase();
  if (userUid && recUid && recUid === userUid) return true;

  // 2. Login ID Check (Exact match, ignoring generic 'admin')
  const recLoginId = (record.loginId || '').toString().trim().toLowerCase();
  if (userLoginId && recLoginId && recLoginId !== 'admin' && recLoginId === userLoginId) return true;

  // 3. User Code Check (Exact / normalized code match)
  const recCode = (record.userCode || record.createdByUserCode || '').toString().trim().toLowerCase();
  if (userCode && recCode && (recCode === userCode || recCode.replace(/^emp-/, '') === userCode.replace(/^emp-/, ''))) return true;

  // 4. Name Match (Exact normalized full-name match)
  const recName = (record.createdByName || record.created_by_name || record.officerName || record.collectedByName || record.userName || record.fullName || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
  if (userName && recName && recName === userName) return true;

  // 5. Phone Match
  const recMobile = (record.mobileNumber || record.contactNumber || '').toString().replace(/\D/g, '').slice(-10);
  if (userMobile && recMobile && recMobile.length >= 10 && recMobile === userMobile) return true;

  // 6. Orphaned-record fallback: if ALL primary creator/owner metadata is missing, match updater
  const hasPrimaryOwnerMeta = Boolean(
    record.userId ||
      record.ownerId ||
      record.created_by_user_id ||
      record.createdByUid ||
      record.collectedByUid ||
      record.uid ||
      record.createdByName ||
      record.created_by_name ||
      record.officerName ||
      record.loginId ||
      record.userCode
  );
  if (!hasPrimaryOwnerMeta) {
    const updUid = (record.updatedByUid || '').toString().trim().toLowerCase();
    if (userUid && updUid && updUid === userUid) return true;
    const updName = (record.updatedByName || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
    if (userName && updName && updName === userName) return true;
  }

  return false;
}

export function useAuth() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem('blackworm_user_profile');
    if (saved) {
      try {
        setProfile(JSON.parse(saved));
      } catch (e) {}
    }
    setLoading(false);
  }, []);

  return { user: profile, profile, loading };
}
