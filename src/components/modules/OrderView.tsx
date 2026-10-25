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
  getDocs,
  updateDoc,
  deleteDoc 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { softDeleteRecord, logAudit } from '../../lib/dataService';
import { Language } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { cn, toTitleCase } from '../../lib/utils';
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
  RefreshCw
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

export interface OrderProductLine {
  productId: string;
  productName: string;
  brandName?: string;
  gradeName?: string;
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
  status: 'pending' | 'pending_approval' | 'confirmed' | 'dispatched' | 'delivered' | 'collected';
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
  dealerOfficerId?: string;
  dealerOfficerName?: string;
  createdByUid?: string;
  createdAt: string;
  updatedAt?: string;
  updatedByName?: string;
  isArchived?: boolean;
}

interface SavedDealer {
  id: string;
  firmName: string;
  proprietorName: string;
  contactNumber: string;
  dealerCode: string;
  village: string;
  district: string;
  userId?: string;
  ownerId?: string;
  dealerOfficerId?: string;
  dealerOfficerName?: string;
  createdByUid?: string;
  createdByName?: string;
  userCode?: string;
  loginId?: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const OrderView: React.FC<Props> = ({ profile }) => {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [dealers, setDealers] = useState<SavedDealer[]>([]);
  const [products, setProducts] = useState<DynamicPriceProduct[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [syncStatus, setSyncStatus] = useState<'online' | 'offline' | 'quota_hit'>('online');
  
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

  // Load Orders from Firestore (Centralized Sync: Admin sees all, Officers see their authorized orders)
  useEffect(() => {
    const q = query(
      collection(db, 'orders'),
      orderBy('createdAt', 'desc'),
      limit(isAdmin(profile) ? 500 : 300)
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: OrderItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        if (!data.isArchived && (isAdmin(profile) || isUserRecord(data, profile))) {
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
            items: data.items || [],
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
            dealerOfficerId: data.dealerOfficerId,
            dealerOfficerName: data.dealerOfficerName,
            createdByUid: data.createdByUid,
            loginId: data.loginId,
            userCode: data.userCode,
            createdByName: data.createdByName || 'User',
            createdAt: data.createdAt || new Date().toISOString(),
            isArchived: data.isArchived || false,
          });
        }
      });
      setOrders(list);
      setSyncStatus('online');
    }, (error: any) => {
      if (error.code === 'resource-exhausted') setSyncStatus('quota_hit');
      else setSyncStatus('offline');
      handleFirestoreError(error, OperationType.LIST, 'orders');
    });
    return () => unsub();
  }, [profile]);

  // Load Saved Dealers from Firestore (and cache in localStorage for fast offline access)
  useEffect(() => {
    const fetchDealers = async () => {
      try {
        const cached = localStorage.getItem('blackworm_all_dealers');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const list: SavedDealer[] = parsed.map((data: any) => ({
              id: data.id,
              firmName: data.firmName || 'Unnamed Firm',
              proprietorName: data.proprietorName || '',
              contactNumber: data.contactNumber || '',
              dealerCode: data.dealerCode || '',
              village: data.village || '',
              district: data.district || '',
              userId: data.userId,
              ownerId: data.ownerId,
              dealerOfficerId: data.dealerOfficerId,
              dealerOfficerName: data.dealerOfficerName,
              createdByUid: data.createdByUid,
              createdByName: data.createdByName,
              userCode: data.userCode,
              loginId: data.loginId,
            }));
            list.sort((a, b) => (a.firmName || '').localeCompare(b.firmName || ''));
            setDealers(list);
          }
        }

        const q = query(
          collection(db, 'dealers_application'),
          orderBy('createdAt', 'desc'),
          limit(isAdmin(profile) ? 500 : 300)
        );
        const snap = await getDocs(q);
        const list: SavedDealer[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          if (!data.isArchived && (isAdmin(profile) || isUserRecord(data, profile))) {
            list.push({
              id: d.id,
              firmName: data.firmName || 'Unnamed Firm',
              proprietorName: data.proprietorName || '',
              contactNumber: data.contactNumber || '',
              dealerCode: data.dealerCode || '',
              village: data.village || '',
              district: data.district || '',
              userId: data.userId || data.ownerId || '',
              ownerId: data.ownerId || '',
              dealerOfficerId: data.dealerOfficerId || data.userId || '',
              dealerOfficerName: data.dealerOfficerName || data.officerName || data.createdByName || '',
              createdByUid: data.createdByUid || data.createdByUserId || '',
              createdByName: data.createdByName || '',
              userCode: data.userCode || '',
              loginId: data.loginId || '',
            });
          }
        });
        list.sort((a, b) => (a.firmName || '').localeCompare(b.firmName || ''));
        setDealers(list);
        try {
          localStorage.setItem('blackworm_all_dealers', JSON.stringify(list));
        } catch {}
      } catch (error: any) {
        if (error.code === 'resource-exhausted') setSyncStatus('quota_hit');
        handleFirestoreError(error, OperationType.LIST, 'dealers_application');
      }
    };
    fetchDealers();
  }, [profile]);

  // Load Products from Price List (with fallback to OFFICIAL_REFERENCE_DATA)
  useEffect(() => {
    const fetchProducts = async () => {
      const q = query(collection(db, 'products_pricelist_v2'));
      try {
        const snap = await getDocs(q);
        if (!snap.empty) {
          const list: DynamicPriceProduct[] = [];
          snap.forEach((d) => {
            const data = d.data() as any;
            if (!data.isArchived) {
              list.push({ ...data, id: d.id });
            }
          });
          list.sort((a, b) => (a.orderIndex || 999) - (b.orderIndex || 999));
          setProducts(list);
        } else {
          const fallback = OFFICIAL_REFERENCE_DATA.map((p, idx) => ({
            ...p,
            id: `ref_${idx}`,
          }));
          setProducts(fallback);
        }
      } catch (error: any) {
        if (error.code === 'resource-exhausted') setSyncStatus('quota_hit');
      }
    };
    fetchProducts();
  }, []);

  // Filter Dealers in New Order Dropdown
  const filteredDealers = dealers.filter((d) => {
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
    setProductSearchQuery(`${prod.brandName} ${prod.gradeName}`);
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

    const newLine: OrderProductLine = {
      productId: selectedProduct.id || `prod_${Date.now()}`,
      productName: `${selectedProduct.brandName} ${selectedProduct.gradeName}`.trim(),
      brandName: selectedProduct.brandName || '',
      gradeName: selectedProduct.gradeName || '',
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

      const newLine: OrderProductLine = {
        productId: selectedProduct.id || `prod_${Date.now()}`,
        productName: `${selectedProduct.brandName} ${selectedProduct.gradeName}`.trim(),
        brandName: selectedProduct.brandName || '',
        gradeName: selectedProduct.gradeName || '',
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

        await setDoc(doc(db, 'orders', editingOrderId), updatedOrderPayload, { merge: true });

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
          message: `ऑर्डर ${existingOrder?.orderNumber || ''} मधील बदल यशस्वीरित्या सेव्ह झाले आहेत.`,
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
        ownerId: dealerToUse.userId || dealerToUse.ownerId || dealerToUse.dealerOfficerId || profile.uid || '',
        userId: dealerToUse.userId || dealerToUse.ownerId || dealerToUse.dealerOfficerId || profile.uid || '',
        dealerOfficerId: dealerToUse.dealerOfficerId || dealerToUse.userId || profile.uid || '',
        dealerOfficerName: dealerToUse.dealerOfficerName || dealerToUse.createdByName || profile.fullName || '',
        createdByUid: profile.uid || '',
        loginId: profile.loginId || '',
        userCode: profile.userCode || '',
        createdByName: profile.fullName || 'Officer',
        createdAt: new Date().toISOString(),
        isArchived: false,
      };

      await setDoc(doc(db, 'orders', orderId), newOrder);

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

  // WhatsApp & Clipboard Message Generator (Dealer, Order, Quantity, Date focused)
  const generateWhatsAppMessage = (order: OrderItem) => {
    const dateStr = new Date(order.createdAt).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

    let itemsListText = '';
    if (order.items && order.items.length > 0) {
      itemsListText = order.items
        .map(
          (it, idx) =>
            `${idx + 1}. *${it.productName}* (${it.packingSize}) - *${it.quantity} Nos.*`
        )
        .join('\n');
    } else {
      itemsListText = `1. Order Items (Qty: ${order.totalQuantity} Nos.)`;
    }

    const message = `🌿 *BLACKWORM AGRITECH PVT LTD* 🌿
📦 *ORDER BOOKING DETAILS*
━━━━━━━━━━━━━━━━━━━━━
*Order No:* ${order.orderNumber}
*Date:* ${dateStr}
*Dealer / Shop:* ${order.dealerName}
${order.cropName ? `*Crop / पीक:* ${order.cropName}\n` : ''}${order.farmerName ? `*Proprietor:* ${order.farmerName}\n` : ''}${order.dealerContact ? `*Contact:* ${order.dealerContact}\n` : ''}${order.dealerVillage ? `*Location:* ${order.dealerVillage}${order.dealerDistrict ? `, ${order.dealerDistrict}` : ''}\n` : ''}
📋 *ORDERED PRODUCTS & QUANTITY:*
${itemsListText}

━━━━━━━━━━━━━━━━━━━━━
*TOTAL QUANTITY:* *${order.totalQuantity} Nos.*
*BOOKED BY:* ${order.createdByName || 'Officer'}
━━━━━━━━━━━━━━━━━━━━━`;

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

        window.open(waUrl, '_blank');
      } catch (err: any) {
        console.error('Error sharing order photo:', err);
        const text = generateWhatsAppMessage(order);
        const cleanPhone = (order.dealerContact || '').replace(/\D/g, '').slice(-10);
        const waUrl =
          cleanPhone && cleanPhone.length === 10
            ? `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(text)}`
            : `https://wa.me/?text=${encodeURIComponent(text)}`;
        window.open(waUrl, '_blank');
      } finally {
        setIsGeneratingImage(false);
      }
    }, 150);
  };

  // Workflow Action 1: Approve Order & Move to Dispatch
  const handleApproveOrder = async (order: OrderItem) => {
    if (!isAdmin(profile)) return;

    const updatedData = {
      status: 'dispatched' as const,
      approvedBy: profile.fullName || 'Admin',
      approvedAt: new Date().toISOString(),
      dispatchedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(doc(db, 'orders', order.id), updatedData);
    await logAudit(
      'UPDATE',
      'orders',
      order.id,
      `Approved and Dispatched order ${order.orderNumber} by ${profile.fullName}`,
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

  // Filter Orders List (Real-time sync across all devices, strictly Officer-wise for non-admin)
  const filteredOrders = orders.filter((o) => {
    // 1. Officer-wise Security: Non-admin users strictly only see their own orders
    if (!isAdmin(profile)) {
      if (!isUserRecord(o, profile)) {
        return false;
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

      {/* Sync Status Banner */}
      <div className={cn(
        "p-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 no-print",
        syncStatus === 'quota_hit' ? "bg-red-50 border-red-200 text-red-900" :
        syncStatus === 'offline' ? "bg-amber-50 border-amber-200 text-amber-900" :
        "bg-purple-50 border-purple-200 text-purple-900"
      )}>
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-1.5 h-1.5 rounded-full",
            syncStatus === 'quota_hit' ? "bg-red-600 animate-pulse" :
            syncStatus === 'offline' ? "bg-amber-500 animate-pulse" :
            "bg-purple-500"
          )} />
          <span className="font-bold">
            {syncStatus === 'quota_hit' ? (
              <span className="flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> Firestore Read Quota Exceeded. Some data may be missing until tomorrow.</span>
            ) : syncStatus === 'offline' ? (
              <span className="flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Connection Lost. Working offline.</span>
            ) : (
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-purple-600" /> All data is synced and up to date.</span>
            )}
          </span>
        </div>
        <div className="text-[10px] font-black uppercase tracking-tighter opacity-50">
          {syncStatus === 'online' ? '● Connected' : '○ Disconnected'}
        </div>
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
        {/* Very small filter buttons matching the compact status badges */}
        <div className="flex gap-1 overflow-x-auto pb-0.5 no-scrollbar items-center">
          {[
            { id: 'all', label: 'All' },
            { id: 'pending', label: 'Pending' },
            { id: 'dispatched', label: 'Dispatched' },
            { id: 'delivered', label: 'Delivered' },
            { id: 'collected', label: 'Collected' },
          ].map((st) => (
            <button
              key={st.id}
              onClick={() => setStatusFilter(st.id)}
              className={cn(
                "px-2 py-0.5 rounded text-[9.5px] font-bold transition whitespace-nowrap cursor-pointer active:scale-95",
                statusFilter === st.id
                  ? "bg-purple-600 text-white shadow-2xs"
                  : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              )}
            >
              {st.label}
            </button>
          ))}
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
            const isDispatched = o.status === 'dispatched' || o.status === 'confirmed';
            const isDelivered = o.status === 'delivered';
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
                          isDispatched && "bg-blue-50 text-blue-700 border border-blue-200",
                          isDelivered && "bg-emerald-50 text-emerald-700 border border-emerald-200",
                          isCollected && "bg-green-100 text-green-800 border border-green-300"
                        )}
                      >
                        {isPending && <Clock className="w-2.5 h-2.5" />}
                        {isDispatched && <Truck className="w-2.5 h-2.5" />}
                        {isDelivered && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {isCollected && <PackageCheck className="w-2.5 h-2.5" />}
                        <span>
                          {isPending && 'Pending'}
                          {isDispatched && 'Dispatched'}
                          {isDelivered && 'Delivered'}
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
                          <span className="truncate pr-2">• {it.productName} ({it.packingSize})</span>
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

                  {/* Workflow Stage 1: Approve Order & Dispatch */}
                  {isPending && isAdmin(profile) && (
                    <button
                      onClick={() => handleApproveOrder(o)}
                      className="p-1 px-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-bold transition shadow-2xs cursor-pointer active:scale-95 flex items-center gap-1"
                      title="Approve Order"
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

      {/* Hidden receipt card container for generating WhatsApp Order Photo */}
      <div className="fixed -left-[9999px] top-0 pointer-events-none" aria-hidden="true">
        {capturingOrder && (
          <div
            ref={receiptCaptureRef}
            className="w-[420px] bg-white p-5 border-2 border-slate-900 rounded-2xl font-sans text-slate-900 space-y-3"
            style={{ width: '420px' }}
          >
            {/* Company Banner */}
            <div className="text-center border-b-2 border-slate-900 pb-2.5">
              <div className="inline-block px-3 py-0.5 rounded bg-purple-700 text-white font-black text-[11px] tracking-wider mb-1 shadow-xs">
                Blackworm Agri Tech Pvt Ltd
              </div>
              <p className="text-[9.5px] font-bold text-slate-500 uppercase tracking-wide">Quality Agricultural Inputs & Nutrition Solutions</p>
              <h2 className="text-base font-black text-slate-900 tracking-tight mt-0.5">ORDER BOOKING DETAILS</h2>
              <div className="flex justify-between items-center text-[10px] font-bold text-slate-600 mt-1 border-t border-slate-200 pt-1">
                <span>Order No: <strong className="font-mono text-purple-800 text-[11px]">{capturingOrder.orderNumber}</strong></span>
                <span>Date: {new Date(capturingOrder.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} {new Date(capturingOrder.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</span>
              </div>
            </div>

            {/* Complete Dealer & Order Information */}
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-[11px] space-y-1">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[9px] font-bold text-slate-400 block">Dealer / Firm Name</span>
                  <p className="font-black text-xs text-slate-900">{toTitleCase(capturingOrder.dealerName)}</p>
                </div>
                {capturingOrder.dealerCode && (
                  <span className="text-[10px] font-mono font-bold bg-white px-2 py-0.5 rounded border border-slate-200 text-purple-700">
                    Code: {capturingOrder.dealerCode}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-slate-200/60 text-[10.5px]">
                {capturingOrder.cropName && (
                  <p className="text-slate-700 col-span-2">
                    Crop / पीक: <strong className="text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded font-bold">{toTitleCase(capturingOrder.cropName)}</strong>
                  </p>
                )}
                {capturingOrder.farmerName && (
                  <p className="text-slate-700">Proprietor: <strong className="text-slate-900">{toTitleCase(capturingOrder.farmerName)}</strong></p>
                )}
                {capturingOrder.dealerContact && (
                  <p className="text-slate-700">Contact: <strong className="font-mono text-slate-900">{capturingOrder.dealerContact}</strong></p>
                )}
                {capturingOrder.dealerVillage && (
                  <p className="text-slate-700 col-span-2">Location: <strong className="text-slate-900">{toTitleCase(capturingOrder.dealerVillage)}{capturingOrder.dealerDistrict ? `, ${toTitleCase(capturingOrder.dealerDistrict)}` : ''}</strong></p>
                )}
                <p className="text-slate-700">Payment: <strong className="text-slate-900">{capturingOrder.paymentMode || 'Credit / Normal Terms'}</strong></p>
                <p className="text-slate-700">Booked By: <strong className="text-slate-900">{toTitleCase(capturingOrder.createdByName)}</strong></p>
              </div>

              {capturingOrder.approvedBy && (
                <div className="pt-1 border-t border-slate-200/60 text-[10px] text-blue-800 font-semibold">
                  Approved By: {toTitleCase(capturingOrder.approvedBy)} ({new Date(capturingOrder.approvedAt || '').toLocaleDateString('en-IN')})
                </div>
              )}
            </div>

            {/* Ordered Products Table (Strictly: Product Name, Packing, Quantity - NO PRICE / TOTAL PRICE) */}
            <div>
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="bg-slate-900 text-white font-black text-[10px] uppercase">
                    <th className="p-1.5 pl-2"># Product Name & Grade</th>
                    <th className="p-1.5 text-center w-24">Packing</th>
                    <th className="p-1.5 text-center w-24">Quantity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 border-b border-slate-200 font-semibold">
                  {capturingOrder.items?.map((it, idx) => (
                    <tr key={idx} className={idx % 2 === 1 ? "bg-slate-50/70" : ""}>
                      <td className="p-1.5 pl-2 font-bold text-slate-900 text-[11px]">{idx + 1}. {it.productName}</td>
                      <td className="p-1.5 text-center text-slate-600 text-[10px] font-bold">{it.packingSize}</td>
                      <td className="p-1.5 text-center font-mono font-black text-slate-900 text-xs">{it.quantity} Nos.</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-emerald-50 font-black text-emerald-950 text-[11px]">
                  <tr>
                    <td colSpan={2} className="p-2 pl-2 text-right uppercase">TOTAL QUANTITY:</td>
                    <td className="p-2 text-center font-mono font-black text-sm text-emerald-900">{capturingOrder.totalQuantity} Nos.</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Footer details */}
            <div className="pt-1.5 border-t border-slate-200 text-[9.5px] text-slate-500 flex justify-between items-center">
              <span>Booked by Officer: <strong>{capturingOrder.createdByName}</strong></span>
              <span>Blackworm Agri Tech Pvt Ltd</span>
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
              <div className="flex justify-between items-center">
                <label className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-purple-600" />
                  <span>1. Select Saved Dealer ({filteredDealers.length}) *</span>
                </label>
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
                      <p className="text-xs text-slate-400 text-center py-2.5">No dealers found.</p>
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
              <label className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                <span>2. Select Product from Price List ({filteredProducts.length}) *</span>
              </label>

              {!selectedDealer ? (
                <div className="bg-white/80 p-3 rounded-lg border border-dashed border-purple-300 text-center text-xs text-purple-800 font-bold">
                  👉 कृपया प्रथम वरील लिस्ट मधून डीलर निवडा (Please select a dealer above first)
                </div>
              ) : (
                <>
                  {/* Product Search & Dropdown */}
                  <div className="space-y-1.5">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search product name (e.g. Airawat 19:19:19, 0:52:34, CMB, Nitro King)..."
                        value={productSearchQuery}
                        onChange={(e) => {
                          setProductSearchQuery(e.target.value);
                          if (selectedProduct && `${selectedProduct.brandName} ${selectedProduct.gradeName}` !== e.target.value) {
                            setSelectedProduct(null);
                          }
                        }}
                        className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-xs"
                      />
                    </div>

                    {/* ALL Filtered Products Compact List */}
                    {!selectedProduct && (
                      <div className="max-h-48 overflow-y-auto space-y-1 bg-white p-1 rounded-lg border border-slate-200">
                        {filteredProducts.length === 0 ? (
                          <p className="text-xs text-slate-400 text-center py-2.5">No products found.</p>
                        ) : (
                          filteredProducts.map((p) => (
                            <div
                              key={p.id}
                              onClick={() => handleSelectProduct(p)}
                              className="p-1.5 px-2 rounded-lg hover:bg-purple-100/60 cursor-pointer transition flex justify-between items-center text-[11px]"
                            >
                              <div className="min-w-0 pr-2">
                                <span className="font-bold text-slate-900">{p.brandName} </span>
                                <span className="font-extrabold text-purple-700">{p.gradeName}</span>
                                {p.groupName && (
                                  <span className="text-[9.5px] text-slate-400 block truncate">{p.groupName}</span>
                                )}
                              </div>
                              <span className="text-[9.5px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">
                                {p.packings?.length || 0} Packings
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Quick Packing & Quantity Picker */}
                  {selectedProduct && (
                    <div className="bg-white p-2.5 rounded-xl border border-purple-200 space-y-2">
                      <div className="flex justify-between items-center border-b border-slate-100 pb-1.5">
                        <div>
                          <span className="text-xs font-black text-slate-900">
                            {selectedProduct.brandName} {selectedProduct.gradeName}
                          </span>
                          {selectedProduct.groupName && (
                            <span className="text-[9.5px] text-slate-400 ml-1.5">({selectedProduct.groupName})</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProduct(null);
                            setProductSearchQuery('');
                          }}
                          className="text-[10px] font-bold text-rose-600 hover:underline cursor-pointer"
                        >
                          Change Product
                        </button>
                      </div>

                      {/* Packing Selection Buttons - Compact Chips */}
                      <div>
                        <span className="text-[10px] font-bold text-slate-600 block mb-1">
                          Select Packing:
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
                                  "px-2 py-0.5 rounded text-[10px] font-bold transition border cursor-pointer active:scale-95 inline-flex items-center gap-1",
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
                          <label className="text-[10px] font-bold text-slate-600 block mb-0.5">Rate (₹ With GST & Disc):</label>
                          <input
                            type="number"
                            value={itemRate}
                            onChange={(e) => setItemRate(e.target.value === '' ? '' : Number(e.target.value))}
                            className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono font-bold focus:outline-none focus:ring-1 focus:ring-purple-500"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] font-bold text-slate-600 block mb-0.5">Quantity *</label>
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
                            <label className="text-[10px] font-bold text-slate-600">Discount:</label>
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
                            <span>+ Add Item</span>
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
                              <span className="text-rose-600 font-medium">Disc: -₹{dAmt.toLocaleString()}</span>
                            )}
                            <span>Subtotal: <span className="font-mono text-purple-700 font-black text-xs">₹{net.toLocaleString()}</span></span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </>
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
                          <td className="p-1.5 pl-2.5 font-bold text-slate-900 truncate max-w-[130px]">
                            {idx + 1}. {item.productName}
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
                      (selectedOrderDetails.status === 'dispatched' || selectedOrderDetails.status === 'confirmed') && "bg-blue-50 text-blue-700 border border-blue-200",
                      selectedOrderDetails.status === 'delivered' && "bg-emerald-50 text-emerald-700 border border-emerald-200",
                      selectedOrderDetails.status === 'collected' && "bg-green-100 text-green-800 border border-green-300"
                    )}
                  >
                    {selectedOrderDetails.status === 'dispatched' ? 'Dispatched' : selectedOrderDetails.status === 'delivered' ? 'Delivered' : selectedOrderDetails.status === 'collected' ? 'Collected' : 'Pending Approval'}
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
                          <p className="font-bold">{it.productName}</p>
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
                  className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Approve & Dispatch</span>
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
