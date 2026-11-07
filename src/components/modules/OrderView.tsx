import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  collection, 
  query, 
  where,
  orderBy,
  limit,
  onSnapshot, 
  doc, 
  getDocs,
  updateDoc,
  deleteDoc,
  startAfter
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { softDeleteRecord, logAudit, safeFirestoreSet, mergeWithLocalData, deduplicateOrders, deduplicateDealers, deduplicateProducts } from '../../lib/dataService';
import { Language } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { cn, toTitleCase, openExternalLinkSafely } from '../../lib/utils';
import { OFFICIAL_REFERENCE_DATA, DynamicPriceProduct, calculateWithGst } from './PriceListView';
import { getStandardBillingDiscount } from './SchemeView';
import html2canvas from 'html2canvas-pro';
import { 
  ShoppingBag, 
  Plus, 
  Search, 
  Trash2, 
  X, 
  CheckCircle2, 
  Clock, 
  Truck, 
  PackageCheck, 
  Share2, 
  MapPin, 
  User, 
  Check, 
  Eye, 
  Building2,
  Sparkles,
  Camera,
  Loader2,
  Copy,
  AlertCircle,
  Edit3,
  Lock,
  Sprout,
  ChevronDown
} from 'lucide-react';

export const COMMON_CROPS = [
  { id: 'grapes', name: 'द्राक्षे (Grapes)', icon: '🍇' },
  { id: 'sugarcane', name: 'ऊस (Sugarcane)', icon: '🎋' },
  { id: 'pomegranate', name: 'डाळिंब (Pomegranate)', icon: '🍎' },
  { id: 'tomato', name: 'टोमॅटो (Tomato)', icon: '🍅' },
  { id: 'onion', name: 'कांदा (Onion)', icon: '🧅' },
  { id: 'soybean', name: 'सोयाबीन (Soybean)', icon: '🌿' },
  { id: 'cotton', name: 'कापूस (Cotton)', icon: '☁️' },
  { id: 'banana', name: 'केळी (Banana)', icon: '🍌' },
  { id: 'chilli', name: 'मिरची (Chilli)', icon: '🌶️' },
  { id: 'ginger_turmeric', name: 'आले / हळद (Ginger/Turmeric)', icon: '🫚' },
  { id: 'vegetables', name: 'भाजीपाला (Vegetables)', icon: '🥦' },
  { id: 'all_crops', name: 'सर्व पिके (General / All Crops)', icon: '🌾' },
];

export const getCleanGradeName = (prod?: { 
  groupName?: string; 
  brandName?: string; 
  gradeName?: string; 
  productName?: string; 
} | null): string => {
  if (!prod) return '';

  const g = (prod.groupName || '').toLowerCase().trim();
  const brand = (prod.brandName || '').trim();
  const grade = (prod.gradeName || '').trim();
  const name = (prod.productName || '').trim();

  // Identify Group B and Group C products (or known Group B/C commercial names)
  const isGroupB = g.includes('group b') || g.includes('micronutrient') || g.includes('micro');
  const isGroupC = g.includes('group c') || g.includes('growth regulator') || g.includes('pgr') || g.includes('stimulant');
  const isKnownBCName = 
    /microgrip/i.test(brand) || 
    /bw\s*combi/i.test(brand) || 
    /nutrijet/i.test(brand) ||
    /microgrip/i.test(grade) || 
    /bw\s*combi/i.test(grade) || 
    /nutrijet/i.test(grade) ||
    /microgrip/i.test(name) || 
    /bw\s*combi/i.test(name) || 
    /nutrijet/i.test(name);

  // RULE 3: ONLY FOR B GROUP AND C GROUP:
  if (isGroupB || isGroupC || isKnownBCName) {
    // Return only the colored product name (e.g. Microgrip®, Microgrip DF®, BW Combi®, Nutrijet)
    // Do NOT include the following blue Grade/Description or extra information!
    if (/microgrip\s*df/i.test(brand) || /microgrip\s*df/i.test(grade) || /microgrip\s*df/i.test(name)) {
      return 'Microgrip DF®';
    }
    if (/microgrip/i.test(brand) || /microgrip/i.test(grade) || /microgrip/i.test(name)) {
      return 'Microgrip®';
    }
    if (/bw\s*combi/i.test(brand) || /bw\s*combi/i.test(grade) || /bw\s*combi/i.test(name)) {
      return 'BW Combi®';
    }
    if (/nutrijet/i.test(brand) || /nutrijet/i.test(grade) || /nutrijet/i.test(name)) {
      return 'Nutrijet';
    }

    if (brand && !/^Airawat[®\s-]*$/i.test(brand) && !/^Blackworm[\s-]*$/i.test(brand)) {
      return brand;
    }
    if (brand) {
      return brand;
    }
  }

  // RULE 4: FOR GROUP A AND SPECIALITY GRADE: NO CHANGE!
  let raw = (grade || name || '').trim();
  if (!raw) return (brand || '').trim();

  if (brand && raw.toLowerCase().startsWith(brand.toLowerCase())) {
    raw = raw.slice(brand.length).trim();
  }

  raw = raw.replace(/^Airawat[®\s-]*/i, '').trim();
  raw = raw.replace(/^Blackworm[\s-]*/i, '').trim();

  return raw || (grade || name || brand || '').trim();
};

export interface OrderProductLine {
  productId: string;
  productName: string;
  brandName?: string;
  gradeName?: string;
  groupName?: string;
  packingSize: string;
  rate: number;
  quantity: number;
  discount?: number;
  discountPercent?: number;
  subtotal: number;
}

export interface OrderItem {
  id: string;
  orderNumber: string;
  cropName?: string;
  dealerId?: string;
  dealerName: string;
  dealerCode?: string;
  dealerContact?: string;
  dealerVillage?: string;
  dealerDistrict?: string;
  farmerName?: string;
  items: OrderProductLine[];
  totalQuantity: number;
  grossAmount?: number;
  discountAmount?: number;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentMode: string;
  status: 'pending' | 'pending_approval' | 'confirmed' | 'dispatched' | 'delivered' | 'collected' | 'complete' | 'approved';
  approvedBy?: string;
  approvedAt?: string;
  dispatchedAt?: string;
  dispatchNote?: string;
  deliveredAt?: string;
  ownerId: string;
  userId?: string;
  loginId?: string;
  userCode?: string;
  createdByName: string;
  createdAt: string;
  updatedAt?: string;
  updatedByName?: string;
  isArchived?: boolean;
}

export interface SavedDealer {
  id: string;
  firmName: string;
  proprietorName: string;
  contactNumber: string;
  dealerCode: string;
  village: string;
  district: string;
  created_by_user_id?: string;
  created_by_name?: string;
  createdByUid?: string;
  userId?: string;
  ownerId?: string;
  loginId?: string;
  userCode?: string;
  officerName?: string;
  assignedOfficerUid?: string;
}

export const isDealerRegisteredByOfficer = (
  d: SavedDealer | any,
  officer: { uid?: string; fullName?: string; loginId?: string; userCode?: string }
): boolean => {
  if (!d || !officer) return false;
  const offUid = (officer.uid || '').toLowerCase().trim();
  const offName = (officer.fullName || '').toUpperCase().trim();
  const offLogin = (officer.loginId || '').toLowerCase().trim();
  const offCode = (officer.userCode || '').toLowerCase().trim();

  // 1. Direct creator / user UID match or assigned officer UID
  const creatorId = (d.created_by_user_id || d.createdByUid || d.userId || d.ownerId || d.assignedOfficerUid || '').toString().toLowerCase().trim();
  if (offUid && creatorId && (creatorId === offUid || creatorId.includes(offUid))) return true;

  // 2. Full name match
  const dOfficer = (d.officerName || d.created_by_name || '').toString().toUpperCase().trim();
  if (offName && dOfficer && (dOfficer === offName || dOfficer.includes(offName) || offName.includes(dOfficer))) return true;

  // 3. Login ID match
  const dLogin = (d.loginId || '').toString().toLowerCase().trim();
  if (offLogin && dLogin && dLogin !== 'admin' && (dLogin === offLogin || dLogin.includes(offLogin))) return true;

  // 4. User Code match
  const dCode = (d.userCode || '').toString().toLowerCase().trim();
  if (offCode && dCode && (dCode === offCode || dCode.includes(offCode))) return true;

  return false;
};

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const OrderView: React.FC<Props> = ({ profile }) => {
  const [orders, setOrders] = useState<OrderItem[]>(() => {
    try {
      const cached = mergeWithLocalData('orders', []);
      if (cached && cached.length > 0) return cached as any;
    } catch {}
    return [];
  });
  const [dealers, setDealers] = useState<SavedDealer[]>(() => {
    try {
      const rawLocal = localStorage.getItem('blackworm_local_dealers_application');
      if (rawLocal) {
        const parsed = JSON.parse(rawLocal);
        const list = Object.values(parsed).filter((d: any) => !d.isArchived);
        if (list.length > 0) return list as any;
      }
      const cached = localStorage.getItem('blackworm_all_dealers');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  });
  const [officers, setOfficers] = useState<{ uid: string; fullName: string; loginId?: string; userCode?: string }[]>(() => {
    try {
      const cached = localStorage.getItem('blackworm_cached_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        return parsed.filter((u: any) => u.role !== 'dealer' && u.role !== 'owner');
      }
    } catch {}
    return [];
  });
  const [selectedOfficerFilter, setSelectedOfficerFilter] = useState<string>('all');
  const [products, setProducts] = useState<DynamicPriceProduct[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('blackworm_cached_pricelist');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
        const masterRaw = localStorage.getItem('blackworm_master_pricelist');
        if (masterRaw) {
          const parsed = JSON.parse(masterRaw);
          if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) {
            return parsed.products;
          }
        }
      } catch {}
    }
    return OFFICIAL_REFERENCE_DATA.map((p, idx) => ({ ...p, id: (p as any).id || `prod_ref_${idx + 1}` }));
  });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');

  // Pagination states for Orders
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const PAGE_SIZE = 20;
  
  // Modals state
  const [showNewOrderModal, setShowNewOrderModal] = useState(false);
  const [selectedOrderDetails, setSelectedOrderDetails] = useState<OrderItem | null>(null);
  const [successOrder, setSuccessOrder] = useState<OrderItem | null>(null);

  // Photo generation state
  const [capturingOrder, setCapturingOrder] = useState<OrderItem | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const receiptCaptureRef = useRef<HTMLDivElement>(null);

  // New Order Form State
  const [selectedDealer, setSelectedDealer] = useState<SavedDealer | null>(null);
  const [dealerSearchQuery, setDealerSearchQuery] = useState('');
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);

  // Line Item Entry State
  const [selectedProduct, setSelectedProduct] = useState<DynamicPriceProduct | null>(null);
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [selectedPacking, setSelectedPacking] = useState<string>('');
  const [itemRate, setItemRate] = useState<number | string>(0);
  const [itemQuantity, setItemQuantity] = useState<number | string>(1);
  const [itemDiscount, setItemDiscount] = useState<number | string>('');
  const [discountType, setDiscountType] = useState<'percent' | 'flat'>('percent');
  const [orderDiscount, setOrderDiscount] = useState<number | string>('');
  const [orderItems, setOrderItems] = useState<OrderProductLine[]>([]);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [productCategoryFilter, setProductCategoryFilter] = useState('all');
  const [formError, setFormError] = useState<string | null>(null);

  const resetNewOrderForm = () => {
    setSelectedDealer(null);
    setDealerSearchQuery('');
    setSelectedProduct(null);
    setProductSearchQuery('');
    setSelectedPacking('');
    setItemRate(0);
    setItemQuantity(1);
    setItemDiscount('');
    setOrderDiscount('');
    setOrderItems([]);
    setEditingOrderId(null);
    setFormError(null);
  };

  const handleOpenEditOrder = (order: OrderItem) => {
    const isPending = order.status === 'pending_approval' || order.status === 'pending';
    const canEdit = isPending 
      ? (order.userId === profile.uid || isUserRecord(order, profile) || isAdmin(profile)) 
      : isAdmin(profile);

    if (!canEdit) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'संपादन मर्यादा',
        message: 'मंजूर झालेली ऑर्डर फक्त Admin एडिट करू शकतात. (Approved orders can only be edited by Admin).',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setEditingOrderId(order.id);
    const foundDealer = dealers.find((d) => d.id === order.dealerId) || {
      id: order.dealerId || 'dealer_custom',
      firmName: order.dealerName,
      proprietorName: order.farmerName || '',
      contactNumber: order.dealerContact || '',
      dealerCode: order.dealerCode || '',
      village: order.dealerVillage || '',
      district: order.dealerDistrict || '',
    };
    setSelectedDealer(foundDealer);

    setOrderItems(order.items || []);
    setOrderDiscount(order.discountAmount ? String(order.discountAmount) : '');
    setSelectedProduct(null);
    setProductSearchQuery('');
    setFormError(null);
    setShowNewOrderModal(true);
  };

  // Mobile back button integration for modals
  useEffect(() => {
    if (showNewOrderModal || selectedOrderDetails || successOrder) {
      window.history.pushState({ tab: 'order', orderModalOpen: true }, '');
      const handlePopState = () => {
        setShowNewOrderModal(false);
        setSelectedOrderDetails(null);
        setSuccessOrder(null);
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [showNewOrderModal, selectedOrderDetails, successOrder]);

  const loadOrders = async (isLoadMore = false) => {
    if (isLoadingMore || (isLoadMore && !hasMore)) return;
    setIsLoadingMore(true);

    try {
      let q = query(
        collection(db, 'orders'),
        orderBy('createdAt', 'desc'),
        limit(PAGE_SIZE)
      );

      if (!isAdmin(profile)) {
        q = query(
          collection(db, 'orders'),
          where('userId', '==', profile.uid),
          orderBy('createdAt', 'desc'),
          limit(PAGE_SIZE)
        );
      }

      if (isLoadMore && lastDoc) {
        if (!isAdmin(profile)) {
          q = query(
            collection(db, 'orders'),
            where('userId', '==', profile.uid),
            orderBy('createdAt', 'desc'),
            startAfter(lastDoc),
            limit(PAGE_SIZE)
          );
        } else {
          q = query(
            collection(db, 'orders'),
            orderBy('createdAt', 'desc'),
            startAfter(lastDoc),
            limit(PAGE_SIZE)
          );
        }
      }

      const snap = await getDocs(q);
      const list: OrderItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        if (!data.isArchived) {
          const cleanedItems = (data.items || []).map((it: any) => {
            const cleanName = getCleanGradeName(it);
            return {
              ...it,
              productName: cleanName,
              gradeName: cleanName,
            };
          });

          list.push({
            id: d.id,
            orderNumber: data.orderNumber || `BW-${d.id.slice(-6)}`,
            cropName: data.cropName || '',
            dealerId: data.dealerId || '',
            dealerName: data.dealerName || 'General Dealer',
            dealerCode: data.dealerCode || '',
            dealerContact: data.dealerContact || '',
            dealerVillage: data.dealerVillage || '',
            dealerDistrict: data.dealerDistrict || '',
            farmerName: data.farmerName || '',
            items: cleanedItems,
            totalQuantity: data.totalQuantity || (data.items?.reduce((a: number, b: any) => a + (b.quantity || 0), 0) || 0),
            grossAmount: Number(data.grossAmount) || 0,
            discountAmount: Number(data.discountAmount) || 0,
            totalAmount: Number(data.totalAmount) || 0,
            paidAmount: Number(data.paidAmount) || 0,
            balanceAmount: Number(data.balanceAmount ?? data.totalAmount) || 0,
            paymentMode: data.paymentMode || 'Credit',
            status: data.status || 'pending_approval',
            approvedBy: data.approvedBy,
            approvedAt: data.approvedAt,
            dispatchedAt: data.dispatchedAt,
            dispatchNote: data.dispatchNote,
            deliveredAt: data.deliveredAt,
            ownerId: data.ownerId || '',
            userId: data.userId,
            loginId: data.loginId,
            userCode: data.userCode,
            createdByName: data.createdByName || 'User',
            createdAt: data.createdAt || new Date().toISOString(),
            isArchived: data.isArchived || false,
          });
        }
      });

      const merged = mergeWithLocalData('orders', list);
      
      if (isLoadMore) {
        setOrders(prev => deduplicateOrders([...prev, ...merged]));
      } else {
        setOrders(deduplicateOrders(merged));
      }

      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (error) {
      console.warn("Orders fetch error:", error);
      if (!isLoadMore) {
        const cached = mergeWithLocalData('orders', []);
        setOrders(deduplicateOrders(cached));
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const q = query(
      collection(db, 'orders'),
      limit(500)
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: OrderItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        if (!data.isArchived) {
          const cleanedItems = (data.items || []).map((it: any) => {
            const cleanName = getCleanGradeName(it);
            return {
              ...it,
              productName: cleanName,
              gradeName: cleanName,
            };
          });

          list.push({
            id: d.id,
            orderNumber: data.orderNumber || `BW-${d.id.slice(-6)}`,
            cropName: data.cropName || '',
            dealerId: data.dealerId || '',
            dealerName: data.dealerName || 'General Dealer',
            dealerCode: data.dealerCode || '',
            dealerContact: data.dealerContact || '',
            dealerVillage: data.dealerVillage || '',
            dealerDistrict: data.dealerDistrict || '',
            farmerName: data.farmerName || '',
            items: cleanedItems,
            totalQuantity: data.totalQuantity || (data.items?.reduce((a: number, b: any) => a + (b.quantity || 0), 0) || 0),
            grossAmount: Number(data.grossAmount) || 0,
            discountAmount: Number(data.discountAmount) || 0,
            totalAmount: Number(data.totalAmount) || 0,
            paidAmount: Number(data.paidAmount) || 0,
            balanceAmount: Number(data.balanceAmount ?? data.totalAmount) || 0,
            paymentMode: data.paymentMode || 'Credit',
            status: data.status || 'pending_approval',
            approvedBy: data.approvedBy,
            approvedAt: data.approvedAt,
            dispatchedAt: data.dispatchedAt,
            dispatchNote: data.dispatchNote,
            deliveredAt: data.deliveredAt,
            ownerId: data.ownerId || '',
            userId: data.userId,
            loginId: data.loginId,
            userCode: data.userCode,
            createdByName: data.createdByName || 'User',
            createdAt: data.createdAt || new Date().toISOString(),
            isArchived: data.isArchived || false,
          });
        }
      });

      list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const merged = mergeWithLocalData('orders', list);
      setOrders(deduplicateOrders(merged));
    }, (error) => {
      console.warn("orders real-time sync notice:", error);
      const cached = mergeWithLocalData('orders', []);
      setOrders(deduplicateOrders(cached));
    });

    return () => unsub();
  }, [profile]);

  // Listen to users for officer filter
  useEffect(() => {
    const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
      const uList: { uid: string; fullName: string; loginId?: string; userCode?: string }[] = [];
      snap.forEach((d) => {
        const u = d.data();
        if (u.role !== 'dealer' && u.role !== 'owner') {
          uList.push({
            uid: d.id,
            fullName: u.fullName || u.loginId || d.id,
            loginId: u.loginId,
            userCode: u.userCode,
          });
        }
      });
      uList.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setOfficers(uList);
    }, (err) => {
      console.warn('Users sync notice in OrderView:', err);
    });

    return () => unsubUsers();
  }, []);

  // Real-time Dealers listener with officer attribution and local storage merging
  useEffect(() => {
    // 1. Initial cached dealers
    try {
      const cached = localStorage.getItem('blackworm_all_dealers');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setDealers(deduplicateDealers(parsed));
        }
      }
    } catch {}

    const qDealers = query(collection(db, 'dealers_application'), limit(500));
    const unsubDealers = onSnapshot(qDealers, (snap) => {
      const dList: SavedDealer[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        if (!data.isArchived) {
          dList.push({
            id: d.id,
            firmName: data.firmName || 'Unnamed Firm',
            proprietorName: data.proprietorName || '',
            contactNumber: data.contactNumber || '',
            dealerCode: data.dealerCode || '',
            village: data.village || '',
            district: data.district || '',
            created_by_user_id: data.created_by_user_id || data.createdByUid || data.userId || data.ownerId,
            created_by_name: data.created_by_name || data.officerName,
            createdByUid: data.createdByUid || data.created_by_user_id || data.userId,
            userId: data.userId || data.created_by_user_id,
            ownerId: data.ownerId,
            loginId: data.loginId,
            userCode: data.userCode,
            officerName: data.officerName || data.created_by_name,
            assignedOfficerUid: data.assignedOfficerUid,
          });
        }
      });

      const mergedDealers = mergeWithLocalData('dealers_application', dList);
      const cleanDealers = deduplicateDealers(mergedDealers);
      cleanDealers.sort((a, b) => (a.firmName || '').localeCompare(b.firmName || ''));
      setDealers(cleanDealers);
      try {
        localStorage.setItem('blackworm_all_dealers', JSON.stringify(cleanDealers));
      } catch {}
    }, (err) => {
      console.warn('Dealers live sync notice in OrderView:', err);
      const cached = mergeWithLocalData('dealers_application', []);
      setDealers(deduplicateDealers(cached));
    });

    // 2. Load & Sync Products with Firestore master_pricelist + products_pricelist_v2 + OFFICIAL_REFERENCE_DATA fallback
    const fallbackProducts = deduplicateProducts(OFFICIAL_REFERENCE_DATA.map((p, idx) => ({
      ...p,
      id: (p as any).id || `prod_ref_${idx + 1}`,
    })));

    // Listen to config/master_pricelist (Single atomic source of truth updated by Admin)
    const unsubMasterPricelist = onSnapshot(doc(db, 'config', 'master_pricelist'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data && Array.isArray(data.products) && data.products.length > 0) {
          const validList = deduplicateProducts(data.products.filter((p: any) => !p.isArchived));
          if (validList.length > 0) {
            setProducts(validList);
            try {
              localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(validList));
            } catch {}
          }
        }
      }
    }, (err) => {
      console.warn('Master pricelist live sync notice in OrderView:', err);
    });

    const loadProducts = async () => {
      try {
        const cachedProducts = localStorage.getItem('blackworm_cached_pricelist');
        if (cachedProducts) {
          const parsed = JSON.parse(cachedProducts);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setProducts(deduplicateProducts(parsed));
          }
        }

        const prodSnap = await getDocs(query(collection(db, 'products_pricelist_v2'), limit(300)));
        const pList: DynamicPriceProduct[] = [];
        prodSnap.forEach((d) => {
          const data = d.data() as any;
          if (!data.isArchived) {
            pList.push({ ...data, id: d.id });
          }
        });
        if (pList.length > 0) {
          const cleanPList = deduplicateProducts(pList);
          cleanPList.sort((a, b) => (a.orderIndex || 999) - (b.orderIndex || 999));
          setProducts(cleanPList);
          try {
            localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(cleanPList));
          } catch {}
        } else {
          // If Firestore collection has no items, ensure fallback
          setProducts((prev) => (prev && prev.length > 0 ? deduplicateProducts(prev) : fallbackProducts));
        }
      } catch (err) {
        console.warn('Products fetch notice in OrderView:', err);
        setProducts((prev) => (prev && prev.length > 0 ? deduplicateProducts(prev) : fallbackProducts));
      }
    };
    loadProducts();

    return () => {
      unsubDealers();
      unsubMasterPricelist();
    };
  }, []);

  // Strict Scoped Dealers:
  // - Officer Login: ONLY see dealers registered by this logged-in officer!
  // - Admin Login: If an officer filter is selected, filter to only that officer's registered dealers!
  const scopedDealers = useMemo(() => {
    if (!isAdmin(profile)) {
      return dealers.filter((d) => isDealerRegisteredByOfficer(d, profile));
    }
    if (selectedOfficerFilter !== 'all') {
      const targetOff = officers.find((o) => o.uid === selectedOfficerFilter);
      if (targetOff) {
        return dealers.filter((d) => isDealerRegisteredByOfficer(d, targetOff));
      }
    }
    return dealers;
  }, [dealers, profile, selectedOfficerFilter, officers]);

  // Filter Dealers in New Order Dropdown
  const filteredDealers = useMemo(() => {
    return scopedDealers.filter((d) => {
      if (!dealerSearchQuery.trim()) return true;
      const queryStr = dealerSearchQuery.toLowerCase();
      return (
        d.firmName.toLowerCase().includes(queryStr) ||
        d.proprietorName.toLowerCase().includes(queryStr) ||
        d.contactNumber.includes(queryStr) ||
        d.dealerCode.toLowerCase().includes(queryStr) ||
        d.village.toLowerCase().includes(queryStr)
      );
    });
  }, [scopedDealers, dealerSearchQuery]);

  // Distinct product categories for filter pills
  const productCategories = useMemo(() => {
    const cats = new Set<string>();
    products.forEach((p) => {
      if (p.groupName && p.groupName.trim()) {
        cats.add(p.groupName.trim());
      }
    });
    return Array.from(cats);
  }, [products]);

  // Filter Products in New Order Dropdown
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (productCategoryFilter !== 'all' && (p.groupName || '').toLowerCase() !== productCategoryFilter.toLowerCase()) {
        return false;
      }
      if (!productSearchQuery.trim()) return true;
      const queryStr = productSearchQuery.toLowerCase();
      const full = `${p.brandName} ${p.gradeName} ${p.groupName || ''}`.toLowerCase();
      return full.includes(queryStr);
    });
  }, [products, productCategoryFilter, productSearchQuery]);

  // Helper to compute Rate with GST and Standard Billing Discount:
  // Group A: 0%, Specialty: 0%, Group B: 10%, Group C: 20%
  const computeProductRate = (prod: DynamicPriceProduct, packingSize: string): number => {
    if (!prod.packings || prod.packings.length === 0) return 0;
    const pk = prod.packings.find((p) => p.packingSize === packingSize) || prod.packings[0];
    const baseWithGst = calculateWithGst(pk.rate, prod.gstRate || 5);
    const billingDisc = getStandardBillingDiscount(prod.groupName || '');
    return Math.round(baseWithGst * (1 - billingDisc / 100) * 100) / 100;
  };

  // When a product is selected, auto-select its first packing size and compute rate with GST & billing discount
  const handleSelectProduct = (prod: DynamicPriceProduct) => {
    setSelectedProduct(prod);
    setFormError(null);
    if (prod.packings && prod.packings.length > 0) {
      const first = prod.packings[0];
      setSelectedPacking(first.packingSize);
      setItemRate(computeProductRate(prod, first.packingSize));
    } else {
      setSelectedPacking('Standard');
      setItemRate(0);
    }
    setItemQuantity(1);
    setItemDiscount('');
  };

  // When a packing size is changed, recompute rate with GST & billing discount
  const handleSelectPacking = (packSize: string) => {
    setSelectedPacking(packSize);
    if (selectedProduct) {
      setItemRate(computeProductRate(selectedProduct, packSize));
    }
  };

  // Add Item to Order list with discount support and robust quantity parsing
  const handleAddItemToOrder = () => {
    setFormError(null);
    if (!selectedProduct) return;
    const packing = selectedPacking || (selectedProduct.packings && selectedProduct.packings[0]?.packingSize) || 'Standard';
    const qty = typeof itemQuantity === 'string' && itemQuantity === '' ? 1 : Math.max(1, Number(itemQuantity) || 1);
    const rate = Number(itemRate) || computeProductRate(selectedProduct, packing) || 0;
    const baseTotal = rate * qty;
    const disc = Number(itemDiscount) || 0;
    const discountAmt = discountType === 'percent' ? Math.round((baseTotal * disc) / 100) : disc;
    const subtotal = Math.max(0, baseTotal - discountAmt);
    const cleanName = getCleanGradeName(selectedProduct);

    const newLine: OrderProductLine = {
      productId: selectedProduct.id || `prod_${Date.now()}`,
      productName: cleanName,
      brandName: selectedProduct.brandName || '',
      gradeName: cleanName,
      groupName: selectedProduct.groupName || '',
      packingSize: packing,
      rate,
      quantity: qty,
      discount: discountAmt > 0 ? discountAmt : 0,
      discountPercent: discountType === 'percent' && disc > 0 ? disc : 0,
      subtotal,
    };

    setOrderItems((prev) => [...prev, newLine]);

    // Reset line item selection for next fast entry
    setSelectedProduct(null);
    setProductSearchQuery('');
    setSelectedPacking('');
    setItemRate(0);
    setItemQuantity(1);
    setItemDiscount('');
  };

  // Remove Item from Order list
  const handleRemoveItem = (index: number) => {
    setOrderItems((prev) => prev.filter((_, i) => i !== index));
  };

  // Total calculations with extra order discount support
  const grossBillAmount = orderItems.reduce((acc, item) => acc + item.subtotal, 0);
  const extraOrderDiscount = Number(orderDiscount) || 0;
  const totalBillAmount = Math.max(0, grossBillAmount - extraOrderDiscount);
  const totalItemDiscounts = orderItems.reduce((acc, item) => acc + (item.discount || 0), 0);
  const allDiscountsTotal = totalItemDiscounts + extraOrderDiscount;
  const totalBagsQuantity = orderItems.reduce((acc, item) => acc + item.quantity, 0);

  // Generate & Save Order to Firestore
  const handleGenerateOrder = async () => {
    if (isSubmittingOrder) return;
    setFormError(null);

    // 1. Resolve Dealer
    let dealerToUse = selectedDealer;
    if (!dealerToUse && dealerSearchQuery.trim()) {
      const match = dealers.find(
        (d) => d.firmName.toLowerCase() === dealerSearchQuery.trim().toLowerCase()
      );
      if (match) {
        dealerToUse = match;
        setSelectedDealer(match);
      } else {
        dealerToUse = {
          id: `custom_${Date.now()}`,
          firmName: dealerSearchQuery.trim(),
          proprietorName: '',
          contactNumber: '',
          dealerCode: 'CUSTOM',
          village: '',
          district: '',
        };
        setSelectedDealer(dealerToUse);
      }
    }

    if (!dealerToUse) {
      setFormError('कृपया प्रथम डीलर निवडा किंवा नाव टाईप करा! (Please select or enter dealer name)');
      return;
    }

    // 2. Auto-add active product if user selected one and has not yet clicked '+ Add Item'
    let currentItems = [...orderItems];
    if (selectedProduct) {
      const packing = selectedPacking || (selectedProduct.packings && selectedProduct.packings[0]?.packingSize) || 'Standard';
      const qty = typeof itemQuantity === 'string' && itemQuantity === '' ? 1 : Math.max(1, Number(itemQuantity) || 1);
      const rate = Number(itemRate) || computeProductRate(selectedProduct, packing) || 0;
      const baseTotal = rate * qty;
      const disc = Number(itemDiscount) || 0;
      const discountAmt = discountType === 'percent' ? Math.round((baseTotal * disc) / 100) : disc;
      const subtotal = Math.max(0, baseTotal - discountAmt);
      const cleanName = getCleanGradeName(selectedProduct);

      const newLine: OrderProductLine = {
        productId: selectedProduct.id || `prod_${Date.now()}`,
        productName: cleanName,
        brandName: selectedProduct.brandName || '',
        gradeName: cleanName,
        groupName: selectedProduct.groupName || '',
        packingSize: packing,
        rate,
        quantity: qty,
        discount: discountAmt > 0 ? discountAmt : 0,
        discountPercent: discountType === 'percent' && disc > 0 ? disc : 0,
        subtotal,
      };
      currentItems.push(newLine);
      setOrderItems(currentItems);
      setSelectedProduct(null);
      setSelectedPacking('');
    }

    if (currentItems.length === 0) {
      setFormError('कृपया किमान एक प्रॉडक्ट निवडून जोडा! (Please select and add at least one product)');
      return;
    }

    setIsSubmittingOrder(true);
    try {
      const gross = currentItems.reduce((acc, item) => acc + (Number(item.subtotal) || 0), 0);
      const extraDisc = Number(orderDiscount) || 0;
      const totalBill = Math.max(0, gross - extraDisc);
      const itemDiscs = currentItems.reduce((acc, item) => acc + (Number(item.discount) || 0), 0);
      const allDiscs = itemDiscs + extraDisc;
      const totalBags = currentItems.reduce((acc, item) => acc + (Number(item.quantity) || 0), 0);

      // Strictly ensure ZERO undefined values for Firestore serialization
      const sanitizedItems = currentItems.map(it => ({
        productId: it.productId || '',
        productName: it.productName || '',
        brandName: it.brandName || '',
        gradeName: it.gradeName || '',
        groupName: it.groupName || '',
        packingSize: it.packingSize || 'Standard',
        rate: Number(it.rate) || 0,
        quantity: Number(it.quantity) || 1,
        discount: Number(it.discount) || 0,
        discountPercent: Number(it.discountPercent) || 0,
        subtotal: Number(it.subtotal) || 0,
      }));

      // If editing an existing order
      if (editingOrderId) {
        const existingOrder = orders.find(o => o.id === editingOrderId);
        const updatedOrderPayload: Partial<OrderItem> = {
          dealerId: dealerToUse.id || '',
          dealerName: dealerToUse.firmName || '',
          dealerCode: dealerToUse.dealerCode || '',
          dealerContact: dealerToUse.contactNumber || '',
          dealerVillage: dealerToUse.village || '',
          dealerDistrict: dealerToUse.district || '',
          farmerName: dealerToUse.proprietorName || '',
          cropName: existingOrder?.cropName || '',
          items: sanitizedItems,
          totalQuantity: totalBags,
          grossAmount: gross,
          discountAmount: allDiscs,
          totalAmount: totalBill,
          balanceAmount: Math.max(0, totalBill - (existingOrder?.paidAmount || 0)),
          updatedAt: new Date().toISOString(),
          updatedByName: profile.fullName || profile.loginId || 'Officer',
        };

        const saveRes = await safeFirestoreSet('orders', editingOrderId, updatedOrderPayload, { merge: true });

        // Immediately update in-memory orders
        setOrders((prev) => {
          const idx = prev.findIndex((o) => o.id === editingOrderId);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], ...updatedOrderPayload } as OrderItem;
            return updated;
          }
          return prev;
        });

        try {
          await logAudit(
            'UPDATE',
            'orders',
            editingOrderId,
            `Updated order ${existingOrder?.orderNumber || editingOrderId} for ${dealerToUse.firmName}`,
            profile
          );
        } catch (e) {
          console.warn('Audit log failed (non-fatal):', e);
        }

        setShowNewOrderModal(false);
        resetNewOrderForm();
        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: 'ऑर्डर अपडेट झाली!',
          message: saveRes.isCachedLocally
            ? `ऑर्डर ${existingOrder?.orderNumber || ''} स्थानिक मेमरीमध्ये सुरक्षित सेव्ह झाली आहे.`
            : `ऑर्डर ${existingOrder?.orderNumber || ''} मधील बदल यशस्वीरित्या सेव्ह झाले आहेत.`,
          confirmText: 'ठीक आहे',
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
        });
        return;
      }

      // Creating a brand new order
      const orderId = `order_${Date.now()}`;
      const orderNumber = `BW-${Math.floor(100000 + Math.random() * 900000)}`;

      const newOrder: OrderItem = {
        id: orderId,
        orderNumber,
        cropName: '',
        dealerId: dealerToUse.id || '',
        dealerName: dealerToUse.firmName || '',
        dealerCode: dealerToUse.dealerCode || '',
        dealerContact: dealerToUse.contactNumber || '',
        dealerVillage: dealerToUse.village || '',
        dealerDistrict: dealerToUse.district || '',
        farmerName: dealerToUse.proprietorName || '',
        items: sanitizedItems,
        totalQuantity: totalBags,
        grossAmount: gross,
        discountAmount: allDiscs,
        totalAmount: totalBill,
        paidAmount: 0,
        balanceAmount: totalBill,
        paymentMode: 'Pending / Credit',
        status: 'pending_approval',
        ownerId: profile.uid || '',
        userId: profile.uid || '',
        loginId: profile.loginId || '',
        userCode: profile.userCode || '',
        createdByName: profile.fullName || 'Officer',
        createdAt: new Date().toISOString(),
        isArchived: false,
      };

      const saveRes = await safeFirestoreSet('orders', orderId, newOrder);

      // Immediately add to in-memory orders
      setOrders((prev) => [newOrder, ...prev]);

      try {
        await logAudit(
          'CREATE',
          'orders',
          orderId,
          `Generated new order ${orderNumber} for ${dealerToUse.firmName} (Total Quantity: ${totalBags} Units)`,
          profile
        );
      } catch (e) {
        console.warn('Audit log failed (non-fatal):', e);
      }

      // Reset modal form
      setShowNewOrderModal(false);
      resetNewOrderForm();

      // Show Success Dialog with direct WhatsApp share
      setSuccessOrder(newOrder);
    } catch (err: any) {
      console.error('Error generating order:', err);
      setFormError('ऑर्डर सेव्ह करताना त्रुटी आली: ' + (err?.message || 'कृपया इंटरनेट तपासून पुन्हा प्रयत्न करा.'));
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  // WhatsApp & Clipboard Message Generator strictly formatted as requested:
  // Dealer, Proprietor Name, Contact Number, Location, and Order Quantity (No Blackworm title, no booking details, no order number, no date)
  const generateWhatsAppMessage = (order: OrderItem) => {
    let itemsListText = '';
    if (order.items && order.items.length > 0) {
      itemsListText = order.items
        .map(
          (it, idx) =>
            `${idx + 1}. *${it.productName}* (${it.packingSize}) - *${it.quantity} Nos.*`
        )
        .join('\n');
    } else {
      itemsListText = `1. Order Items - *${order.totalQuantity} Nos.*`;
    }

    const locationStr = [order.dealerVillage, order.dealerDistrict].filter(Boolean).join(', ');

    const message = `*Dealer:* ${order.dealerName}
*Proprietor Name:* ${order.farmerName || '-'}
*Contact Number:* ${order.dealerContact || '-'}
*Location:* ${locationStr || '-'}

*Order Quantity:*
${itemsListText}

*Total Quantity:* *${order.totalQuantity} Nos.*`;

    return message;
  };

  // Copy Order Text to Clipboard for WhatsApp
  const handleCopyOrderText = async (order: OrderItem) => {
    try {
      const text = generateWhatsAppMessage(order);
      await navigator.clipboard.writeText(text);
      setCopiedOrderId(order.id);
      setTimeout(() => setCopiedOrderId(null), 2500);
    } catch (e) {
      console.error('Error copying order text:', e);
    }
  };

  // Direct WhatsApp Share Trigger with Generated Order Photo & Status
  const handleShareOnWhatsApp = async (order: OrderItem) => {
    setIsGeneratingImage(true);
    setCapturingOrder(order);

    setTimeout(async () => {
      try {
        const text = generateWhatsAppMessage(order);
        const cleanPhone = (order.dealerContact || '').replace(/\D/g, '').slice(-10);
        const waUrl =
          cleanPhone && cleanPhone.length === 10
            ? `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(text)}`
            : `https://wa.me/?text=${encodeURIComponent(text)}`;

        if (receiptCaptureRef.current) {
          const canvas = await html2canvas(receiptCaptureRef.current, {
            scale: 2.5,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
          });

          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/png')
          );

          if (blob) {
            const fileName = `Order_${order.orderNumber}.png`;
            const file = new File([blob], fileName, { type: 'image/png' });

            // Check if native Web Share with files is supported (mobile browsers)
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({
                files: [file],
                title: `Order - ${order.orderNumber}`,
              });
              setIsGeneratingImage(false);
              return;
            } else {
              // Desktop or browser without files sharing:
              // Download image cleanly for user
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = fileName;
              link.click();
              URL.revokeObjectURL(link.href);
              setIsGeneratingImage(false);
              return;
            }
          }
        }

        openExternalLinkSafely(waUrl);
      } catch (err: any) {
        console.error('Error sharing order photo:', err);
        const text = generateWhatsAppMessage(order);
        const cleanPhone = (order.dealerContact || '').replace(/\D/g, '').slice(-10);
        const waUrl =
          cleanPhone && cleanPhone.length === 10
            ? `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(text)}`
            : `https://wa.me/?text=${encodeURIComponent(text)}`;
        openExternalLinkSafely(waUrl);
      } finally {
        setIsGeneratingImage(false);
      }
    }, 150);
  };

  // Workflow Action 1: Approve Order & Move to Complete
  const handleApproveOrder = async (order: OrderItem) => {
    if (!isAdmin(profile)) return;

    const updatedData = {
      status: 'complete' as const,
      approvedBy: profile.fullName || 'Admin',
      approvedAt: new Date().toISOString(),
      dispatchedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Update state immediately
    setOrders((prev) =>
      prev.map((o) => (o.id === order.id ? { ...o, ...updatedData } : o))
    );

    try {
      await updateDoc(doc(db, 'orders', order.id), updatedData);
    } catch {
      await safeFirestoreSet('orders', order.id, updatedData, { merge: true });
    }

    await logAudit(
      'UPDATE',
      'orders',
      order.id,
      `Approved order ${order.orderNumber} (Moved to Complete) by ${profile.fullName}`,
      profile
    );

    // If modal open, update view
    if (selectedOrderDetails && selectedOrderDetails.id === order.id) {
      setSelectedOrderDetails({ ...selectedOrderDetails, ...updatedData });
    }
  };

  // Workflow Action 2: Mark Delivered & Complete Order
  const handleMarkDelivered = async (order: OrderItem) => {
    if (!isAdmin(profile) && !isUserRecord(order, profile)) return;

    const updatedData = {
      status: 'delivered' as const,
      deliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(doc(db, 'orders', order.id), updatedData);
    await logAudit(
      'UPDATE',
      'orders',
      order.id,
      `Order ${order.orderNumber} marked as Delivered / Complete to dealer`,
      profile
    );

    if (selectedOrderDetails && selectedOrderDetails.id === order.id) {
      setSelectedOrderDetails({ ...selectedOrderDetails, ...updatedData });
    }
  };

  // Delete Order Confirmation
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

  const handleDelete = async (order: OrderItem) => {
    const isPending = order.status === 'pending_approval' || order.status === 'pending';
    const canDelete = isPending 
      ? (order.userId === profile.uid || isUserRecord(order, profile) || isAdmin(profile)) 
      : isAdmin(profile);

    if (!canDelete) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'काढून टाकण्यास मनाई',
        message: 'मंजूर झालेली ऑर्डर फक्त Admin डिलीट करू शकतात. (Approved orders can only be deleted by Admin).',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Order',
      message: `Are you sure you want to delete order ${order.orderNumber} (${order.dealerName})?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig((prev) => ({ ...prev, isOpen: false }));
        // Instantly remove from local state for immediate visual response
        setOrders((prev) => prev.filter((o) => o.id !== order.id));
        if (selectedOrderDetails?.id === order.id) {
          setSelectedOrderDetails(null);
        }
        try {
          await deleteDoc(doc(db, 'orders', order.id));
          await logAudit('DELETE', 'orders', order.id, `Deleted order ${order.orderNumber} for ${order.dealerName}`, profile);
        } catch (err) {
          console.error('Delete error, trying soft delete fallback:', err);
          try {
            await updateDoc(doc(db, 'orders', order.id), { isArchived: true });
          } catch (e2) {
            console.error('Soft delete error:', e2);
          }
        }
      },
      onCancel: () => setDialogConfig((prev) => ({ ...prev, isOpen: false })),
    });
  };

  // Filter Orders List (Strictly Officer-wise for non-admin, and officer filter for admin)
  const filteredOrders = orders.filter((o) => {
    if (!isAdmin(profile)) {
      if (!isUserRecord(o, profile)) {
        return false;
      }
    } else {
      if (selectedOfficerFilter !== 'all') {
        const targetOfficer = officers.find((off) => off.uid === selectedOfficerFilter);
        if (targetOfficer) {
          const anyOrder = o as any;
          const recUid = (anyOrder.userId || anyOrder.ownerId || anyOrder.created_by_user_id || anyOrder.createdByUid || '').toString().toLowerCase().trim();
          const targetUid = (targetOfficer.uid || '').toLowerCase().trim();
          const targetName = (targetOfficer.fullName || '').toLowerCase().trim();
          const targetLogin = (targetOfficer.loginId || '').toLowerCase().trim();
          const targetCode = (targetOfficer.userCode || '').toLowerCase().trim();
          const recName = (anyOrder.createdByName || anyOrder.created_by_name || '').toString().toLowerCase().trim();
          const recLogin = (anyOrder.loginId || '').toString().toLowerCase().trim();
          const recCode = (anyOrder.userCode || '').toString().toLowerCase().trim();

          const match =
            (targetUid && recUid === targetUid) ||
            (targetName && recName && (recName === targetName || recName.includes(targetName) || targetName.includes(recName))) ||
            (targetLogin && recLogin && recLogin === targetLogin) ||
            (targetCode && recCode && recCode === targetCode);

          if (!match) return false;
        }
      }
    }

    const queryStr = search.toLowerCase();
    const matchSearch =
      o.dealerName.toLowerCase().includes(queryStr) ||
      o.orderNumber.toLowerCase().includes(queryStr) ||
      (o.dealerContact || '').includes(queryStr) ||
      (o.farmerName || '').toLowerCase().includes(queryStr) ||
      (o.items && o.items.some((it) => it.productName.toLowerCase().includes(queryStr)));

    if (!matchSearch) return false;

    if (statusFilter === 'all') return true;
    if (statusFilter === 'pending') return o.status === 'pending_approval' || o.status === 'pending';
    if (statusFilter === 'complete') return o.status === 'complete' || o.status === 'approved' || o.status === 'delivered';
    if (statusFilter === 'dispatched') return o.status === 'dispatched' || o.status === 'confirmed';
    if (statusFilter === 'delivered') return o.status === 'delivered';
    if (statusFilter === 'collected') return o.status === 'collected';
    return true;
  });

  return (
    <div className="space-y-3 sm:space-y-4 max-w-5xl mx-auto pb-16">
      {/* Header Banner - Compact without subtitle */}
      <div className="flex justify-between items-center bg-white px-3.5 py-2.5 rounded-2xl border border-slate-200 shadow-xs">
        <h2 className="text-base sm:text-lg font-black text-slate-900 flex items-center gap-2">
          <ShoppingBag className="w-5 h-5 text-purple-600" />
          <span>Order Management</span>
        </h2>
        <button
          onClick={() => {
            setShowNewOrderModal(true);
            setSelectedDealer(null);
            setOrderItems([]);
          }}
          className="flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-xs cursor-pointer active:scale-95"
        >
          <Plus className="w-3.5 h-3.5 stroke-[3]" />
          <span>New Order</span>
        </button>
      </div>

      {/* Search & Filter Bar - Ultra Compact Small Buttons */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search Order No, Dealer Name, Contact, Product..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-xs"
          />
        </div>

        {/* Admin Officer Filter Dropdown */}
        {isAdmin(profile) && officers.length > 0 && (
          <div className="shrink-0 flex items-center">
            <select
              value={selectedOfficerFilter}
              onChange={(e) => setSelectedOfficerFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-xl border border-purple-200 bg-purple-50 text-purple-900 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-xs cursor-pointer"
              title="Filter by Officer"
            >
              <option value="all">सर्व ऑफिसर्स (All Officers)</option>
              {officers.map((off) => {
                const offOrdersCount = orders.filter((o) => isUserRecord(o, off as any)).length;
                return (
                  <option key={off.uid} value={off.uid}>
                    {toTitleCase(off.fullName || 'Officer')} ({offOrdersCount})
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Status filter buttons: Pending (default), Complete, All */}
        <div className="flex gap-1 overflow-x-auto pb-0.5 no-scrollbar items-center">
          {[
            { id: 'pending', label: 'Pending' },
            { id: 'complete', label: 'Complete' },
            { id: 'all', label: 'All' },
          ].map((st) => {
            const count = orders.filter((o) => {
              if (!isAdmin(profile)) {
                if (!isUserRecord(o, profile)) return false;
              } else if (selectedOfficerFilter !== 'all') {
                const targetOfficer = officers.find((off) => off.uid === selectedOfficerFilter);
                if (targetOfficer && !isUserRecord(o, targetOfficer as any)) return false;
              }
              if (st.id === 'pending') return o.status === 'pending_approval' || o.status === 'pending';
              if (st.id === 'complete') return o.status === 'complete' || o.status === 'approved' || o.status === 'delivered';
              return true;
            }).length;

            return (
              <button
                key={st.id}
                onClick={() => setStatusFilter(st.id)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-bold transition whitespace-nowrap cursor-pointer active:scale-95 flex items-center gap-1",
                  statusFilter === st.id
                    ? "bg-purple-600 text-white shadow-2xs"
                    : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                )}
              >
                <span>{st.label}</span>
                <span className={cn(
                  "px-1.5 py-0.2 rounded-full text-[10px] font-mono",
                  statusFilter === st.id ? "bg-white/25 text-white" : "bg-slate-100 text-slate-700"
                )}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Orders List */}
      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center space-y-2">
          <ShoppingBag className="w-10 h-10 text-slate-300 mx-auto" />
          <p className="text-xs font-bold text-slate-700">No orders found</p>
          <p className="text-[11px] text-slate-400">Click on 'New Order' button above to create a new order.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredOrders.map((o) => {
            const isPending = o.status === 'pending_approval' || o.status === 'pending';
            const isComplete = o.status === 'complete' || o.status === 'approved' || o.status === 'delivered';
            const isDispatched = o.status === 'dispatched' || o.status === 'confirmed';
            const isCollected = o.status === 'collected';

            return (
              <div
                key={o.id}
                className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-3.5 shadow-xs space-y-2 hover:border-purple-200 transition"
              >
                {/* Header: Order No, Dealer Code & STATUS BADGE RIGHT IN FRONT OF CODE */}
                <div className="flex justify-between items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-xs font-black text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded-md">
                        {o.orderNumber}
                      </span>
                      {o.dealerCode && (
                        <span className="text-[9.5px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-mono">
                          Code: {o.dealerCode}
                        </span>
                      )}

                      {/* Status Badge placed right in front of the code to save space */}
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-black uppercase tracking-tight",
                          isPending && "bg-amber-50 text-amber-800 border border-amber-200",
                          isComplete && "bg-emerald-50 text-emerald-700 border border-emerald-200",
                          isDispatched && !isComplete && "bg-blue-50 text-blue-700 border border-blue-200",
                          isCollected && "bg-green-100 text-green-800 border border-green-300"
                        )}
                      >
                        {isPending && <Clock className="w-2.5 h-2.5" />}
                        {isComplete && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {isDispatched && !isComplete && <Truck className="w-2.5 h-2.5" />}
                        {isCollected && <PackageCheck className="w-2.5 h-2.5" />}
                        <span>
                          {isPending && 'Pending'}
                          {isComplete && 'Complete'}
                          {isDispatched && !isComplete && 'Dispatched'}
                          {isCollected && 'Collected'}
                        </span>
                      </span>

                      {/* Crop Badge */}
                      {o.cropName && (
                        <span className="text-[9.5px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md inline-flex items-center gap-1">
                          <Sprout className="w-2.5 h-2.5 text-emerald-600" />
                          <span>{o.cropName}</span>
                        </span>
                      )}
                    </div>

                    {/* Compact Dealer Firm, Proprietor & Location Info */}
                    <div className="mt-1 bg-slate-50/80 px-2 py-1.5 rounded-lg border border-slate-100">
                      <div className="flex items-center justify-between gap-1.5">
                        <h3 className="text-xs font-black text-slate-900 truncate leading-tight">
                          {toTitleCase(o.dealerName)}
                        </h3>
                        {o.dealerContact && (
                          <span className="text-[9.5px] font-mono font-bold text-slate-500 shrink-0">
                            {o.dealerContact}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[9.5px] text-slate-600 font-medium truncate mt-0.5">
                        {o.farmerName && o.farmerName !== o.dealerName && (
                          <span className="inline-flex items-center gap-0.5 truncate shrink-0">
                            <User className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                            <span>{toTitleCase(o.farmerName)}</span>
                          </span>
                        )}
                        {o.dealerVillage && (
                          <span className="inline-flex items-center gap-0.5 truncate text-slate-500">
                            <MapPin className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                            <span>{toTitleCase(o.dealerVillage)}{o.dealerDistrict ? `, ${toTitleCase(o.dealerDistrict)}` : ''}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Items Preview */}
                <div className="bg-slate-50 rounded-xl p-2 text-xs border border-slate-100 space-y-1">
                  <div className="flex justify-between items-center text-[9.5px] font-black text-slate-500 uppercase tracking-wider pb-0.5 border-b border-slate-200/60">
                    <span>Order Items</span>
                    <span>{o.items?.length || 1} Items</span>
                  </div>
                  {o.items && o.items.length > 0 ? (
                    <div className="space-y-0.5 pt-0.5">
                      {o.items.slice(0, 2).map((it, idx) => (
                        <div key={idx} className="flex justify-between items-center text-[10.5px] font-semibold text-slate-700">
                          <span className="truncate pr-2 font-bold text-sky-700">• {it.gradeName || it.productName} ({it.packingSize})</span>
                          <span className="shrink-0 font-mono text-slate-900 font-bold">
                            {it.quantity} x ₹{it.rate} = ₹{it.subtotal.toLocaleString()}
                          </span>
                        </div>
                      ))}
                      {o.items.length > 2 && (
                        <p className="text-[9.5px] font-bold text-purple-600 text-right">
                          + {o.items.length - 2} more items...
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="text-[10.5px] font-medium text-slate-600">Standard Order Items</div>
                  )}
                </div>

                {/* Ultra-Compact Bill & Payment Bar */}
                <div className="flex items-center justify-between px-2.5 py-1 bg-purple-50/50 rounded-lg border border-purple-100 text-[10.5px]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9.5px] font-bold text-slate-500">Total Bill:</span>
                    <span className="text-xs font-black text-purple-900 font-mono">
                      ₹{o.totalAmount.toLocaleString()}
                    </span>
                  </div>

                  {o.paidAmount > 0 ? (
                    <div className="flex items-center gap-2 text-[9.5px] font-bold">
                      <span className="text-emerald-700">Paid: ₹{o.paidAmount.toLocaleString()}</span>
                      <span className="text-slate-500">Bal: ₹{o.balanceAmount.toLocaleString()}</span>
                    </div>
                  ) : (
                    <span className="text-[9px] font-bold text-amber-800 bg-amber-100/60 px-1.5 py-0.2 rounded font-sans">
                      Unpaid
                    </span>
                  )}
                </div>

                {/* Action Buttons: Ultra-Compact Buttons matching View/Delete size */}
                <div className="pt-0.5 flex flex-wrap items-center gap-1.5">
                  {/* WhatsApp Share Button - Compact icon matching View and Delete */}
                  <button
                    onClick={() => handleShareOnWhatsApp(o)}
                    disabled={isGeneratingImage}
                    className="p-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 rounded transition flex items-center justify-center cursor-pointer active:scale-95 shrink-0"
                    title="Share Order Photo on WhatsApp"
                  >
                    {isGeneratingImage && capturingOrder?.id === o.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Camera className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* Copy Order Text Button */}
                  <button
                    onClick={() => handleCopyOrderText(o)}
                    className="p-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded transition cursor-pointer active:scale-95 shrink-0"
                    title={copiedOrderId === o.id ? "Copied to clipboard!" : "Copy Order Text"}
                  >
                    {copiedOrderId === o.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* View Details Modal Trigger */}
                  <button
                    onClick={() => setSelectedOrderDetails(o)}
                    className="p-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded transition cursor-pointer active:scale-95 shrink-0"
                    title="View Details"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>

                  {/* Workflow Stage 1: Approve Order & Move to Complete */}
                  {isPending && isAdmin(profile) && (
                    <button
                      onClick={() => handleApproveOrder(o)}
                      className="p-1 px-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold transition shadow-2xs cursor-pointer active:scale-95 flex items-center gap-1"
                      title="Approve Order (Move to Complete)"
                    >
                      <Check className="w-3 h-3 stroke-[3]" />
                      <span>Approve</span>
                    </button>
                  )}

                  {/* Workflow Stage 2: Mark Delivered & Complete - Small matching icon */}
                  {isDispatched && (
                    <button
                      onClick={() => handleMarkDelivered(o)}
                      className="p-1 px-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-[10px] font-bold transition shadow-2xs cursor-pointer active:scale-95 flex items-center gap-1"
                      title="Mark Delivered"
                    >
                      <PackageCheck className="w-3 h-3" />
                      <span>Delivered</span>
                    </button>
                  )}

                  {/* Edit Order Button: Before approval creator/admin can edit, After approval strictly Admin */}
                  {((isPending && (o.userId === profile.uid || isUserRecord(o, profile) || isAdmin(profile))) || (!isPending && isAdmin(profile))) && (
                    <button
                      onClick={() => handleOpenEditOrder(o)}
                      className="p-1 px-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded transition cursor-pointer active:scale-95 shrink-0 flex items-center gap-1 text-[10px] font-bold border border-amber-200"
                      title="Edit Order (ऑर्डर दुरुस्त करा)"
                    >
                      <Edit3 className="w-3 h-3 text-amber-600" />
                      <span>Edit</span>
                    </button>
                  )}

                  {/* Locked indicator when order is approved and user is not Admin */}
                  {!isPending && !isAdmin(profile) && (
                    <span
                      className="p-1 px-1.5 text-slate-400 bg-slate-50 border border-slate-200 rounded flex items-center gap-1 text-[10px] font-bold cursor-not-allowed opacity-80"
                      title="मंजूर झालेली ऑर्डर फक्त Admin एडिट करू शकतात"
                    >
                      <Lock className="w-3 h-3 text-slate-400" />
                      <span>Locked</span>
                    </span>
                  )}

                  {/* Delete Button: Pending can be deleted by creator or admin; Approved only by Admin */}
                  {((isPending && (o.userId === profile.uid || isUserRecord(o, profile) || isAdmin(profile))) || (!isPending && isAdmin(profile))) && (
                    <button
                      onClick={() => handleDelete(o)}
                      className="p-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded transition cursor-pointer active:scale-95 shrink-0"
                      title="Delete Order"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Footer Creator Tag */}
                <div className="text-[9px] text-slate-400 font-medium pt-0.5 flex justify-between items-center border-t border-slate-100">
                  <span>Booked by: {toTitleCase(o.createdByName)}</span>
                  <span>{new Date(o.createdAt).toLocaleDateString('en-GB')}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hidden receipt card container for generating WhatsApp Order Photo strictly formatted */}
      <div className="fixed -left-[9999px] top-0 pointer-events-none" aria-hidden="true">
        {capturingOrder && (
          <div
            ref={receiptCaptureRef}
            className="w-[420px] bg-white p-5 border-2 border-slate-900 rounded-2xl font-sans text-slate-900 space-y-3"
            style={{ width: '420px' }}
          >
            {/* Dealer & Location Information */}
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs space-y-1.5">
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Dealer:</span>{' '}
                <strong className="text-sm font-black text-slate-900">{toTitleCase(capturingOrder.dealerName)}</strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Proprietor Name:</span>{' '}
                <strong className="text-slate-900">{toTitleCase(capturingOrder.farmerName || '-')}</strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Contact Number:</span>{' '}
                <strong className="font-mono text-slate-900">{capturingOrder.dealerContact || '-'}</strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Location:</span>{' '}
                <strong className="text-slate-900">{[toTitleCase(capturingOrder.dealerVillage), toTitleCase(capturingOrder.dealerDistrict)].filter(Boolean).join(', ') || '-'}</strong>
              </p>
            </div>

            {/* Order Quantity Section */}
            <div>
              <p className="text-xs font-black text-slate-800 uppercase tracking-wide mb-1.5">Order Quantity:</p>
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="bg-slate-900 text-white font-black text-[10px] uppercase">
                    <th className="p-1.5 pl-2"># Product</th>
                    <th className="p-1.5 text-center w-24">Packing</th>
                    <th className="p-1.5 text-center w-24">Quantity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 border-b border-slate-200 font-semibold">
                  {capturingOrder.items?.map((it, idx) => (
                    <tr key={idx} className={idx % 2 === 1 ? "bg-slate-50/70" : ""}>
                      <td className="p-1.5 pl-2 font-bold text-sky-700 text-[11px]">{idx + 1}. {it.gradeName || it.productName}</td>
                      <td className="p-1.5 text-center text-slate-600 text-[10px] font-bold">{it.packingSize}</td>
                      <td className="p-1.5 text-center font-mono font-black text-slate-900 text-xs">{it.quantity} Nos.</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-emerald-50 font-black text-emerald-950 text-[11px]">
                  <tr>
                    <td colSpan={2} className="p-2 pl-2 text-right uppercase">Total Quantity:</td>
                    <td className="p-2 text-center font-mono font-black text-sm text-emerald-900">{capturingOrder.totalQuantity} Nos.</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ===================== NEW ORDER ENTRY MODAL ===================== */}
      {showNewOrderModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-2.5 sm:p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-3.5 sm:p-5 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-3">
            {/* Modal Header */}
            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
                  <ShoppingBag className="w-4 h-4" />
                </div>
                <h3 className="text-base font-black text-slate-900 leading-tight">
                  {editingOrderId ? 'Edit Order Details (ऑर्डर संपादन)' : 'New Order Entry'}
                </h3>
              </div>
              <button
                onClick={() => {
                  setShowNewOrderModal(false);
                  resetNewOrderForm();
                }}
                className="p-1 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* STEP 1: SELECT DEALER FROM SAVED LIST */}
            <div className="space-y-1.5 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
              <div className="flex justify-between items-center flex-wrap gap-1.5">
                <label className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-purple-600" />
                  <span>1. Select Saved Dealer ({filteredDealers.length}) *</span>
                </label>

                {/* For Admin: Filter dealers by Officer right in the order creation modal */}
                {isAdmin(profile) && officers.length > 0 && !selectedDealer && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-slate-500">ऑफिसर:</span>
                    <select
                      value={selectedOfficerFilter}
                      onChange={(e) => setSelectedOfficerFilter(e.target.value)}
                      className="px-2 py-0.5 rounded-lg border border-purple-200 bg-white text-purple-900 text-[10px] font-bold focus:outline-none focus:ring-1 focus:ring-purple-500 shadow-2xs cursor-pointer"
                    >
                      <option value="all">सर्व ऑफिसर्स (All)</option>
                      {officers.map((off) => (
                        <option key={off.uid} value={off.uid}>
                          {toTitleCase(off.fullName || 'Officer')}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {selectedDealer && (
                  <button
                    onClick={() => {
                      setSelectedDealer(null);
                      setDealerSearchQuery('');
                    }}
                    className="text-[10px] font-bold text-purple-600 hover:underline cursor-pointer"
                  >
                    Change
                  </button>
                )}
              </div>

              {!selectedDealer ? (
                <div className="space-y-1.5">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search dealer or firm name (e.g. Banai, Vishal, Dhage)..."
                      value={dealerSearchQuery}
                      onChange={(e) => setDealerSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-xs"
                    />
                  </div>

                  {/* Dealer List Selection - Compact Rows with Smaller Font */}
                  <div className="max-h-52 overflow-y-auto space-y-1 bg-white p-1 rounded-lg border border-slate-200">
                    {filteredDealers.length === 0 ? (
                      <div className="p-4 text-center text-slate-500 text-xs font-medium space-y-1">
                        <p className="font-bold text-slate-700">
                          {!isAdmin(profile)
                            ? "तुम्ही नोंदणी केलेला कोणताही डीलर आढळला नाही."
                            : "निवडलेल्या ऑफिसरने नोंदणी केलेला कोणताही डीलर आढळला नाही."}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {!isAdmin(profile)
                            ? "ऑर्डर टाकण्यासाठी कृपया प्रथम 'Dealer' मेनूमध्ये जाऊन डीलर नोंदणी करा."
                            : "कृपया दुसरा ऑफिसर निवडा किंवा डीलर नाव तपासा."}
                        </p>
                      </div>
                    ) : (
                      filteredDealers.map((d) => (
                        <div
                          key={d.id}
                          onClick={() => setSelectedDealer(d)}
                          className="p-1.5 px-2 rounded-lg hover:bg-purple-50 border border-slate-100 hover:border-purple-200 cursor-pointer transition flex justify-between items-center"
                        >
                          <div className="min-w-0 pr-2">
                            <p className="text-[11px] font-bold text-slate-900 truncate leading-tight">{d.firmName}</p>
                            <p className="text-[9.5px] text-slate-500 font-medium truncate">
                              {d.proprietorName ? `${d.proprietorName} • ` : ''}
                              {d.contactNumber ? `${d.contactNumber} • ` : ''}
                              {d.village}
                            </p>
                          </div>
                          <span className="text-[9.5px] font-bold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded shrink-0 font-mono">
                            {d.dealerCode || '001'}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                /* Selected Dealer Banner */
                <div className="bg-white p-2 px-3 rounded-lg border border-purple-300 shadow-2xs flex justify-between items-center">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-black text-slate-900 truncate">{selectedDealer.firmName}</span>
                      <span className="text-[9.5px] font-bold text-purple-700 bg-purple-50 px-1.5 py-0.2 rounded font-mono">
                        {selectedDealer.dealerCode}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-600 truncate">
                      {selectedDealer.proprietorName ? `Prop: ${selectedDealer.proprietorName} | ` : ''}
                      {selectedDealer.contactNumber ? `Phone: ${selectedDealer.contactNumber} | ` : ''}
                      Loc: {selectedDealer.village}
                    </p>
                  </div>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 ml-2" />
                </div>
              )}
            </div>

            {/* STEP 2: SELECT PRODUCT & PACKING FROM PRICE LIST */}
            <div className="space-y-2 bg-purple-50/50 p-2.5 rounded-xl border border-purple-200">
              <div className="flex justify-between items-center">
                <label className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                  <span>2. Select Product from Price List ({filteredProducts.length}/{products.length}) *</span>
                </label>
                {selectedProduct && (
                  <span className="text-[10px] bg-purple-600 text-white font-bold px-2 py-0.5 rounded-full">
                    {getCleanGradeName(selectedProduct)}
                  </span>
                )}
              </div>

              {!selectedDealer && (
                <div className="bg-amber-50 p-2 rounded-lg border border-amber-200 text-amber-800 text-[11px] font-medium flex items-center justify-between">
                  <span>💡 टीप: तुम्ही प्रथम प्रॉडक्ट्स सिलेक्ट करू शकता, ऑर्डर सेव्ह करण्यापूर्वी वरील लिस्ट मधून डीलर निवडा.</span>
                </div>
              )}

              {/* Category Filter Chips */}
              <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
                <button
                  type="button"
                  onClick={() => setProductCategoryFilter('all')}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-bold shrink-0 transition cursor-pointer",
                    productCategoryFilter === 'all'
                      ? "bg-purple-600 text-white shadow-2xs"
                      : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                  )}
                >
                  All ({products.length})
                </button>
                {productCategories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setProductCategoryFilter(cat)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-bold shrink-0 transition cursor-pointer truncate max-w-[130px]",
                      productCategoryFilter === cat
                        ? "bg-purple-600 text-white shadow-2xs"
                        : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Product Search & Dropdown */}
              <div className="space-y-1.5">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search product (उदा. 19:19:19, 0:52:34, Microgrip, Combi)..."
                    value={productSearchQuery}
                    onChange={(e) => setProductSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-8 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-xs"
                  />
                  {productSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setProductSearchQuery('')}
                      className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Filtered Products Compact Scrollable List */}
                <div className="max-h-40 overflow-y-auto space-y-1 bg-white p-1 rounded-lg border border-slate-200">
                  {filteredProducts.length === 0 ? (
                    <div className="text-center py-3">
                      <p className="text-xs text-slate-400">कोणतेही प्रॉडक्ट सापडले नाही.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setProductSearchQuery('');
                          setProductCategoryFilter('all');
                        }}
                        className="mt-1 text-[11px] font-bold text-purple-600 hover:underline cursor-pointer"
                      >
                        सर्व प्रॉडक्ट्स दाखवा ({products.length})
                      </button>
                    </div>
                  ) : (
                    filteredProducts.map((p) => {
                      const cleanName = getCleanGradeName(p);
                      const isSelected = selectedProduct?.id === p.id;
                      const g = (p.groupName || '').toLowerCase();
                      const isBC = g.includes('group b') || g.includes('group c') || g.includes('micronutrient') || g.includes('growth regulator') || g.includes('pgr') || /microgrip|bw\s*combi|nutrijet/i.test(p.brandName || '') || /microgrip|bw\s*combi|nutrijet/i.test(p.gradeName || '');
                      return (
                        <div
                          key={p.id}
                          onClick={() => handleSelectProduct(p)}
                          className={cn(
                            "p-1.5 px-2 rounded-lg cursor-pointer transition flex justify-between items-center text-[11px]",
                            isSelected
                              ? "bg-purple-100 border border-purple-400 text-purple-950 font-bold"
                              : "hover:bg-purple-50/70 border border-transparent text-slate-700"
                          )}
                        >
                          <div className="min-w-0 pr-2 flex items-center gap-1.5">
                            {isSelected ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-purple-700 shrink-0" />
                            ) : (
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                            )}
                            <div className="truncate">
                              {isBC ? (
                                <span className="font-black text-amber-800 text-xs">{cleanName}</span>
                              ) : (
                                <>
                                  {p.brandName && (
                                    <span className="font-bold text-amber-700 text-[10.5px] mr-1">{p.brandName}</span>
                                  )}
                                  <span className="font-black text-sky-800">{cleanName}</span>
                                </>
                              )}
                              {p.groupName && (
                                <span className="text-[9.5px] text-slate-400 block truncate">{p.groupName}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[9.5px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                              {p.packings?.length || 0} Packings
                            </span>
                            {isSelected && (
                              <span className="text-[9.5px] bg-purple-600 text-white font-bold px-1.5 py-0.5 rounded">
                                निवडले ✓
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Quick Packing & Quantity Picker when Product is Selected */}
              {selectedProduct ? (
                <div className="bg-white p-2.5 rounded-xl border border-purple-300 shadow-xs space-y-2">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-1.5">
                    <div>
                      <span className="text-xs font-black text-sky-800">
                        {getCleanGradeName(selectedProduct)}
                      </span>
                      {selectedProduct.groupName && (
                        <span className="text-[9.5px] text-slate-400 ml-1.5">({selectedProduct.groupName})</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedProduct(null)}
                      className="text-[10px] font-bold text-rose-600 hover:underline cursor-pointer"
                    >
                      Clear Selection
                    </button>
                  </div>

                  {/* Packing Selection Buttons - Compact Chips */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-600 block mb-1">
                      पॅकिंग निवडा (Select Packing):
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {selectedProduct.packings?.map((pk) => {
                        const pkComputedRate = computeProductRate(selectedProduct, pk.packingSize);
                        return (
                          <button
                            key={pk.packingSize}
                            type="button"
                            onClick={() => handleSelectPacking(pk.packingSize)}
                            className={cn(
                              "px-2.5 py-1 rounded text-[10px] font-bold transition border cursor-pointer active:scale-95 inline-flex items-center gap-1",
                              selectedPacking === pk.packingSize
                                ? "bg-purple-600 text-white border-purple-600 shadow-2xs"
                                : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                            )}
                          >
                            <span>{pk.packingSize}</span>
                            <span className={cn(
                              "font-mono text-[9px] px-1 py-0.2 rounded font-black",
                              selectedPacking === pk.packingSize ? "bg-white/20 text-white" : "bg-black/5 text-slate-800"
                            )}>
                              ₹{pkComputedRate}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Rate, Quantity, Discount & Add Item Row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end pt-1">
                    <div>
                      <label className="text-[10px] font-bold text-slate-600 block mb-0.5">दर (Rate ₹):</label>
                      <input
                        type="number"
                        value={itemRate}
                        onChange={(e) => setItemRate(e.target.value === '' ? '' : Number(e.target.value))}
                        className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono font-bold focus:outline-none focus:ring-1 focus:ring-purple-500"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-600 block mb-0.5">नग (Quantity *):</label>
                      <input
                        type="number"
                        min="1"
                        value={itemQuantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          setItemQuantity(val === '' ? '' : Number(val));
                        }}
                        onBlur={() => {
                          if (itemQuantity === '' || Number(itemQuantity) < 1) {
                            setItemQuantity(1);
                          }
                        }}
                        className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono font-bold text-center focus:outline-none focus:ring-1 focus:ring-purple-500"
                        placeholder="1"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between items-center mb-0.5">
                        <label className="text-[10px] font-bold text-slate-600">सूट (Discount):</label>
                        <div className="flex text-[9px] font-bold bg-slate-100 rounded border border-slate-200 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => setDiscountType('percent')}
                            className={cn(
                              "px-1 py-0.2 cursor-pointer transition",
                              discountType === 'percent' ? "bg-purple-600 text-white" : "text-slate-500"
                            )}
                          >
                            %
                          </button>
                          <button
                            type="button"
                            onClick={() => setDiscountType('flat')}
                            className={cn(
                              "px-1 py-0.2 cursor-pointer transition",
                              discountType === 'flat' ? "bg-purple-600 text-white" : "text-slate-500"
                            )}
                          >
                            ₹
                          </button>
                        </div>
                      </div>
                      <input
                        type="number"
                        min="0"
                        value={itemDiscount}
                        onChange={(e) => setItemDiscount(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
                        className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono font-bold text-center focus:outline-none focus:ring-1 focus:ring-purple-500"
                        placeholder={discountType === 'percent' ? "0%" : "₹0"}
                      />
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={handleAddItemToOrder}
                        className="w-full py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-xs cursor-pointer flex items-center justify-center gap-1 active:scale-95 h-[30px]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>+ ॲड करा (Add Item)</span>
                      </button>
                    </div>
                  </div>

                  {/* Live Calculation Preview */}
                  {(() => {
                    const r = Number(itemRate) || 0;
                    const q = typeof itemQuantity === 'string' && itemQuantity === '' ? 1 : Math.max(1, Number(itemQuantity) || 1);
                    const gross = r * q;
                    const d = Number(itemDiscount) || 0;
                    const dAmt = discountType === 'percent' ? Math.round((gross * d) / 100) : d;
                    const net = Math.max(0, gross - dAmt);
                    return (
                      <div className="flex justify-between items-center text-[10px] font-bold text-slate-500 pt-0.5 border-t border-slate-100">
                        <span>Base: <span className="font-mono">₹{gross.toLocaleString()}</span></span>
                        {dAmt > 0 && (
                          <span className="text-rose-600 font-medium">सूट: -₹{dAmt.toLocaleString()}</span>
                        )}
                        <span>एकूण (Subtotal): <span className="font-mono text-purple-700 font-black text-xs">₹{net.toLocaleString()}</span></span>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="bg-white/80 p-2 rounded-lg border border-dashed border-purple-200 text-center text-[11px] text-purple-700 font-medium">
                  👉 वरील लिस्ट मधून प्रॉडक्ट वर क्लिक करा (Click any product above to configure packing and quantity)
                </div>
              )}
            </div>

            {/* STEP 3: ADDED ITEMS SUMMARY - Compact Table Display */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-xs font-black text-slate-800">
                  3. Items Added ({orderItems.length})
                </span>
                {orderItems.length > 0 && (
                  <span className="text-xs font-black text-purple-700 font-mono">
                    Total: ₹{totalBillAmount.toLocaleString()}
                  </span>
                )}
              </div>

              {orderItems.length === 0 ? (
                <div className="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-3 text-center text-slate-400 text-xs font-medium">
                  No products added yet. Select product from above to add.
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden bg-white text-xs max-h-56 overflow-y-auto space-y-1">
                  <table className="w-full text-left">
                    <thead className="bg-slate-100 text-[10px] font-black text-slate-600 uppercase">
                      <tr>
                        <th className="p-1.5 pl-2.5"># Product</th>
                        <th className="p-1.5 text-center">Packing</th>
                        <th className="p-1.5 text-center">Qty</th>
                        <th className="p-1.5 text-right">Rate</th>
                        <th className="p-1.5 text-right">Disc</th>
                        <th className="p-1.5 text-right">Subtotal</th>
                        <th className="p-1.5 pr-2.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[11px]">
                      {orderItems.map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="p-1.5 pl-2.5 font-bold text-sky-700 truncate max-w-[150px]">
                            {idx + 1}. {item.gradeName || item.productName}
                          </td>
                          <td className="p-1.5 text-center text-slate-500 font-medium">{item.packingSize}</td>
                          <td className="p-1.5 text-center font-mono font-bold text-slate-800">{item.quantity}</td>
                          <td className="p-1.5 text-right font-mono text-slate-600">₹{item.rate}</td>
                          <td className="p-1.5 text-right font-mono text-rose-600">
                            {item.discount ? `-₹${item.discount}` : '-'}
                          </td>
                          <td className="p-1.5 text-right font-mono font-bold text-purple-700">₹{item.subtotal.toLocaleString()}</td>
                          <td className="p-1.5 pr-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(idx)}
                              className="p-1 text-slate-400 hover:text-rose-600 transition cursor-pointer"
                              title="Remove"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-purple-50 font-black text-purple-900 border-t border-purple-200 text-xs">
                      <tr>
                        <td colSpan={2} className="p-1.5 pl-2.5 text-slate-700">Total:</td>
                        <td className="p-1.5 text-center font-mono">{totalBagsQuantity} Nos.</td>
                        <td colSpan={2} className="p-1.5 text-right text-[10px] text-rose-700">
                          {allDiscountsTotal > 0 ? `Disc: -₹${allDiscountsTotal.toLocaleString()}` : ''}
                        </td>
                        <td className="p-1.5 text-right font-mono text-sm">₹{totalBillAmount.toLocaleString()}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>

                  {/* Extra Order-level Discount Input */}
                  <div className="flex justify-between items-center px-2.5 py-1.5 bg-slate-50 border-t border-slate-100 text-xs">
                    <span className="font-bold text-slate-700 text-[11px]">Extra Order Discount (₹):</span>
                    <input
                      type="number"
                      min="0"
                      value={orderDiscount}
                      onChange={(e) => setOrderDiscount(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
                      placeholder="0"
                      className="w-24 px-2 py-0.5 border border-slate-300 rounded text-xs font-mono font-bold text-right focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Error Message Display */}
            {formError && (
              <div className="p-2.5 px-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-800 text-xs font-bold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{formError}</span>
              </div>
            )}

            {/* Modal Actions */}
            <div className="pt-2 flex justify-end items-center gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowNewOrderModal(false);
                  setFormError(null);
                }}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer transition active:scale-95"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGenerateOrder}
                disabled={isSubmittingOrder}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-xs font-bold text-white shadow-xs transition cursor-pointer flex items-center gap-1.5 active:scale-95"
              >
                {isSubmittingOrder ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{editingOrderId ? 'Updating Order...' : 'Generating Order...'}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{editingOrderId ? 'Update Order (बदल सेव्ह करा)' : 'Generate Order'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== SUCCESS & WHATSAPP SHARE MODAL ===================== */}
      {successOrder && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-4 sm:p-5 shadow-2xl border border-slate-200 text-center space-y-3">
            <div className="w-11 h-11 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div>
              <h3 className="text-base font-black text-slate-900">Order Generated Successfully!</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">Order No: {successOrder.orderNumber}</p>
            </div>

            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-left text-xs space-y-1">
              <p className="font-black text-slate-900 truncate">Dealer: {successOrder.dealerName}</p>
              <p className="text-slate-700 font-bold">Total Quantity: <span className="font-mono font-black text-emerald-700">{successOrder.totalQuantity} Nos.</span></p>
              <p className="text-slate-500 text-[10.5px]">Status: ⏳ Pending Approval</p>
            </div>

            <div className="space-y-1.5 pt-1">
              <button
                onClick={() => {
                  handleShareOnWhatsApp(successOrder);
                  setSuccessOrder(null);
                }}
                disabled={isGeneratingImage}
                className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 shadow-xs transition active:scale-95 cursor-pointer"
              >
                {isGeneratingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                <span>Share Order Photo on WhatsApp</span>
              </button>

              <button
                onClick={() => handleCopyOrderText(successOrder)}
                className="w-full py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer"
              >
                {copiedOrderId === successOrder.id ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedOrderId === successOrder.id ? "Order Copied to Clipboard!" : "Copy Order Text for WhatsApp"}</span>
              </button>

              <button
                onClick={() => setSuccessOrder(null)}
                className="w-full py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== VIEW ORDER DETAILS MODAL ===================== */}
      {selectedOrderDetails && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-lg w-full p-4 sm:p-5 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-3">
            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-black text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                    {selectedOrderDetails.orderNumber}
                  </span>
                  {/* Status in Details Modal */}
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tight",
                      (selectedOrderDetails.status === 'pending_approval' || selectedOrderDetails.status === 'pending') && "bg-amber-50 text-amber-800 border border-amber-200",
                      (selectedOrderDetails.status === 'complete' || selectedOrderDetails.status === 'approved' || selectedOrderDetails.status === 'delivered') && "bg-emerald-50 text-emerald-700 border border-emerald-200",
                      (selectedOrderDetails.status === 'dispatched' || selectedOrderDetails.status === 'confirmed') && "bg-blue-50 text-blue-700 border border-blue-200",
                      selectedOrderDetails.status === 'collected' && "bg-green-100 text-green-800 border border-green-300"
                    )}
                  >
                    {selectedOrderDetails.status === 'complete' || selectedOrderDetails.status === 'approved' || selectedOrderDetails.status === 'delivered' ? 'Complete (Approved)' : selectedOrderDetails.status === 'dispatched' ? 'Dispatched' : selectedOrderDetails.status === 'collected' ? 'Collected' : 'Pending Approval'}
                  </span>
                </div>
                <h3 className="text-sm font-black text-slate-900 mt-1">Order Details</h3>
              </div>
              <button onClick={() => setSelectedOrderDetails(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Dealer Info */}
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-xs space-y-0.5">
              <p className="font-black text-slate-900 text-sm truncate">{selectedOrderDetails.dealerName}</p>
              {selectedOrderDetails.farmerName && <p className="text-slate-600 text-[11px]">Proprietor: {selectedOrderDetails.farmerName}</p>}
              {selectedOrderDetails.dealerContact && <p className="text-slate-600 font-mono text-[11px]">Phone: {selectedOrderDetails.dealerContact}</p>}
              {selectedOrderDetails.dealerVillage && (
                <p className="text-slate-500 text-[10.5px]">Location: {selectedOrderDetails.dealerVillage}{selectedOrderDetails.dealerDistrict ? `, ${selectedOrderDetails.dealerDistrict}` : ''}</p>
              )}
            </div>

            {/* Products Table */}
            <div>
              <p className="text-xs font-black text-slate-800 mb-1.5">Ordered Products:</p>
              <div className="border border-slate-200 rounded-xl overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead className="bg-slate-100 font-black text-slate-700 text-[10.5px]">
                    <tr>
                      <th className="p-1.5 pl-2">Product</th>
                      <th className="p-1.5 text-center">Qty</th>
                      <th className="p-1.5 text-right">Rate (₹)</th>
                      <th className="p-1.5 text-right">Total (₹)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-[11px]">
                    {selectedOrderDetails.items?.map((it, idx) => (
                      <tr key={idx} className="font-semibold text-slate-800">
                        <td className="p-1.5 pl-2">
                          <p className="font-bold text-sky-700">{it.gradeName || it.productName}</p>
                          <span className="text-[9.5px] text-slate-400">{it.packingSize}</span>
                        </td>
                        <td className="p-1.5 text-center font-mono">{it.quantity}</td>
                        <td className="p-1.5 text-right font-mono">₹{it.rate}</td>
                        <td className="p-1.5 text-right font-mono font-bold">₹{it.subtotal.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-purple-50 font-black text-purple-900 border-t border-purple-200 text-xs">
                    {selectedOrderDetails.discountAmount && selectedOrderDetails.discountAmount > 0 ? (
                      <>
                        <tr>
                          <td colSpan={3} className="p-1.5 text-right text-slate-600 font-bold">Gross Amount:</td>
                          <td className="p-1.5 text-right font-mono">₹{(selectedOrderDetails.grossAmount || (selectedOrderDetails.totalAmount + selectedOrderDetails.discountAmount)).toLocaleString()}</td>
                        </tr>
                        <tr>
                          <td colSpan={3} className="p-1.5 text-right text-rose-700 font-bold">Discount Applied:</td>
                          <td className="p-1.5 text-right font-mono text-rose-700 font-bold">-₹{selectedOrderDetails.discountAmount.toLocaleString()}</td>
                        </tr>
                      </>
                    ) : null}
                    <tr className="border-t border-purple-200">
                      <td colSpan={3} className="p-1.5 text-right uppercase">Net Bill Amount:</td>
                      <td className="p-1.5 text-right font-mono text-sm font-bold text-purple-950">₹{selectedOrderDetails.totalAmount.toLocaleString()}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Status History & Approvals */}
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-[11px] space-y-0.5 text-slate-600">
              <p>Booked by: <span className="font-bold text-slate-900">{selectedOrderDetails.createdByName}</span></p>
              <p>Booking Date: <span className="font-mono">{new Date(selectedOrderDetails.createdAt).toLocaleString('en-IN')}</span></p>
              {selectedOrderDetails.approvedBy && (
                <p>Approved by: <span className="font-bold text-slate-900">{selectedOrderDetails.approvedBy}</span> ({new Date(selectedOrderDetails.approvedAt || '').toLocaleDateString('en-IN')})</p>
              )}
              {selectedOrderDetails.deliveredAt && (
                <p>Delivered on: <span className="font-bold text-emerald-700">{new Date(selectedOrderDetails.deliveredAt).toLocaleString('en-IN')}</span></p>
              )}
            </div>

            {/* Actions Inside Modal */}
            <div className="pt-1 flex flex-wrap gap-2">
              {/* Direct Photo Share on WhatsApp */}
              <button
                onClick={() => handleShareOnWhatsApp(selectedOrderDetails)}
                disabled={isGeneratingImage}
                className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
              >
                {isGeneratingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                <span>Share Order Photo</span>
              </button>

              {/* Copy Order Text */}
              <button
                onClick={() => handleCopyOrderText(selectedOrderDetails)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95 shrink-0"
                title="Copy Order Text for WhatsApp"
              >
                {copiedOrderId === selectedOrderDetails.id ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedOrderId === selectedOrderDetails.id ? "Copied!" : "Copy"}</span>
              </button>

              {(selectedOrderDetails.status === 'pending_approval' || selectedOrderDetails.status === 'pending') && isAdmin(profile) && (
                <button
                  onClick={() => handleApproveOrder(selectedOrderDetails)}
                  className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Approve (Complete)</span>
                </button>
              )}

              {(selectedOrderDetails.status === 'dispatched' || selectedOrderDetails.status === 'confirmed') && (
                <button
                  onClick={() => handleMarkDelivered(selectedOrderDetails)}
                  className="flex-1 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95"
                >
                  <PackageCheck className="w-3.5 h-3.5" />
                  <span>Delivered (Complete)</span>
                </button>
              )}

              {/* Delete Order Button */}
              <button
                onClick={() => handleDelete(selectedOrderDetails)}
                className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95 shrink-0"
                title="Delete Order"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
