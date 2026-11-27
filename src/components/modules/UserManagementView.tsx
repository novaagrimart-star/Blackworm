import React, { useState, useEffect, useRef, useMemo } from 'react';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { db, getFriendlyErrorMessage, isQuotaExceededError } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit, syncOfficerDetailsEverywhere, safeFirestoreSet, safeFirestoreDelete, toTimestampMs, getLocalDateStr, mergeWithLocalData, isQuotaBlocked, setQuotaBlocked, formatDisplayDate, safeLocalStorageSet } from '../../lib/dataService';
import { useSharedUsers } from '../../lib/realtimeStore';
import { useBranding } from '../../lib/branding';
import { subscribeSecondaryCollection, fetchSecondaryCollection } from '../../lib/secondaryDb';
import { toTitleCase } from '../../lib/utils';
import { compressImageFile } from '../../lib/imageCompression';
import { Language, translations } from '../../lib/i18n';
import { getRecordUpdateMs } from '../../lib/moduleUpdates';
import { ModuleUpdateBanner, useModuleRecordHighlights } from '../ModuleUpdateBanner';
import { CustomDialogModal } from '../CustomDialogModal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Users, 
  UserPlus, 
  Search, 
  Trash2, 
  Edit3, 
  Check, 
  X, 
  Camera, 
  Image as ImageIcon,
  Phone, 
  Mail, 
  MapPin, 
  Key, 
  Lock, 
  Eye, 
  EyeOff, 
  CheckCircle2, 
  Download, 
  Loader2, 
  Save, 
  ChevronDown,
  ChevronUp,
  Target, 
  ShoppingBag, 
  IndianRupee, 
  Calculator, 
  FileText, 
  Gift, 
  BarChart3, 
  Settings,
  ShieldCheck,
  Clock,
  Warehouse
} from 'lucide-react';

export interface SystemModuleItem {
  id: string;
  en: string;
  mr: string;
  icon: any;
}

export const SYSTEM_MODULES: SystemModuleItem[] = [
  { id: 'target', en: 'Target Sheet', mr: 'टार्गेट शीट', icon: Target },
  { id: 'order', en: 'Orders', mr: 'ऑर्डर्स', icon: ShoppingBag },
  { id: 'collection', en: 'Collections', mr: 'कलेक्शन', icon: IndianRupee },
  { id: 'dealer', en: 'Dealer Forms', mr: 'डीलर फॉर्म्स', icon: Users },
  { id: 'calculator', en: 'Outstanding', mr: 'आउटस्टँडिंग', icon: FileText },
  { id: 'price', en: 'Price List', mr: 'प्राईस लिस्ट', icon: FileText },
  { id: 'travel', en: 'Travel Record', mr: 'ट्रॅव्हल रेकॉर्ड', icon: MapPin },
  { id: 'scheme', en: 'Schemes & Offers', mr: 'स्कीम व ऑफर्स', icon: Gift },
  { id: 'report', en: 'Reports & Analytics', mr: 'रिपोर्ट्स व अ‍ॅनालिटिक्स', icon: BarChart3 },
  { id: 'user', en: 'User Management', mr: 'युजर मॅनेजमेंट', icon: UserPlus },
  { id: 'office_staff', en: 'Godown / Office Staff', mr: 'गोडाऊन / ऑफिस स्टाफ', icon: Warehouse },
  { id: 'setting', en: 'Settings', mr: 'सेटिंग्ज', icon: Settings },
];

export interface SystemRoleItem {
  id: string;
  label: string;
  designation: string;
}

export const SYSTEM_ROLES: SystemRoleItem[] = [
  { id: 'owner', label: 'Owner ( MD )', designation: 'Owner ( MD )' },
  { id: 'asm', label: 'ASM', designation: 'ASM' },
  { id: 'sr_sales_exec', label: 'Sr. Sales executive', designation: 'Sr. Sales Executive' },
  { id: 'sales_exec', label: 'Sales executive', designation: 'Sales Executive' },
  { id: 'sales_officer', label: 'Sales officer', designation: 'Sales Officer' },
  { id: 'dev_officer', label: 'Development officer', designation: 'Development Officer' },
  { id: 'sr_dev_officer', label: 'Sr. development officer', designation: 'Sr. Development Officer' },
  { id: 'field_officer', label: 'Field officer', designation: 'Field Officer' },
  { id: 'godown_incharge', label: 'Godown Incharge', designation: 'Godown Incharge' },
  { id: 'office_staff', label: 'Office Staff', designation: 'Office Staff' },
  { id: 'factory_staff', label: 'Factory Staff', designation: 'Factory Staff' },
  { id: 'admin', label: 'Admin', designation: 'Admin Officer' },
  { id: 'dealer', label: 'Dealer', designation: 'Authorized Dealer' },
];

export const DESIGNATION_OPTIONS: string[] = [
  'Field Officer',
  'Development Officer',
  'Sr. Development Officer',
  'Sales Officer',
  'Sales Executive',
  'Sr. Sales Executive',
  'ASM',
  'Office Staff',
  'Factory Staff',
  'Godown Incharge',
  'Admin Officer',
  'Owner ( MD )',
  'Authorized Dealer',
];

export const getDefaultDesignationForRole = (r: string): string => {
  const found = SYSTEM_ROLES.find((item) => item.id === r);
  return found ? found.designation : 'Field Officer';
};

export const getDefaultModulesForRole = (r: string): string[] => {
  switch (r) {
    case 'owner':
    case 'admin':
      return ['target', 'order', 'collection', 'dealer', 'calculator', 'price', 'travel', 'scheme', 'report', 'user', 'office_staff', 'setting'];
    case 'godown_incharge':
      return ['order', 'office_staff'];
    case 'office_staff':
      return ['order'];
    case 'factory_staff':
      return [];
    case 'dealer':
      return ['order', 'price', 'scheme', 'calculator'];
    default:
      return ['target', 'order', 'collection', 'dealer', 'calculator', 'price', 'travel', 'scheme'];
  }
};

/**
 * Calculates sequential user number / code:
 * Owner is 1. Subsequent users get the next available number (2, 3, 4, etc.).
 */
export const calculateNextUserCode = (selectedRole: string, existingUsers: DetailedUserProfile[]): string => {
  const numericValues: number[] = [];
  existingUsers.forEach((u) => {
    const raw = (u.userCode || '').trim().toUpperCase();
    if (raw.startsWith('EMP-')) {
      const numPart = raw.replace('EMP-', '');
      const parsed = parseInt(numPart, 10);
      if (!isNaN(parsed)) numericValues.push(parsed);
    } else {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) numericValues.push(parsed);
    }
  });

  let nextNum = 1;
  if (numericValues.length > 0) {
    nextNum = Math.max(...numericValues) + 1;
  }

  return `EMP-${String(nextNum).padStart(2, '0')}`;
};

/**
 * Safely converts any Date, Timestamp, number, or string value to YYYY-MM-DD string
 */
export const formatSafeDateString = (val: any): string => {
  if (!val) return new Date().toISOString().slice(0, 10);
  if (typeof val === 'string') {
    if (val.length >= 10 && val.includes('-')) return val.slice(0, 10);
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return val;
  }
  if (val && typeof val.toDate === 'function') {
    try {
      return val.toDate().toISOString().slice(0, 10);
    } catch (e) {}
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && !isNaN(val)) {
    return new Date(val).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
};

export interface DetailedUserProfile extends UserProfile {
  userCode?: string;
  designation?: string;
  center?: string;
  loginId?: string;
  password?: string;
  photoUrl?: string;
  altPhone?: string;
  address?: string;
  village?: string;
  taluka?: string;
  district?: string;
  state?: string;
  pinCode?: string;
  dateOfBirth?: string;
  joiningDate?: string;
  aadhaarNo?: string;
  panNo?: string;
  status?: 'Active' | 'Inactive';
  allowedModules?: string[];
  updatedByUid?: string;
  updatedByName?: string;
  updatedAt?: string;
  createdAt: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
  onProfileUpdate?: (profile: UserProfile) => void;
}

export const UserManagementView: React.FC<Props> = ({ profile, lang, onProfileUpdate }) => {
  const t = translations[lang];
  const { users: sharedUsers, setUsersOptimistic } = useSharedUsers();
  const users = sharedUsers as DetailedUserProfile[];
  const [viewMode, setViewMode] = useState<'list' | 'form'>('list');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showAccessList, setShowAccessList] = useState(false);

  // Form State
  const [currentUid, setCurrentUid] = useState<string | null>(null);
  const [userCode, setUserCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [designation, setDesignation] = useState('FIELD OFFICER');
  const [center, setCenter] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [emailId, setEmailId] = useState('');
  const [role, setRole] = useState<string>('field_officer');
  const [address, setAddress] = useState('');
  const [village, setVillage] = useState('');
  const [taluka, setTaluka] = useState('');
  const [district, setDistrict] = useState('SANGLI');
  const [stateName, setStateName] = useState('Maharashtra');
  const [pinCode, setPinCode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [joiningDate, setJoiningDate] = useState(getLocalDateStr());
  const [aadhaarNo, setAadhaarNo] = useState('');
  const [panNo, setPanNo] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('bw@123');
  const [status, setStatus] = useState<'Active' | 'Inactive'>('Active');
  const [allowedModules, setAllowedModules] = useState<string[]>(getDefaultModulesForRole('field_officer'));
  const [photoUrl, setPhotoUrl] = useState('');

  // Banking Details & Security Cheque
  const [bankName, setBankName] = useState('');
  const [bankAddress, setBankAddress] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [hasSecurityCheque, setHasSecurityCheque] = useState(false);
  const [securityChequeNumber, setSecurityChequeNumber] = useState('');

  // Branding (shared singleton hook)
  const { logoUrl, logoSize } = useBranding();

  // Approval requests state for Admin
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const {
    badge: userBadge,
    unreadById: userUnreadById,
    markViewed: markUserItemViewed,
    markAllViewed: markAllUserItemsViewed,
  } = useModuleRecordHighlights(profile, 'user', {
    users,
    userApprovalRequests: pendingRequests,
  });

  // UI state & refs
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const printableUserFormRef = useRef<HTMLDivElement>(null);
  const hasAutoOpenedRef = useRef(false);

  const userFormHistoryPushedRef = useRef(false);
  const userMountedRef = useRef(true);
  useEffect(() => {
    userMountedRef.current = true;
    return () => {
      userMountedRef.current = false;
      userFormHistoryPushedRef.current = false;
    };
  }, []);

  // Mobile Hardware / Navigation Back Button Integration
  useEffect(() => {
    if (viewMode === 'form') {
      if (!userFormHistoryPushedRef.current && !window.history.state?.userFormOpen) {
        window.history.pushState({ tab: 'user', userFormOpen: true }, '');
        userFormHistoryPushedRef.current = true;
      }
      const handlePopState = () => {
        userFormHistoryPushedRef.current = false;
        setViewMode('list');
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    } else if (userFormHistoryPushedRef.current) {
      userFormHistoryPushedRef.current = false;
      if (userMountedRef.current && window.history.state?.userFormOpen) {
        window.history.back();
      }
    }
  }, [viewMode]);

  // Users are provided in real-time by shared useSharedUsers() singleton channel above.

  // Auto-open own form for non-admin users so they immediately see only their own form on initial mount
  useEffect(() => {
    if (!isAdmin(profile) && viewMode === 'list' && !hasAutoOpenedRef.current) {
      hasAutoOpenedRef.current = true;
      const myUser = users.find((u) => {
        const uUid = (u.uid || '').trim().toLowerCase();
        const profUid = (profile.uid || '').trim().toLowerCase();
        if (profUid && uUid === profUid) return true;
        const uLogin = (u.loginId || '').trim().toLowerCase();
        const profLogin = (profile.loginId || '').trim().toLowerCase();
        if (profLogin && uLogin && uLogin === profLogin) return true;
        const uCode = (u.userCode || '').trim().toLowerCase();
        const profCode = (profile.userCode || '').trim().toLowerCase();
        if (profCode && uCode && uCode === profCode) return true;
        const uName = (u.fullName || '').trim().toUpperCase();
        const profName = (profile.fullName || '').trim().toUpperCase();
        if (profName && uName && uName === profName) return true;
        return false;
      }) || (profile as DetailedUserProfile);

      if (myUser) {
        loadUserToForm(myUser, true);
      }
    }
  }, [profile, users, viewMode]);

  // Pending profile update requests listener (Primary + Secondary DB)
  useEffect(() => {
    const reqMap = new Map<string, any>();
    const syncList = () => {
      const list = Array.from(reqMap.values())
        .filter((d) => d && d.status === 'pending' && !d.isArchived)
        .sort((a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt));
      setPendingRequests(list);
    };

    const pullRequestsFromSecondary = () => {
      void fetchSecondaryCollection('user_approval_requests', { limit: 500 }).then((res) => {
        if (!res.ok) return;
        (res.archivedIds || []).forEach((id) => reqMap.delete(id));
        res.items.forEach((it) => {
          if (it?.id) reqMap.set(it.id, it);
        });
        syncList();
      });
    };

    const unsubSec = subscribeSecondaryCollection('user_approval_requests', (events) => {
      events.forEach((evt) => {
        if (evt.deleted || evt.doc?.isArchived) reqMap.delete(evt.id);
        else if (evt.doc) reqMap.set(evt.id, { ...evt.doc, id: evt.id });
      });
      syncList();
    });

    pullRequestsFromSecondary();

    let unsub: (() => void) | null = null;
    const attachReqListener = () => {
      if (unsub || isQuotaBlocked()) return;
      try {
        const qReq = query(collection(db, 'user_approval_requests'));
        unsub = onSnapshot(qReq, (snap) => {
          const isServer = !snap.metadata?.fromCache;
          if (isServer && typeof snap.docChanges === 'function') {
            snap.docChanges().forEach((change) => {
              const id = change.doc.id;
              const data = change.doc.data();
              if (change.type === 'removed' || data?.isArchived) {
                reqMap.delete(id);
              } else {
                reqMap.set(id, { ...data, id });
              }
            });
          } else {
            snap.forEach((d) => {
              const data = d.data();
              if (data?.isArchived) {
                reqMap.delete(d.id);
                return;
              }
              const existing = reqMap.get(d.id);
              const existingTs = Math.max(Number(existing?._syncUpdatedAtMs) || 0, toTimestampMs(existing?.updatedAt || existing?.createdAt));
              const incomingTs = Math.max(Number(data?._syncUpdatedAtMs) || 0, toTimestampMs(data?.updatedAt || data?.createdAt));
              if (!existing || (isServer && incomingTs >= existingTs)) {
                reqMap.set(d.id, { ...data, id: d.id });
              }
            });
          }
          syncList();
        }, (err) => {
          if (unsub) {
            try { unsub(); } catch {}
            unsub = null;
          }
          if (isQuotaExceededError(err)) setQuotaBlocked(2 * 60 * 1000);
          pullRequestsFromSecondary();
          console.warn('UserManagement approval requests sync notice:', err);
        });
      } catch {
        unsub = null;
      }
    };

    const handleRefresh = () => { pullRequestsFromSecondary(); attachReqListener(); };
    const handleQuotaCleared = () => { attachReqListener(); };
    const handleLocalMutation = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      if (detail?.collection === 'user_approval_requests' && detail?.id) {
        if (detail.deleted || detail.doc?.isArchived) {
          reqMap.delete(detail.id);
        } else if (detail.doc) {
          const prev = reqMap.get(detail.id) || {};
          reqMap.set(detail.id, { ...prev, ...detail.doc, id: detail.id });
        }
        syncList();
      }
    };
    window.addEventListener('blackworm_data_refresh', handleRefresh);
    window.addEventListener('blackworm_secondary_resync', handleRefresh);
    window.addEventListener('blackworm_quota_blocked', pullRequestsFromSecondary);
    window.addEventListener('blackworm_quota_cleared', handleQuotaCleared);
    window.addEventListener('blackworm_local_record_mutation', handleLocalMutation as EventListener);

    attachReqListener();
    return () => {
      unsubSec();
      if (unsub) unsub();
      window.removeEventListener('blackworm_data_refresh', handleRefresh);
      window.removeEventListener('blackworm_secondary_resync', handleRefresh);
      window.removeEventListener('blackworm_quota_blocked', pullRequestsFromSecondary);
      window.removeEventListener('blackworm_quota_cleared', handleQuotaCleared);
      window.removeEventListener('blackworm_local_record_mutation', handleLocalMutation as EventListener);
    };
  }, []);

  const handleApproveRequest = async (req: any) => {
    markUserItemViewed(`req:${req.id}`, getRecordUpdateMs(req));
    setActionLoading(req.id);
    try {
      const updatedAtIso = new Date().toISOString();
      // Immediately update shared users state & clear pending card optimistically
      setUsersOptimistic((prev) =>
        prev.map((u) =>
          u.uid === req.targetUserId
            ? { ...u, ...req.proposedData, updatedAt: updatedAtIso }
            : u
        )
      );
      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));

      await safeFirestoreSet('users', req.targetUserId, {
        ...req.proposedData,
        updatedAt: updatedAtIso,
      }, { merge: true });

      await safeFirestoreSet('user_approval_requests', req.id, {
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedByUid: profile.uid,
        approvedByName: profile.fullName || 'Admin',
      }, { merge: true });

      // Synchronize updated user details everywhere across all linked records in background
      void syncOfficerDetailsEverywhere(
        req.targetUserId,
        req.proposedData.fullName,
        req.proposedData.designation,
        req.proposedData.center,
        {
          loginId: req.proposedData.loginId,
          oldName: req.targetUserName,
          userCode: req.targetUserCode,
        }
      ).catch((syncErr) => {
        console.warn('Sync error on approval:', syncErr);
      });

      void logAudit(
        'UPDATE',
        'users',
        req.targetUserId,
        `Admin approved profile updates for ${req.targetUserName} (${req.targetUserCode})`,
        profile
      ).catch(() => {});

      setDialogConfig({
        isOpen: true,
        type: 'success',
        title: 'Saved',
        message: 'Saved',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } catch (err: any) {
      console.error('Approve error:', err);
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'त्रुटी',
        message: getFriendlyErrorMessage(err, 'मंजूर करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRejectRequest = async (req: any) => {
    markUserItemViewed(`req:${req.id}`, getRecordUpdateMs(req));
    setActionLoading(req.id);
    try {
      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));
      await safeFirestoreSet('user_approval_requests', req.id, {
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
        rejectedByUid: profile.uid,
        rejectedByName: profile.fullName || 'Admin',
      }, { merge: true });

      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'बदल नाकारले',
        message: `${req.targetUserName} यांची प्रोफाईल बदल विनंती नाकारण्यात आली.`,
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } catch (err: any) {
      console.error('Reject error:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleChange = (newRole: string) => {
    setRole(newRole);
    // सिस्टीम रोल बदलला की डेस्टिनेशन (हुद्दा) आपोआप बदलणे
    const nextDesig = getDefaultDesignationForRole(newRole);
    setDesignation(nextDesig);
    // जर रोल Admin किंवा Owner असेल तर आपोआप सर्व मॉड्युल्सचे फुल ॲक्सेस देणे
    if (newRole === 'admin' || newRole === 'owner' || nextDesig.toUpperCase().includes('ADMIN')) {
      setAllowedModules(SYSTEM_MODULES.map((m) => m.id));
    } else {
      // ॲक्सेस लेव्हल मधील मॉड्युल्स त्या रोलनुसार डीफॉल्ट सेट करणे
      setAllowedModules(getDefaultModulesForRole(newRole));
    }
    // युजर कोड ऑटोमॅटिक जनरेट करणे (EMP-00 फॉरमॅट)
    if (!userCode || userCode === '1' || userCode.startsWith('EMP-')) {
      setUserCode(calculateNextUserCode(newRole, users));
    }
  };

  const resetForm = (customCode?: string) => {
    if (!isAdmin(profile)) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Action Restricted',
        message: 'नवीन युजर तयार करण्याची परवानगी फक्त ॲडमिनला आहे. (Only Admin can register new users)',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false }))
      });
      return;
    }
    const defaultRole = 'field_officer';
    const nextCode = customCode || calculateNextUserCode(defaultRole, users);
    setCurrentUid(null);
    setUserCode(nextCode);
    setFullName('');
    setDesignation('FIELD OFFICER');
    setCenter('');
    setMobileNumber('');
    setAltPhone('');
    setEmailId('');
    setRole(defaultRole);
    setAddress('');
    setVillage('');
    setTaluka('');
    setDistrict('SANGLI');
    setStateName('Maharashtra');
    setPinCode('');
    setDateOfBirth('');
    setJoiningDate(getLocalDateStr());
    setAadhaarNo('');
    setPanNo('');
    setLoginId('');
    setPassword('bw@123');
    setStatus('Active');
    setAllowedModules(getDefaultModulesForRole(defaultRole));
    setPhotoUrl('');
    setBankName('');
    setBankAddress('');
    setAccountNumber('');
    setIfscCode('');
    setHasSecurityCheque(false);
    setSecurityChequeNumber('');
    setShowAccessList(false);
    setIsEditing(true);
    setViewMode('form');
  };

  const loadUserToForm = (u: DetailedUserProfile, editMode: boolean = true) => {
    if (!isAdmin(profile)) {
      const isSelf = 
        u.uid === profile.uid ||
        (profile.loginId && u.loginId && String(u.loginId).toLowerCase() === String(profile.loginId).toLowerCase()) ||
        (profile.userCode && u.userCode && String(u.userCode).toLowerCase() === String(profile.userCode).toLowerCase());
      if (!isSelf) {
        setDialogConfig({
          isOpen: true,
          type: 'alert',
          title: 'Access Restricted',
          message: 'तुम्हाला फक्त स्वतःचे युजर डिटेल्स पाहण्याची परवानगी आहे. (You can only access your own profile)',
          confirmText: 'ठीक आहे',
          onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false }))
        });
        return;
      }
    }
    markUserItemViewed(u.uid, getRecordUpdateMs(u));
    setCurrentUid(u.uid);
    setUserCode(u.userCode || calculateNextUserCode(u.role || 'field_officer', users));
    setFullName(u.fullName || '');
    setDesignation(u.designation || getDefaultDesignationForRole(u.role || 'field_officer'));
    setCenter(u.center || '');
    setMobileNumber(u.mobileNumber || '');
    setAltPhone(u.altPhone || '');
    setEmailId(u.emailId || '');
    setRole(u.role || 'field_officer');
    setAddress(u.address || '');
    setVillage(u.village || '');
    setTaluka(u.taluka || '');
    setDistrict(u.district || 'SANGLI');
    setStateName(u.state || 'Maharashtra');
    setPinCode(u.pinCode || '');
    setDateOfBirth(u.dateOfBirth || '');
    setJoiningDate(formatSafeDateString(u.joiningDate || u.createdAt));
    setAadhaarNo(u.aadhaarNo || '');
    setPanNo(u.panNo || '');
    setLoginId(u.loginId || u.mobileNumber || '');
    setPassword(u.password || 'bw@123');
    setStatus(u.status || 'Active');
    setAllowedModules(u.allowedModules && u.allowedModules.length > 0 ? u.allowedModules : getDefaultModulesForRole(u.role || 'field_officer'));
    setPhotoUrl(u.photoUrl || '');
    setBankName(u.bankName || '');
    setBankAddress(u.bankAddress || '');
    setAccountNumber(u.accountNumber || '');
    setIfscCode(u.ifscCode || '');
    setHasSecurityCheque(!!u.hasSecurityCheque || !!u.securityChequeNumber);
    setSecurityChequeNumber(u.securityChequeNumber || '');

    setShowAccessList(false);
    setIsEditing(editMode);
    setViewMode('form');
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressed = await compressImageFile(file, 1000, 0.7);
        setPhotoUrl(compressed);
      } catch (err) {
        console.warn('User photo compression fallback:', err);
        const reader = new FileReader();
        reader.onloadend = () => {
          setPhotoUrl(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const toggleModulePermission = (modId: string) => {
    if (!isEditing) return;
    if (allowedModules.includes(modId)) {
      setAllowedModules(allowedModules.filter((id) => id !== modId));
    } else {
      setAllowedModules([...allowedModules, modId]);
    }
  };

  const [dialogConfig, setDialogConfig] = useState<{
    isOpen: boolean;
    type?: 'confirm' | 'alert' | 'success';
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    message: '',
    onConfirm: () => {},
  });

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSavingUser) return;
    if (!fullName.trim()) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Validation Error',
        message: 'Please enter User Full Name',
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
      return;
    }
    if (!mobileNumber.trim()) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Validation Error',
        message: 'Please enter Mobile Number',
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
      return;
    }

    const trimmedMobile = mobileNumber.trim();
    const trimmedLogin = loginId.trim() || trimmedMobile;
    const uid = currentUid || `user_${Date.now()}`;
    const code = userCode.trim() || calculateNextUserCode(role, users);

    const isTargetAdmin = role === 'admin' || role === 'owner' || designation.toUpperCase().includes('ADMIN') || designation.toUpperCase().includes('OWNER') || designation.toUpperCase().includes('MD');
    const finalAllowedModules = isTargetAdmin ? SYSTEM_MODULES.map((m) => m.id) : allowedModules;

    const payload: DetailedUserProfile = {
      uid,
      userCode: code,
      fullName: toTitleCase(fullName.trim()),
      designation: toTitleCase(designation.trim()),
      center: toTitleCase(center.trim()),
      mobileNumber: trimmedMobile,
      altPhone: altPhone.trim(),
      emailId: emailId.trim() || `${trimmedMobile}@blackwormagri.com`,
      role,
      address: toTitleCase(address.trim()),
      village: toTitleCase(village.trim()),
      taluka: toTitleCase(taluka.trim()),
      district: toTitleCase(district.trim()),
      state: stateName.trim(),
      pinCode: pinCode.trim(),
      dateOfBirth,
      joiningDate,
      aadhaarNo: aadhaarNo.trim(),
      panNo: panNo.trim().toUpperCase(),
      loginId: trimmedLogin,
      password: password.trim() || 'bw@123',
      status,
      allowedModules: finalAllowedModules,
      photoUrl,
      bankName: toTitleCase(bankName.trim()),
      bankAddress: toTitleCase(bankAddress.trim()),
      accountNumber: accountNumber.trim(),
      ifscCode: ifscCode.trim().toUpperCase(),
      hasSecurityCheque: !!hasSecurityCheque || !!securityChequeNumber.trim(),
      securityChequeNumber: securityChequeNumber.trim().toUpperCase(),
      updatedByUid: profile.uid || '',
      updatedByName: profile.fullName || profile.loginId || '',
      updatedAt: new Date().toISOString(),
      createdAt: currentUid ? (formatSafeDateString(users.find(u => u.uid === currentUid)?.createdAt) || new Date().toISOString()) : new Date().toISOString(),
    };

    setIsSavingUser(true);
    try {
      const existingUser = users.find(u => u.uid === uid);
      const wasNewUser = !currentUid;

      // 1. Immediately update shared in-memory state across app before awaiting network write
      setUsersOptimistic((prev) => {
        const idx = prev.findIndex((u) => u.uid === uid);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = payload;
          return updated;
        }
        return [...prev, payload];
      });
      setFullName(payload.fullName);
      setDesignation(payload.designation || '');
      setCenter(payload.center || '');

      // 2. Direct safe save with local backup (guarantees zero data loss & fast response)
      await safeFirestoreSet('users', uid, payload, { merge: true });

      // 3. Strictly update current session ONLY if editing the exact same UID (never overwrite session via shared mobile/loginId)
      if (uid === profile.uid) {
        const { password: _omittedPass, ...safeSession } = payload;
        safeLocalStorageSet('blackworm_user_profile', JSON.stringify(safeSession));
        onProfileUpdate?.(safeSession as DetailedUserProfile);
      }

      setCurrentUid(uid);
      setIsEditing(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);

      // 4. Run secondary cascades & audit in background so Save completes immediately
      void (async () => {
        try {
          await syncOfficerDetailsEverywhere(
            uid,
            payload.fullName,
            payload.designation,
            payload.center,
            {
              loginId: payload.loginId,
              oldName: existingUser?.fullName,
              userCode: payload.userCode,
            }
          );
        } catch (syncErr) {
          console.warn('Sync notice on save:', syncErr);
        }

        if (!isAdmin(profile)) {
          try {
            const approvalId = `req_${uid}_${Date.now()}`;
            await safeFirestoreSet('user_approval_requests', approvalId, {
              id: approvalId,
              targetUserId: uid,
              targetUserCode: code,
              targetUserName: payload.fullName,
              requestedByUid: profile.uid,
              requestedByName: profile.fullName || profile.loginId || 'User',
              status: 'approved_direct',
              createdAt: new Date().toISOString(),
              proposedData: payload,
            });
          } catch (e) {
            console.warn('Audit request log notice:', e);
          }
        }

        const lowerRole = String(role || '').toLowerCase();
        const lowerDesig = String(payload.designation || '').toLowerCase();
        if (
          lowerRole === 'office_staff' ||
          lowerRole === 'factory_staff' ||
          lowerRole === 'godown_incharge' ||
          lowerDesig.includes('office staff') ||
          lowerDesig.includes('factory staff') ||
          lowerDesig.includes('godown')
        ) {
          const staffCat =
            lowerRole === 'factory_staff' || lowerDesig.includes('factory')
              ? 'Factory Staff'
              : 'Office Staff';
          const staffDocId = `staff_user_${uid}`;
          await safeFirestoreSet(
            'office_staff_members',
            staffDocId,
            {
              id: staffDocId,
              fullName: payload.fullName,
              category: staffCat,
              workRole: payload.designation || (staffCat === 'Factory Staff' ? 'Factory Staff' : 'Office Staff'),
              mobileNumber: payload.mobileNumber || '',
              joiningDate: payload.joiningDate || getLocalDateStr(),
              status: payload.status === 'Inactive' ? 'Inactive' : 'Active',
              linkedUserUid: uid,
              createdByUid: profile.uid || '',
              createdByName: profile.fullName || 'Admin',
              isArchived: false,
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
            { merge: true }
          ).catch(() => {});
        }

        if (
          wasNewUser &&
          role !== 'owner' &&
          role !== 'dealer' &&
          role !== 'office_staff' &&
          role !== 'factory_staff' &&
          role !== 'godown_incharge'
        ) {
          const targetId = `target_${uid}_oct26`;
          await safeFirestoreSet('targets', targetId, {
            id: targetId,
            userId: uid,
            userName: payload.fullName,
            month: 'October',
            year: 2026,
            targetSales: 200000,
            achievedSales: 0,
            targetCollection: 180000,
            achievedCollection: 0,
            ownerId: profile.uid,
            isArchived: false,
            createdAt: new Date().toISOString(),
          }, { merge: true }).catch(() => {});
        }

        await logAudit(
          wasNewUser ? 'CREATE' : 'UPDATE',
          'users',
          uid,
          `${wasNewUser ? 'Registered' : 'Updated'} User Profile for ${payload.fullName} (${payload.role} / ${payload.loginId})`,
          profile
        ).catch(() => {});
      })();
    } catch (err: any) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'सेव्ह करताना त्रुटी',
        message: getFriendlyErrorMessage(err, 'माहिती सेव्ह करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleDelete = async (uid: string, name: string) => {
    if (!isAdmin(profile)) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Action Restricted',
        message: 'युजर डिलीट करण्याची परवानगी फक्त ॲडमिनला आहे. (Only Admin can delete users)',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
      return;
    }
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Confirmation',
      message: `Are you sure you want to delete User record for "${name}"?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        try {
          setUsersOptimistic((prev) => prev.filter((u) => u.uid !== uid));
          if (currentUid === uid) {
            setViewMode('list');
          }
          await safeFirestoreDelete('users', uid, { softDelete: true, user: profile });
          await safeFirestoreDelete('office_staff_members', `staff_user_${uid}`, { softDelete: true, user: profile }).catch(() => {});
          await logAudit('DELETE', 'users', uid, `Deleted user profile for ${name}`, profile);
        } catch (err: any) {
          setDialogConfig({
            isOpen: true,
            type: 'alert',
            title: 'डिलीट करताना त्रुटी',
            message: getFriendlyErrorMessage(err, 'युजर हटवताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
            onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
          });
        }
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  const handleDownloadPdf = async () => {
    if (!printableUserFormRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const element = printableUserFormRef.current;
      
      const canvas = await html2canvas(element, {
        scale: 2.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      const sanitizedName = (fullName || userCode || 'User_Profile_Form').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const getRoleLabel = (roleId: string) => {
    const r = SYSTEM_ROLES.find((item) => item.id === roleId);
    return r ? r.label : roleId;
  };

  const userIsAdmin = isAdmin(profile);

  const filteredUsers = useMemo(() => {
    // Non-admin user: strictly return ONLY their own profile (इतर युजर दिसू नयेत)
    if (!userIsAdmin) {
      const myUid = (profile.uid || '').trim().toLowerCase();
      const myLogin = (profile.loginId || '').trim().toLowerCase();
      const myCode = (profile.userCode || '').trim().toLowerCase();
      const myName = (profile.fullName || '').trim().toUpperCase();

      const matched = users.filter((u) => {
        const uUid = (u.uid || '').trim().toLowerCase();
        if (myUid && uUid === myUid) return true;
        const uLogin = (u.loginId || '').trim().toLowerCase();
        if (myLogin && uLogin && uLogin === myLogin) return true;
        const uCode = (u.userCode || '').trim().toLowerCase();
        if (myCode && uCode && uCode === myCode) return true;
        const uName = (u.fullName || '').trim().toUpperCase();
        if (myName && uName && uName === myName) return true;
        return false;
      });
      if (matched.length > 0) return [matched[0]];
      return [{
        ...profile,
        userCode: profile.userCode || 'EMP-01',
        designation: profile.designation || 'FIELD OFFICER',
        center: profile.center || 'Sangli',
        createdAt: (profile as any).createdAt || new Date().toISOString(),
      } as DetailedUserProfile];
    }

    // Admin / Owner: allow searching and filtering all users
    return users.filter((u) => {
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.center || '').toLowerCase().includes(q) ||
        (u.mobileNumber || '').toLowerCase().includes(q) ||
        (u.loginId || '').toLowerCase().includes(q) ||
        (u.designation || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q) ||
        (u.district || '').toLowerCase().includes(q);

      if (activeFilter !== 'all') {
        return matchQuery && u.role === activeFilter;
      }
      return matchQuery;
    });
  }, [users, userIsAdmin, profile, searchQuery, activeFilter]);

  // Get module label based on current system language
  const getModuleLabel = (mod: SystemModuleItem) => {
    return (lang as string) === 'mr' ? mod.mr : mod.en;
  };

  return (
    <div className="space-y-4 font-sans">
      {viewMode === 'list' && (
        <ModuleUpdateBanner
          badge={userBadge}
          onMarkAllViewed={() => markAllUserItemsViewed()}
          onMarkSingleViewed={(rec) => markUserItemViewed(rec.id, rec.updatedAtMs)}
          onSelectRecord={(rec) => {
            markUserItemViewed(rec.id, rec.updatedAtMs);
            if (rec.subType !== 'approval') {
              const match = users.find((u) => u.uid === rec.id);
              if (match) loadUserToForm(match, true);
            }
          }}
        />
      )}

      {/* ======================= PENDING APPROVALS SECTION (FOR ADMIN) ======================= */}
      {isAdmin(profile) && pendingRequests.length > 0 && viewMode === 'list' && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 space-y-3 shadow-sm no-print">
          <div className="flex items-center justify-between border-b border-amber-200 pb-2">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-700" />
              <h3 className="text-sm font-black text-amber-950 uppercase tracking-tight">
                बदल मंजुरी विनंत्या (Pending Profile Approvals: {pendingRequests.length})
              </h3>
            </div>
            <span className="text-[10px] font-black text-amber-800 bg-amber-200/70 px-2 py-0.5 rounded-full uppercase">
              Action Required
            </span>
          </div>

          <div className="space-y-2.5">
            {pendingRequests.map((req) => {
              const reqUnread = userUnreadById.get(`req:${req.id}`);
              return (
              <div 
                key={req.id} 
                className={`rounded-xl border p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm transition ${
                  reqUnread
                    ? 'bg-amber-50/70 border-amber-400 ring-1 ring-amber-200'
                    : 'bg-white border-amber-200 hover:border-amber-400'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black font-mono text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                      {req.targetUserCode || 'EMP'}
                    </span>
                    <span className="text-sm font-black text-slate-900 uppercase truncate">
                      {req.proposedData?.fullName || req.targetUserName}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 font-bold mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>हुद्दा: <strong className="text-slate-900">{req.proposedData?.designation || '-'}</strong></span>
                    <span>मोबाईल: <strong className="text-slate-900">{req.proposedData?.mobileNumber || '-'}</strong></span>
                    <span>सेंटर: <strong className="text-slate-900">{req.proposedData?.center || '-'}</strong></span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-bold mt-1">
                    विनंती दिनांक: {formatDisplayDate(req.createdAt, true) || '-'} · {req.requestedByName} द्वारे
                  </p>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
                  {reqUnread && (
                    <button
                      type="button"
                      onClick={() => markUserItemViewed(`req:${req.id}`, reqUnread.updatedAtMs)}
                      className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-xs font-bold transition cursor-pointer whitespace-nowrap"
                      title="पाहिले (Mark Viewed)"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>पाहिले</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleApproveRequest(req)}
                    disabled={actionLoading === req.id}
                    className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-black shadow-sm transition active:scale-95 disabled:opacity-50 cursor-pointer"
                    title="बदल मंजूर करा व लागू करा"
                  >
                    {actionLoading === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    <span>मंजूर करा (Approve)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRejectRequest(req)}
                    disabled={actionLoading === req.id}
                    className="flex items-center gap-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3 py-2 rounded-xl text-xs font-black shadow-sm transition active:scale-95 disabled:opacity-50 cursor-pointer"
                    title="विनंती नाकारा"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>नाकारा (Reject)</span>
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ======================= TOP BAR (LIST VIEW - ADMIN ONLY) ======================= */}
      {viewMode === 'list' && isAdmin(profile) && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex items-center gap-2.5 sm:gap-3 no-print">
          <button
            onClick={() => resetForm()}
            className="flex items-center justify-center bg-red-600 hover:bg-red-700 text-white p-2.5 rounded-xl transition shadow-lg shrink-0 active:scale-95 cursor-pointer"
            title="New User Form"
          >
            <UserPlus className="w-6 h-6 stroke-[3.5px]" />
          </button>

          <div className="relative flex-1">
            <Search className="w-5 h-5 absolute left-3.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search by Name, Mobile, Login ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-2.5 text-sm rounded-xl border border-slate-100 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 transition-all font-medium"
            />
          </div>
        </div>
      )}

      {/* Success notification */}
      {saveSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center justify-between no-print animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-semibold">Saved</span>
          </div>
          <button onClick={() => setSaveSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= VIEW MODE: LIST ======================= */}
      {viewMode === 'list' && (
        <div className="space-y-4 no-print">
          {/* Filter Pills for Admin only */}
          {isAdmin(profile) ? (
            <div className="flex items-center gap-2 px-1 overflow-x-auto pb-1">
              <button
                onClick={() => setActiveFilter('all')}
                className={`px-4 py-1.5 rounded-lg text-xs font-black transition shrink-0 ${
                  activeFilter === 'all'
                    ? 'bg-slate-900 text-white shadow-md'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                All Users ({users.length})
              </button>
              {SYSTEM_ROLES.map((r) => {
                const count = users.filter((u) => u.role === r.id).length;
                if (count === 0 && activeFilter !== r.id) return null;
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveFilter(r.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-black transition shrink-0 ${
                      activeFilter === r.id
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {r.label} ({count})
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-1 flex items-center gap-2 truncate whitespace-nowrap">
              <span className="text-sm font-black text-slate-900 tracking-tight truncate whitespace-nowrap">
                {toTitleCase(profile.fullName) || profile.uid}
              </span>
              <span className="text-[9.5px] font-bold text-slate-600 tracking-tight bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded shrink-0">
                {toTitleCase(profile.designation || profile.role)}
              </span>
            </div>
          )}

          {/* User Cards Grid: Strictly Code and Full Name in Single Line */}
          <div className="space-y-2.5">
            {filteredUsers.map((u) => {
              const userUnread = userUnreadById.get(u.uid);
              return (
                <div
                  key={u.uid}
                  onClick={() => loadUserToForm(u, true)}
                  className={`rounded-2xl border hover:shadow-md p-3.5 sm:p-4 transition-all cursor-pointer flex items-center justify-between gap-3 group relative overflow-hidden ${
                    userUnread
                      ? 'bg-amber-50/50 border-amber-400 ring-1 ring-amber-200 hover:border-amber-500'
                      : 'bg-white border-slate-200 hover:border-red-400'
                  }`}
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <span className="text-xs font-black text-red-600 bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg uppercase tracking-wider shrink-0 font-mono shadow-sm">
                      {u.userCode || 'USER'}
                    </span>
                    
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm sm:text-base font-black text-slate-900 group-hover:text-red-600 transition-colors tracking-wide truncate whitespace-nowrap leading-snug">
                        {toTitleCase(u.fullName) || 'Unnamed User'}
                      </h3>
                      <span className="text-[9.5px] font-bold text-slate-600 block mt-0.5 truncate whitespace-nowrap">
                        {toTitleCase(u.designation || u.role)} {u.center && `• ${toTitleCase(u.center)}`}
                      </span>
                      {userUnread && (
                        <span className="text-[10px] font-bold text-amber-800 block mt-0.5 truncate">
                          {userUnread.actorName} · {userUnread.actionLabel}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 no-print">
                    {userUnread && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          markUserItemViewed(u.uid, userUnread.updatedAtMs);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px] font-bold transition whitespace-nowrap cursor-pointer"
                        title="पाहिले (Mark Viewed)"
                      >
                        <Check className="w-3 h-3 shrink-0" />
                        <span>पाहिले</span>
                      </button>
                    )}
                    <span className="text-xs font-bold text-slate-400 group-hover:text-red-600 transition">
                      👉
                    </span>
                  </div>
                </div>
              );
            })}

            {filteredUsers.length === 0 && (
              <div className="col-span-full bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
                <p className="text-sm font-semibold">No user applications or records found.</p>
                <p className="text-xs text-slate-400 mt-1">Click "New User Form" above to add the first user.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ======================= VIEW MODE: FULL PAGE STRUCTURED USER FORM ======================= */}
      {viewMode === 'form' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
            {/* Top Action Toolbar inside form card - Single line compact layout */}
            <div className="bg-slate-50 border-b border-slate-200 px-2.5 py-1.5 sm:px-4 sm:py-2 flex items-center justify-end gap-1.5 no-print sticky left-0 w-full z-10">
              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                {/* 1. Edit button */}
                <button
                  type="button"
                  onClick={() => setIsEditing(!isEditing)}
                  className={`p-1.5 rounded-lg text-xs font-bold transition shadow-xs border ${
                    isEditing 
                      ? 'bg-emerald-600 text-white border-emerald-500' 
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-red-600'
                  }`}
                  title={isEditing ? 'Viewing Mode (Click to View Mode)' : 'Edit Mode (Click to Edit)'}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>

                {/* 2. Save button (compact 50% size) */}
                {isEditing && (
                  <button
                    type="submit"
                    form="user-profile-form"
                    disabled={isSavingUser}
                    className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white flex items-center gap-0.5 shadow-xs transition cursor-pointer shrink-0"
                    title="Save Form"
                  >
                    {isSavingUser ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
                    <span>{isSavingUser ? '...' : 'Save'}</span>
                  </button>
                )}

                {/* 3. PDF / Download button (compact 50% size) */}
                <button
                  type="button"
                  onClick={handleDownloadPdf}
                  disabled={isGeneratingPdf}
                  className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-0.5 shadow-xs transition disabled:opacity-50 shrink-0 cursor-pointer"
                  title="Download A4 PDF Form"
                >
                  {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
                  <span>{isAdmin(profile) ? 'PDF' : 'Download'}</span>
                </button>

                {/* Delete button (Admin only) */}
                {isAdmin(profile) && currentUid && (
                  <button
                    type="button"
                    onClick={() => handleDelete(currentUid, fullName)}
                    className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                    title="Delete Form"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Pending Approval Notice for Standard User */}
            {!isAdmin(profile) && pendingRequests.some(r => r.targetUserId === profile.uid || r.requestedByUid === profile.uid) && (
              <div className="mx-4 sm:mx-6 mt-3 p-3 bg-amber-50 border-2 border-amber-300 text-amber-950 rounded-xl text-xs font-bold flex items-center justify-between shadow-xs no-print">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600 animate-pulse shrink-0" />
                  <span>तुमच्या प्रोफाईल बदलांची विनंती ॲडमिन मंजुरीसाठी प्रलंबित आहे. ॲडमिनने मंजूर केल्यानंतर नवीन माहिती लगेच लागू होईल.</span>
                </div>
              </div>
            )}

            {/* Official Full Page Form */}
            <form id="user-profile-form" onSubmit={handleSave} className="p-4 sm:p-6 space-y-0 text-[11px] min-w-[800px] sm:min-w-0 font-sans">
              {/* Full Form Outer Border Wrapper */}
              <div ref={printableUserFormRef} className="border-2 border-black bg-white shadow-sm">
                {/* 1. Header Section - Logo (Left), Name (Center), Photo (Right) */}
                <div className="p-4 relative bg-white border-b-2 border-black">
                  <div className="flex items-center justify-between gap-4">
                    {/* Company Logo (Left) */}
                    <div className="w-24 h-24 flex items-center justify-center shrink-0">
                      {logoUrl && (
                        <img 
                          src={logoUrl} 
                          alt="Logo" 
                          style={{ width: `${logoSize}px`, height: `${logoSize}px` }} 
                          className="object-contain" 
                        />
                      )}
                    </div>

                    {/* Company Info (Center) */}
                    <div className="flex-1 text-center space-y-1">
                      <h1 className="text-2xl font-black text-red-600 uppercase tracking-tight leading-none">
                        BLACKWORM AGRITECH PVT LTD
                      </h1>
                      <div className="text-[8px] text-slate-700 font-bold leading-tight mt-2">
                        <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                        <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                        <p className="flex items-center justify-center gap-4 mt-1">
                          <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                          <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                        </p>
                      </div>
                    </div>

                    {/* User Photo Box (Right) */}
                    <div 
                      onClick={() => isEditing && setShowPhotoModal(true)}
                      className={`w-28 h-28 border-2 border-black bg-white flex items-center justify-center overflow-hidden relative group shrink-0 ${isEditing ? 'cursor-pointer hover:border-emerald-600' : ''}`}
                      title={isEditing ? "Click to add or change user photo" : undefined}
                    >
                      {photoUrl ? (
                        <>
                          <img src={photoUrl} alt="User Photo" className="w-full h-full object-cover" />
                          {isEditing && (
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition-opacity">
                              <Camera className="w-6 h-6" />
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-center p-2">
                          <Camera className="w-6 h-6 mx-auto text-slate-400 mb-1" />
                          <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter leading-none block">
                            {isEditing ? 'Click to Add Photo' : 'User Photo'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Banner: Employee / User Registration Form */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-b-2 border-black">
                  EMPLOYEE / USER REGISTRATION & PROFILE FORM
                </div>

                {/* 3. Main Form Grid Data with Uniform w-44 Label Width and Continuous Vertical Divider */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  {/* Row 1: User / Emp Code No (Auto Generated & Manually Editable) & Joining Date */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50/50">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter flex items-center gap-1">
                        User / Emp Code No -
                        {!isAdmin(profile) && <span title="Locked by Admin"><Lock className="w-3 h-3 text-slate-500" /></span>}
                      </span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type="text"
                          disabled={!isAdmin(profile) || !isEditing}
                          value={userCode}
                          onChange={(e) => isAdmin(profile) && setUserCode(e.target.value)}
                          placeholder={calculateNextUserCode(role, users)}
                          className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-sm uppercase disabled:text-red-600 disabled:opacity-90"
                        />
                        {isAdmin(profile) && isEditing && (
                          <button
                            type="button"
                            onClick={() => setUserCode(calculateNextUserCode(role, users))}
                            className="text-[9px] font-black text-slate-600 hover:text-red-600 uppercase tracking-tight bg-white border border-slate-300 hover:border-red-400 px-2 py-0.5 rounded shrink-0 transition shadow-xs"
                            title="Auto Calculate Sequential Number (EMP-01, EMP-02...)"
                          >
                            Auto (#{calculateNextUserCode(role, users)})
                          </button>
                        )}
                        {!isAdmin(profile) && (
                          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-tight bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" />
                            कायमस्वरूपी (Locked)
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Joining Date -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditing}
                          value={joiningDate}
                          onChange={(e) => setJoiningDate(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 2: Full Name (Dedicated Full Single Line Across Entire Form) */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Full Name -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        required
                        disabled={!isEditing}
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="SHRIDHAR BALKRUSHNA SHINDE"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Row 3: Designation & Center (HQ) */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Designation -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditing ? (
                          <select
                            value={designation}
                            onChange={(e) => {
                              const nextDesig = e.target.value;
                              setDesignation(nextDesig);
                              const matchedRole = SYSTEM_ROLES.find(
                                (r) => r.designation.toLowerCase() === nextDesig.toLowerCase()
                              );
                              if (matchedRole) {
                                handleRoleChange(matchedRole.id);
                              }
                            }}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none cursor-pointer"
                          >
                            {designation &&
                              !DESIGNATION_OPTIONS.some(
                                (opt) => opt.toLowerCase() === designation.toLowerCase()
                              ) && (
                                <option value={designation}>{designation.toUpperCase()}</option>
                              )}
                            {DESIGNATION_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt.toUpperCase()}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="font-black text-black uppercase">
                            {designation || getDefaultDesignationForRole(role)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50/40">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Center (HQ) -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={center}
                          onChange={(e) => setCenter(e.target.value)}
                          placeholder="SANGLI / HEADQUARTER LOCATION"
                          className="w-full bg-transparent font-black text-slate-900 uppercase focus:outline-none placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 3B: System Role */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">System Role -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      {isEditing ? (
                        <select
                          value={role}
                          onChange={(e) => handleRoleChange(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        >
                          {SYSTEM_ROLES.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-black text-black">{getRoleLabel(role)}</span>
                      )}
                    </div>
                  </div>

                  {/* Row 4: Mobile Number & Alt Contact */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Mobile No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="tel"
                          required
                          disabled={!isEditing}
                          value={mobileNumber}
                          onChange={(e) => setMobileNumber(e.target.value)}
                          placeholder="98220XXXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Alt / WhatsApp -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="tel"
                          disabled={!isEditing}
                          value={altPhone}
                          onChange={(e) => setAltPhone(e.target.value)}
                          placeholder="ALT CONTACT"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 5: Email ID & State */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Email ID -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="email"
                          disabled={!isEditing}
                          value={emailId}
                          onChange={(e) => setEmailId(e.target.value)}
                          placeholder="user@blackwormagri.com"
                          className="w-full bg-transparent font-black text-black focus:outline-none lowercase font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">State -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={stateName}
                          onChange={(e) => setStateName(e.target.value)}
                          placeholder="MAHARASHTRA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 6: Full Address */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Full Address -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="HOUSE NO, STREET, AREA ADDRESS"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Row 7: Village / City & Taluka */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Village / City -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={village}
                          onChange={(e) => setVillage(e.target.value)}
                          placeholder="VILLAGE / CITY NAME"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Taluka / Tehsil -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={taluka}
                          onChange={(e) => setTaluka(e.target.value)}
                          placeholder="TALUKA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 8: District & Pin Code */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">District -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={district}
                          onChange={(e) => setDistrict(e.target.value)}
                          placeholder="SANGLI"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Pin Code -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={pinCode}
                          onChange={(e) => setPinCode(e.target.value)}
                          placeholder="416409"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 9: Date of Birth & Aadhaar No */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Date of Birth -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditing}
                          value={dateOfBirth}
                          onChange={(e) => setDateOfBirth(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Aadhaar No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={aadhaarNo}
                          onChange={(e) => setAadhaarNo(e.target.value)}
                          placeholder="12 DIGIT AADHAAR"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 10: PAN Card No */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">PAN Card No -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={panNo}
                        onChange={(e) => setPanNo(e.target.value)}
                        placeholder="ABCDE1234F"
                        className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                      />
                    </div>
                  </div>
                </div>

                {/* 4. Banking & Security Cheque Details Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                  BANKING & SECURITY CHEQUE DETAILS
                </div>

                {/* Banking & Security Cheque Rows */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  {/* Bank Name */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Bank Name -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        placeholder="BANK NAME (E.G. STATE BANK OF INDIA)"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Bank Address */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Bank Address -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={bankAddress}
                        onChange={(e) => setBankAddress(e.target.value)}
                        placeholder="BRANCH / BANK ADDRESS"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Account No & IFSC Code */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Account No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={accountNumber}
                          onChange={(e) => setAccountNumber(e.target.value)}
                          placeholder="ACCOUNT NUMBER"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">IFSC Code -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={ifscCode}
                          onChange={(e) => setIfscCode(e.target.value)}
                          placeholder="SBIN000XXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Security Cheque & Cheque Number */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Security Cheque -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditing ? (
                          <select
                            value={hasSecurityCheque ? 'YES' : 'NO'}
                            onChange={(e) => {
                              const val = e.target.value === 'YES';
                              setHasSecurityCheque(val);
                              if (!val) setSecurityChequeNumber('');
                            }}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                          >
                            <option value="NO">NO (नाही)</option>
                            <option value="YES">YES (दिली आहे)</option>
                          </select>
                        ) : (
                          <span className="font-black uppercase text-black">
                            {hasSecurityCheque || securityChequeNumber ? 'YES' : 'NO'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Cheque No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={securityChequeNumber}
                          onChange={(e) => {
                            setSecurityChequeNumber(e.target.value);
                            if (e.target.value.trim()) {
                              setHasSecurityCheque(true);
                            }
                          }}
                          placeholder={hasSecurityCheque ? "CHEQUE NUMBER" : "CHEQUE NUMBER"}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Credentials Section Banner - Strictly visible ONLY to Admin/Owner */}
                {isAdmin(profile) && (
                  <>
                    <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                      LOGIN & ACCESS CREDENTIALS
                    </div>

                    {/* Credentials & Access Mode Rows */}
                    <div className="divide-y-2 divide-black bg-white text-[11px]">
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Login ID -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          required
                          disabled={!isEditing}
                          value={loginId}
                          onChange={(e) => setLoginId(e.target.value)}
                          placeholder="LOGIN ID"
                          className="w-full bg-transparent font-black text-emerald-800 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Password -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type={showPassword || isEditing ? 'text' : 'password'}
                          required
                          disabled={!isEditing}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="bw@123"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                        {!isEditing && (
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="text-slate-400 hover:text-slate-700 no-print"
                          >
                            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Account Status -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditing ? (
                          <select
                            value={status}
                            onChange={(e) => setStatus(e.target.value as any)}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                          >
                            <option value="Active">ACTIVE</option>
                            <option value="Inactive">INACTIVE</option>
                          </select>
                        ) : (
                          <span className="font-black text-emerald-700 uppercase">{status}</span>
                        )}
                      </div>
                    </div>

                    {/* Access Mode Row with Clickable Arrow to Open Dashboard Options List */}
                    <div className="flex items-center p-0 min-h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Access Mode -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 py-1 bg-slate-50/50">
                        <span className="font-black text-slate-900 uppercase truncate">
                          {allowedModules.length === SYSTEM_MODULES.length
                            ? 'FULL ACCESS'
                            : `${allowedModules.length} MODULES`}
                        </span>

                        {/* Dropdown Toggle Arrow */}
                        <button
                          type="button"
                          onClick={() => setShowAccessList(!showAccessList)}
                          className="flex items-center gap-1 text-[10px] font-black text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-1 rounded-md transition no-print"
                          title="Click to view/edit allowed dashboard options"
                        >
                          <span>Options</span>
                          {showAccessList ? (
                            <ChevronUp className="w-3.5 h-3.5 stroke-[3px]" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 stroke-[3px]" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expandable Dashboard Options Checklist (Opens when arrow is clicked) */}
                  {showAccessList && (
                    <div className="p-3 bg-slate-50 border-t-2 border-black animate-in fade-in duration-150">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200">
                        <div className="flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-emerald-600" />
                          <span className="font-black text-slate-800 text-xs uppercase">
                            Dashboard Options ({allowedModules.length}/{SYSTEM_MODULES.length})
                          </span>
                        </div>

                        {isEditing && (
                          <div className="flex items-center gap-1.5 no-print">
                            <button
                              type="button"
                              onClick={() => setAllowedModules(SYSTEM_MODULES.map((m) => m.id))}
                              className="text-[9px] font-black px-2 py-0.5 rounded bg-slate-900 text-white hover:bg-black uppercase"
                            >
                              Select All
                            </button>
                            <button
                              type="button"
                              onClick={() => setAllowedModules(getDefaultModulesForRole(role))}
                              className="text-[9px] font-black px-2 py-0.5 rounded bg-slate-200 text-slate-800 hover:bg-slate-300 uppercase"
                            >
                              Reset
                            </button>
                            <button
                              type="button"
                              onClick={() => setAllowedModules([])}
                              className="text-[9px] font-black px-2 py-0.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 uppercase"
                            >
                              Clear
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Options Grid displayed in current system language */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {SYSTEM_MODULES.map((mod) => {
                          const isSelected = allowedModules.includes(mod.id);
                          const Icon = mod.icon;
                          const label = getModuleLabel(mod);

                          return (
                            <div
                              key={mod.id}
                              onClick={() => toggleModulePermission(mod.id)}
                              className={`flex items-center gap-2 p-2 rounded-lg border transition-all select-none ${
                                isSelected
                                  ? 'bg-emerald-50 border-emerald-500 text-emerald-950 font-black shadow-xs'
                                  : 'bg-white border-slate-200 text-slate-400 opacity-60'
                              } ${isEditing ? 'cursor-pointer hover:border-emerald-600 hover:opacity-100' : 'cursor-default'}`}
                            >
                              <div
                                className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border ${
                                  isSelected
                                    ? 'bg-emerald-600 border-emerald-600 text-white'
                                    : 'bg-slate-100 border-slate-300 text-transparent'
                                }`}
                              >
                                <Check className="w-3 h-3 stroke-[3px]" />
                              </div>

                              <div
                                className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${
                                  isSelected ? 'bg-emerald-200/60 text-emerald-800' : 'bg-slate-100 text-slate-400'
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5" />
                              </div>

                              <span className="text-[10px] font-black uppercase truncate flex-1">
                                {label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================= PHOTO SELECTION MODAL ======================= */}
      {showPhotoModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 no-print animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700">
                  <Camera className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">फोटो ॲड करा (Add Photo)</h3>
                  <p className="text-[11px] text-slate-500">पर्याय निवडा (Choose an option)</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPhotoModal(false)}
                className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setShowPhotoModal(false);
                  cameraInputRef.current?.click();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/60 text-slate-800 font-bold text-xs transition text-left group"
              >
                <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-black text-slate-900">कॅमेऱ्याने थेट फोटो काढा</div>
                  <div className="text-[10px] text-slate-500 font-medium">Take Live Photo / Open Camera</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowPhotoModal(false);
                  galleryInputRef.current?.click();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50/60 text-slate-800 font-bold text-xs transition text-left group"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0">
                  <ImageIcon className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-black text-slate-900">गॅलरी / फाइलमधून निवडा</div>
                  <div className="text-[10px] text-slate-500 font-medium">Choose from Gallery / Files</div>
                </div>
              </button>

              {photoUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setPhotoUrl('');
                    setShowPhotoModal(false);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-rose-200 hover:bg-rose-50 text-rose-700 font-bold text-xs transition text-left"
                >
                  <Trash2 className="w-4 h-4 text-rose-500 shrink-0" />
                  <span>फोटो काढून टाका (Remove Photo)</span>
                </button>
              )}
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowPhotoModal(false)}
                className="w-full py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden File Inputs for Photo Modal */}
      <input
        type="file"
        ref={cameraInputRef}
        accept="image/*"
        capture="environment"
        onChange={handlePhotoUpload}
        className="hidden"
      />
      <input
        type="file"
        ref={galleryInputRef}
        accept="image/*"
        onChange={handlePhotoUpload}
        className="hidden"
      />
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
