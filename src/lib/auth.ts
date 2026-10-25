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
  if (!user.allowedModules || !Array.isArray(user.allowedModules)) return false;
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
  const userName = (user.fullName || '').trim().toLowerCase();
  const userMobile = (user.mobileNumber || '').replace(/\D/g, '').slice(-10);

  // 1. UID Check (userId, ownerId, createdByUid, created_by_user_id, collectedByUid, dealerOfficerId, assignedToUid, officerUid)
  const recUids = [
    record.userId,
    record.ownerId,
    record.created_by_user_id,
    record.createdByUid,
    record.collectedByUid,
    record.dealerOfficerId,
    record.assignedToUid,
    record.officerUid,
    record.uid
  ].filter(Boolean).map(x => String(x).trim().toLowerCase());

  if (userUid && recUids.some(id => id === userUid || id.includes(userUid) || userUid.includes(id))) {
    return true;
  }

  // 2. Login ID Check
  const recLoginIds = [
    record.loginId,
    record.officerLoginId,
    record.userLoginId,
    record.assignedToLoginId
  ].filter(Boolean).map(x => String(x).trim().toLowerCase());

  if (userLoginId && recLoginIds.some(id => id === userLoginId || id.includes(userLoginId))) {
    return true;
  }

  // 3. User Code Check (EMP-XX or XX)
  const recCodes = [
    record.userCode,
    record.createdByUserCode,
    record.officerCode,
    record.dealerOfficerCode
  ].filter(Boolean).map(x => String(x).trim().toLowerCase());

  if (userCode && recCodes.some(c => c === userCode || c.replace(/^emp-/, '') === userCode.replace(/^emp-/, ''))) {
    return true;
  }

  // 4. Officer / Creator Name Match (Title Case / Uppercase agnostic)
  const recNames = [
    record.createdByName,
    record.created_by_name,
    record.officerName,
    record.collectedByName,
    record.dealerOfficerName,
    record.assignedToName,
    record.userName,
    record.fullName
  ].filter(Boolean).map(x => String(x).trim().toLowerCase());

  if (userName && recNames.some(n => n === userName || n.includes(userName) || userName.includes(n))) {
    return true;
  }

  // 5. Phone Match
  const recMobiles = [
    record.mobileNumber,
    record.contactNumber,
    record.officerMobile,
    record.creatorMobile
  ].filter(Boolean).map(x => String(x).replace(/\D/g, '').slice(-10));

  if (userMobile && userMobile.length >= 10 && recMobiles.includes(userMobile)) {
    return true;
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
