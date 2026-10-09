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
    designation.includes('md') || 
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

  // Check IDs in record
  const recUid = (record.ownerId || record.userId || record.collectedByUid || record.createdByUid || record.uid || '').toString().trim().toLowerCase();
  if (userUid && recUid === userUid) return true;

  // Check Login ID in record
  const recLoginId = (record.loginId || '').toString().trim().toLowerCase();
  if (userLoginId && recLoginId === userLoginId) return true;

  // Check User Code in record
  const recCode = (record.userCode || record.dealerCode || '').toString().trim().toLowerCase();
  if (userCode && recCode && (recCode === userCode || recCode.replace(/^emp-/, '') === userCode.replace(/^emp-/, ''))) return true;

  // Check Full Name
  const recName = (record.createdByName || record.collectedByName || record.officerName || record.userName || record.fullName || '').toString().trim().toLowerCase();
  if (userName && recName && (recName === userName || recName.includes(userName) || userName.includes(recName))) return true;

  // Check Phone Number
  const recMobile = (record.mobileNumber || record.contactNumber || '').toString().replace(/\D/g, '').slice(-10);
  if (userMobile && recMobile && recMobile.length >= 10 && recMobile === userMobile) return true;

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
