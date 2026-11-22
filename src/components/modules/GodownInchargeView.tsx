import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Clock,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mail,
  PackageCheck,
  Phone,
  Plus,
  Save,
  Search,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Truck,
  UserCheck,
  UserPlus,
  Users,
  UserX,
  Warehouse,
  X,
} from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { getFriendlyErrorMessage } from '../../firebase';
import { UserProfile, isAdmin, isGodownIncharge, isOfficeOrFactoryStaff } from '../../lib/auth';
import {
  formatDisplayDate,
  getLocalDateStr,
  logAudit,
  safeFirestoreDelete,
  safeFirestoreSet,
  safeLocalStorageSet,
  syncOfficerDetailsEverywhere,
  toTimestampMs,
  triggerBlobDownload,
} from '../../lib/dataService';
import {
  OfficeStaffAttendanceRecord,
  OfficeStaffMember,
  useSharedMasterPricelist,
  useSharedOfficeAttendance,
  useSharedOfficeStaff,
  useSharedOrders,
  useSharedUsers,
} from '../../lib/realtimeStore';
import { useBranding } from '../../lib/branding';
import { compressImageFile } from '../../lib/imageCompression';
import { Language } from '../../lib/i18n';
import { cn, toTitleCase } from '../../lib/utils';
import { CustomDialogModal } from '../CustomDialogModal';
import {
  getCleanGradeName,
  getWarehouseOrderStatus,
  GodownOrderSlipCard,
  isOrderApprovedForGodown,
  OrderItem,
  resolveOrderLineForBox,
  WarehouseOrderStatus,
} from './OrderView';
import { OFFICIAL_REFERENCE_DATA, DynamicPriceProduct } from './PriceListView';
import {
  calculateNextUserCode,
  DESIGNATION_OPTIONS,
  DetailedUserProfile,
  getDefaultDesignationForRole,
  getDefaultModulesForRole,
  SYSTEM_MODULES,
  SYSTEM_ROLES,
  SystemModuleItem,
} from './UserManagementView';

interface Props {
  profile: UserProfile;
  lang: Language;
}

type ModuleTab = 'orders' | 'attendance' | 'report' | 'incharge_form' | null;
type AttendanceStatus = 'present' | 'half_day' | 'absent' | 'leave';

const QUICK_WORK_ROLES = [
  'Office Clerk',
  'Warehouse Helper',
  'Packing Staff',
  'Loading / Dispatch',
  'Factory Worker',
  'Operator',
];

function normalizePersonKey(name?: string, category?: string): string {
  const cleanName = String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const cleanCat = String(category || 'Office Staff').toLowerCase().trim();
  return `${cleanName}|${cleanCat}`;
}

function calculateNextStaffCode(existingStaff: OfficeStaffMember[]): string {
  const numericValues: number[] = [];
  existingStaff.forEach((s) => {
    const raw = String(s.staffCode || s.userCode || '').trim().toUpperCase();
    if (raw.startsWith('STF-')) {
      const parsed = parseInt(raw.replace('STF-', ''), 10);
      if (!isNaN(parsed)) numericValues.push(parsed);
    } else if (raw.startsWith('EMP-')) {
      const parsed = parseInt(raw.replace('EMP-', ''), 10);
      if (!isNaN(parsed)) numericValues.push(parsed);
    }
  });
  const nextNum = numericValues.length > 0 ? Math.max(...numericValues) + 1 : 1;
  return `STF-${String(nextNum).padStart(2, '0')}`;
}

function formatSafeDateString(val: any): string {
  if (!val) return getLocalDateStr();
  if (typeof val === 'string') {
    if (val.length >= 10 && val.includes('-')) return val.slice(0, 10);
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return val;
  }
  if (val && typeof val.toDate === 'function') {
    try {
      return val.toDate().toISOString().slice(0, 10);
    } catch {}
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && !isNaN(val)) {
    return new Date(val).toISOString().slice(0, 10);
  }
  return getLocalDateStr();
}

export const GodownInchargeView: React.FC<Props> = ({ profile, lang }) => {
  const userIsAdmin = isAdmin(profile);
  const canAccess =
    userIsAdmin ||
    isGodownIncharge(profile) ||
    Boolean(Array.isArray(profile.allowedModules) && profile.allowedModules.includes('office_staff'));

  const { staffMembers, loaded: staffLoaded, setOfficeStaffOptimistic } = useSharedOfficeStaff();
  const { attendanceRecords, setOfficeAttendanceOptimistic } = useSharedOfficeAttendance();
  const { users: sharedUsers, setUsersOptimistic } = useSharedUsers();
  const allUsers = sharedUsers as DetailedUserProfile[];
  const { orders: rawSharedOrders, setOrdersOptimistic } = useSharedOrders();
  const { products: sharedMasterProducts } = useSharedMasterPricelist();
  const { logoUrl, logoSize } = useBranding();

  const [activeTab, setActiveTab] = useState<ModuleTab>(null);
  const [selectedDate, setSelectedDate] = useState<string>(() => getLocalDateStr());
  const [selectedMonth, setSelectedMonth] = useState<string>(() => getLocalDateStr().slice(0, 7));
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'Office Staff' | 'Factory Staff'>('all');
  const [staffSearch, setStaffSearch] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [warehouseStatusFilter, setWarehouseStatusFilter] = useState<'all' | WarehouseOrderStatus>('fresh');
  const [orderDateSort, setOrderDateSort] = useState<'desc' | 'asc'>('desc');
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [savingStaffId, setSavingStaffId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  // Full-Page Structured Staff Form State
  const [staffViewMode, setStaffViewMode] = useState<'list' | 'form'>('list');
  const [isEditingStaffForm, setIsEditingStaffForm] = useState(false);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [linkedUserUidInput, setLinkedUserUidInput] = useState<string>('');
  const [staffCodeInput, setStaffCodeInput] = useState('');
  const [staffJoiningDateInput, setStaffJoiningDateInput] = useState(getLocalDateStr());
  const [staffNameInput, setStaffNameInput] = useState('');
  const [staffCategoryInput, setStaffCategoryInput] = useState<'Office Staff' | 'Factory Staff'>('Office Staff');
  const [staffWorkRoleInput, setStaffWorkRoleInput] = useState('');
  const [staffMobileInput, setStaffMobileInput] = useState('');
  const [staffStateInput, setStaffStateInput] = useState('Maharashtra');
  const [staffTalukaInput, setStaffTalukaInput] = useState('');
  const [staffDistrictInput, setStaffDistrictInput] = useState('SANGLI');
  const [staffPinCodeInput, setStaffPinCodeInput] = useState('');
  const [staffDobInput, setStaffDobInput] = useState('');
  const [staffAadhaarInput, setStaffAadhaarInput] = useState('');
  const [staffStatusInput, setStaffStatusInput] = useState<'Active' | 'Inactive'>('Active');
  const [staffPhotoUrlInput, setStaffPhotoUrlInput] = useState('');
  const [staffBankNameInput, setStaffBankNameInput] = useState('');
  const [staffBankAddressInput, setStaffBankAddressInput] = useState('');
  const [staffAccountNumberInput, setStaffAccountNumberInput] = useState('');
  const [staffIfscCodeInput, setStaffIfscCodeInput] = useState('');
  const [staffHasSecurityChequeInput, setStaffHasSecurityChequeInput] = useState(false);
  const [staffSecurityChequeNumberInput, setStaffSecurityChequeNumberInput] = useState('');

  // Admin-Only Warehouse Incharge User Form State (Exact User Form Parity + Login ID & Password)
  const [incUid, setIncUid] = useState<string | null>(null);
  const [incUserCode, setIncUserCode] = useState('');
  const [incJoiningDate, setIncJoiningDate] = useState(getLocalDateStr());
  const [incFullName, setIncFullName] = useState('');
  const [incDesignation, setIncDesignation] = useState('Godown Incharge');
  const [incCenter, setIncCenter] = useState('');
  const [incRole, setIncRole] = useState('godown_incharge');
  const [incMobileNumber, setIncMobileNumber] = useState('');
  const [incAltPhone, setIncAltPhone] = useState('');
  const [incEmailId, setIncEmailId] = useState('');
  const [incStateName, setIncStateName] = useState('Maharashtra');
  const [incAddress, setIncAddress] = useState('');
  const [incVillage, setIncVillage] = useState('');
  const [incTaluka, setIncTaluka] = useState('');
  const [incDistrict, setIncDistrict] = useState('SANGLI');
  const [incPinCode, setIncPinCode] = useState('');
  const [incDateOfBirth, setIncDateOfBirth] = useState('');
  const [incAadhaarNo, setIncAadhaarNo] = useState('');
  const [incPanNo, setIncPanNo] = useState('');
  const [incBankName, setIncBankName] = useState('');
  const [incBankAddress, setIncBankAddress] = useState('');
  const [incAccountNumber, setIncAccountNumber] = useState('');
  const [incIfscCode, setIncIfscCode] = useState('');
  const [incHasSecurityCheque, setIncHasSecurityCheque] = useState(false);
  const [incSecurityChequeNumber, setIncSecurityChequeNumber] = useState('');
  const [incLoginId, setIncLoginId] = useState('');
  const [incPassword, setIncPassword] = useState('bw@123');
  const [incStatus, setIncStatus] = useState<'Active' | 'Inactive'>('Active');
  const [incAllowedModules, setIncAllowedModules] = useState<string[]>(getDefaultModulesForRole('godown_incharge'));
  const [incPhotoUrl, setIncPhotoUrl] = useState('');
  const [isEditingInchargeForm, setIsEditingInchargeForm] = useState(false);
  const [isSavingIncharge, setIsSavingIncharge] = useState(false);
  const [showIncPassword, setShowIncPassword] = useState(false);
  const [showIncAccessList, setShowIncAccessList] = useState(false);

  const [isSavingMember, setIsSavingMember] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [saveToast, setSaveToast] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const printableStaffFormRef = useRef<HTMLDivElement>(null);
  const printableInchargeFormRef = useRef<HTMLDivElement>(null);
  const staffFormHistoryPushedRef = useRef(false);

  const warehouseInchargeUsers = useMemo<DetailedUserProfile[]>(() => {
    if (!userIsAdmin) return [];
    return allUsers
      .filter((u: any) => u && !u.isArchived && isGodownIncharge(u))
      .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || '')));
  }, [allUsers, userIsAdmin]);

  const isUnmountingRef = useRef(false);

  useEffect(() => {
    isUnmountingRef.current = false;
    return () => {
      isUnmountingRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!userIsAdmin && activeTab === 'incharge_form') {
      setActiveTab(null);
    }
  }, [userIsAdmin, activeTab]);

  const openSubTab = (tab: Exclude<ModuleTab, null>) => {
    if (tab === 'incharge_form' && !userIsAdmin) return;
    if (tab === 'orders') {
      setWarehouseStatusFilter('fresh');
    }
    setStaffViewMode('list');
    setActiveTab(tab);
    try {
      if (!window.history.state?.warehouseTab) {
        window.history.pushState({ tab: 'office_staff', warehouseTab: tab }, '');
      } else {
        window.history.replaceState({ tab: 'office_staff', warehouseTab: tab }, '');
      }
    } catch {}
  };

  const handleReturnToHub = () => {
    try {
      if (window.history.state?.tab === 'office_staff' && window.history.state?.warehouseStaffFormOpen) {
        setStaffViewMode('list');
        setActiveTab(null);
        window.history.go(-2);
        return;
      }
      if (window.history.state?.tab === 'office_staff' && window.history.state?.warehouseTab) {
        window.history.back();
        return;
      }
    } catch {}
    setStaffViewMode('list');
    setActiveTab(null);
  };

  const handleCloseStaffForm = () => {
    try {
      if (window.history.state?.tab === 'office_staff' && window.history.state?.warehouseStaffFormOpen) {
        window.history.back();
        return;
      }
    } catch {}
    setStaffViewMode('list');
  };

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (isUnmountingRef.current) return;
      const st = e.state;
      if (st?.tab === 'office_staff') {
        const nextTab = (st.warehouseTab || null) as ModuleTab;
        const nextForm = Boolean(st.warehouseStaffFormOpen && nextTab === 'attendance');
        setActiveTab(nextTab && (nextTab !== 'incharge_form' || userIsAdmin) ? nextTab : null);
        setStaffViewMode(nextForm ? 'form' : 'list');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [userIsAdmin]);

  useEffect(() => {
    if (staffViewMode === 'form') {
      try {
        if (!window.history.state?.warehouseStaffFormOpen) {
          window.history.pushState(
            { tab: 'office_staff', warehouseTab: 'attendance', warehouseStaffFormOpen: true },
            ''
          );
        }
      } catch {}
    }
  }, [staffViewMode]);

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

  // Deduplicated, reliable Staff Roster:
  // 1. Includes Office Staff, Factory Staff, and Warehouse/Godown Incharge accounts (plus active logged-in profile).
  // 2. Merges linked User Form profile fields (code, address, KYC, bank details, photo) when linkedUserUid matches.
  // 3. Deduplicates strictly by normalized (fullName + category) so Warehouse Incharge names never appear twice or disappear.
  const combinedStaffRoster = useMemo<OfficeStaffMember[]>(() => {
    const activeUserMap = new Map<string, any>();
    (sharedUsers || []).forEach((u: any) => {
      if (!u || u.isArchived) return;
      const uid = String(u.uid || u.id || '').trim();
      if (uid) activeUserMap.set(uid, u);
    });
    if (profile?.uid && !activeUserMap.has(profile.uid)) {
      activeUserMap.set(profile.uid, profile);
    }

    const byId = new Map<string, OfficeStaffMember>();
    const linkedUidSet = new Set<string>();

    staffMembers.forEach((m) => {
      if (!m || m.isArchived || !String(m.fullName || '').trim()) return;
      const linkedUid =
        m.linkedUserUid || (m.id.startsWith('staff_user_') ? m.id.replace(/^staff_user_/, '') : '');
      const lu = linkedUid ? activeUserMap.get(linkedUid) : undefined;
      const enriched: OfficeStaffMember = lu
        ? {
            ...m,
            linkedUserUid: linkedUid,
            staffCode: m.staffCode || m.userCode || lu.userCode || '',
            userCode: m.userCode || lu.userCode || '',
            designation: m.designation || m.workRole || lu.designation || '',
            center: m.center ?? lu.center ?? '',
            mobileNumber: m.mobileNumber || lu.mobileNumber || '',
            altPhone: m.altPhone ?? lu.altPhone ?? '',
            emailId: m.emailId ?? lu.emailId ?? '',
            address: m.address ?? lu.address ?? '',
            village: m.village ?? lu.village ?? '',
            taluka: m.taluka ?? lu.taluka ?? '',
            district: m.district ?? lu.district ?? '',
            state: m.state ?? lu.state ?? '',
            pinCode: m.pinCode ?? lu.pinCode ?? '',
            dateOfBirth: m.dateOfBirth ?? lu.dateOfBirth ?? '',
            joiningDate: m.joiningDate || lu.joiningDate || '',
            aadhaarNo: m.aadhaarNo ?? lu.aadhaarNo ?? '',
            panNo: m.panNo ?? lu.panNo ?? '',
            photoUrl: m.photoUrl || lu.photoUrl || '',
            bankName: m.bankName ?? lu.bankName ?? '',
            bankAddress: m.bankAddress ?? lu.bankAddress ?? '',
            accountNumber: m.accountNumber ?? lu.accountNumber ?? '',
            ifscCode: m.ifscCode ?? lu.ifscCode ?? '',
            hasSecurityCheque: m.hasSecurityCheque ?? lu.hasSecurityCheque ?? false,
            securityChequeNumber: m.securityChequeNumber ?? lu.securityChequeNumber ?? '',
          }
        : m;
      byId.set(m.id, enriched);
      if (linkedUid) linkedUidSet.add(linkedUid);
    });

    const userCandidates: any[] = [...(sharedUsers || [])];
    if (
      profile?.uid &&
      !isAdmin(profile) &&
      (isGodownIncharge(profile) || isOfficeOrFactoryStaff(profile)) &&
      !userCandidates.some((u: any) => u && String(u.uid || u.id) === profile.uid)
    ) {
      userCandidates.push(profile);
    }

    userCandidates.forEach((u: any) => {
      if (!u || u.isArchived || !u.uid) return;
      if (linkedUidSet.has(u.uid) || byId.has(`staff_user_${u.uid}`)) return;
      const r = String(u.role || '').toLowerCase().trim();
      const d = String(u.designation || '').toLowerCase().trim();
      const isWarehouseOrOfficeOrFactory =
        r === 'office_staff' ||
        r === 'factory_staff' ||
        r === 'godown_incharge' ||
        r === 'warehouse_incharge' ||
        d.includes('office staff') ||
        d.includes('factory staff') ||
        d.includes('godown') ||
        d.includes('warehouse') ||
        d.includes('store incharge') ||
        d.includes('store in-charge');
      if (!isWarehouseOrOfficeOrFactory) return;

      const cat: 'Office Staff' | 'Factory Staff' =
        r === 'factory_staff' || d.includes('factory') ? 'Factory Staff' : 'Office Staff';
      byId.set(`staff_user_${u.uid}`, {
        id: `staff_user_${u.uid}`,
        staffCode: u.userCode || '',
        userCode: u.userCode || '',
        fullName: toTitleCase(u.fullName || u.loginId || 'Staff'),
        category: cat,
        workRole: toTitleCase(u.designation || cat),
        designation: toTitleCase(u.designation || cat),
        center: u.center || '',
        mobileNumber: u.mobileNumber || '',
        altPhone: u.altPhone || '',
        emailId: u.emailId || '',
        address: u.address || '',
        village: u.village || '',
        taluka: u.taluka || '',
        district: u.district || '',
        state: u.state || 'Maharashtra',
        pinCode: u.pinCode || '',
        dateOfBirth: u.dateOfBirth || '',
        joiningDate: u.joiningDate || '',
        aadhaarNo: u.aadhaarNo || '',
        panNo: u.panNo || '',
        photoUrl: u.photoUrl || '',
        bankName: u.bankName || '',
        bankAddress: u.bankAddress || '',
        accountNumber: u.accountNumber || '',
        ifscCode: u.ifscCode || '',
        hasSecurityCheque: Boolean(u.hasSecurityCheque || u.securityChequeNumber),
        securityChequeNumber: u.securityChequeNumber || '',
        status: u.status === 'Inactive' ? 'Inactive' : 'Active',
        linkedUserUid: u.uid,
        createdAt: u.createdAt || '',
        updatedAt: u.updatedAt || '',
      });
    });

    // Person-level deduplication by normalized (fullName + category)
    const uniqueByPerson = new Map<string, OfficeStaffMember>();
    const scoreEntry = (item: OfficeStaffMember): number => {
      const uid = item.linkedUserUid || '';
      let score = 0;
      if (uid && uid === profile?.uid) score += 1000;
      if (uid && activeUserMap.has(uid)) score += 500;
      if (!item.id.startsWith('staff_user_')) score += 200;
      return score;
    };

    Array.from(byId.values()).forEach((item) => {
      const key = normalizePersonKey(item.fullName, item.category);
      const prev = uniqueByPerson.get(key);
      if (!prev) {
        uniqueByPerson.set(key, item);
        return;
      }
      const prevScore = scoreEntry(prev);
      const nextScore = scoreEntry(item);
      if (nextScore > prevScore) {
        uniqueByPerson.set(key, item);
      } else if (nextScore === prevScore) {
        const prevTs = toTimestampMs(prev.updatedAt || prev.createdAt);
        const nextTs = toTimestampMs(item.updatedAt || item.createdAt);
        if (nextTs >= prevTs) {
          uniqueByPerson.set(key, item);
        }
      }
    });

    return Array.from(uniqueByPerson.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [staffMembers, sharedUsers, profile]);

  const activeRoster = useMemo(
    () => combinedStaffRoster.filter((s) => s.status !== 'Inactive'),
    [combinedStaffRoster]
  );

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    return combinedStaffRoster.filter((s) => {
      if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        s.fullName.toLowerCase().includes(q) ||
        String(s.workRole || '').toLowerCase().includes(q) ||
        String(s.mobileNumber || '').includes(q)
      );
    });
  }, [combinedStaffRoster, categoryFilter, staffSearch]);

  // Attendance map for selected date: staffId -> record (with name fallback for linked records)
  const dateAttendanceMap = useMemo(() => {
    const map = new Map<string, OfficeStaffAttendanceRecord>();
    const byName = new Map<string, OfficeStaffAttendanceRecord>();
    attendanceRecords.forEach((rec) => {
      if (rec.date === selectedDate && !rec.isArchived) {
        map.set(rec.staffId, rec);
        const nameKey = normalizePersonKey(rec.staffName, rec.category);
        if (!byName.has(nameKey)) byName.set(nameKey, rec);
      }
    });
    combinedStaffRoster.forEach((member) => {
      if (!map.has(member.id)) {
        const fallbackRec = byName.get(normalizePersonKey(member.fullName, member.category));
        if (fallbackRec) map.set(member.id, fallbackRec);
      }
    });
    return map;
  }, [attendanceRecords, selectedDate, combinedStaffRoster]);

  // Daily Summary Counters
  const dailySummary = useMemo(() => {
    let present = 0;
    let halfDay = 0;
    let absent = 0;
    let leave = 0;

    activeRoster.forEach((s) => {
      const rec = dateAttendanceMap.get(s.id);
      if (!rec) return;
      if (rec.status === 'present') present += 1;
      else if (rec.status === 'half_day') halfDay += 1;
      else if (rec.status === 'absent') absent += 1;
      else if (rec.status === 'leave') leave += 1;
    });

    return {
      total: activeRoster.length,
      present,
      halfDay,
      absent,
      leave,
    };
  }, [activeRoster, dateAttendanceMap]);

  // Monthly Summary Rows
  const monthlySummaryRows = useMemo(() => {
    const monthRecords = attendanceRecords.filter(
      (r) => !r.isArchived && (r.monthKey === selectedMonth || r.date.startsWith(selectedMonth))
    );
    const byStaff = new Map<string, { present: number; halfDay: number; absent: number; leave: number }>();
    const rosterIds = new Set(combinedStaffRoster.map((s) => s.id));
    const rosterByName = new Map<string, string>();
    combinedStaffRoster.forEach((s) => {
      rosterByName.set(normalizePersonKey(s.fullName, s.category), s.id);
    });

    monthRecords.forEach((r) => {
      const targetId = rosterIds.has(r.staffId)
        ? r.staffId
        : rosterByName.get(normalizePersonKey(r.staffName, r.category)) || r.staffId;
      const cur = byStaff.get(targetId) || { present: 0, halfDay: 0, absent: 0, leave: 0 };
      if (r.status === 'present') cur.present += 1;
      else if (r.status === 'half_day') cur.halfDay += 1;
      else if (r.status === 'absent') cur.absent += 1;
      else if (r.status === 'leave') cur.leave += 1;
      byStaff.set(targetId, cur);
    });

    return combinedStaffRoster.map((s) => {
      const counts = byStaff.get(s.id) || { present: 0, halfDay: 0, absent: 0, leave: 0 };
      const payableDays = counts.present + counts.halfDay * 0.5;
      return {
        staff: s,
        ...counts,
        payableDays,
      };
    });
  }, [combinedStaffRoster, attendanceRecords, selectedMonth]);

  // Approved Orders for Warehouse Fulfillment
  const productsLookup = useMemo<DynamicPriceProduct[]>(() => {
    return sharedMasterProducts.length > 0 ? sharedMasterProducts : OFFICIAL_REFERENCE_DATA;
  }, [sharedMasterProducts]);

  const findProductForOrderItem = (it: any): DynamicPriceProduct | null => {
    if (!it) return null;
    if (it.productId) {
      const byId = productsLookup.find((p) => p.id === it.productId);
      if (byId) return byId;
    }
    const label = String(it.gradeName || it.productName || '').toLowerCase().trim();
    if (!label) return null;
    return (
      productsLookup.find(
        (p) =>
          (p.gradeName || '').toLowerCase().trim() === label ||
          (p.brandName || '').toLowerCase().trim() === label ||
          getCleanGradeName(p).toLowerCase().trim() === label
      ) || null
    );
  };

  const allApprovedOrders = useMemo<OrderItem[]>(() => {
    return rawSharedOrders
      .filter((o: any) => !o.isArchived && isOrderApprovedForGodown(o))
      .map((data: any) => {
        const cleanedItems = (data.items || []).map((it: any) => {
          const cleanName = getCleanGradeName(it);
          return {
            ...it,
            productName: cleanName,
            gradeName: cleanName,
          };
        });
        return {
          ...data,
          id: data.id,
          orderNumber: data.orderNumber || `BW-${String(data.id || '').slice(-6)}`,
          dealerName: data.dealerName || 'General Dealer',
          items: cleanedItems,
          totalQuantity:
            data.totalQuantity ||
            (data.items?.reduce((a: number, b: any) => a + (Number(b.quantity) || 0), 0) || 0),
          createdByName: data.createdByName || 'Officer',
          createdAt: data.createdAt || new Date().toISOString(),
        } as OrderItem;
      });
  }, [rawSharedOrders]);

  const orderStatusCounts = useMemo(() => {
    let fresh = 0;
    let dispatched = 0;
    let delivered = 0;
    allApprovedOrders.forEach((o) => {
      const st = getWarehouseOrderStatus(o);
      if (st === 'fresh') fresh += 1;
      else if (st === 'dispatched') dispatched += 1;
      else if (st === 'delivered') delivered += 1;
    });
    return {
      all: allApprovedOrders.length,
      fresh,
      dispatched,
      delivered,
    };
  }, [allApprovedOrders]);

  const filteredApprovedOrders = useMemo<OrderItem[]>(() => {
    const q = orderSearch.trim().toLowerCase();
    const list = allApprovedOrders.filter((o) => {
      if (warehouseStatusFilter !== 'all' && getWarehouseOrderStatus(o) !== warehouseStatusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        String(o.orderNumber || '').toLowerCase().includes(q) ||
        String(o.dealerName || '').toLowerCase().includes(q) ||
        String(o.dealerVillage || '').toLowerCase().includes(q) ||
        String(o.dealerDistrict || '').toLowerCase().includes(q) ||
        String(o.dealerContact || '').includes(q) ||
        String(o.transportName || o.transportDetails || o.dispatchNote || '').toLowerCase().includes(q) ||
        (o.items || []).some((it) =>
          String(it.gradeName || it.productName || '').toLowerCase().includes(q)
        )
      );
    });

    const getSortDateMs = (o: OrderItem): number => {
      if (warehouseStatusFilter === 'dispatched') {
        return toTimestampMs(o.warehouseDispatchedAt || o.dispatchedAt || o.createdAt || o.approvedAt);
      }
      if (warehouseStatusFilter === 'delivered') {
        return toTimestampMs(o.warehouseDeliveredAt || o.deliveredAt || o.createdAt || o.approvedAt);
      }
      return toTimestampMs(o.createdAt || o.approvedAt);
    };

    return [...list].sort((a, b) => {
      const diff = getSortDateMs(a) - getSortDateMs(b);
      if (diff !== 0) {
        return orderDateSort === 'desc' ? -diff : diff;
      }
      return String(b.orderNumber || '').localeCompare(String(a.orderNumber || ''));
    });
  }, [allApprovedOrders, warehouseStatusFilter, orderSearch, orderDateSort]);

  if (!canAccess) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-8">
        <p className="text-sm font-bold text-slate-800">
          This section is only available to Warehouse Incharge and Admin.
        </p>
      </div>
    );
  }

  const openAddStaffForm = () => {
    setEditingStaffId(null);
    setLinkedUserUidInput('');
    setStaffCodeInput(calculateNextStaffCode(combinedStaffRoster));
    setStaffJoiningDateInput(getLocalDateStr());
    setStaffNameInput('');
    setStaffCategoryInput(categoryFilter === 'Factory Staff' ? 'Factory Staff' : 'Office Staff');
    setStaffWorkRoleInput('');
    setStaffMobileInput('');
    setStaffStateInput('Maharashtra');
    setStaffTalukaInput('');
    setStaffDistrictInput('SANGLI');
    setStaffPinCodeInput('');
    setStaffDobInput('');
    setStaffAadhaarInput('');
    setStaffStatusInput('Active');
    setStaffPhotoUrlInput('');
    setStaffBankNameInput('');
    setStaffBankAddressInput('');
    setStaffAccountNumberInput('');
    setStaffIfscCodeInput('');
    setStaffHasSecurityChequeInput(false);
    setStaffSecurityChequeNumberInput('');
    setIsEditingStaffForm(true);
    setStaffViewMode('form');
  };

  const openStaffForm = (member: OfficeStaffMember, editMode: boolean = true) => {
    setEditingStaffId(member.id);
    setLinkedUserUidInput(member.linkedUserUid || '');
    setStaffCodeInput(member.staffCode || member.userCode || calculateNextStaffCode(combinedStaffRoster));
    setStaffJoiningDateInput(formatSafeDateString(member.joiningDate || member.createdAt));
    setStaffNameInput(member.fullName || '');
    setStaffCategoryInput(member.category);
    setStaffWorkRoleInput(member.workRole || member.designation || '');
    setStaffMobileInput(member.mobileNumber || '');
    setStaffStateInput(member.state || 'Maharashtra');
    setStaffTalukaInput(member.taluka || '');
    setStaffDistrictInput(member.district || 'SANGLI');
    setStaffPinCodeInput(member.pinCode || '');
    setStaffDobInput(member.dateOfBirth || '');
    setStaffAadhaarInput(member.aadhaarNo || '');
    setStaffStatusInput(member.status === 'Inactive' ? 'Inactive' : 'Active');
    setStaffPhotoUrlInput(member.photoUrl || '');
    setStaffBankNameInput(member.bankName || '');
    setStaffBankAddressInput(member.bankAddress || '');
    setStaffAccountNumberInput(member.accountNumber || '');
    setStaffIfscCodeInput(member.ifscCode || '');
    setStaffHasSecurityChequeInput(Boolean(member.hasSecurityCheque || member.securityChequeNumber));
    setStaffSecurityChequeNumberInput(member.securityChequeNumber || '');
    setIsEditingStaffForm(editMode);
    setStaffViewMode('form');
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressed = await compressImageFile(file, 1000, 0.7);
        if (activeTab === 'incharge_form') setIncPhotoUrl(compressed);
        else setStaffPhotoUrlInput(compressed);
      } catch {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          if (activeTab === 'incharge_form') setIncPhotoUrl(result);
          else setStaffPhotoUrlInput(result);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = '';
  };

  // -------------------- Admin-Only Warehouse Incharge User Form Helpers --------------------
  const resetInchargeForm = () => {
    if (!userIsAdmin) return;
    const defaultRole = 'godown_incharge';
    setIncUid(null);
    setIncUserCode(calculateNextUserCode(defaultRole, allUsers));
    setIncJoiningDate(getLocalDateStr());
    setIncFullName('');
    setIncDesignation(getDefaultDesignationForRole(defaultRole));
    setIncCenter('');
    setIncRole(defaultRole);
    setIncMobileNumber('');
    setIncAltPhone('');
    setIncEmailId('');
    setIncStateName('Maharashtra');
    setIncAddress('');
    setIncVillage('');
    setIncTaluka('');
    setIncDistrict('SANGLI');
    setIncPinCode('');
    setIncDateOfBirth('');
    setIncAadhaarNo('');
    setIncPanNo('');
    setIncBankName('');
    setIncBankAddress('');
    setIncAccountNumber('');
    setIncIfscCode('');
    setIncHasSecurityCheque(false);
    setIncSecurityChequeNumber('');
    setIncLoginId('');
    setIncPassword('bw@123');
    setIncStatus('Active');
    setIncAllowedModules(getDefaultModulesForRole(defaultRole));
    setIncPhotoUrl('');
    setShowIncAccessList(false);
    setShowIncPassword(false);
    setIsEditingInchargeForm(true);
  };

  const loadInchargeToForm = (u: DetailedUserProfile, editMode: boolean = true) => {
    if (!userIsAdmin) return;
    setIncUid(u.uid);
    setIncUserCode(u.userCode || calculateNextUserCode(u.role || 'godown_incharge', allUsers));
    setIncJoiningDate(formatSafeDateString(u.joiningDate || u.createdAt));
    setIncFullName(u.fullName || '');
    setIncDesignation(u.designation || getDefaultDesignationForRole(u.role || 'godown_incharge'));
    setIncCenter(u.center || '');
    setIncRole(u.role || 'godown_incharge');
    setIncMobileNumber(u.mobileNumber || '');
    setIncAltPhone(u.altPhone || '');
    setIncEmailId(u.emailId || '');
    setIncStateName(u.state || 'Maharashtra');
    setIncAddress(u.address || '');
    setIncVillage(u.village || '');
    setIncTaluka(u.taluka || '');
    setIncDistrict(u.district || 'SANGLI');
    setIncPinCode(u.pinCode || '');
    setIncDateOfBirth(u.dateOfBirth || '');
    setIncAadhaarNo(u.aadhaarNo || '');
    setIncPanNo(u.panNo || '');
    setIncBankName(u.bankName || '');
    setIncBankAddress(u.bankAddress || '');
    setIncAccountNumber(u.accountNumber || '');
    setIncIfscCode(u.ifscCode || '');
    setIncHasSecurityCheque(Boolean(u.hasSecurityCheque || u.securityChequeNumber));
    setIncSecurityChequeNumber(u.securityChequeNumber || '');
    setIncLoginId(u.loginId || u.mobileNumber || '');
    setIncPassword(u.password || 'bw@123');
    setIncStatus(u.status === 'Inactive' ? 'Inactive' : 'Active');
    setIncAllowedModules(
      u.allowedModules && u.allowedModules.length > 0
        ? u.allowedModules
        : getDefaultModulesForRole(u.role || 'godown_incharge')
    );
    setIncPhotoUrl(u.photoUrl || '');
    setShowIncAccessList(false);
    setShowIncPassword(false);
    setIsEditingInchargeForm(editMode);
  };

  const openAdminInchargeTab = () => {
    if (!userIsAdmin) return;
    openSubTab('incharge_form');
    if (warehouseInchargeUsers.length > 0) {
      const target =
        (incUid ? warehouseInchargeUsers.find((u) => u.uid === incUid) : null) ||
        warehouseInchargeUsers[0];
      loadInchargeToForm(target, false);
    } else {
      resetInchargeForm();
    }
  };

  const handleInchargeRoleChange = (newRole: string) => {
    setIncRole(newRole);
    const nextDesig = getDefaultDesignationForRole(newRole);
    setIncDesignation(nextDesig);
    if (newRole === 'admin' || newRole === 'owner' || nextDesig.toUpperCase().includes('ADMIN')) {
      setIncAllowedModules(SYSTEM_MODULES.map((m) => m.id));
    } else {
      setIncAllowedModules(getDefaultModulesForRole(newRole));
    }
    if (!incUserCode || incUserCode === '1' || incUserCode.startsWith('EMP-')) {
      setIncUserCode(calculateNextUserCode(newRole, allUsers));
    }
  };

  const toggleInchargeModulePermission = (modId: string) => {
    if (!isEditingInchargeForm) return;
    if (incAllowedModules.includes(modId)) {
      setIncAllowedModules(incAllowedModules.filter((id) => id !== modId));
    } else {
      setIncAllowedModules([...incAllowedModules, modId]);
    }
  };

  const handleSaveInchargeForm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!userIsAdmin || isSavingIncharge) return;
    if (!incFullName.trim()) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Validation Error',
        message: 'Please enter Full Name',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }
    if (!incMobileNumber.trim()) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Validation Error',
        message: 'Please enter Mobile Number',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    const trimmedMobile = incMobileNumber.trim();
    const trimmedLogin = incLoginId.trim() || trimmedMobile;
    const uid = incUid || `user_${Date.now()}`;
    const code = incUserCode.trim() || calculateNextUserCode(incRole, allUsers);
    const isTargetAdmin =
      incRole === 'admin' ||
      incRole === 'owner' ||
      incDesignation.toUpperCase().includes('ADMIN') ||
      incDesignation.toUpperCase().includes('OWNER') ||
      incDesignation.toUpperCase().includes('MD');
    const finalAllowedModules = isTargetAdmin ? SYSTEM_MODULES.map((m) => m.id) : incAllowedModules;
    const nowIso = new Date().toISOString();

    const payload: DetailedUserProfile = {
      uid,
      userCode: code,
      fullName: toTitleCase(incFullName.trim()),
      designation: toTitleCase(incDesignation.trim()),
      center: toTitleCase(incCenter.trim()),
      mobileNumber: trimmedMobile,
      altPhone: incAltPhone.trim(),
      emailId: incEmailId.trim() || `${trimmedMobile}@blackwormagri.com`,
      role: incRole,
      address: toTitleCase(incAddress.trim()),
      village: toTitleCase(incVillage.trim()),
      taluka: toTitleCase(incTaluka.trim()),
      district: toTitleCase(incDistrict.trim()),
      state: incStateName.trim(),
      pinCode: incPinCode.trim(),
      dateOfBirth: incDateOfBirth,
      joiningDate: incJoiningDate,
      aadhaarNo: incAadhaarNo.trim(),
      panNo: incPanNo.trim().toUpperCase(),
      loginId: trimmedLogin,
      password: incPassword.trim() || 'bw@123',
      status: incStatus,
      allowedModules: finalAllowedModules,
      photoUrl: incPhotoUrl,
      bankName: toTitleCase(incBankName.trim()),
      bankAddress: toTitleCase(incBankAddress.trim()),
      accountNumber: incAccountNumber.trim(),
      ifscCode: incIfscCode.trim().toUpperCase(),
      hasSecurityCheque: Boolean(incHasSecurityCheque || incSecurityChequeNumber.trim()),
      securityChequeNumber: incSecurityChequeNumber.trim().toUpperCase(),
      updatedAt: nowIso,
      createdAt: incUid
        ? formatSafeDateString(allUsers.find((u) => u.uid === incUid)?.createdAt) || nowIso
        : nowIso,
    };

    setIsSavingIncharge(true);
    try {
      const existingUser = allUsers.find((u) => u.uid === uid);
      const wasNewUser = !incUid;

      setUsersOptimistic((prev) => {
        const idx = prev.findIndex((u) => u.uid === uid);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = payload;
          return updated;
        }
        return [...prev, payload];
      });
      setIncFullName(payload.fullName);
      setIncDesignation(payload.designation || '');
      setIncCenter(payload.center || '');
      setIncLoginId(payload.loginId || '');

      await safeFirestoreSet('users', uid, payload, { merge: true });

      if (uid === profile.uid) {
        const { password: _omittedPass, ...safeSession } = payload;
        safeLocalStorageSet('blackworm_user_profile', JSON.stringify(safeSession));
      }

      setIncUid(uid);
      setIsEditingInchargeForm(false);
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);

      void (async () => {
        try {
          await syncOfficerDetailsEverywhere(uid, payload.fullName, payload.designation, payload.center, {
            loginId: payload.loginId,
            oldName: existingUser?.fullName,
            userCode: payload.userCode,
          });
        } catch {}

        const staffDocId = `staff_user_${uid}`;
        const staffCat: 'Office Staff' | 'Factory Staff' =
          String(payload.role || '').toLowerCase() === 'factory_staff' ||
          String(payload.designation || '').toLowerCase().includes('factory')
            ? 'Factory Staff'
            : 'Office Staff';
        await safeFirestoreSet(
          'office_staff_members',
          staffDocId,
          {
            id: staffDocId,
            staffCode: payload.userCode || '',
            userCode: payload.userCode || '',
            fullName: payload.fullName,
            category: staffCat,
            workRole: payload.designation || 'Godown Incharge',
            designation: payload.designation || 'Godown Incharge',
            center: payload.center || '',
            mobileNumber: payload.mobileNumber || '',
            joiningDate: payload.joiningDate || getLocalDateStr(),
            status: payload.status === 'Inactive' ? 'Inactive' : 'Active',
            linkedUserUid: uid,
            createdByUid: profile.uid || '',
            createdByName: profile.fullName || 'Admin',
            isArchived: false,
            updatedAt: nowIso,
            createdAt: nowIso,
          },
          { merge: true }
        ).catch(() => {});

        await logAudit(
          wasNewUser ? 'CREATE' : 'UPDATE',
          'users',
          uid,
          `${wasNewUser ? 'Registered' : 'Updated'} Warehouse Incharge Form for ${payload.fullName} (${payload.loginId})`,
          profile
        ).catch(() => {});
      })();
    } catch (err: any) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Save Error',
        message: getFriendlyErrorMessage(err, 'Failed to save Warehouse Incharge details.'),
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsSavingIncharge(false);
    }
  };

  const handleDeleteInchargeForm = (uid: string, name: string) => {
    if (!userIsAdmin) return;
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Warehouse Incharge?',
      message: `Are you sure you want to delete Warehouse Incharge record for "${name}"?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        try {
          setUsersOptimistic((prev) => prev.filter((u) => u.uid !== uid));
          setOfficeStaffOptimistic((prev) => prev.filter((s) => s.id !== `staff_user_${uid}` && s.linkedUserUid !== uid));
          await safeFirestoreDelete('users', uid, { softDelete: true, user: profile });
          await safeFirestoreDelete('office_staff_members', `staff_user_${uid}`, { softDelete: true, user: profile }).catch(() => {});
          await logAudit('DELETE', 'users', uid, `Deleted Warehouse Incharge user ${name}`, profile).catch(() => {});
          const remaining = warehouseInchargeUsers.filter((u) => u.uid !== uid);
          if (remaining.length > 0) loadInchargeToForm(remaining[0], false);
          else resetInchargeForm();
        } catch (err: any) {
          setDialogConfig({
            isOpen: true,
            type: 'alert',
            title: 'Delete Error',
            message: getFriendlyErrorMessage(err, 'Could not delete Warehouse Incharge record.'),
            onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
          });
        }
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const handleDownloadInchargePdf = async () => {
    if (!printableInchargeFormRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const canvas = await html2canvas(printableInchargeFormRef.current, {
        scale: 2.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });
      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      const sanitizedName = (incFullName || incUserCode || 'Warehouse_Incharge_Form').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch {
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const getInchargeRoleLabel = (roleId: string) => {
    const r = SYSTEM_ROLES.find((item) => item.id === roleId);
    return r ? r.label : roleId;
  };

  const getModuleLabel = (mod: SystemModuleItem) => {
    return (lang as string) === 'mr' ? mod.mr : mod.en;
  };

  const handleDownloadStaffPdf = async () => {
    if (!printableStaffFormRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const element = printableStaffFormRef.current;
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
        format: 'a4',
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      const sanitizedName = (staffNameInput || staffCodeInput || 'Warehouse_Staff_Form').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err) {
      console.error('Staff PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleSaveStaffMember = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSavingMember) return;
    const cleanName = toTitleCase(staffNameInput.trim());
    if (!cleanName) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Validation Error',
        message: 'Please enter Full Name',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setIsSavingMember(true);
    try {
      const nowIso = new Date().toISOString();
      const id = editingStaffId || `staff_${Date.now()}`;
      const existing = combinedStaffRoster.find((s) => s.id === id);
      const finalCode = staffCodeInput.trim().toUpperCase() || existing?.staffCode || existing?.userCode || calculateNextStaffCode(combinedStaffRoster);
      const finalWorkRole = toTitleCase(staffWorkRoleInput.trim()) || staffCategoryInput;

      const record: OfficeStaffMember = {
        ...(existing || {}),
        id,
        staffCode: finalCode,
        userCode: existing?.userCode || finalCode,
        fullName: cleanName,
        category: staffCategoryInput,
        workRole: finalWorkRole,
        designation: finalWorkRole,
        mobileNumber: staffMobileInput.trim(),
        taluka: toTitleCase(staffTalukaInput.trim()),
        district: toTitleCase(staffDistrictInput.trim()),
        state: staffStateInput.trim(),
        pinCode: staffPinCodeInput.trim(),
        dateOfBirth: staffDobInput,
        joiningDate: staffJoiningDateInput || existing?.joiningDate || getLocalDateStr(),
        aadhaarNo: staffAadhaarInput.trim(),
        photoUrl: staffPhotoUrlInput,
        bankName: toTitleCase(staffBankNameInput.trim()),
        bankAddress: toTitleCase(staffBankAddressInput.trim()),
        accountNumber: staffAccountNumberInput.trim(),
        ifscCode: staffIfscCodeInput.trim().toUpperCase(),
        hasSecurityCheque: Boolean(staffHasSecurityChequeInput || staffSecurityChequeNumberInput.trim()),
        securityChequeNumber: staffSecurityChequeNumberInput.trim().toUpperCase(),
        status: staffStatusInput,
        linkedUserUid: linkedUserUidInput || existing?.linkedUserUid || '',
        createdByUid: existing?.createdByUid || profile.uid || '',
        createdByName: existing?.createdByName || profile.fullName || 'Warehouse Incharge',
        isArchived: false,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
      };

      setOfficeStaffOptimistic((prev) => {
        const rest = prev.filter((item) => item.id !== id);
        return [...rest, record];
      });

      await safeFirestoreSet('office_staff_members', id, record, { merge: true });

      // Keep linked user profile details in sync (without touching loginId/password/role/allowedModules or excluded fields)
      const linkedUid = record.linkedUserUid;
      if (linkedUid && (sharedUsers || []).some((u: any) => u && String(u.uid || u.id) === linkedUid)) {
        const userPatch = {
          fullName: record.fullName,
          designation: record.workRole || record.category,
          mobileNumber: record.mobileNumber || '',
          taluka: record.taluka || '',
          district: record.district || '',
          state: record.state || '',
          pinCode: record.pinCode || '',
          dateOfBirth: record.dateOfBirth || '',
          joiningDate: record.joiningDate || '',
          aadhaarNo: record.aadhaarNo || '',
          photoUrl: record.photoUrl || '',
          bankName: record.bankName || '',
          bankAddress: record.bankAddress || '',
          accountNumber: record.accountNumber || '',
          ifscCode: record.ifscCode || '',
          hasSecurityCheque: Boolean(record.hasSecurityCheque),
          securityChequeNumber: record.securityChequeNumber || '',
          status: record.status || 'Active',
          updatedAt: nowIso,
        };
        setUsersOptimistic((prev) =>
          prev.map((u) => (u.uid === linkedUid ? { ...u, ...userPatch } : u))
        );
        void safeFirestoreSet('users', linkedUid, userPatch, { merge: true }).catch(() => {});
      }

      void logAudit(
        editingStaffId ? 'UPDATE' : 'CREATE',
        'office_staff_members',
        id,
        `${editingStaffId ? 'Updated' : 'Added'} ${record.category}: ${record.fullName}`,
        profile
      ).catch(() => {});

      setEditingStaffId(id);
      setIsEditingStaffForm(false);
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setIsSavingMember(false);
    }
  };

  const handleDeleteStaffMember = (member: OfficeStaffMember) => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Remove Staff Member?',
      message: `Remove ${member.fullName} (${member.category}) from the staff list?`,
      confirmText: 'Remove',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        const normTarget = normalizePersonKey(member.fullName, member.category);
        const duplicateIds = staffMembers
          .filter((s) => s.id === member.id || normalizePersonKey(s.fullName, s.category) === normTarget)
          .map((s) => s.id);
        const idsToRemove = Array.from(new Set([member.id, ...duplicateIds]));
        const removeSet = new Set(idsToRemove);

        setOfficeStaffOptimistic((prev) => prev.filter((item) => !removeSet.has(item.id)));
        if (editingStaffId && removeSet.has(editingStaffId)) {
          handleCloseStaffForm();
        }
        await Promise.all(
          idsToRemove.map((id) =>
            safeFirestoreDelete('office_staff_members', id, {
              softDelete: true,
              user: profile,
            }).catch(() => {})
          )
        );
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const handleMarkAttendance = async (member: OfficeStaffMember, status: AttendanceStatus) => {
    setSavingStaffId(member.id);
    try {
      const nowIso = new Date().toISOString();
      const docId = `att_${selectedDate}_${member.id}`;
      const existing = dateAttendanceMap.get(member.id);

      if (!staffMembers.some((s) => s.id === member.id)) {
        await safeFirestoreSet('office_staff_members', member.id, member, { merge: true }).catch(() => {});
      }

      const record: OfficeStaffAttendanceRecord = {
        id: docId,
        date: selectedDate,
        monthKey: selectedDate.slice(0, 7),
        staffId: member.id,
        staffName: member.fullName,
        category: member.category,
        workRole: member.workRole || member.category,
        status,
        markedByUid: profile.uid || '',
        markedByName: profile.fullName || profile.loginId || 'Warehouse Incharge',
        markedAt: nowIso,
        isArchived: false,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
      };

      setOfficeAttendanceOptimistic((prev) => {
        const rest = prev.filter((r) => r.id !== docId);
        return [record, ...rest];
      });

      await safeFirestoreSet('office_staff_attendance', docId, record, { merge: true });
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setSavingStaffId(null);
    }
  };

  const handleMarkAllPresent = async () => {
    const visibleActive = filteredStaff.filter((s) => s.status !== 'Inactive');
    if (visibleActive.length === 0) return;

    setMarkingAll(true);
    try {
      const nowIso = new Date().toISOString();
      const updates: OfficeStaffAttendanceRecord[] = visibleActive.map((member) => ({
        id: `att_${selectedDate}_${member.id}`,
        date: selectedDate,
        monthKey: selectedDate.slice(0, 7),
        staffId: member.id,
        staffName: member.fullName,
        category: member.category,
        workRole: member.workRole || member.category,
        status: 'present',
        markedByUid: profile.uid || '',
        markedByName: profile.fullName || profile.loginId || 'Warehouse Incharge',
        markedAt: nowIso,
        isArchived: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }));

      const updateIds = new Set(updates.map((u) => u.id));
      setOfficeAttendanceOptimistic((prev) => [
        ...updates,
        ...prev.filter((r) => !updateIds.has(r.id)),
      ]);

      await Promise.all(
        updates.map((rec) =>
          safeFirestoreSet('office_staff_attendance', rec.id, rec, { merge: true }).catch(() => {})
        )
      );
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setMarkingAll(false);
    }
  };

  const handleExportMonthlyCsv = () => {
    const header = ['Staff Name', 'Department', 'Work Role', 'Present', 'Half Day', 'Absent', 'Leave', 'Payable Days'];
    const lines = monthlySummaryRows.map((row) =>
      [
        `"${(row.staff.fullName || '').replace(/"/g, '""')}"`,
        `"${row.staff.category}"`,
        `"${(row.staff.workRole || '').replace(/"/g, '""')}"`,
        row.present,
        row.halfDay,
        row.absent,
        row.leave,
        row.payableDays,
      ].join(',')
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    triggerBlobDownload(blob, `Warehouse_Staff_Attendance_${selectedMonth}.csv`);
  };

  // Warehouse Order Dispatch & Delivery Actions
  const handleDispatchOrder = async (order: OrderItem, transportText: string) => {
    const cleanTransport = transportText.trim();
    const nowIso = new Date().toISOString();
    setUpdatingOrderId(order.id);
    try {
      const updatedData = {
        warehouseStatus: 'dispatched' as const,
        transportName: cleanTransport,
        transportDetails: cleanTransport,
        dispatchNote: cleanTransport,
        warehouseDispatchedAt: nowIso,
        warehouseDispatchedBy: profile.fullName || profile.loginId || 'Warehouse Incharge',
        updatedAt: nowIso,
      };
      setOrdersOptimistic((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, ...updatedData } : o))
      );
      await safeFirestoreSet('orders', order.id, updatedData, { merge: true });
      void logAudit(
        'UPDATE',
        'orders',
        order.id,
        `Warehouse Dispatched order ${order.orderNumber}${cleanTransport ? ` via ${cleanTransport}` : ''}`,
        profile
      ).catch(() => {});
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleUpdateTransport = async (order: OrderItem, transportText: string) => {
    const cleanTransport = transportText.trim();
    const nowIso = new Date().toISOString();
    setUpdatingOrderId(order.id);
    try {
      const updatedData = {
        transportName: cleanTransport,
        transportDetails: cleanTransport,
        dispatchNote: cleanTransport,
        updatedAt: nowIso,
      };
      setOrdersOptimistic((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, ...updatedData } : o))
      );
      await safeFirestoreSet('orders', order.id, updatedData, { merge: true });
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 3000);
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleConfirmDelivered = (order: OrderItem) => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Confirm Delivery',
      message: `Confirm that order ${order.orderNumber} for ${toTitleCase(order.dealerName)} has been delivered?`,
      confirmText: 'Confirm Delivered',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        const nowIso = new Date().toISOString();
        setUpdatingOrderId(order.id);
        try {
          const updatedData = {
            warehouseStatus: 'delivered' as const,
            warehouseDeliveredAt: nowIso,
            warehouseDeliveredBy: profile.fullName || profile.loginId || 'Warehouse Incharge',
            updatedAt: nowIso,
          };
          setOrdersOptimistic((prev) =>
            prev.map((o) => (o.id === order.id ? { ...o, ...updatedData } : o))
          );
          await safeFirestoreSet('orders', order.id, updatedData, { merge: true });
          void logAudit(
            'UPDATE',
            'orders',
            order.id,
            `Warehouse confirmed Delivered for order ${order.orderNumber}`,
            profile
          ).catch(() => {});
          setSaveToast(true);
          setTimeout(() => setSaveToast(false), 3000);
        } finally {
          setUpdatingOrderId(null);
        }
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const shiftDate = (days: number) => {
    const d = new Date(`${selectedDate}T00:00:00`);
    if (isNaN(d.getTime())) return;
    d.setDate(d.getDate() + days);
    setSelectedDate(getLocalDateStr(d));
  };

  const isLoadingInitial = !staffLoaded && combinedStaffRoster.length === 0;

  return (
    <div className="space-y-4 max-w-5xl mx-auto pb-20">
      {saveToast && (
        <div className="px-4 py-2.5 bg-emerald-600 text-white text-xs rounded-xl flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="font-semibold">Saved</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveToast(false)}
            className="text-white/80 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Clean Header Bar */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
        <div className="px-4 py-3.5 sm:px-5 sm:py-4 flex items-center justify-between gap-3 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white">
          <div className="flex items-center gap-3 min-w-0">
            {activeTab !== null ? (
              <button
                type="button"
                onClick={handleReturnToHub}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 text-white text-xs font-bold transition shrink-0 cursor-pointer active:scale-95"
                title="Back to Warehouse Options"
              >
                <ArrowLeft className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">All Options</span>
              </button>
            ) : (
              <div className="w-10 h-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                <Warehouse className="w-5 h-5 text-emerald-300" />
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-sm sm:text-lg font-bold tracking-tight truncate">
                {activeTab === 'orders'
                  ? 'Warehouse · Orders'
                  : activeTab === 'attendance'
                  ? 'Warehouse · Attendance'
                  : activeTab === 'report'
                  ? 'Warehouse · Monthly Review'
                  : activeTab === 'incharge_form'
                  ? 'Warehouse Incharge Form'
                  : 'Warehouse Incharge'}
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-300 truncate">
                {activeTab === 'orders'
                  ? 'Order Dispatch & Delivery'
                  : activeTab === 'attendance'
                  ? 'Staff Daily Attendance'
                  : activeTab === 'report'
                  ? 'Monthly Attendance Summary'
                  : activeTab === 'incharge_form'
                  ? 'Login & Profile Details'
                  : 'Select an option below to open'}
              </p>
            </div>
          </div>

          {activeTab === 'attendance' && staffViewMode === 'list' && (
            <button
              type="button"
              onClick={openAddStaffForm}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5 shrink-0" />
              <span>Add Staff</span>
            </button>
          )}
        </div>

        {/* Initial 4 Hub Option Cards (Shown only when activeTab === null) */}
        {activeTab === null && (
          <div
            className={cn(
              'p-4 sm:p-6 bg-slate-50/70 grid gap-3 sm:gap-4',
              userIsAdmin ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-3'
            )}
          >
            {/* 1. Orders */}
            <button
              type="button"
              onClick={() => openSubTab('orders')}
              className="group relative flex flex-col items-center justify-center gap-3 p-5 sm:p-6 rounded-2xl bg-gradient-to-b from-white to-blue-50/60 border border-blue-200/80 hover:border-blue-400 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer active:scale-95 text-center"
            >
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform">
                <PackageCheck className="w-7 h-7 sm:w-8 sm:h-8" />
              </div>
              <div className="space-y-1">
                <span className="block text-sm sm:text-base font-black text-slate-900 tracking-tight">
                  Orders
                </span>
                <span className="block text-[11px] font-semibold text-blue-700 font-mono tabular-nums">
                  {orderStatusCounts.fresh} Fresh · {orderStatusCounts.all} Total
                </span>
              </div>
            </button>

            {/* 2. Attendance */}
            <button
              type="button"
              onClick={() => openSubTab('attendance')}
              className="group relative flex flex-col items-center justify-center gap-3 p-5 sm:p-6 rounded-2xl bg-gradient-to-b from-white to-emerald-50/60 border border-emerald-200/80 hover:border-emerald-400 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer active:scale-95 text-center"
            >
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform">
                <ClipboardCheck className="w-7 h-7 sm:w-8 sm:h-8" />
              </div>
              <div className="space-y-1">
                <span className="block text-sm sm:text-base font-black text-slate-900 tracking-tight">
                  Attendance
                </span>
                <span className="block text-[11px] font-semibold text-emerald-700 font-mono tabular-nums">
                  {activeRoster.length} Active Staff
                </span>
              </div>
            </button>

            {/* 3. Monthly Review */}
            <button
              type="button"
              onClick={() => openSubTab('report')}
              className="group relative flex flex-col items-center justify-center gap-3 p-5 sm:p-6 rounded-2xl bg-gradient-to-b from-white to-amber-50/60 border border-amber-200/80 hover:border-amber-400 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer active:scale-95 text-center"
            >
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform">
                <BarChart3 className="w-7 h-7 sm:w-8 sm:h-8" />
              </div>
              <div className="space-y-1">
                <span className="block text-sm sm:text-base font-black text-slate-900 tracking-tight">
                  Monthly Review
                </span>
                <span className="block text-[11px] font-semibold text-amber-700">
                  Attendance Summary
                </span>
              </div>
            </button>

            {/* 4. Warehouse Incharge Form (Strictly Admin Only) */}
            {userIsAdmin && (
              <button
                type="button"
                onClick={openAdminInchargeTab}
                className="group relative flex flex-col items-center justify-center gap-3 p-5 sm:p-6 rounded-2xl bg-gradient-to-b from-white to-rose-50/60 border border-rose-200/80 hover:border-rose-400 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer active:scale-95 text-center"
              >
                <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-rose-600 to-red-600 text-white shadow-sm flex items-center justify-center group-hover:scale-105 transition-transform">
                  <ShieldCheck className="w-7 h-7 sm:w-8 sm:h-8" />
                </div>
                <div className="space-y-1">
                  <span className="block text-sm sm:text-base font-black text-slate-900 tracking-tight">
                    Warehouse Incharge
                  </span>
                  <span className="block text-[11px] font-semibold text-rose-700 font-mono tabular-nums">
                    {warehouseInchargeUsers.length > 0 ? `${warehouseInchargeUsers.length} Form` : 'Login & Profile'}
                  </span>
                </div>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ============================ ADMIN-ONLY TAB: WAREHOUSE INCHARGE USER FORM (WITH LOGIN ID & PASSWORD) ============================ */}
      {userIsAdmin && activeTab === 'incharge_form' && (
        <div className="space-y-3">
          {/* Quick Switcher & Add New Incharge Bar */}
          <div className="bg-white rounded-2xl border border-slate-200 p-2.5 sm:p-3 shadow-2xs flex flex-wrap items-center justify-between gap-2 no-print">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {warehouseInchargeUsers.map((u) => {
                const isSelected = incUid === u.uid;
                return (
                  <button
                    key={u.uid}
                    type="button"
                    onClick={() => loadInchargeToForm(u, false)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer',
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    <span
                      className={cn(
                        'font-mono text-[10px] px-1.5 py-0.5 rounded',
                        isSelected ? 'bg-white/15 text-emerald-300' : 'bg-red-50 text-red-600 border border-red-200'
                      )}
                    >
                      {u.userCode || 'EMP'}
                    </span>
                    <span className="truncate max-w-[160px]">{toTitleCase(u.fullName) || 'Warehouse Incharge'}</span>
                  </button>
                );
              })}
              {warehouseInchargeUsers.length === 0 && (
                <span className="text-xs font-semibold text-slate-500 px-1">
                  New Warehouse Incharge Registration Form
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={resetInchargeForm}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition active:scale-95 shrink-0 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5 shrink-0" />
              <span>New Incharge Form</span>
            </button>
          </div>

          {/* Exact User Form Card Structure */}
          <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
            {/* Top Action Toolbar inside form card - Exact User Form layout */}
            <div className="bg-slate-50 border-b border-slate-200 px-2.5 py-1.5 sm:px-4 sm:py-2 flex items-center justify-end gap-1.5 no-print sticky left-0 w-full z-10">
              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsEditingInchargeForm(!isEditingInchargeForm)}
                  className={`p-1.5 rounded-lg text-xs font-bold transition shadow-xs border cursor-pointer ${
                    isEditingInchargeForm
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-red-600'
                  }`}
                  title={isEditingInchargeForm ? 'Viewing Mode (Click to View Mode)' : 'Edit Mode (Click to Edit)'}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>

                {isEditingInchargeForm && (
                  <button
                    type="submit"
                    form="warehouse-incharge-user-form"
                    disabled={isSavingIncharge}
                    className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white flex items-center gap-0.5 shadow-xs transition cursor-pointer shrink-0"
                    title="Save Form"
                  >
                    {isSavingIncharge ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
                    <span>{isSavingIncharge ? '...' : 'Save'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleDownloadInchargePdf}
                  disabled={isGeneratingPdf}
                  className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-0.5 shadow-xs transition disabled:opacity-50 shrink-0 cursor-pointer"
                  title="Download A4 PDF Form"
                >
                  {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
                  <span>PDF</span>
                </button>

                {incUid && (
                  <button
                    type="button"
                    onClick={() => handleDeleteInchargeForm(incUid, incFullName)}
                    className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition cursor-pointer"
                    title="Delete Form"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Official Full Page Warehouse Incharge Form */}
            <form
              id="warehouse-incharge-user-form"
              onSubmit={handleSaveInchargeForm}
              className="p-4 sm:p-6 space-y-0 text-[11px] min-w-[800px] sm:min-w-0 font-sans"
            >
              <div ref={printableInchargeFormRef} className="border-2 border-black bg-white shadow-sm">
                {/* 1. Header Section - Logo (Left), Name (Center), Photo (Right) */}
                <div className="p-4 relative bg-white border-b-2 border-black">
                  <div className="flex items-center justify-between gap-4">
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

                    <div className="flex-1 text-center space-y-1">
                      <h1 className="text-2xl font-black text-red-600 uppercase tracking-tight leading-none">
                        BLACKWORM AGRITECH PVT LTD
                      </h1>
                      <div className="text-[8px] text-slate-700 font-bold leading-tight mt-2">
                        <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                        <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                        <p className="flex items-center justify-center gap-4 mt-1">
                          <span className="flex items-center gap-1 text-red-600">
                            <Phone className="w-2.5 h-2.5" /> +91 7798716201
                          </span>
                          <span className="flex items-center gap-1 text-red-600 underline">
                            <Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com
                          </span>
                        </p>
                      </div>
                    </div>

                    <div
                      onClick={() => isEditingInchargeForm && setShowPhotoModal(true)}
                      className={`w-28 h-28 border-2 border-black bg-white flex items-center justify-center overflow-hidden relative group shrink-0 ${
                        isEditingInchargeForm ? 'cursor-pointer hover:border-emerald-600' : ''
                      }`}
                      title={isEditingInchargeForm ? 'Click to add or change photo' : undefined}
                    >
                      {incPhotoUrl ? (
                        <>
                          <img src={incPhotoUrl} alt="User Photo" className="w-full h-full object-cover" />
                          {isEditingInchargeForm && (
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition-opacity">
                              <Camera className="w-6 h-6" />
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-center p-2">
                          <Camera className="w-6 h-6 mx-auto text-slate-400 mb-1" />
                          <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter leading-none block">
                            {isEditingInchargeForm ? 'Click to Add Photo' : 'User Photo'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-b-2 border-black">
                  WAREHOUSE INCHARGE REGISTRATION &amp; PROFILE FORM
                </div>

                {/* 3. Main Form Grid Data */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50/50">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        User / Emp Code No -
                      </span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incUserCode}
                          onChange={(e) => setIncUserCode(e.target.value)}
                          placeholder={calculateNextUserCode(incRole, allUsers)}
                          className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-sm uppercase disabled:text-red-600 disabled:opacity-90"
                        />
                        {isEditingInchargeForm && (
                          <button
                            type="button"
                            onClick={() => setIncUserCode(calculateNextUserCode(incRole, allUsers))}
                            className="text-[9px] font-black text-slate-600 hover:text-red-600 uppercase tracking-tight bg-white border border-slate-300 hover:border-red-400 px-2 py-0.5 rounded shrink-0 transition shadow-xs cursor-pointer"
                            title="Auto Calculate Sequential Number (EMP-01, EMP-02...)"
                          >
                            Auto (#{calculateNextUserCode(incRole, allUsers)})
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Joining Date -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditingInchargeForm}
                          value={incJoiningDate}
                          onChange={(e) => setIncJoiningDate(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Full Name -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        required
                        disabled={!isEditingInchargeForm}
                        value={incFullName}
                        onChange={(e) => setIncFullName(e.target.value)}
                        placeholder="WAREHOUSE INCHARGE FULL NAME"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Designation -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingInchargeForm ? (
                          <select
                            value={incDesignation}
                            onChange={(e) => {
                              const nextDesig = e.target.value;
                              setIncDesignation(nextDesig);
                              const matchedRole = SYSTEM_ROLES.find(
                                (r) => r.designation.toLowerCase() === nextDesig.toLowerCase()
                              );
                              if (matchedRole) {
                                handleInchargeRoleChange(matchedRole.id);
                              }
                            }}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none cursor-pointer"
                          >
                            {incDesignation &&
                              !DESIGNATION_OPTIONS.some(
                                (opt) => opt.toLowerCase() === incDesignation.toLowerCase()
                              ) && <option value={incDesignation}>{incDesignation.toUpperCase()}</option>}
                            {DESIGNATION_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt.toUpperCase()}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="font-black text-black uppercase">
                            {incDesignation || getDefaultDesignationForRole(incRole)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50/40">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Center (HQ) -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incCenter}
                          onChange={(e) => setIncCenter(e.target.value)}
                          placeholder="SANGLI / HEADQUARTER LOCATION"
                          className="w-full bg-transparent font-black text-slate-900 uppercase focus:outline-none placeholder:text-slate-400"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      System Role -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      {isEditingInchargeForm ? (
                        <select
                          value={incRole}
                          onChange={(e) => handleInchargeRoleChange(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        >
                          {SYSTEM_ROLES.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-black text-black">{getInchargeRoleLabel(incRole)}</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Mobile No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="tel"
                          required
                          disabled={!isEditingInchargeForm}
                          value={incMobileNumber}
                          onChange={(e) => setIncMobileNumber(e.target.value)}
                          placeholder="98220XXXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Alt / WhatsApp -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="tel"
                          disabled={!isEditingInchargeForm}
                          value={incAltPhone}
                          onChange={(e) => setIncAltPhone(e.target.value)}
                          placeholder="ALT CONTACT"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Email ID -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="email"
                          disabled={!isEditingInchargeForm}
                          value={incEmailId}
                          onChange={(e) => setIncEmailId(e.target.value)}
                          placeholder="user@blackwormagri.com"
                          className="w-full bg-transparent font-black text-black focus:outline-none lowercase font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        State -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incStateName}
                          onChange={(e) => setIncStateName(e.target.value)}
                          placeholder="MAHARASHTRA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Full Address -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingInchargeForm}
                        value={incAddress}
                        onChange={(e) => setIncAddress(e.target.value)}
                        placeholder="HOUSE NO, STREET, AREA ADDRESS"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Village / City -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incVillage}
                          onChange={(e) => setIncVillage(e.target.value)}
                          placeholder="VILLAGE / CITY NAME"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Taluka / Tehsil -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incTaluka}
                          onChange={(e) => setIncTaluka(e.target.value)}
                          placeholder="TALUKA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        District -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incDistrict}
                          onChange={(e) => setIncDistrict(e.target.value)}
                          placeholder="SANGLI"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Pin Code -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incPinCode}
                          onChange={(e) => setIncPinCode(e.target.value)}
                          placeholder="416409"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Date of Birth -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditingInchargeForm}
                          value={incDateOfBirth}
                          onChange={(e) => setIncDateOfBirth(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Aadhaar No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incAadhaarNo}
                          onChange={(e) => setIncAadhaarNo(e.target.value)}
                          placeholder="12 DIGIT AADHAAR"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      PAN Card No -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingInchargeForm}
                        value={incPanNo}
                        onChange={(e) => setIncPanNo(e.target.value)}
                        placeholder="ABCDE1234F"
                        className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                      />
                    </div>
                  </div>
                </div>

                {/* 4. Banking & Security Cheque Details Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                  BANKING &amp; SECURITY CHEQUE DETAILS
                </div>

                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Bank Name -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingInchargeForm}
                        value={incBankName}
                        onChange={(e) => setIncBankName(e.target.value)}
                        placeholder="BANK NAME (E.G. STATE BANK OF INDIA)"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Bank Address -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingInchargeForm}
                        value={incBankAddress}
                        onChange={(e) => setIncBankAddress(e.target.value)}
                        placeholder="BRANCH / BANK ADDRESS"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Account No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incAccountNumber}
                          onChange={(e) => setIncAccountNumber(e.target.value)}
                          placeholder="ACCOUNT NUMBER"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        IFSC Code -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incIfscCode}
                          onChange={(e) => setIncIfscCode(e.target.value)}
                          placeholder="SBIN000XXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Security Cheque -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingInchargeForm ? (
                          <select
                            value={incHasSecurityCheque ? 'YES' : 'NO'}
                            onChange={(e) => {
                              const val = e.target.value === 'YES';
                              setIncHasSecurityCheque(val);
                              if (!val) setIncSecurityChequeNumber('');
                            }}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                          >
                            <option value="NO">NO (नाही)</option>
                            <option value="YES">YES (दिली आहे)</option>
                          </select>
                        ) : (
                          <span className="font-black uppercase text-black">
                            {incHasSecurityCheque || incSecurityChequeNumber ? 'YES' : 'NO'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Cheque No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingInchargeForm}
                          value={incSecurityChequeNumber}
                          onChange={(e) => {
                            setIncSecurityChequeNumber(e.target.value);
                            if (e.target.value.trim()) {
                              setIncHasSecurityCheque(true);
                            }
                          }}
                          placeholder="CHEQUE NUMBER"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Login & Access Credentials Section - Strictly Visible ONLY in Admin Login */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                  LOGIN &amp; ACCESS CREDENTIALS
                </div>

                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Login ID -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          required
                          disabled={!isEditingInchargeForm}
                          value={incLoginId}
                          onChange={(e) => setIncLoginId(e.target.value)}
                          placeholder="LOGIN ID"
                          className="w-full bg-transparent font-black text-emerald-800 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Password -
                      </span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type={showIncPassword || isEditingInchargeForm ? 'text' : 'password'}
                          required
                          disabled={!isEditingInchargeForm}
                          value={incPassword}
                          onChange={(e) => setIncPassword(e.target.value)}
                          placeholder="bw@123"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                        {!isEditingInchargeForm && (
                          <button
                            type="button"
                            onClick={() => setShowIncPassword(!showIncPassword)}
                            className="text-slate-400 hover:text-slate-700 no-print cursor-pointer"
                          >
                            {showIncPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Account Status -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingInchargeForm ? (
                          <select
                            value={incStatus}
                            onChange={(e) =>
                              setIncStatus(e.target.value === 'Inactive' ? 'Inactive' : 'Active')
                            }
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                          >
                            <option value="Active">ACTIVE</option>
                            <option value="Inactive">INACTIVE</option>
                          </select>
                        ) : (
                          <span className="font-black text-emerald-700 uppercase">{incStatus}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center p-0 min-h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Access Mode -
                      </span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 py-1 bg-slate-50/50">
                        <span className="font-black text-slate-900 uppercase truncate">
                          {incAllowedModules.length === SYSTEM_MODULES.length
                            ? 'FULL ACCESS'
                            : `${incAllowedModules.length} MODULES`}
                        </span>

                        <button
                          type="button"
                          onClick={() => setShowIncAccessList(!showIncAccessList)}
                          className="flex items-center gap-1 text-[10px] font-black text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-1 rounded-md transition no-print cursor-pointer"
                          title="Click to view/edit allowed dashboard options"
                        >
                          <span>Options</span>
                          {showIncAccessList ? (
                            <ChevronUp className="w-3.5 h-3.5 stroke-[3px]" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 stroke-[3px]" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {showIncAccessList && (
                    <div className="p-3 bg-slate-50 border-t-2 border-black animate-in fade-in duration-150">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200">
                        <div className="flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-emerald-600" />
                          <span className="font-black text-slate-800 text-xs uppercase">
                            Dashboard Options ({incAllowedModules.length}/{SYSTEM_MODULES.length})
                          </span>
                        </div>

                        {isEditingInchargeForm && (
                          <div className="flex items-center gap-1.5 no-print">
                            <button
                              type="button"
                              onClick={() => setIncAllowedModules(SYSTEM_MODULES.map((m) => m.id))}
                              className="text-[9px] font-black px-2 py-0.5 rounded bg-slate-900 text-white hover:bg-black uppercase cursor-pointer"
                            >
                              Select All
                            </button>
                            <button
                              type="button"
                              onClick={() => setIncAllowedModules(getDefaultModulesForRole(incRole))}
                              className="text-[9px] font-black px-2 py-0.5 rounded bg-slate-200 text-slate-800 hover:bg-slate-300 uppercase cursor-pointer"
                            >
                              Reset
                            </button>
                            <button
                              type="button"
                              onClick={() => setIncAllowedModules([])}
                              className="text-[9px] font-black px-2 py-0.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 uppercase cursor-pointer"
                            >
                              Clear
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {SYSTEM_MODULES.map((mod) => {
                          const isSelected = incAllowedModules.includes(mod.id);
                          const Icon = mod.icon;
                          const label = getModuleLabel(mod);

                          return (
                            <div
                              key={mod.id}
                              onClick={() => toggleInchargeModulePermission(mod.id)}
                              className={`flex items-center gap-2 p-2 rounded-lg border transition-all select-none ${
                                isSelected
                                  ? 'bg-emerald-50 border-emerald-500 text-emerald-950 font-black shadow-xs'
                                  : 'bg-white border-slate-200 text-slate-400 opacity-60'
                              } ${isEditingInchargeForm ? 'cursor-pointer hover:border-emerald-600 hover:opacity-100' : 'cursor-default'}`}
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
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================ TAB 1A: FULL PAGE STRUCTURED STAFF FORM (USER FORM PARITY) ============================ */}
      {activeTab === 'attendance' && staffViewMode === 'form' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
            {/* Top Action Toolbar inside form card */}
            <div className="bg-slate-50 border-b border-slate-200 px-2.5 py-1.5 sm:px-4 sm:py-2 flex items-center justify-between gap-1.5 no-print sticky left-0 w-full z-10">
              <button
                type="button"
                onClick={handleCloseStaffForm}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-xs font-bold text-slate-700 transition cursor-pointer shrink-0"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>

              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                {/* 1. Edit button */}
                <button
                  type="button"
                  onClick={() => setIsEditingStaffForm(!isEditingStaffForm)}
                  className={`p-1.5 rounded-lg text-xs font-bold transition shadow-xs border cursor-pointer ${
                    isEditingStaffForm
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-red-600'
                  }`}
                  title={isEditingStaffForm ? 'Viewing Mode (Click to View Mode)' : 'Edit Mode (Click to Edit)'}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>

                {/* 2. Save button (compact layout matching User Form) */}
                {isEditingStaffForm && (
                  <button
                    type="submit"
                    form="warehouse-staff-profile-form"
                    disabled={isSavingMember}
                    className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white flex items-center gap-0.5 shadow-xs transition cursor-pointer shrink-0"
                    title="Save Form"
                  >
                    {isSavingMember ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
                    <span>{isSavingMember ? '...' : 'Save'}</span>
                  </button>
                )}

                {/* 3. PDF / Download button */}
                <button
                  type="button"
                  onClick={handleDownloadStaffPdf}
                  disabled={isGeneratingPdf}
                  className="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-0.5 shadow-xs transition disabled:opacity-50 shrink-0 cursor-pointer"
                  title="Download A4 PDF Form"
                >
                  {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
                  <span>PDF</span>
                </button>

                {/* 4. Delete button */}
                {editingStaffId && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = combinedStaffRoster.find((s) => s.id === editingStaffId);
                      if (target) handleDeleteStaffMember(target);
                    }}
                    className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition cursor-pointer"
                    title="Remove Staff Form"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Official Full Page Form */}
            <form
              id="warehouse-staff-profile-form"
              onSubmit={handleSaveStaffMember}
              className="p-4 sm:p-6 space-y-0 text-[11px] min-w-[800px] sm:min-w-0 font-sans"
            >
              {/* Full Form Outer Border Wrapper */}
              <div ref={printableStaffFormRef} className="border-2 border-black bg-white shadow-sm">
                {/* 1. Header Section - Logo (Left), Company Info (Center), Photo (Right) */}
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
                          <span className="flex items-center gap-1 text-red-600">
                            <Phone className="w-2.5 h-2.5" /> +91 7798716201
                          </span>
                          <span className="flex items-center gap-1 text-red-600 underline">
                            <Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com
                          </span>
                        </p>
                      </div>
                    </div>

                    {/* Staff Photo Box (Right) */}
                    <div
                      onClick={() => isEditingStaffForm && setShowPhotoModal(true)}
                      className={`w-28 h-28 border-2 border-black bg-white flex items-center justify-center overflow-hidden relative group shrink-0 ${
                        isEditingStaffForm ? 'cursor-pointer hover:border-emerald-600' : ''
                      }`}
                      title={isEditingStaffForm ? 'Click to add or change staff photo' : undefined}
                    >
                      {staffPhotoUrlInput ? (
                        <>
                          <img src={staffPhotoUrlInput} alt="Staff Photo" className="w-full h-full object-cover" />
                          {isEditingStaffForm && (
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition-opacity">
                              <Camera className="w-6 h-6" />
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-center p-2">
                          <Camera className="w-6 h-6 mx-auto text-slate-400 mb-1" />
                          <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter leading-none block">
                            {isEditingStaffForm ? 'Click to Add Photo' : 'Staff Photo'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-b-2 border-black">
                  WAREHOUSE / STAFF REGISTRATION &amp; PROFILE FORM
                </div>

                {/* 3. Main Form Grid Data with Uniform w-44 Label Width and Continuous Vertical Divider */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  {/* Row 1: Staff / Emp Code No & Joining Date */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50/50">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Staff / Emp Code No -
                      </span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffCodeInput}
                          onChange={(e) => setStaffCodeInput(e.target.value)}
                          placeholder={calculateNextStaffCode(combinedStaffRoster)}
                          className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-sm uppercase disabled:text-red-600 disabled:opacity-90"
                        />
                        {isEditingStaffForm && (
                          <button
                            type="button"
                            onClick={() => setStaffCodeInput(calculateNextStaffCode(combinedStaffRoster))}
                            className="text-[9px] font-black text-slate-600 hover:text-red-600 uppercase tracking-tight bg-white border border-slate-300 hover:border-red-400 px-2 py-0.5 rounded shrink-0 transition shadow-xs cursor-pointer"
                            title="Auto Calculate Sequential Number (STF-01, STF-02...)"
                          >
                            Auto (#{calculateNextStaffCode(combinedStaffRoster)})
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Joining Date -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditingStaffForm}
                          value={staffJoiningDateInput}
                          onChange={(e) => setStaffJoiningDateInput(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 2: Full Name */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Full Name -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        required
                        disabled={!isEditingStaffForm}
                        value={staffNameInput}
                        onChange={(e) => setStaffNameInput(e.target.value)}
                        placeholder="SURESH RAMCHANDRA PAWAR"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Row 3: Department & Account Status */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Department -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingStaffForm ? (
                          <select
                            value={staffCategoryInput}
                            onChange={(e) =>
                              setStaffCategoryInput(
                                e.target.value === 'Factory Staff' ? 'Factory Staff' : 'Office Staff'
                              )
                            }
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none cursor-pointer"
                          >
                            <option value="Office Staff">OFFICE STAFF</option>
                            <option value="Factory Staff">FACTORY STAFF</option>
                          </select>
                        ) : (
                          <span className="font-black text-black uppercase">{staffCategoryInput}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Account Status -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingStaffForm ? (
                          <select
                            value={staffStatusInput}
                            onChange={(e) =>
                              setStaffStatusInput(e.target.value === 'Inactive' ? 'Inactive' : 'Active')
                            }
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none cursor-pointer"
                          >
                            <option value="Active">ACTIVE</option>
                            <option value="Inactive">INACTIVE</option>
                          </select>
                        ) : (
                          <span
                            className={cn(
                              'font-black uppercase',
                              staffStatusInput === 'Active' ? 'text-emerald-700' : 'text-rose-600'
                            )}
                          >
                            {staffStatusInput}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Row 3B: Work Role / Designation */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Work Role / Desig -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex flex-wrap items-center justify-between gap-2 px-3 py-1">
                      <input
                        type="text"
                        disabled={!isEditingStaffForm}
                        value={staffWorkRoleInput}
                        onChange={(e) => setStaffWorkRoleInput(e.target.value)}
                        placeholder="E.G. PACKING, HELPER, DISPATCH, GODOWN INCHARGE"
                        className="flex-1 min-w-[180px] bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                      {isEditingStaffForm && (
                        <div className="flex flex-wrap gap-1 no-print">
                          {QUICK_WORK_ROLES.map((r) => (
                            <button
                              key={r}
                              type="button"
                              onClick={() => setStaffWorkRoleInput(r)}
                              className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 text-[9px] font-black uppercase cursor-pointer"
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 4: Mobile No & Date of Birth */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Mobile No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="tel"
                          disabled={!isEditingStaffForm}
                          value={staffMobileInput}
                          onChange={(e) => setStaffMobileInput(e.target.value)}
                          placeholder="98220XXXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Date of Birth -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditingStaffForm}
                          value={staffDobInput}
                          onChange={(e) => setStaffDobInput(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 5: Taluka / Tehsil & District */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Taluka / Tehsil -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffTalukaInput}
                          onChange={(e) => setStaffTalukaInput(e.target.value)}
                          placeholder="TALUKA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        District -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffDistrictInput}
                          onChange={(e) => setStaffDistrictInput(e.target.value)}
                          placeholder="SANGLI"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 6: State & Pin Code */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        State -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffStateInput}
                          onChange={(e) => setStaffStateInput(e.target.value)}
                          placeholder="MAHARASHTRA"
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Pin Code -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffPinCodeInput}
                          onChange={(e) => setStaffPinCodeInput(e.target.value)}
                          placeholder="416409"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 7: Aadhaar No */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Aadhaar No -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingStaffForm}
                        value={staffAadhaarInput}
                        onChange={(e) => setStaffAadhaarInput(e.target.value)}
                        placeholder="12 DIGIT AADHAAR"
                        className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* 4. Banking & Security Cheque Details Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                  BANKING &amp; SECURITY CHEQUE DETAILS
                </div>

                {/* Banking & Security Cheque Rows */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  {/* Bank Name */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Bank Name -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingStaffForm}
                        value={staffBankNameInput}
                        onChange={(e) => setStaffBankNameInput(e.target.value)}
                        placeholder="BANK NAME (E.G. STATE BANK OF INDIA)"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Bank Address */}
                  <div className="flex items-center p-0 min-h-[40px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                      Bank Address -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditingStaffForm}
                        value={staffBankAddressInput}
                        onChange={(e) => setStaffBankAddressInput(e.target.value)}
                        placeholder="BRANCH / BANK ADDRESS"
                        className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Account No & IFSC Code */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Account No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffAccountNumberInput}
                          onChange={(e) => setStaffAccountNumberInput(e.target.value)}
                          placeholder="ACCOUNT NUMBER"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        IFSC Code -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffIfscCodeInput}
                          onChange={(e) => setStaffIfscCodeInput(e.target.value)}
                          placeholder="SBIN000XXXX"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Security Cheque & Cheque Number */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Security Cheque -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        {isEditingStaffForm ? (
                          <select
                            value={staffHasSecurityChequeInput ? 'YES' : 'NO'}
                            onChange={(e) => {
                              const val = e.target.value === 'YES';
                              setStaffHasSecurityChequeInput(val);
                              if (!val) setStaffSecurityChequeNumberInput('');
                            }}
                            className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                          >
                            <option value="NO">NO (नाही)</option>
                            <option value="YES">YES (दिली आहे)</option>
                          </select>
                        ) : (
                          <span className="font-black uppercase text-black">
                            {staffHasSecurityChequeInput || staffSecurityChequeNumberInput ? 'YES' : 'NO'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[40px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">
                        Cheque No -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditingStaffForm}
                          value={staffSecurityChequeNumberInput}
                          onChange={(e) => {
                            setStaffSecurityChequeNumberInput(e.target.value);
                            if (e.target.value.trim()) {
                              setStaffHasSecurityChequeInput(true);
                            }
                          }}
                          placeholder="CHEQUE NUMBER"
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================ TAB 1B: DAILY ATTENDANCE ROSTER ============================ */}
      {activeTab === 'attendance' && staffViewMode === 'list' && (
        <div className="space-y-3">
          {/* Compact Control Surface: Date Bar + Summary Strip + Search/Filter */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
            {/* Row 1: Date Picker & Mark All Present */}
            <div className="px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => shiftDate(-1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 cursor-pointer active:scale-95 shrink-0"
                  title="Previous Day"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2 pointer-events-none" />
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value || getLocalDateStr())}
                    className="pl-8 pr-2 py-1.5 rounded-lg border border-slate-200 text-xs font-bold font-mono tabular-nums text-slate-900 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => shiftDate(1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 cursor-pointer active:scale-95 shrink-0"
                  title="Next Day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDate(getLocalDateStr())}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Today
                </button>
              </div>

              {filteredStaff.some((s) => s.status !== 'Inactive') && (
                <button
                  type="button"
                  onClick={() => void handleMarkAllPresent()}
                  disabled={markingAll}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold transition active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
                  <span>Mark All Present</span>
                </button>
              )}
            </div>

            {/* Row 2: Slim 5-Column Metrics Strip */}
            <div className="grid grid-cols-5 divide-x divide-slate-100 bg-slate-50/70 text-center">
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-slate-500">Total</p>
                <p className="text-sm font-bold text-slate-900 font-mono tabular-nums">{dailySummary.total}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-emerald-700">Present</p>
                <p className="text-sm font-bold text-emerald-700 font-mono tabular-nums">{dailySummary.present}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-amber-700">Half Day</p>
                <p className="text-sm font-bold text-amber-700 font-mono tabular-nums">{dailySummary.halfDay}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-rose-700">Absent</p>
                <p className="text-sm font-bold text-rose-700 font-mono tabular-nums">{dailySummary.absent}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-sky-700">Leave</p>
                <p className="text-sm font-bold text-sky-700 font-mono tabular-nums">{dailySummary.leave}</p>
              </div>
            </div>

            {/* Row 3: Search + Department Filter */}
            <div className="px-3.5 py-2.5 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={staffSearch}
                  onChange={(e) => setStaffSearch(e.target.value)}
                  placeholder="Search staff name, role, or phone..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="flex p-0.5 bg-slate-100 rounded-xl shrink-0">
                {([
                  { id: 'all', label: 'All' },
                  { id: 'Office Staff', label: 'Office' },
                  { id: 'Factory Staff', label: 'Factory' },
                ] as const).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategoryFilter(cat.id)}
                    className={cn(
                      'px-3 py-1 rounded-lg text-[11px] font-semibold transition whitespace-nowrap cursor-pointer',
                      categoryFilter === cat.id
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Staff Attendance Cards */}
          {isLoadingInitial ? (
            <div className="space-y-2.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-white rounded-2xl border border-slate-200 p-4 animate-pulse space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-1/3" />
                  <div className="h-3 bg-slate-100 rounded w-1/2" />
                  <div className="h-9 bg-slate-100 rounded-xl w-full mt-2" />
                </div>
              ))}
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center space-y-3">
              <Users className="w-10 h-10 text-slate-300 mx-auto" />
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {staffSearch || categoryFilter !== 'all'
                    ? 'No matching staff found'
                    : 'No Office or Factory staff added yet'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Click &quot;Add Staff&quot; above to add a staff member.
                </p>
              </div>
              {!staffSearch && categoryFilter === 'all' && (
                <button
                  type="button"
                  onClick={openAddStaffForm}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add First Staff</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredStaff.map((member, idx) => {
                const currentRec = dateAttendanceMap.get(member.id);
                const st = currentRec?.status;
                const isInactive = member.status === 'Inactive';
                const isSavingThis = savingStaffId === member.id;
                const displayCode = member.staffCode || member.userCode || `STF-${String(idx + 1).padStart(2, '0')}`;
                const showWorkRole =
                  Boolean(member.workRole) &&
                  String(member.workRole).toLowerCase() !== String(member.category).toLowerCase() &&
                  String(member.workRole).toLowerCase() !== String(member.fullName).toLowerCase();

                return (
                  <div
                    key={member.id}
                    className={cn(
                      'bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 transition space-y-3',
                      isInactive && 'opacity-60'
                    )}
                  >
                    {/* Top Row */}
                    <div className="flex items-start justify-between gap-2">
                      <div
                        onClick={() => openStaffForm(member, true)}
                        className="min-w-0 flex-1 flex items-start gap-2.5 cursor-pointer group"
                        title="Open Structured Staff Form"
                      >
                        <span className="text-[11px] font-black text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded-lg uppercase tracking-wider shrink-0 font-mono mt-0.5">
                          {displayCode}
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className="text-sm sm:text-base font-bold text-slate-900 group-hover:text-red-600 transition-colors truncate">
                              {member.fullName}
                            </h3>
                            {isInactive && (
                              <span className="text-[11px] font-semibold text-slate-500 shrink-0">
                                · Inactive
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
                            <span>{member.category}</span>
                            {showWorkRole && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{member.workRole}</span>
                              </>
                            )}
                            {member.center && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{toTitleCase(member.center)}</span>
                              </>
                            )}
                            {member.mobileNumber && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                                  <Phone className="w-3 h-3 text-slate-400" />
                                  {member.mobileNumber}
                                </span>
                              </>
                            )}
                          </div>

                          {currentRec?.markedByName && (
                            <p className="text-[11px] text-slate-500 flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                              <span>
                                Marked by {toTitleCase(currentRec.markedByName)} ·{' '}
                                {formatDisplayDate(currentRec.markedAt || currentRec.updatedAt, true) || '-'}
                              </span>
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openStaffForm(member, false)}
                          className="p-2 rounded-xl text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition cursor-pointer"
                          title="View Structured Form / PDF"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openStaffForm(member, true)}
                          className="p-2 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition cursor-pointer"
                          title="Edit Staff Form"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteStaffMember(member)}
                          className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                          title="Remove Staff"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Bottom Row: Unified Segmented Attendance Control */}
                    {!isInactive && (
                      <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100">
                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'present')}
                          className={cn(
                            'py-1.5 px-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer active:scale-95',
                            st === 'present'
                              ? 'bg-emerald-600 text-white shadow-2xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>Present</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'half_day')}
                          className={cn(
                            'py-1.5 px-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer active:scale-95',
                            st === 'half_day'
                              ? 'bg-amber-500 text-white shadow-2xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          <span>Half Day</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'absent')}
                          className={cn(
                            'py-1.5 px-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer active:scale-95',
                            st === 'absent'
                              ? 'bg-rose-600 text-white shadow-2xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <UserX className="w-3.5 h-3.5 shrink-0" />
                          <span>Absent</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'leave')}
                          className={cn(
                            'py-1.5 px-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer active:scale-95',
                            st === 'leave'
                              ? 'bg-sky-600 text-white shadow-2xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <span>Leave</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================ TAB 2: WAREHOUSE ORDER MANAGEMENT ============================ */}
      {activeTab === 'orders' && (
        <div className="space-y-3.5">
          {/* 4 Attractive Icon Filter Buttons in Exact Requested Sequence: Fresh Order -> Dispatched -> Delivered -> All Order */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {(
              [
                {
                  id: 'fresh',
                  label: 'Fresh Order',
                  count: orderStatusCounts.fresh,
                  icon: Clock,
                  activeClass: 'bg-sky-600 text-white border-sky-600 shadow-md',
                  iconBgActive: 'bg-white/20 text-white',
                  iconBgIdle: 'bg-sky-50 text-sky-600',
                  countIdle: 'text-sky-700',
                },
                {
                  id: 'dispatched',
                  label: 'Dispatched',
                  count: orderStatusCounts.dispatched,
                  icon: Truck,
                  activeClass: 'bg-amber-600 text-white border-amber-600 shadow-md',
                  iconBgActive: 'bg-white/20 text-white',
                  iconBgIdle: 'bg-amber-50 text-amber-600',
                  countIdle: 'text-amber-700',
                },
                {
                  id: 'delivered',
                  label: 'Delivered',
                  count: orderStatusCounts.delivered,
                  icon: PackageCheck,
                  activeClass: 'bg-emerald-600 text-white border-emerald-600 shadow-md',
                  iconBgActive: 'bg-white/20 text-white',
                  iconBgIdle: 'bg-emerald-50 text-emerald-600',
                  countIdle: 'text-emerald-700',
                },
                {
                  id: 'all',
                  label: 'All Order',
                  count: orderStatusCounts.all,
                  icon: ShoppingBag,
                  activeClass: 'bg-slate-900 text-white border-slate-900 shadow-md',
                  iconBgActive: 'bg-white/15 text-white',
                  iconBgIdle: 'bg-slate-100 text-slate-700',
                  countIdle: 'text-slate-600',
                },
              ] as const
            ).map((st) => {
              const Icon = st.icon;
              const isSelected = warehouseStatusFilter === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setWarehouseStatusFilter(st.id)}
                  className={cn(
                    'flex items-center gap-2.5 p-3 rounded-2xl border transition-all cursor-pointer active:scale-95 text-left',
                    isSelected
                      ? st.activeClass
                      : 'bg-white text-slate-800 border-slate-200 hover:border-slate-300 hover:shadow-xs'
                  )}
                >
                  <div
                    className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                      isSelected ? st.iconBgActive : st.iconBgIdle
                    )}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs sm:text-sm font-black tracking-tight leading-tight truncate">
                      {st.label}
                    </span>
                    <span
                      className={cn(
                        'block text-[11px] font-mono font-bold tabular-nums mt-0.5',
                        isSelected ? 'text-white/90' : st.countIdle
                      )}
                    >
                      {st.count} {st.count === 1 ? 'Order' : 'Orders'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Search & Date Sort Toolbar */}
          <div className="bg-white rounded-2xl border border-slate-200 p-2.5 sm:p-3 shadow-2xs flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="Search Order No, Dealer, Village, Product, Transport..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <button
              type="button"
              onClick={() => setOrderDateSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition whitespace-nowrap shrink-0 cursor-pointer"
              title="Toggle Date Order"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span>Date: {orderDateSort === 'desc' ? 'Newest First' : 'Oldest First'}</span>
            </button>
          </div>

          {filteredApprovedOrders.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center space-y-2">
              <PackageCheck className="w-10 h-10 text-slate-300 mx-auto" />
              <p className="text-sm font-bold text-slate-700">
                {warehouseStatusFilter === 'all'
                  ? 'No approved orders available'
                  : `No ${
                      warehouseStatusFilter === 'fresh'
                        ? 'Fresh'
                        : warehouseStatusFilter === 'dispatched'
                        ? 'Dispatched'
                        : 'Delivered'
                    } orders found`}
              </p>
              <p className="text-xs text-slate-500">
                Admin-approved orders appear here immediately for dispatch and delivery tracking.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredApprovedOrders.map((o) => {
                const resolvedCardItems = (o.items || []).map((it) =>
                  resolveOrderLineForBox(it, findProductForOrderItem(it))
                );
                return (
                  <GodownOrderSlipCard
                    key={o.id}
                    order={o}
                    resolvedItems={resolvedCardItems}
                    isUpdating={updatingOrderId === o.id}
                    onDispatchOrder={handleDispatchOrder}
                    onUpdateTransport={handleUpdateTransport}
                    onConfirmDelivered={handleConfirmDelivered}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================ TAB 3: MONTHLY REPORT ============================ */}
      {activeTab === 'report' && (
        <div className="space-y-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-700" />
              <span className="text-xs font-bold text-slate-800">Select Month:</span>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value || getLocalDateStr().slice(0, 7))}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold font-mono tabular-nums bg-slate-50 focus:bg-white"
              />
            </div>

            <button
              type="button"
              onClick={handleExportMonthlyCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-black text-white text-xs font-semibold transition active:scale-95 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>Export CSV</span>
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 text-[11px] font-bold">
                  <th className="p-3">Staff Name</th>
                  <th className="p-3">Department</th>
                  <th className="p-3 text-center">Present</th>
                  <th className="p-3 text-center">Half Day</th>
                  <th className="p-3 text-center">Absent</th>
                  <th className="p-3 text-center">Leave</th>
                  <th className="p-3 text-right">Payable Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {monthlySummaryRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400 font-semibold">
                      No attendance records found for this month.
                    </td>
                  </tr>
                ) : (
                  monthlySummaryRows.map((row) => {
                    const showWorkRole =
                      Boolean(row.staff.workRole) &&
                      String(row.staff.workRole).toLowerCase() !== String(row.staff.category).toLowerCase() &&
                      String(row.staff.workRole).toLowerCase() !== String(row.staff.fullName).toLowerCase();
                    return (
                      <tr key={row.staff.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-3">
                          <div className="font-bold text-slate-900">{row.staff.fullName}</div>
                          {showWorkRole && (
                            <div className="text-[11px] text-slate-500">{row.staff.workRole}</div>
                          )}
                        </td>
                        <td className="p-3 text-slate-600 whitespace-nowrap">{row.staff.category}</td>
                        <td className="p-3 text-center font-mono font-bold text-emerald-700 tabular-nums">
                          {row.present}
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-amber-700 tabular-nums">
                          {row.halfDay}
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-rose-700 tabular-nums">
                          {row.absent}
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-sky-700 tabular-nums">
                          {row.leave}
                        </td>
                        <td className="p-3 text-right font-mono font-bold text-slate-900 bg-slate-50/70 tabular-nums">
                          {row.payableDays}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
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
                className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition cursor-pointer"
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
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/60 text-slate-800 font-bold text-xs transition text-left group cursor-pointer"
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
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50/60 text-slate-800 font-bold text-xs transition text-left group cursor-pointer"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0">
                  <ImageIcon className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-black text-slate-900">गॅलरी / फाइलमधून निवडा</div>
                  <div className="text-[10px] text-slate-500 font-medium">Choose from Gallery / Files</div>
                </div>
              </button>

              {(activeTab === 'incharge_form' ? incPhotoUrl : staffPhotoUrlInput) && (
                <button
                  type="button"
                  onClick={() => {
                    if (activeTab === 'incharge_form') setIncPhotoUrl('');
                    else setStaffPhotoUrlInput('');
                    setShowPhotoModal(false);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-rose-200 hover:bg-rose-50 text-rose-700 font-bold text-xs transition text-left cursor-pointer"
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
                className="w-full py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 transition cursor-pointer"
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
