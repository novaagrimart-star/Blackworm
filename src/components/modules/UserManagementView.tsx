import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Users, 
  UserPlus, 
  Search, 
  Trash2, 
  Printer, 
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
  ArrowLeft
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
  { id: 'calculator', en: 'Order Calculator', mr: 'ऑर्डर कॅल्क्युलेटर', icon: Calculator },
  { id: 'price', en: 'Price List', mr: 'प्राईस लिस्ट', icon: FileText },
  { id: 'travel', en: 'Travel Record', mr: 'ट्रॅव्हल रेकॉर्ड', icon: MapPin },
  { id: 'scheme', en: 'Schemes & Offers', mr: 'स्कीम व ऑफर्स', icon: Gift },
  { id: 'report', en: 'Reports & Analytics', mr: 'रिपोर्ट्स व अ‍ॅनालिटिक्स', icon: BarChart3 },
  { id: 'user', en: 'User Management', mr: 'युजर मॅनेजमेंट', icon: UserPlus },
  { id: 'setting', en: 'Settings', mr: 'सेटिंग्ज', icon: Settings },
];

export interface SystemRoleItem {
  id: string;
  label: string;
  designation: string;
}

export const SYSTEM_ROLES: SystemRoleItem[] = [
  { id: 'owner', label: 'Owner ( MD )', designation: 'OWNER ( MD )' },
  { id: 'asm', label: 'ASM', designation: 'ASM' },
  { id: 'sr_sales_exec', label: 'Sr. Sales executive', designation: 'SR. SALES EXECUTIVE' },
  { id: 'sales_exec', label: 'Sales executive', designation: 'SALES EXECUTIVE' },
  { id: 'sales_officer', label: 'Sales officer', designation: 'SALES OFFICER' },
  { id: 'dev_officer', label: 'Development officer', designation: 'DEVELOPMENT OFFICER' },
  { id: 'sr_dev_officer', label: 'Sr. development officer', designation: 'SR. DEVELOPMENT OFFICER' },
  { id: 'field_officer', label: 'Field officer', designation: 'FIELD OFFICER' },
  { id: 'admin', label: 'Admin', designation: 'ADMIN OFFICER' },
  { id: 'dealer', label: 'Dealer', designation: 'AUTHORIZED DEALER' },
];

export const getDefaultDesignationForRole = (r: string): string => {
  const found = SYSTEM_ROLES.find((item) => item.id === r);
  return found ? found.designation : 'FIELD OFFICER';
};

export const getDefaultModulesForRole = (r: string): string[] => {
  switch (r) {
    case 'owner':
    case 'admin':
      return ['target', 'order', 'collection', 'dealer', 'calculator', 'price', 'travel', 'scheme', 'report', 'user', 'setting'];
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
  updatedAt?: string;
  createdAt: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const UserManagementView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [users, setUsers] = useState<DetailedUserProfile[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'form'>('list');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
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
  const [joiningDate, setJoiningDate] = useState(new Date().toISOString().slice(0, 10));
  const [aadhaarNo, setAadhaarNo] = useState('');
  const [panNo, setPanNo] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('bw@123');
  const [status, setStatus] = useState<'Active' | 'Inactive'>('Active');
  const [allowedModules, setAllowedModules] = useState<string[]>(getDefaultModulesForRole('field_officer'));
  const [photoUrl, setPhotoUrl] = useState('');

  // Branding
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);

  // UI state & refs
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const printableUserFormRef = useRef<HTMLDivElement>(null);

  // Mobile Hardware / Navigation Back Button Integration
  useEffect(() => {
    if (viewMode === 'form') {
      window.history.pushState({ tab: 'user', userFormOpen: true }, '');
      const handlePopState = () => {
        setViewMode('list');
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [viewMode]);

  // Real-time listener for all users
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list: DetailedUserProfile[] = [];
      snapshot.forEach((docSnap) => {
        const u = docSnap.data() as DetailedUserProfile;
        list.push({ ...u, uid: docSnap.id });
      });
      // Sort users: Owner (#1) first, followed by ascending user code number, then by full name
      list.sort((a, b) => {
        const aCode = (a.userCode ? String(a.userCode) : '').replace(/\D/g, '');
        const bCode = (b.userCode ? String(b.userCode) : '').replace(/\D/g, '');
        const aNum = parseInt(aCode, 10);
        const bNum = parseInt(bCode, 10);
        if (!isNaN(aNum) && !isNaN(bNum) && aNum !== bNum) {
          return aNum - bNum;
        }
        if (a.role === 'owner' && b.role !== 'owner') return -1;
        if (b.role === 'owner' && a.role !== 'owner') return 1;
        return (a.fullName || '').localeCompare(b.fullName || '');
      });
      setUsers(list);
    }, (error) => {
      console.error("Users firestore error:", error);
    });
    return () => unsubscribe();
  }, []);

  // Branding listener
  useEffect(() => {
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 80);
      }
    });
    return () => unsubBranding();
  }, []);

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
    setJoiningDate(new Date().toISOString().slice(0, 10));
    setAadhaarNo('');
    setPanNo('');
    setLoginId('');
    setPassword('bw@123');
    setStatus('Active');
    setAllowedModules(getDefaultModulesForRole(defaultRole));
    setPhotoUrl('');
    setShowAccessList(false);
    setIsEditing(true);
    setViewMode('form');
  };

  const loadUserToForm = (u: DetailedUserProfile, editMode: boolean = true) => {
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
    setShowAccessList(false);
    setIsEditing(editMode);
    setViewMode('form');
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoUrl(reader.result as string);
      };
      reader.readAsDataURL(file);
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
      fullName: fullName.trim().toUpperCase(),
      designation: designation.trim().toUpperCase(),
      center: center.trim().toUpperCase(),
      mobileNumber: trimmedMobile,
      altPhone: altPhone.trim(),
      emailId: emailId.trim() || `${trimmedMobile}@blackwormagri.com`,
      role,
      address: address.trim().toUpperCase(),
      village: village.trim().toUpperCase(),
      taluka: taluka.trim().toUpperCase(),
      district: district.trim().toUpperCase(),
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
      updatedAt: new Date().toISOString(),
      createdAt: currentUid ? (formatSafeDateString(users.find(u => u.uid === currentUid)?.createdAt) || new Date().toISOString()) : new Date().toISOString(),
    };

    try {
      await setDoc(doc(db, 'users', uid), payload, { merge: true });

      // If new user (and not owner), create initial target & travel records
      if (!currentUid && role !== 'owner') {
        const targetId = `target_${uid}_oct26`;
        await setDoc(doc(db, 'targets', targetId), {
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
        });

        const travelId = `travel_${uid}_init`;
        await setDoc(doc(db, 'travel_records', travelId), {
          id: travelId,
          userId: uid,
          userName: payload.fullName,
          date: new Date().toISOString().slice(0, 10),
          startLocation: 'Head Office',
          endLocation: 'Field Visits',
          vehicleType: 'Bike',
          kmTravelled: 0,
          kmRate: 3.5,
          fuelExpense: 0,
          daFoodExpense: 200,
          lodgingExpense: 0,
          totalExpense: 200,
          purpose: 'Initial Field Setup',
          status: 'submitted',
          ownerId: uid,
          isArchived: false,
          createdAt: new Date().toISOString(),
        });
      }

      await logAudit(
        currentUid ? 'UPDATE' : 'CREATE',
        'users',
        uid,
        `${currentUid ? 'Updated' : 'Registered'} User Profile for ${payload.fullName} (${payload.role} / ${payload.loginId})`,
        profile
      );

      setCurrentUid(uid);
      setIsEditing(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Save Error',
        message: `Save error: ${err.message || err}`,
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
    }
  };

  const handleDelete = async (uid: string, name: string) => {
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
          await deleteDoc(doc(db, 'users', uid));
          if (currentUid === uid) {
            setViewMode('list');
          }
        } catch (err: any) {
          setDialogConfig({
            isOpen: true,
            type: 'alert',
            title: 'Delete Failed',
            message: 'Delete failed: ' + err.message,
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

  const filteredUsers = users.filter((u) => {
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

  // Get module label based on current system language
  const getModuleLabel = (mod: SystemModuleItem) => {
    return (lang as string) === 'mr' ? mod.mr : mod.en;
  };

  if (!isAdmin(profile)) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-12">
        <ShieldCheck className="w-12 h-12 text-rose-500 mx-auto mb-3" />
        <h3 className="text-base font-bold text-slate-900">फक्त ॲडमिनसाठी उपलब्ध (Admin Access Only)</h3>
        <p className="text-xs text-slate-500 mt-1">युजर मॅनेजमेंट फक्त ॲडमिन उघडू शकतात.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 font-sans">
      {/* ======================= TOP BAR (LIST VIEW) ======================= */}
      {viewMode === 'list' && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex items-center gap-3 no-print">
          <button
            onClick={() => resetForm()}
            className="flex items-center justify-center bg-red-600 hover:bg-red-700 text-white p-2.5 rounded-xl transition shadow-lg shrink-0 active:scale-95"
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
            <span className="font-semibold">User details saved successfully!</span>
          </div>
          <button onClick={() => setSaveSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= VIEW MODE: LIST ======================= */}
      {viewMode === 'list' && (
        <div className="space-y-4 no-print">
          {/* Filter Pills */}
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

          {/* User Cards Grid: Strictly Code and Full Name in Single Line */}
          <div className="space-y-2.5">
            {filteredUsers.map((u) => (
              <div
                key={u.uid}
                onClick={() => loadUserToForm(u, true)}
                className="bg-white rounded-2xl border border-slate-200 hover:border-red-400 hover:shadow-md p-3.5 sm:p-4 transition-all cursor-pointer flex items-center justify-between gap-3 group relative overflow-hidden"
              >
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <span className="text-xs font-black text-red-600 bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg uppercase tracking-wider shrink-0 font-mono shadow-sm">
                    {u.userCode || 'USER'}
                  </span>
                  
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm sm:text-base font-black text-slate-900 group-hover:text-red-600 transition-colors uppercase truncate tracking-wide">
                      {u.fullName || 'Unnamed User'}
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 no-print">
                  <span className="text-xs font-bold text-slate-400 group-hover:text-red-600 transition">
                    👉
                  </span>
                </div>
              </div>
            ))}

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
            {/* Top Action Toolbar inside form card */}
            <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between no-print sticky left-0 min-w-max">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (window.history.state?.userFormOpen) {
                      window.history.back();
                    } else {
                      setViewMode('list');
                    }
                  }}
                  className="p-1.5 px-2.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 text-xs font-bold transition shadow-sm active:scale-95 cursor-pointer"
                  title="Back to User List"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-600" />
                  <span>Back</span>
                </button>
                <span className="text-xs font-black text-slate-800 uppercase tracking-wide">
                  {userCode || fullName || 'EMPLOYEE / USER REGISTRATION FORM'}
                </span>
                {isEditing && (
                  <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full uppercase">
                    Editing Mode
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(!isEditing)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm border flex items-center gap-1.5 ${
                    isEditing 
                      ? 'bg-emerald-600 text-white border-emerald-500' 
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-red-600'
                  }`}
                  title={isEditing ? 'Editing Mode Active (Click for View Mode)' : 'Click to Enable Editing'}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>{isEditing ? 'Editing' : 'Edit Form'}</span>
                </button>

                {isEditing && (
                  <button
                    type="submit"
                    form="user-profile-form"
                    className="text-xs font-bold px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1 shadow-sm transition"
                    title="Save Form"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleDownloadPdf}
                  disabled={isGeneratingPdf}
                  className="text-xs font-bold px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-sm transition disabled:opacity-50"
                  title="Download A4 PDF Form"
                >
                  {isGeneratingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  <span>{isGeneratingPdf ? 'Generating...' : 'Download'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => window.print()}
                  className="p-2 rounded-lg bg-red-600 hover:bg-red-700 text-white flex items-center shadow-sm transition"
                  title="Print Form"
                >
                  <Printer className="w-4 h-4" />
                </button>

                {currentUid && (
                  <button
                    type="button"
                    onClick={() => handleDelete(currentUid, fullName)}
                    className="p-2 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                    title="Delete Form"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

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
                    <div className="flex items-center p-0 h-10 bg-slate-50/50">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">User / Emp Code No -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center justify-between px-3 gap-2">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={userCode}
                          onChange={(e) => setUserCode(e.target.value)}
                          placeholder={calculateNextUserCode(role, users)}
                          className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-sm uppercase disabled:text-red-600"
                        />
                        {isEditing && (
                          <button
                            type="button"
                            onClick={() => setUserCode(calculateNextUserCode(role, users))}
                            className="text-[9px] font-black text-slate-600 hover:text-red-600 uppercase tracking-tight bg-white border border-slate-300 hover:border-red-400 px-2 py-0.5 rounded shrink-0 transition shadow-xs"
                            title="Auto Calculate Sequential Number (EMP-01, EMP-02...)"
                          >
                            Auto (#{calculateNextUserCode(role, users)})
                          </button>
                        )}
                        {!isEditing && (
                          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-tight bg-white border border-slate-200 px-1.5 py-0.5 rounded shrink-0">
                            No. {userCode || calculateNextUserCode(role, users)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Joining Date -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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

                  {/* Row 2: Full Name & Designation */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Full Name -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Designation -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={designation}
                          onChange={(e) => setDesignation(e.target.value)}
                          placeholder={getDefaultDesignationForRole(role)}
                          className="w-full bg-transparent font-black text-black uppercase focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 3: Center (HQ) & System Role */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 h-10 bg-slate-50/40">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Center (HQ) -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">System Role -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                  </div>

                  {/* Row 4: Mobile Number & Alt Contact */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Mobile No -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Alt / WhatsApp -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Email ID -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">State -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                  <div className="flex items-center p-0 h-10">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Full Address -</span>
                    <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Village / City -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Taluka / Tehsil -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">District -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Pin Code -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Date of Birth -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditing}
                          value={dateOfBirth}
                          onChange={(e) => setDateOfBirth(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Aadhaar No -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                  <div className="flex items-center p-0 h-10">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">PAN Card No -</span>
                    <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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

                {/* 4. Credentials Section Banner */}
                <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-center uppercase tracking-widest text-xs border-y-2 border-black">
                  LOGIN & ACCESS CREDENTIALS
                </div>

                {/* Credentials & Access Mode Rows */}
                <div className="divide-y-2 divide-black bg-white text-[11px]">
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Login ID -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
                    <div className="flex items-center p-0 h-10">
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
                    <div className="flex items-center p-0 h-10">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Account Status -</span>
                      <div className="flex-1 border-l-2 border-black h-full flex items-center px-3">
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
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================= PHOTO SELECTION MODAL ======================= */}
      {showPhotoModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 no-print animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5 space-y-4 border border-slate-200">
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
