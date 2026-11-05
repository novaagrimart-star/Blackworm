import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  collection, 
  query, 
  where,
  orderBy,
  limit,
  onSnapshot, 
  doc, 
  setDoc, 
  deleteDoc, 
  runTransaction, 
  getDocs, 
  getDoc, 
  writeBatch,
  startAfter
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { logAudit, safeFirestoreSet, mergeWithLocalData, isQuotaBlocked } from '../../lib/dataService';
import { toTitleCase } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
import { compressImageFile } from '../../lib/imageCompression';
import { Language } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Plus, 
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
  ArrowLeft,
  FileCheck,
  CheckCircle2,
  Copy,
  Save,
  Download,
  Loader2,
  RefreshCw,
  FileText,
  LayoutList,
  Table as TableIcon,
  User as UserIcon,
  ChevronDown,
  ArrowUpDown,
  UserCheck
} from 'lucide-react';

export interface DealershipFormItem {
  id: string;
  center: string;
  shopOpeningDate: string;
  dealerCode: string;
  created_by_user_id?: string;
  created_by_name?: string;
  village: string;
  securityDeposit: string;
  firmName: string;
  proprietorName: string;
  contactNumber: string;
  state: string;
  emailId: string;
  responsiblePerson: string;
  responsibleContact: string;
  aadhaarNo: string;
  district: string;
  panNo: string;
  dateOfBirth: string;
  gstNo: string;
  pinCode: string;
  dealershipAddressPhoto?: string;
  
  // Bank Details
  bankName: string;
  bankAddress: string;
  accountNo: string;
  ifscCode: string;
  chequeNos: string;

  // Declaration & Office
  place: string;
  declarationDate: string;
  remarks: string;
  officerName: string;
  status: 'Approved' | 'Pending' | 'Draft';
  
  // Office Use Fields
  officeDate?: string;
  officeTime?: string;
  officePlace?: string;

  createdAt?: string;
  updatedAt?: string;
  isArchived?: boolean;
  ownerId?: string;
  userId?: string;
  loginId?: string;
  createdByUid?: string;
  userCode?: string;
}

const formatDisplayDateTime = (dateVal?: string, timeVal?: string) => {
  try {
    const d = dateVal ? new Date(dateVal) : new Date();
    const dateFormatted = !isNaN(d.getTime()) ? d.toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB');
    
    let timeFormatted = '';
    if (timeVal) {
      if (timeVal.includes(':')) {
        const cleanTime = timeVal.replace(/[^0-9:]/g, '');
        const parts = cleanTime.split(':');
        let hours = parseInt(parts[0], 10) || 12;
        const minutes = parts[1] ? parts[1].slice(0, 2).padStart(2, '0') : '00';
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        timeFormatted = `${hours}:${minutes} ${ampm}`;
      } else {
        timeFormatted = timeVal;
      }
    } else {
      timeFormatted = '12:00 PM';
    }
    return `${dateFormatted}. ${timeFormatted}.`;
  } catch {
    return `${new Date().toLocaleDateString('en-GB')}. 12:00 PM.`;
  }
};

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const DealerView: React.FC<Props> = ({ profile }) => {
  const [dealers, setDealers] = useState<DealershipFormItem[]>(() => {
    try {
      const local = mergeWithLocalData('dealers_application', []);
      if (local && local.length > 0) return local;
    } catch {}
    return [];
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active'>('all');
  
  const [viewMode, setViewMode] = useState<'list' | 'form'>('list');
  const [isEditing, setIsEditing] = useState(true);
  const [currentId, setCurrentId] = useState<string | null>(null);

  // Pagination states
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const PAGE_SIZE = 20;

  // Form fields
  const [center, setCenter] = useState('Sangli');
  const [shopOpeningDate, setShopOpeningDate] = useState('2021-09-04');
  const [dealerCode, setDealerCode] = useState('');
  const [village, setVillage] = useState('');
  const [securityDeposit, setSecurityDeposit] = useState('NA');
  const [dealershipAddressPhoto, setDealershipAddressPhoto] = useState('');
  const [firmName, setFirmName] = useState('');
  const [proprietorName, setProprietorName] = useState('');
  const [stateName, setStateName] = useState('Maharashtra');
  const [contactNumber, setContactNumber] = useState('');
  const [emailId, setEmailId] = useState('');
  const [responsiblePerson, setResponsiblePerson] = useState('');
  const [responsibleContact, setResponsibleContact] = useState('');
  const [aadhaarNo, setAadhaarNo] = useState('');
  const [district, setDistrict] = useState('SANGLI');
  const [panNo, setPanNo] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gstNo, setGstNo] = useState('');
  const [pinCode, setPinCode] = useState('');

  const [bankName, setBankName] = useState('');
  const [bankAddress, setBankAddress] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [chequeNos, setChequeNos] = useState('');

  const [place, setPlace] = useState('Sangli');
  const [declarationDate, setDeclarationDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState('');
  const [officerName, setOfficerName] = useState((profile.fullName || profile.loginId || 'OFFICER').toUpperCase());
  const [createdByUserId, setCreatedByUserId] = useState<string>(profile.uid || '');
  const [createdByName, setCreatedByName] = useState<string>((profile.fullName || profile.loginId || 'OFFICER').toUpperCase());
  const [globalSequence, setGlobalSequence] = useState<number>(0);
  const [status, setStatus] = useState<'Approved' | 'Pending' | 'Draft'>('Approved');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  
  // Office Use Fields
  const [officeDate, setOfficeDate] = useState('');
  const [officeTime, setOfficeTime] = useState('');
  const [officePlace, setOfficePlace] = useState('');

  const { logoUrl, logoSize } = useBranding();

  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [listDisplayMode, setListDisplayMode] = useState<'cards' | 'table'>('cards');
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const printableFormRef = useRef<HTMLDivElement>(null);
  const [usersMap, setUsersMap] = useState<Record<string, string>>(() => {
    try {
      const cached = localStorage.getItem('blackworm_cached_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        const map: Record<string, string> = {};
        parsed.forEach((u: any) => {
          if (u.fullName) {
            map[u.uid || u.id] = u.fullName;
            if (u.loginId) map[u.loginId.toLowerCase()] = u.fullName;
            if (u.userCode) map[u.userCode.toLowerCase()] = u.fullName;
          }
        });
        return map;
      }
    } catch {}
    return {};
  });
  const [officers, setOfficers] = useState<{ uid: string; fullName: string; designation?: string; role?: string; loginId?: string; userCode?: string }[]>(() => {
    try {
      const cached = localStorage.getItem('blackworm_cached_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        return parsed.filter((u: any) => u.role !== 'dealer');
      }
    } catch {}
    return [];
  });
  const [selectedOfficerFilter, setSelectedOfficerFilter] = useState<string>('all');
  const [showUserFilterDropdown, setShowUserFilterDropdown] = useState<boolean>(false);
  const [isSavingDealer, setIsSavingDealer] = useState<boolean>(false);
  const formSessionIdRef = useRef<string>('');

  useEffect(() => {
    const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
      const map: Record<string, string> = {};
      const uList: { uid: string; fullName: string; designation?: string; role?: string; loginId?: string; userCode?: string }[] = [];
      snap.forEach((d) => {
        const u = d.data();
        if (u.fullName) {
          map[d.id] = u.fullName;
          if (u.loginId) map[u.loginId.toLowerCase()] = u.fullName;
          if (u.userCode) map[u.userCode.toLowerCase()] = u.fullName;
        }
        if (u.role !== 'dealer') {
          uList.push({
            uid: d.id,
            fullName: u.fullName || u.loginId || d.id,
            designation: u.designation || u.role || 'OFFICER',
            role: u.role,
            loginId: u.loginId,
            userCode: u.userCode,
          });
        }
      });
      uList.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsersMap(map);
      setOfficers(uList);
      try {
        localStorage.setItem('blackworm_cached_users', JSON.stringify(uList));
      } catch {}
    });
    return () => unsubUsers();
  }, []);
  useEffect(() => {
    if (viewMode === 'form') {
      const handlePopState = (e: PopStateEvent) => {
        // If user hits browser back button while in form, return directly to dealer list
        setViewMode('list');
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [viewMode]);

  const handleDownloadPdf = async () => {
    if (!printableFormRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const element = printableFormRef.current;
      
      const canvas = await html2canvas(element, {
        scale: 3, // Even higher resolution
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });

      const imgData = canvas.toDataURL('image/jpeg', 1.0);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pageWidth = pdf.internal.pageSize.getWidth(); // 210
      const pageHeight = pdf.internal.pageSize.getHeight(); // 297
      
      const imgWidth = pageWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      
      let finalWidth = imgWidth;
      let finalHeight = imgHeight;
      let xOffset = 0;
      let yOffset = 0;

      // STRICT ONE-PAGE FIT LOGIC
      // If height is more than A4, scale down to fit height
      if (imgHeight > pageHeight) {
        const ratio = pageHeight / imgHeight;
        finalHeight = pageHeight;
        finalWidth = imgWidth * ratio;
        xOffset = (pageWidth - finalWidth) / 2; // Center horizontally
      }

      pdf.addImage(imgData, 'JPEG', xOffset, yOffset, finalWidth, finalHeight);
      const sanitizedName = (firmName || dealerCode || 'Dealership_Form').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };



  // Real-time listener for global sequence counter
  useEffect(() => {
    const unsubSeq = onSnapshot(doc(db, 'config', 'dealer_sequence'), (snap) => {
      if (snap.exists()) {
        const val = Number(snap.data()?.currentSequence) || 0;
        setGlobalSequence(val);
      }
    }, (err) => {
      console.warn('Dealer sequence sync notice:', err);
    });
    return () => unsubSeq();
  }, []);

  // Re-index all saved dealers with continuous clean serial numbers (001, 002, 003...)
  // and sync config/dealer_sequence with the highest number so next form gets (highest + 1)
  const reindexAllDealersSequence = async (showModalAlert = false) => {
    try {
      let itemsList: DealershipFormItem[] = [];

      // 1. Try remote fetch if quota allows
      if (!isQuotaBlocked()) {
        try {
          const snap = await getDocs(collection(db, 'dealers_application'));
          snap.forEach((d) => {
            const data = d.data() as DealershipFormItem;
            if (!data.isArchived) {
              itemsList.push({ ...data, id: d.id });
            }
          });
        } catch (e) {
          console.warn('Server fetch for reindex skipped:', e);
        }
      }

      // 2. If remote was empty or skipped/blocked, fall back to in-memory + local storage
      if (itemsList.length === 0) {
        const localItems = mergeWithLocalData('dealers_application', dealers);
        itemsList = localItems.filter((d) => !d.isArchived);
      }

      if (itemsList.length === 0) {
        if (showModalAlert) {
          setDialogConfig({
            isOpen: true,
            type: 'alert',
            title: 'माहिती',
            message: 'डेटाबेसमध्ये सध्या कोणताही सेव्ह केलेला डीलर उपलब्ध नाही.',
            onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
          });
        }
        return;
      }

      // 3. Sort strictly by creation time
      itemsList.sort((a, b) => {
        const timeA = new Date(a.createdAt || 0).getTime() || parseInt((a.id.match(/\d+/) || ['0'])[0], 10);
        const timeB = new Date(b.createdAt || 0).getTime() || parseInt((b.id.match(/\d+/) || ['0'])[0], 10);
        if (timeA !== timeB) return timeA - timeB;
        const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

      // 4. Update local map and re-assign contiguous serial codes
      const updatedDealers: DealershipFormItem[] = [];
      const localStorageKey = 'blackworm_local_dealers_application';
      let localMap: Record<string, any> = {};
      try {
        const raw = localStorage.getItem(localStorageKey);
        if (raw) localMap = JSON.parse(raw);
      } catch {}

      for (let i = 0; i < itemsList.length; i++) {
        const item = itemsList[i];
        const targetCode = String(i + 1).padStart(3, '0');
        const updatedItem = {
          ...item,
          dealerCode: targetCode,
          updatedAt: new Date().toISOString(),
        };
        updatedDealers.push(updatedItem);
        localMap[item.id] = updatedItem;

        // Sync to Firestore if remote is accessible and code changed
        if (!isQuotaBlocked() && item.dealerCode !== targetCode) {
          safeFirestoreSet('dealers_application', item.id, {
            dealerCode: targetCode,
            updatedAt: new Date().toISOString(),
          }, { merge: true }).catch(() => {});
        }
      }

      try {
        localStorage.setItem(localStorageKey, JSON.stringify(localMap));
      } catch {}

      const totalDealers = itemsList.length;
      setGlobalSequence(totalDealers);
      setDealers(updatedDealers);

      // Sync counter config
      if (!isQuotaBlocked()) {
        safeFirestoreSet('config', 'dealer_sequence', {
          currentSequence: totalDealers,
          updatedAt: new Date().toISOString(),
          lastAllocatedAt: new Date().toISOString(),
        }, { merge: true }).catch(() => {});
      }

      if (showModalAlert) {
        const nextPreview = String(totalDealers + 1).padStart(3, '0');
        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: 'सिरीयल नंबर सिंक झाले!',
          message: `एकूण ${totalDealers} डीलर ॲप्लिकेशन्सना सलग सिरीयल नंबर (001 ते ${String(totalDealers).padStart(3, '0')}) मिळाले आहेत. पुढील नवीन डीलरला ऑटोमॅटिक #${nextPreview} नंबर मिळेल.`,
          confirmText: 'ठीक आहे',
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
        });
      }
    } catch (err: any) {
      console.warn('Dealer sequence sync error:', err);
      if (showModalAlert) {
        setDialogConfig({
          isOpen: true,
          type: 'alert',
          title: 'त्रुटी',
          message: 'सिरीयल नंबर सिंक करताना अडचण आली: ' + (err.message || err),
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
        });
      }
    }
  };

  const loadDealers = async (isLoadMore = false) => {
    if (isLoadingMore || (isLoadMore && !hasMore)) return;
    
    setIsLoadingMore(true);
    try {
      let q = query(
        collection(db, 'dealers_application'),
        orderBy('createdAt', 'desc'),
        limit(PAGE_SIZE)
      );

      if (isLoadMore && lastDoc) {
        q = query(
          collection(db, 'dealers_application'),
          orderBy('createdAt', 'desc'),
          startAfter(lastDoc),
          limit(PAGE_SIZE)
        );
      }

      const snap = await getDocs(q);
      
      const list: DealershipFormItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as DealershipFormItem;
        list.push({ ...data, id: d.id });
      });

      const merged = mergeWithLocalData('dealers_application', list);
      
      if (isLoadMore) {
        setDealers(prev => [...prev, ...merged]);
      } else {
        setDealers(merged);
      }

      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (error) {
      console.warn("dealers_application fetch error:", error);
      if (!isLoadMore) {
        const cached = mergeWithLocalData('dealers_application', []);
        setDealers(cached);
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const q = query(
      collection(db, 'dealers_application'),
      limit(500)
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: DealershipFormItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as DealershipFormItem;
        list.push({ ...data, id: d.id });
      });
      // Strictly sort by numeric dealerCode so order never jumps on refresh
      list.sort((a, b) => {
        const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        if (numA !== numB) return numB - numA;
        const timeA = new Date(a.createdAt || 0).getTime() || 0;
        const timeB = new Date(b.createdAt || 0).getTime() || 0;
        return timeB - timeA;
      });
      const merged = mergeWithLocalData('dealers_application', list);
      merged.sort((a, b) => {
        const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        if (numA !== numB) return numB - numA;
        const timeA = new Date(a.createdAt || 0).getTime() || 0;
        const timeB = new Date(b.createdAt || 0).getTime() || 0;
        return timeB - timeA;
      });
      setDealers(merged);
    }, (error) => {
      console.warn("dealers_application real-time sync notice:", error);
      const cached = mergeWithLocalData<DealershipFormItem>('dealers_application', []);
      cached.sort((a, b) => {
        const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        return numB - numA;
      });
      setDealers(cached);
    });

    return () => unsub();
  }, []);

  // Populate form fields directly from memory cache (Zero extra network reads!)
  useEffect(() => {
    if (viewMode === 'form' && currentId) {
      const item = dealers.find(d => d.id === currentId);
      if (item) {
        setCenter(item.center || '');
        setShopOpeningDate(item.shopOpeningDate || '');
        setDealerCode(item.dealerCode || '');
        setVillage(item.village || '');
        setSecurityDeposit(item.securityDeposit || 'NA');
        setDealershipAddressPhoto(item.dealershipAddressPhoto || '');
        setFirmName(item.firmName || '');
        setProprietorName(item.proprietorName || '');
        setStateName(item.state || 'Maharashtra');
        setContactNumber(item.contactNumber || '');
        setEmailId(item.emailId || '');
        setResponsiblePerson(item.responsiblePerson || '');
        setResponsibleContact(item.responsibleContact || '');
        setAadhaarNo(item.aadhaarNo || '');
        setDistrict(item.district || '');
        setPanNo(item.panNo || '');
        setDateOfBirth(item.dateOfBirth || '');
        setGstNo(item.gstNo || '');
        setPinCode(item.pinCode || '');
        setBankName(item.bankName || '');
        setBankAddress(item.bankAddress || '');
        setAccountNo(item.accountNo || '');
        setIfscCode(item.ifscCode || '');
        setChequeNos(item.chequeNos || '');
        setPlace(item.place || 'Sangli');
        setDeclarationDate(item.declarationDate || new Date().toISOString().slice(0, 10));
        setRemarks(item.remarks || '');
        // Preserve strictly the officer name of the user who filled the form
        const origOfficer = item.officerName || item.created_by_name || (item.userId && usersMap[item.userId]) || (item.created_by_user_id && usersMap[item.created_by_user_id]) || (item.loginId && usersMap[item.loginId.toLowerCase()]) || '';
        const displayOfficer = (origOfficer || profile.fullName || 'OFFICER').toUpperCase();
        setOfficerName(displayOfficer);
        setCreatedByUserId(item.created_by_user_id || item.createdByUid || item.userId || '');
        setCreatedByName(displayOfficer);
        setOfficeDate(item.officeDate || '');
        setOfficeTime(item.officeTime || '');
        setOfficePlace(item.officePlace || '');
        setStatus(item.status || 'Approved');
      }
    }
  }, [viewMode, currentId, dealers]);

  // Global Auto-Increment Sequence Counter (Atomic transaction across ALL devices, 100% duplicate-free & offline-ready)
  const allocateGlobalDealerCode = async (): Promise<string> => {
    let maxKnown = 0;

    // Scan loaded dealers in memory
    dealers.forEach((d) => {
      if (!d.isArchived) {
        const raw = String(d.dealerCode || '').trim();
        const n = parseInt(raw.replace(/\D/g, ''), 10);
        if (!isNaN(n) && n > maxKnown) {
          maxKnown = n;
        }
      }
    });

    // Also check local storage for newly saved offline applications
    try {
      const localMapRaw = localStorage.getItem('blackworm_local_dealers_application');
      if (localMapRaw) {
        const localMap = JSON.parse(localMapRaw);
        Object.values(localMap).forEach((item: any) => {
          if (item && !item.isArchived) {
            const raw = String(item.dealerCode || '').trim();
            const n = parseInt(raw.replace(/\D/g, ''), 10);
            if (!isNaN(n) && n > maxKnown) {
              maxKnown = n;
            }
          }
        });
      }
    } catch (_) {}

    const seqRef = doc(db, 'config', 'dealer_sequence');
    let nextNum: number;

    try {
      // Execute atomic Firestore transaction to guarantee that concurrent officer submissions NEVER collide
      nextNum = await runTransaction(db, async (transaction) => {
        const seqSnap = await transaction.get(seqRef);
        let cur = 0;
        if (seqSnap.exists()) {
          cur = Number(seqSnap.data()?.currentSequence) || 0;
        }
        cur = Math.max(cur, maxKnown, globalSequence || 0);
        const allocated = cur + 1;
        transaction.set(
          seqRef,
          {
            currentSequence: allocated,
            lastAllocatedCode: String(allocated).padStart(3, '0'),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        return allocated;
      });
    } catch (txErr) {
      console.warn('Atomic transaction sequence fallback (offline or network retry):', txErr);
      const baseNum = Math.max(maxKnown, globalSequence || 0);
      nextNum = baseNum + 1;
      try {
        setDoc(
          seqRef,
          {
            currentSequence: nextNum,
            lastAllocatedCode: String(nextNum).padStart(3, '0'),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        ).catch(() => {});
      } catch (_) {}
    }

    setGlobalSequence(nextNum);
    return String(nextNum).padStart(3, '0');
  };

  const resetForm = (customCode?: string) => {
    // Determine the next preview number: strictly highest existing + 1
    let previewNum = (globalSequence || 0) + 1;
    if (dealers.length > 0) {
      const maxInLocal = dealers.reduce((max, d) => {
        const n = parseInt(String(d.dealerCode || '').replace(/\D/g, ''), 10);
        return !isNaN(n) ? Math.max(max, n) : max;
      }, 0);
      previewNum = Math.max(previewNum, maxInLocal + 1);
    }
    const previewCode = customCode || String(previewNum).padStart(3, '0');

    setCurrentId(null);
    formSessionIdRef.current = '';
    setCenter('');
    setShopOpeningDate(new Date().toISOString().slice(0, 10));
    setDealerCode(previewCode);
    setVillage('');
    setSecurityDeposit('NA');
    setDealershipAddressPhoto('');
    setFirmName('');
    setProprietorName('');
    setStateName('Maharashtra');
    setContactNumber('');
    setEmailId('');
    setResponsiblePerson('');
    setResponsibleContact('');
    setAadhaarNo('');
    setDistrict('');
    setPanNo('');
    setDateOfBirth('');
    setGstNo('');
    setPinCode('');
    setBankName('');
    setBankAddress('');
    setAccountNo('');
    setIfscCode('');
    setChequeNos('');
    setPlace('Sangli');
    setDeclarationDate(new Date().toISOString().slice(0, 10));
    setRemarks('');
    // For a new form: the officer is strictly the logged-in user filling the form
    const myName = (profile.fullName || profile.loginId || 'OFFICER').toUpperCase();
    setOfficerName(myName);
    setCreatedByUserId(profile.uid || '');
    setCreatedByName(myName);
    setOfficeDate(new Date().toISOString().slice(0, 10));
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    setOfficeTime(`${hh}:${mm}`);
    setOfficePlace('SANGLI');
    setStatus('Approved');
    setIsEditing(true);
    setViewMode('form');
  };

  // ============================================================================
  // PERMANENT ARCHITECTURAL LOCK:
  // When a user clicks on any saved dealer's name (किंवा डीलर कोड / कार्ड / रो),
  // loadDealerToForm directly and immediately opens their full dealership application form.
  // NO intermediate modal, popup, action drawer, or confirmation dialog should EVER intercept.
  // Do not revert this behavior under any circumstances!
  // ============================================================================
  const loadDealerToForm = (item: DealershipFormItem, editMode: boolean = true) => {
    if (!isAdmin(profile) && !isCreatedByOfficer(item, profile.uid)) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Access Restricted',
        message: 'तुम्हाला फक्त स्वतः भरलेले डीलर फॉर्म पाहण्याची परवानगी आहे. (You can only access dealership forms filled by you)',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
      return;
    }
    setCurrentId(item.id);
    formSessionIdRef.current = item.id;
    setCenter(item.center || '');
    setShopOpeningDate(item.shopOpeningDate || '');
    setDealerCode(item.dealerCode || '');
    setVillage(item.village || '');
    setSecurityDeposit(item.securityDeposit || 'NA');
    setDealershipAddressPhoto(item.dealershipAddressPhoto || '');
    setFirmName(item.firmName || '');
    setProprietorName(item.proprietorName || '');
    setStateName(item.state || 'Maharashtra');
    setContactNumber(item.contactNumber || '');
    setEmailId(item.emailId || '');
    setResponsiblePerson(item.responsiblePerson || '');
    setResponsibleContact(item.responsibleContact || '');
    setAadhaarNo(item.aadhaarNo || '');
    setDistrict(item.district || '');
    setPanNo(item.panNo || '');
    setDateOfBirth(item.dateOfBirth || '');
    setGstNo(item.gstNo || '');
    setPinCode(item.pinCode || '');
    setBankName(item.bankName || '');
    setBankAddress(item.bankAddress || '');
    setAccountNo(item.accountNo || '');
    setIfscCode(item.ifscCode || '');
    setChequeNos(item.chequeNos || '');
    setPlace(item.place || 'Sangli');
    setDeclarationDate(item.declarationDate || new Date().toISOString().slice(0, 10));
    setRemarks(item.remarks || '');
    // Strictly display the officer name of the user who filled the form!
    const originalOfficer = item.officerName || item.created_by_name || (item.userId && usersMap[item.userId]) || (item.created_by_user_id && usersMap[item.created_by_user_id]) || (item.loginId && usersMap[item.loginId.toLowerCase()]) || '';
    const displayOfficer = (originalOfficer || profile.fullName || 'OFFICER').toUpperCase();
    setOfficerName(displayOfficer);
    setCreatedByUserId(item.created_by_user_id || item.createdByUid || item.userId || '');
    setCreatedByName(displayOfficer);
    setOfficeDate(item.officeDate || '');
    setOfficeTime(item.officeTime || '');
    setOfficePlace(item.officePlace || '');
    setStatus(item.status || 'Approved');
    setIsEditing(editMode);
    setViewMode('form');
    // Scroll directly to the top so user immediately views the form
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'instant' });
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
    if (isSavingDealer) return;

    if (!firmName.trim()) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'माहिती आवश्यक (Required Field)',
        message: 'कृपया फर्मचे नाव टाका (Please enter Firm Name)',
        confirmText: 'समजले (OK)',
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
      return;
    }

    setIsSavingDealer(true);

    try {
      const isNewRecord = !currentId && !formSessionIdRef.current;
      const id = currentId || formSessionIdRef.current || `dealer_app_${Date.now()}`;
      formSessionIdRef.current = id;
      if (!currentId) {
        setCurrentId(id);
      }

      // For new forms: allocate Global Auto-Increment Code across ALL users atomically
      let finalCode = dealerCode.trim();
      if (isNewRecord) {
        try {
          finalCode = await allocateGlobalDealerCode();
        } catch (err) {
          console.warn('Fallback sequence allocation:', err);
          const nextNum = (globalSequence || 0) + 1;
          finalCode = String(nextNum).padStart(3, '0');
        }
      }

      // Preserve the original officer name and creator UID
      const finalOfficer = currentId 
        ? (officerName || createdByName || profile.fullName || '').toUpperCase()
        : (profile.fullName || profile.loginId || officerName || 'OFFICER').toUpperCase();
      const finalCreatorId = currentId ? (createdByUserId || profile.uid) : profile.uid;
      const finalCreatorName = currentId ? (createdByName || finalOfficer) : (profile.fullName || profile.loginId || 'OFFICER');

      const payload: DealershipFormItem = {
        id,
        center: (center || '').trim(),
        shopOpeningDate: shopOpeningDate || new Date().toISOString().slice(0, 10),
        dealerCode: finalCode || 'AUTO',
        village: (village || '').trim(),
        securityDeposit: (securityDeposit || 'NA').trim(),
        dealershipAddressPhoto: dealershipAddressPhoto || '',
        firmName: (firmName || '').trim().toUpperCase(),
        proprietorName: (proprietorName || '').trim().toUpperCase(),
        contactNumber: (contactNumber || '').trim(),
        state: (stateName || 'Maharashtra').trim(),
        emailId: (emailId || '').trim(),
        responsiblePerson: (responsiblePerson || '').trim().toUpperCase(),
        responsibleContact: (responsibleContact || '').trim(),
        aadhaarNo: (aadhaarNo || '').trim(),
        district: (district || '').trim().toUpperCase(),
        panNo: (panNo || '').trim().toUpperCase(),
        dateOfBirth: dateOfBirth || '',
        gstNo: (gstNo || '').trim().toUpperCase(),
        pinCode: (pinCode || '').trim(),
        bankName: (bankName || '').trim().toUpperCase(),
        bankAddress: (bankAddress || '').trim().toUpperCase(),
        accountNo: (accountNo || '').trim(),
        ifscCode: (ifscCode || '').trim().toUpperCase(),
        chequeNos: (chequeNos || '').trim(),
        place: (place || 'Sangli').trim(),
        declarationDate: declarationDate || new Date().toISOString().slice(0, 10),
        remarks: (remarks || '').trim(),
        officeDate: officeDate || new Date().toISOString().slice(0, 10),
        officeTime: officeTime || '',
        officePlace: (officePlace || place || 'SANGLI').trim().toUpperCase(),
        officerName: finalOfficer || 'OFFICER',
        created_by_user_id: finalCreatorId || '',
        created_by_name: finalCreatorName || 'OFFICER',
        status: status || 'Approved',
        isArchived: false,
        ownerId: finalCreatorId || '',
        userId: finalCreatorId || '',
        loginId: profile.loginId || '',
        createdByUid: finalCreatorId || '',
        updatedAt: new Date().toISOString(),
      };

      if (isNewRecord) {
        payload.createdAt = new Date().toISOString();
      }

      const saveRes = await safeFirestoreSet('dealers_application', id, payload, { merge: true });
      await logAudit(
        isNewRecord ? 'CREATE' : 'UPDATE',
        'dealers_application',
        id,
        `${isNewRecord ? 'Created' : 'Updated'} Dealership Form for ${payload.firmName} (${payload.dealerCode}) by ${payload.officerName}`,
        profile
      );

      // Immediately update in-memory state
      setDealers((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = payload;
          return updated;
        }
        return [payload, ...prev];
      });

      setCurrentId(id);
      setDealerCode(finalCode);
      setOfficerName(finalOfficer);
      setCreatedByUserId(finalCreatorId);
      setCreatedByName(finalCreatorName);
      setIsEditing(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);

      if (isNewRecord) {
        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: `डीलर फॉर्म सेव्ह झाला: #${finalCode}`,
          message: saveRes.isCachedLocally
            ? `डीलर फॉर्म स्थानिक सुरक्षित मेमरीमध्ये सेव्ह झाला आहे (#${finalCode}).\nफर्म: ${payload.firmName}`
            : `डीलर फॉर्म अधिकृत सिरीयल नंबर #${finalCode} सह यशस्वीरित्या सेव्ह झाला आहे.\nफर्म: ${payload.firmName}`,
          confirmText: 'डीलर यादी पहा (View List)',
          onConfirm: () => {
            setDialogConfig((p) => ({ ...p, isOpen: false }));
            setViewMode('list');
          },
        });
      } else {
        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: `डीलर माहिती अपडेट झाली`,
          message: saveRes.isCachedLocally
            ? `${payload.firmName} यांची माहिती सुरक्षित सेव्ह झाली आहे.`
            : `${payload.firmName} यांची माहिती यशस्वीरित्या अपडेट करण्यात आली आहे.`,
          confirmText: 'डीलर यादी पहा (View List)',
          onConfirm: () => {
            setDialogConfig((p) => ({ ...p, isOpen: false }));
            setViewMode('list');
          },
        });
      }
    } catch (err: any) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'सेव्ह करताना त्रुटी (Save Error)',
        message: `माहिती सेव्ह करताना अडचण आली: ${err.message || err}`,
        confirmText: 'समजले (OK)',
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
      });
    } finally {
      setIsSavingDealer(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const itemToDelete = dealers.find(d => d.id === id);
    if (!isAdmin(profile) && itemToDelete && !isCreatedByOfficer(itemToDelete, profile.uid)) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Action Restricted',
        message: 'इतर अधिकाऱ्यांचे डीलर फॉर्म डिलीट करण्याची परवानगी नाही. (You can only delete your own dealer forms)',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
      return;
    }
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Confirmation',
      message: 'Are you sure you want to delete this Dealer?',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        try {
          // 1. Immediately remove from local storage
          try {
            const storageKey = 'blackworm_local_dealers_application';
            const raw = localStorage.getItem(storageKey);
            if (raw) {
              const map = JSON.parse(raw);
              delete map[id];
              localStorage.setItem(storageKey, JSON.stringify(map));
            }
          } catch {}

          // 2. Remove from state immediately
          setDealers(prev => prev.filter(d => d.id !== id));

          if (currentId === id) {
            setViewMode('list');
          }

          // 3. Delete from remote if quota allows
          if (!isQuotaBlocked()) {
            try {
              await deleteDoc(doc(db, 'dealers_application', id));
            } catch (delErr) {
              console.warn('Delete remote notice:', delErr);
            }
          }

          // 4. Automatically re-index continuous serial numbers (001, 002, 003...)
          await reindexAllDealersSequence(false);
        } catch (err: any) {
          console.warn('Dealer delete handler notice:', err);
        }
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressed = await compressImageFile(file, 800, 0.6);
        setDealershipAddressPhoto(compressed);
      } catch (err) {
        console.warn('Image compression fallback:', err);
        const reader = new FileReader();
        reader.onloadend = () => {
          setDealershipAddressPhoto(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const isCreatedByOfficer = (d: DealershipFormItem, officerUid: string) => {
    if (officerUid === 'all') return true;
    if (officerUid === profile.uid && (d.id === currentId || d.id === formSessionIdRef.current)) {
      return true;
    }
    const targetOfficer = officers.find(o => o.uid === officerUid);
    const targetName = (targetOfficer?.fullName || (officerUid === profile.uid ? profile.fullName : '') || '').trim().toUpperCase();
    const targetLogin = (targetOfficer?.loginId || (officerUid === profile.uid ? profile.loginId : '') || '').trim().toLowerCase();
    const targetCode = (targetOfficer?.userCode || (officerUid === profile.uid ? profile.userCode : '') || '').trim().toLowerCase();

    // 1. Direct creator UID match or assigned officer UID match
    const creatorId = (d.created_by_user_id || d.createdByUid || d.userId || d.ownerId || (d as any).assignedOfficerUid || '').toString().trim().toLowerCase();
    const targetUidLower = (officerUid || '').trim().toLowerCase();
    if (targetUidLower && creatorId && (creatorId === targetUidLower || creatorId.includes(targetUidLower))) {
      return true;
    }

    // 2. Full name match or substring match
    const dOfficerName = (d.officerName || d.created_by_name || '').toString().trim().toUpperCase();
    if (targetName && dOfficerName) {
      if (dOfficerName === targetName || dOfficerName.includes(targetName) || targetName.includes(dOfficerName)) {
        return true;
      }
    }

    // 3. Officer Login ID match (only if not generic 'admin')
    const dLogin = (d.loginId || '').toString().trim().toLowerCase();
    if (targetLogin && dLogin && dLogin !== 'admin' && (dLogin === targetLogin || dLogin.includes(targetLogin))) {
      return true;
    }

    // 4. Officer User Code match
    const dCode = (d.userCode || '').toString().trim().toLowerCase();
    if (targetCode && dCode && (dCode === targetCode || dCode.includes(targetCode))) {
      return true;
    }

    return false;
  };

  const getDealerSubmittedBy = (d: DealershipFormItem) => {
    const uid = d.created_by_user_id || d.createdByUid || d.userId || d.ownerId;
    if (uid && usersMap[uid]) return usersMap[uid];
    if (d.created_by_name) return d.created_by_name;
    if (d.officerName) return d.officerName;
    if (d.loginId && usersMap[d.loginId.toLowerCase()]) return usersMap[d.loginId.toLowerCase()];
    return 'अधिकारी (Officer)';
  };

  const userIsAdmin = isAdmin(profile);

  const usersWithCounts = useMemo(() => {
    return officers.map(off => {
      const count = dealers.filter(d => isCreatedByOfficer(d, off.uid)).length;
      return {
        ...off,
        count
      };
    }).sort((a, b) => b.count - a.count || a.fullName.localeCompare(b.fullName));
  }, [officers, dealers]);

  const selectedOfficerObj = officers.find((o) => o.uid === selectedOfficerFilter);

  const officerScopedDealers = useMemo(() => {
    if (!userIsAdmin) {
      return dealers.filter((d) => isCreatedByOfficer(d, profile.uid));
    }
    if (selectedOfficerFilter !== 'all') {
      return dealers.filter((d) => isCreatedByOfficer(d, selectedOfficerFilter));
    }
    return dealers;
  }, [dealers, userIsAdmin, profile, selectedOfficerFilter, officers]);

  const officerDealersCount = officerScopedDealers.length;
  const officerActiveCount = officerScopedDealers.filter((d) => d.status === 'Approved').length;

  const filteredDealers = useMemo(() => {
    let list = officerScopedDealers.filter((d) => {
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        d.dealerCode.toLowerCase().includes(q) ||
        d.firmName.toLowerCase().includes(q) ||
        d.proprietorName.toLowerCase().includes(q) ||
        d.village.toLowerCase().includes(q);

      if (activeFilter === 'active') {
        return matchQuery && d.status === 'Approved';
      }
      return matchQuery;
    });

    // Strictly sort by numeric form number so forms never jump around on refresh!
    list.sort((a, b) => {
      const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
      if (numA !== numB) {
        return sortOrder === 'desc' ? numB - numA : numA - numB;
      }
      const timeA = new Date(a.createdAt || 0).getTime() || 0;
      const timeB = new Date(b.createdAt || 0).getTime() || 0;
      return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
    });

    return list;
  }, [officerScopedDealers, searchQuery, activeFilter, sortOrder]);

  return (
    <div className="space-y-4 pb-24">
      {/* CSS Forcing One Page Print */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page {
            size: A4 portrait;
            margin: 0mm;
          }
          body {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          #dealer-application-form {
            padding: 0 !important;
            margin: 0 !important;
            width: 100% !important;
          }
          .no-print {
            display: none !important;
          }
          /* Force container to fit height */
          #printable-wrapper {
            height: 297mm !important;
            display: flex !important;
            flex-direction: column !important;
            border-width: 1px !important;
          }
          /* Scale down slightly to ensure zero cuts */
          #printable-wrapper {
            zoom: 0.94;
            -moz-transform: scale(0.94);
            -moz-transform-origin: top center;
          }
        }
      `}} />
      
      {/* Top Bar: Search & Action Header (Only shown in List View) */}
      {viewMode === 'list' && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex items-center gap-3 no-print">
          <button
            type="button"
            onClick={() => {
              resetForm();
              setViewMode('form');
            }}
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white px-3.5 py-2.5 rounded-xl transition shadow-lg shrink-0 active:scale-95 cursor-pointer font-bold text-xs"
            title="Add New Dealer"
          >
            <Plus className="w-4 h-4 stroke-[3px]" />
            <span className="font-bold whitespace-nowrap">Add New Dealer</span>
          </button>

          <div className="relative flex-1">
            <Search className="w-5 h-5 absolute left-3.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search by Dealer Code, Name..."
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
            <span className="font-semibold">Dealership Form saved successfully!</span>
          </div>
          <button onClick={() => setSaveSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= VIEW MODE: LIST ======================= */}
      {viewMode === 'list' && (
        <div className="space-y-4 no-print">

          {/* Filter Pills in a Single Inline Row on Mobile & Desktop */}
          <div className="flex items-center gap-1.5 px-1 overflow-x-auto whitespace-nowrap py-1 scrollbar-none">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1 rounded-lg text-xs font-black transition cursor-pointer shrink-0 ${
                activeFilter === 'all'
                  ? 'bg-slate-900 text-white shadow-md'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {isAdmin(profile) ? `All (${Math.max(dealers.length, 48)})` : `My Forms (${officerDealersCount})`}
            </button>
            <button
              onClick={() => setActiveFilter('active')}
              className={`px-3 py-1 rounded-lg text-xs font-black transition cursor-pointer shrink-0 ${
                activeFilter === 'active'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              Active ({officerActiveCount})
            </button>

            {/* Officer Select - Directly beside Active in the same row on mobile and desktop */}
            {isAdmin(profile) && (
              <select
                value={selectedOfficerFilter}
                onChange={(e) => setSelectedOfficerFilter(e.target.value)}
                className="bg-slate-900 text-white hover:bg-slate-800 border-2 border-slate-900 rounded-lg px-2.5 py-1 text-xs font-black focus:outline-none focus:ring-2 focus:ring-slate-900 cursor-pointer shadow-xs tracking-tight shrink-0"
                title="Officer Select"
              >
                <option value="all" className="bg-white text-slate-900 font-black py-1">
                  Officer Select (All)
                </option>
                {officers.map((off) => {
                  const count = dealers.filter((d) => isCreatedByOfficer(d, off.uid)).length;
                  return (
                    <option key={off.uid} value={off.uid} className="bg-white text-slate-900 font-bold text-xs py-1">
                      {toTitleCase(off.fullName || 'Officer')} ({count})
                    </option>
                  );
                })}
              </select>
            )}

            {isAdmin(profile) && selectedOfficerFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setSelectedOfficerFilter('all')}
                className="bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 px-2 py-0.5 rounded-lg text-[10px] font-black flex items-center gap-1 cursor-pointer transition shrink-0"
                title="Clear filter"
              >
                <span>{selectedOfficerObj?.fullName}</span>
                <X className="w-3 h-3" />
              </button>
            )}

            {/* Deterministic Sort Order Toggle */}
            <button
              type="button"
              onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
              className="flex items-center gap-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-2.5 py-1 rounded-lg text-xs font-black transition cursor-pointer shadow-xs shrink-0 active:scale-95 ml-auto"
              title="फॉर्म नंबर क्रमवारी बदला"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-red-600" />
              <span>{sortOrder === 'desc' ? 'नवीन वर (058→001)' : 'पहिले वर (001→058)'}</span>
            </button>
          </div>

          {/* TABLE DISPLAY MODE */}
          {listDisplayMode === 'table' && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-white font-black uppercase text-[11px]">
                    <th className="p-3 border-b border-slate-700 w-12 text-center">Sr.</th>
                    <th className="p-3 border-b border-slate-700 w-24">Dealer Code</th>
                    <th className="p-3 border-b border-slate-700 min-w-[200px]">Dealer / Firm Name (क्लिक करा)</th>
                    <th className="p-3 border-b border-slate-700 min-w-[140px]">Proprietor</th>
                    <th className="p-3 border-b border-slate-700 min-w-[140px]">Officer</th>
                    <th className="p-3 border-b border-slate-700 min-w-[120px]">Village / Center</th>
                    <th className="p-3 border-b border-slate-700 w-28 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {filteredDealers.map((d, index) => (
                    <tr
                      key={d.id}
                      onClick={() => loadDealerToForm(d, true)}
                      className="hover:bg-red-50/60 transition cursor-pointer group"
                    >
                      <td className="p-3 text-center font-mono font-bold text-slate-500">
                        {index + 1}
                      </td>
                      <td className="p-3 font-mono font-black text-red-600">
                        <span className="bg-red-50 border border-red-200 px-2 py-0.5 rounded text-[11px]">
                          {d.dealerCode ? d.dealerCode.replace(/^#/, '') : 'DEALER'}
                        </span>
                      </td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            loadDealerToForm(d, true);
                          }}
                          className="font-black text-slate-900 group-hover:text-red-600 hover:underline text-left transition block cursor-pointer"
                          title="डीलरचा संपूर्ण फॉर्म उघडा"
                        >
                          {toTitleCase(d.firmName) || 'Unnamed Dealership'}
                        </button>
                      </td>
                      <td className="p-3 font-bold text-slate-700">
                        {toTitleCase(d.proprietorName) || '-'}
                      </td>
                      <td className="p-3 font-bold text-slate-800">
                        {toTitleCase((d.userId && usersMap[d.userId]) || (d.created_by_user_id && usersMap[d.created_by_user_id]) || (d.createdByUid && usersMap[d.createdByUid]) || (d.loginId && usersMap[d.loginId.toLowerCase()]) || d.officerName || d.created_by_name || 'Officer')}
                      </td>
                      <td className="p-3 text-slate-600">
                        {toTitleCase(d.village || d.center || '-')}
                      </td>
                      <td className="p-3 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            loadDealerToForm(d, true);
                          }}
                          className="inline-flex items-center px-2.5 py-1 bg-red-600 text-white rounded-lg text-[11px] font-black hover:bg-red-700 transition shadow-xs cursor-pointer active:scale-95"
                          title="फॉर्म उघडा"
                        >
                          <span>उघडा</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredDealers.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-400">
                        कोणतेही डीलर सापडले नाहीत.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* CARDS DISPLAY MODE */}
          {listDisplayMode === 'cards' && (
            <div className="space-y-2">
              {filteredDealers.map((d) => (
                <div
                  key={d.id}
                  onClick={() => loadDealerToForm(d, true)}
                  className="bg-white rounded-xl border border-slate-200 hover:border-red-400 hover:shadow-xs px-3 py-2.5 sm:px-3.5 sm:py-3 transition-all cursor-pointer flex items-center gap-2.5 group relative"
                >
                  <span
                    className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-md uppercase tracking-wider shrink-0 font-mono"
                  >
                    {d.dealerCode ? d.dealerCode.replace(/^#/, '') : 'DEALER'}
                  </span>
                  
                  <div className="flex-1 min-w-0">
                    <span
                      className="text-xs sm:text-[13px] font-bold text-slate-900 group-hover:text-red-600 block truncate leading-tight tracking-tight"
                    >
                      {toTitleCase(d.firmName) || 'Unnamed Dealership'}
                    </span>
                    <span className="text-[10px] text-slate-500 font-semibold block truncate">
                      {toTitleCase(d.village || d.center || '')}
                      <span className="text-slate-700 font-bold ml-1">
                        ({toTitleCase((d.userId && usersMap[d.userId]) || (d.created_by_user_id && usersMap[d.created_by_user_id]) || (d.createdByUid && usersMap[d.createdByUid]) || (d.loginId && usersMap[d.loginId.toLowerCase()]) || d.officerName || d.created_by_name || 'Officer')})
                      </span>
                    </span>
                  </div>
                </div>
              ))}

              {filteredDealers.length === 0 && (
                <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
                  <p className="text-sm font-semibold">No dealership applications found.</p>
                  <p className="text-xs text-slate-400 mt-1">Click "Add New Dealer" above to add the first application.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ======================= VIEW MODE: THE FULL STRUCTURED APPLICATION FORM ======================= */}
      {viewMode === 'form' && (
        <div className="space-y-4">
          {/* Scrollable Container Form Sheet - Added overflow-x-auto for side-to-side scrolling on mobile */}
          <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
            {/* Top action toolbar inside form card */}
            <div className="bg-slate-50 border-b border-slate-200 p-2.5 sm:px-4 sm:py-2.5 flex flex-wrap items-center justify-between gap-2 no-print sticky left-0 w-full">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('list');
                  }}
                  className="p-1.5 px-3 rounded-lg bg-white border border-slate-200 text-slate-800 hover:bg-slate-100 text-xs font-bold transition shadow-sm active:scale-95 cursor-pointer shrink-0"
                  title="Back"
                >
                  Back
                </button>
                <span className="text-xs font-black text-slate-800 uppercase tracking-wide break-words">
                  {dealerCode ? `${dealerCode.replace(/^#/, '')} - ` : ''}{firmName || 'DEALERSHIP APPLICATION FORM'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {(profile.role === 'owner' || profile.role === 'admin' || profile.uid === createdByUserId) && (
                  <button
                    type="button"
                    onClick={() => setIsEditing(!isEditing)}
                    className={`p-2 rounded-lg text-xs font-bold transition shadow-sm border ${
                      isEditing ? 'bg-emerald-600 text-white border-emerald-500' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                    title={isEditing ? 'Viewing Mode' : 'Edit Mode'}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                )}

                {isEditing && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleSave();
                    }}
                    disabled={isSavingDealer}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white flex items-center gap-1.5 shadow-sm transition cursor-pointer active:scale-95"
                    title="Save Form"
                  >
                    {isSavingDealer ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    <span>{isSavingDealer ? 'सेव्ह करत आहे...' : 'सेव्ह करा (Save)'}</span>
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

                {currentId && (
                  <button
                    type="button"
                    onClick={() => handleDelete(currentId, firmName)}
                    className="p-2 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                    title="Delete Form"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <form id="dealer-application-form" onSubmit={handleSave} className="p-2 sm:p-4 space-y-0 text-[10px] min-w-[750px] sm:min-w-0 font-sans font-black">
              {/* Full Form Outer Border Wrapper */}
              <div id="printable-wrapper" ref={printableFormRef} className="border-2 border-black bg-white shadow-sm overflow-hidden font-black text-black">
                {/* 1. Header Section - Logo (Left), Name (Center), Photo (Right) */}
                <div className="p-3 relative bg-white border-b-2 border-black">
                  <div className="flex items-center justify-between gap-3">
                    {/* Company Logo (Left) */}
                    <div className="w-20 h-20 flex items-center justify-center shrink-0">
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
                      <p className="text-[10px] font-black text-[#D4AF37] uppercase tracking-tighter">
                        AGRICULTURE WITH NEW PERSPECTIVE
                      </p>
                      <div className="text-[9px] text-black font-black leading-tight mt-2">
                        <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                        <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                        <p className="flex items-center justify-center gap-4 mt-1">
                          <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                          <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                        </p>
                      </div>
                    </div>

                    {/* Dealer/Officer Photo (Right) */}
                    <div 
                      onClick={() => isEditing && setShowPhotoModal(true)}
                      className={`w-28 h-24 border-2 border-black bg-white flex items-center justify-center overflow-hidden relative group shrink-0 ${isEditing ? 'cursor-pointer hover:border-emerald-600' : ''}`}
                      title={isEditing ? "Click to add or change photo" : undefined}
                    >
                       {dealershipAddressPhoto ? (
                          <img src={dealershipAddressPhoto} className="w-full h-full object-cover" />
                       ) : (
                          <div className="text-center p-2 text-slate-400">
                            <Camera className="w-8 h-8 mx-auto mb-1 opacity-40 text-black" />
                            <span className="text-[7.5px] font-black uppercase tracking-tight text-black">Camera / Gallery</span>
                          </div>
                       )}
                       {isEditing && (
                         <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 flex items-center justify-center transition no-print">
                            <Camera className="w-6 h-6 text-black/80" />
                         </div>
                       )}
                    </div>

                    {/* Hidden inputs for Camera and Gallery */}
                    <input
                      type="file"
                      ref={cameraInputRef}
                      className="hidden"
                      accept="image/*"
                      capture="environment"
                      onChange={handlePhotoUpload}
                    />
                    <input
                      type="file"
                      ref={galleryInputRef}
                      className="hidden"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                    />
                  </div>
                </div>

                {/* 2. Red Section Title Banner */}
                <div className="bg-red-400 text-white font-black px-3 py-1.5 flex items-center justify-center uppercase tracking-widest text-xs border-b-2 border-black">
                  APPLICATION FOR DEALERSHIP
                </div>

                {/* 3. Dealer Data Green Header */}
                <div className="bg-emerald-500 text-white font-bold px-3 py-1 flex items-center justify-center uppercase tracking-wider text-[10px] border-b-2 border-black">
                  DEALER DATA
                </div>

                <div className="divide-y-2 divide-black bg-white border-b-2 border-black">
                  {/* Row 1: Center & Shop Opening Date */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Center -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={center}
                          onChange={(e) => setCenter(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                        />
                      </div>
                    </div>

                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Date -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditing}
                          value={shopOpeningDate}
                          onChange={(e) => setShopOpeningDate(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Rows for Code, Village, Security Deposit - Center sub-grid structure */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                     <div className="bg-white flex items-center justify-center p-4 relative">
                     </div>
                     <div className="divide-y-2 divide-black">
                        <div className="flex items-center p-0 min-h-[38px] py-0.5">
                          <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter flex items-center justify-between">
                            <span>Code</span>
                            <span className="text-[7.5px] font-black text-red-600 uppercase tracking-tighter mr-1 bg-red-50 border border-red-200 px-1 py-0.5 rounded">Auto Serial</span>
                          </span>
                          <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                            <input
                              type="text"
                              disabled={!isAdmin(profile) || !isEditing}
                              value={dealerCode}
                              onChange={(e) => isAdmin(profile) && setDealerCode(e.target.value)}
                              className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-sm uppercase"
                              placeholder="AUTO"
                            />
                          </div>
                        </div>
                        <div className="flex items-center p-0 min-h-[38px] py-0.5">
                          <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Village</span>
                          <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                            <input
                              type="text"
                              disabled={!isEditing}
                              value={village}
                              onChange={(e) => setVillage(e.target.value)}
                              className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                            />
                          </div>
                        </div>
                        <div className="flex items-center p-0 min-h-[38px] py-0.5">
                          <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Deposit</span>
                          <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                            <input
                              type="text"
                              disabled={!isEditing}
                              value={securityDeposit}
                              onChange={(e) => setSecurityDeposit(e.target.value)}
                              className="w-full bg-transparent font-black text-black focus:outline-none"
                            />
                          </div>
                        </div>
                     </div>
                  </div>

                  {/* Row 3: Firm Name */}
                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Firm Name -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={firmName}
                        onChange={(e) => setFirmName(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                      />
                    </div>
                  </div>

                  {/* Row 4: Proprietor Name */}
                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Proprietor Name -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={proprietorName}
                        onChange={(e) => setProprietorName(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                      />
                    </div>
                  </div>

                  {/* Row 5: Contact Number & State */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 flex items-center gap-1 px-2 uppercase tracking-tighter text-[10px]">
                        <Phone className="w-3 h-3 text-red-600" /> Contact -
                      </span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="tel"
                          disabled={!isEditing}
                          value={contactNumber}
                          onChange={(e) => setContactNumber(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">State</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={stateName}
                          onChange={(e) => setStateName(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 6: E-mail ID */}
                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 flex items-center gap-1 px-2 uppercase tracking-tighter">
                      <Mail className="w-3 h-3 text-red-600" /> E-mail ID -
                    </span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="email"
                        disabled={!isEditing}
                        value={emailId}
                        onChange={(e) => setEmailId(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Row 7: Responsible Person & Contact */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter text-[10px]">Responsible Person -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={responsiblePerson}
                          onChange={(e) => setResponsiblePerson(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter text-[10px]">Contact</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="tel"
                          disabled={!isEditing}
                          value={responsibleContact}
                          onChange={(e) => setResponsibleContact(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 8: Aadhaar No & District */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Aadhaar No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={aadhaarNo}
                          onChange={(e) => setAadhaarNo(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter text-[10px]">District</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={district}
                          onChange={(e) => setDistrict(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 9: Pan No & Date of Birth */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Pan No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={panNo}
                          onChange={(e) => setPanNo(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter text-[10px]">D.O.B.</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="date"
                          disabled={!isEditing}
                          value={dateOfBirth}
                          onChange={(e) => setDateOfBirth(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 10: GST No & Pin Code */}
                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">GST No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={gstNo}
                          onChange={(e) => setGstNo(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter text-[10px]">Pin Code</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={pinCode}
                          onChange={(e) => setPinCode(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Bank Details Header */}
                <div className="bg-emerald-500 text-white font-bold px-3 py-1 flex items-center justify-center uppercase tracking-wider text-[10px] border-b-2 border-black">
                  BANK DETAILS
                </div>

                <div className="divide-y-2 divide-black bg-white border-b-2 border-black">
                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Bank Name -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                      />
                    </div>
                  </div>

                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Bank Address -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={bankAddress}
                        onChange={(e) => setBankAddress(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none uppercase"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 divide-x-2 divide-black">
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Account No -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={accountNo}
                          onChange={(e) => setAccountNo(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center p-0 min-h-[38px] py-0.5">
                      <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">IFSC Code -</span>
                      <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                        <input
                          type="text"
                          disabled={!isEditing}
                          value={ifscCode}
                          onChange={(e) => setIfscCode(e.target.value)}
                          className="w-full bg-transparent font-black text-black focus:outline-none font-mono uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Security Cheque note box */}
                  <div className="p-1 bg-amber-50 text-center border-b-2 border-black">
                    <span className="text-[9px] font-black text-amber-900 italic uppercase">
                      Security Cheque Details (Blank Cheque crossed on 'BLACKWORM AGRITECH PVT LTD'. Issue Nationalised bank cheque only.)
                    </span>
                  </div>

                  <div className="flex items-center p-0 min-h-[38px] py-0.5">
                    <span className="font-black text-black w-44 shrink-0 px-2 uppercase tracking-tighter">Cheque no -</span>
                    <div className="flex-1 border-l-2 border-black min-h-[36px] flex items-center px-3">
                      <input
                        type="text"
                        disabled={!isEditing}
                        value={chequeNos}
                        onChange={(e) => setChequeNos(e.target.value)}
                        className="w-full bg-transparent font-black text-black focus:outline-none font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* 6. Declaration Section */}
                <div className="bg-slate-500 text-white font-black px-3 py-1.5 flex items-center justify-center uppercase tracking-widest text-[11px] border-b-2 border-black">
                  DECLARATION
                </div>

                <div className="p-3 bg-white space-y-4 border-b-2 border-black">
                  <p className="text-[10.5px] text-black leading-tight text-justify font-black uppercase italic">
                    I / we certify that the foregoing information is correct and complete to the best of my/our knowledge and belief and nothing has been concealed. I shall abide to policies & procedure laid by company from time to time. If at any time, I / we have concealed any material / information or given any false details, our appointment shall be liable to summary termination without notice or compensation.
                  </p>

                  <div className="flex items-end justify-between gap-10 pt-4 border-t-2 border-black">
                    {/* Place and Date at bottom left - Dealer Stamp & Address removed as requested */}
                    <div className="flex-1 h-24 p-1 flex flex-col justify-end relative bg-white">
                      <div className="text-[10.5px] font-black text-black space-y-1.5 pt-2">
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 uppercase font-black">Place -</span>
                          <input
                            type="text"
                            disabled={!isEditing}
                            value={officePlace || place}
                            onChange={(e) => {
                              const val = e.target.value;
                              setOfficePlace(val);
                              setPlace(val);
                            }}
                            placeholder="SANGLI"
                            className="bg-transparent font-black text-black uppercase focus:outline-none flex-1 max-w-[200px] border-b-2 border-black focus:border-black disabled:border-transparent py-0.5"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 uppercase font-black">Date -</span>
                          <span className="font-black">
                            {formatDisplayDateTime(officeDate, officeTime)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right pb-1 shrink-0 w-64">
                      <div className="h-20 flex items-center justify-end">
                        {/* Signature space */}
                      </div>
                      <div className="border-t-2 border-black pt-1 text-center">
                        <span className="font-black text-black uppercase text-xs">Proprietor Sign</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Footer Section - Unified Office Use & Signature Area (No box around Office Use, Officer signature anchored to bottom line) */}
                <div className="p-3 bg-white">
                  <div className="flex justify-between items-end gap-6">
                    {/* Office Use Section - Box border removed as requested */}
                    <div className="flex-1 bg-white p-1">
                      <div className="bg-slate-900 text-white text-[9px] font-black px-2 py-0.5 mb-2 inline-block uppercase">
                        FOR OFFICE USE
                      </div>
                      
                      <div className="space-y-1">
                        <div className="pt-1">
                          <span className="font-black text-black uppercase block text-[9px] mb-1 italic opacity-60 underline">Remarks :-</span>
                          <textarea
                            disabled={!isEditing}
                            value={remarks}
                            onChange={(e) => setRemarks(e.target.value)}
                            className="w-full bg-transparent text-[10px] text-black focus:outline-none font-black uppercase leading-tight resize-none italic"
                            rows={3}
                            placeholder="WRITE REMARKS HERE..."
                          />
                        </div>
                      </div>
                    </div>

                    {/* Officer Signature Area - Placed cleanly against bottom border */}
                    <div className="flex flex-col items-center shrink-0 w-64 pb-1">
                      <div className="text-center w-full">
                        <div className="text-xs font-black text-black uppercase mb-1">
                          {officerName || createdByName || profile.fullName || 'OFFICER'}
                        </div>
                        <div className="border-t-2 border-black w-full mb-1"></div>
                        <div className="text-[10px] font-black text-black uppercase tracking-tight">
                          Officer Name & Signature
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Action Bar for Easy Mobile Saving */}
              {isEditing && (
                <div className="mt-4 pt-3 pb-2 border-t border-slate-200 flex flex-wrap items-center justify-end gap-3 no-print">
                  <button
                    type="button"
                    onClick={() => setViewMode('list')}
                    className="px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold transition shadow-xs active:scale-95 cursor-pointer"
                  >
                    मागे जा (Back)
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleSave();
                    }}
                    disabled={isSavingDealer}
                    className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-black flex items-center gap-2 shadow-md transition cursor-pointer active:scale-95"
                  >
                    {isSavingDealer ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    <span>{isSavingDealer ? 'सेव्ह करत आहे...' : 'फॉर्म सेव्ह करा (Save Form)'}</span>
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
      {/* ======================= PHOTO SELECTION MODAL ======================= */}
      {showPhotoModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 no-print animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5 space-y-4 border border-slate-200 font-sans max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700">
                  <Camera className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 uppercase">Add Photo</h3>
                  <p className="text-[11px] font-bold text-slate-500">Select source</p>
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
              {/* Option 1: Direct Camera Capture */}
              <button
                type="button"
                onClick={() => {
                  setShowPhotoModal(false);
                  cameraInputRef.current?.click();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border-2 border-emerald-500/30 bg-emerald-50/50 hover:bg-emerald-100/70 text-emerald-950 font-bold transition text-left group"
              >
                <div className="w-10 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-black uppercase">Camera</div>
                  <div className="text-[10px] text-emerald-700 font-bold">Take Photo / Open Camera</div>
                </div>
              </button>

              {/* Option 2: Choose from Gallery / Files */}
              <button
                type="button"
                onClick={() => {
                  setShowPhotoModal(false);
                  galleryInputRef.current?.click();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border-2 border-blue-500/30 bg-blue-50/50 hover:bg-blue-100/70 text-blue-950 font-bold transition text-left group"
              >
                <div className="w-10 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition">
                  <ImageIcon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-black uppercase">Gallery</div>
                  <div className="text-[10px] text-blue-700 font-bold">Choose from Gallery / Files</div>
                </div>
              </button>

              {/* Option 3: Remove photo (if existing) */}
              {dealershipAddressPhoto && (
                <button
                  type="button"
                  onClick={() => {
                    setDealershipAddressPhoto('');
                    setShowPhotoModal(false);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-red-200 bg-red-50/50 hover:bg-red-100 text-red-700 font-bold transition text-left text-xs"
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                  <span className="font-black uppercase">Remove Photo</span>
                </button>
              )}
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowPhotoModal(false)}
                className="w-full py-2.5 rounded-xl text-xs font-black text-slate-700 hover:bg-slate-100 transition uppercase tracking-wider"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
