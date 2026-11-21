import React, { useMemo, useState } from 'react';
import {
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Download,
  Edit3,
  FileSpreadsheet,
  Loader2,
  PackageCheck,
  Phone,
  Plus,
  Search,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  UserX,
  Warehouse,
  X,
} from 'lucide-react';
import { UserProfile, isAdmin, isGodownIncharge, isOfficeOrFactoryStaff } from '../../lib/auth';
import {
  formatDisplayDate,
  getLocalDateStr,
  logAudit,
  safeFirestoreDelete,
  safeFirestoreSet,
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

interface Props {
  profile: UserProfile;
  lang: Language;
}

type ModuleTab = 'attendance' | 'orders' | 'report';
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

export const GodownInchargeView: React.FC<Props> = ({ profile }) => {
  const canAccess =
    isAdmin(profile) ||
    isGodownIncharge(profile) ||
    Boolean(Array.isArray(profile.allowedModules) && profile.allowedModules.includes('office_staff'));

  const { staffMembers, loaded: staffLoaded, setOfficeStaffOptimistic } = useSharedOfficeStaff();
  const { attendanceRecords, setOfficeAttendanceOptimistic } = useSharedOfficeAttendance();
  const { users: sharedUsers } = useSharedUsers();
  const { orders: rawSharedOrders, setOrdersOptimistic } = useSharedOrders();
  const { products: sharedMasterProducts } = useSharedMasterPricelist();

  const [activeTab, setActiveTab] = useState<ModuleTab>('attendance');
  const [selectedDate, setSelectedDate] = useState<string>(() => getLocalDateStr());
  const [selectedMonth, setSelectedMonth] = useState<string>(() => getLocalDateStr().slice(0, 7));
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'Office Staff' | 'Factory Staff'>('all');
  const [staffSearch, setStaffSearch] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [warehouseStatusFilter, setWarehouseStatusFilter] = useState<'all' | WarehouseOrderStatus>('all');
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [savingStaffId, setSavingStaffId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  // Add / Edit Staff Modal State
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [staffNameInput, setStaffNameInput] = useState('');
  const [staffCategoryInput, setStaffCategoryInput] = useState<'Office Staff' | 'Factory Staff'>('Office Staff');
  const [staffWorkRoleInput, setStaffWorkRoleInput] = useState('');
  const [staffMobileInput, setStaffMobileInput] = useState('');
  const [staffStatusInput, setStaffStatusInput] = useState<'Active' | 'Inactive'>('Active');
  const [isSavingMember, setIsSavingMember] = useState(false);
  const [saveToast, setSaveToast] = useState(false);

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
  // 2. Deduplicates strictly by normalized (fullName + category) so Warehouse Incharge names never appear twice or disappear.
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
      byId.set(m.id, m);
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
        fullName: toTitleCase(u.fullName || u.loginId || 'Staff'),
        category: cat,
        workRole: toTitleCase(u.designation || cat),
        mobileNumber: u.mobileNumber || '',
        joiningDate: u.joiningDate || '',
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
    return allApprovedOrders.filter((o) => {
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
  }, [allApprovedOrders, warehouseStatusFilter, orderSearch]);

  if (!canAccess) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-8">
        <p className="text-sm font-bold text-slate-800">
          This section is only available to Warehouse Incharge and Admin.
        </p>
      </div>
    );
  }

  const openAddStaffModal = () => {
    setEditingStaffId(null);
    setStaffNameInput('');
    setStaffCategoryInput(categoryFilter === 'Factory Staff' ? 'Factory Staff' : 'Office Staff');
    setStaffWorkRoleInput('');
    setStaffMobileInput('');
    setStaffStatusInput('Active');
    setShowStaffModal(true);
  };

  const openEditStaffModal = (member: OfficeStaffMember) => {
    setEditingStaffId(member.id);
    setStaffNameInput(member.fullName);
    setStaffCategoryInput(member.category);
    setStaffWorkRoleInput(member.workRole || '');
    setStaffMobileInput(member.mobileNumber || '');
    setStaffStatusInput(member.status === 'Inactive' ? 'Inactive' : 'Active');
    setShowStaffModal(true);
  };

  const handleSaveStaffMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = toTitleCase(staffNameInput.trim());
    if (!cleanName) return;

    setIsSavingMember(true);
    try {
      const nowIso = new Date().toISOString();
      const id = editingStaffId || `staff_${Date.now()}`;
      const existing = combinedStaffRoster.find((s) => s.id === id);

      const record: OfficeStaffMember = {
        ...(existing || {}),
        id,
        fullName: cleanName,
        category: staffCategoryInput,
        workRole: toTitleCase(staffWorkRoleInput.trim()) || staffCategoryInput,
        mobileNumber: staffMobileInput.trim(),
        joiningDate: existing?.joiningDate || getLocalDateStr(),
        status: staffStatusInput,
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
      void logAudit(
        editingStaffId ? 'UPDATE' : 'CREATE',
        'office_staff_members',
        id,
        `${editingStaffId ? 'Updated' : 'Added'} ${record.category}: ${record.fullName}`,
        profile
      ).catch(() => {});

      setShowStaffModal(false);
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

      {/* Clean Header & Segmented Workspace Switcher */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
        <div className="px-4 py-3.5 sm:px-5 sm:py-4 flex items-center justify-between gap-3 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
              <Warehouse className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-lg font-bold tracking-tight truncate">
                Warehouse Incharge
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-300 truncate">
                Staff Attendance · Order Dispatch · Monthly Report
              </p>
            </div>
          </div>

          {activeTab === 'attendance' && (
            <button
              type="button"
              onClick={openAddStaffModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5 shrink-0" />
              <span>Add Staff</span>
            </button>
          )}
        </div>

        {/* 3-Tab Segmented Navigation */}
        <div className="p-1.5 bg-slate-100 grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('attendance')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'attendance'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <ClipboardCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Attendance (<span className="font-mono tabular-nums">{activeRoster.length}</span>)
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'orders'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <PackageCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Orders (<span className="font-mono tabular-nums">{orderStatusCounts.all}</span>)
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'report'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Monthly Report</span>
          </button>
        </div>
      </div>

      {/* ============================ TAB 1: DAILY ATTENDANCE ============================ */}
      {activeTab === 'attendance' && (
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
                  onClick={openAddStaffModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add First Staff</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredStaff.map((member) => {
                const currentRec = dateAttendanceMap.get(member.id);
                const st = currentRec?.status;
                const isInactive = member.status === 'Inactive';
                const isSavingThis = savingStaffId === member.id;
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
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-sm sm:text-base font-bold text-slate-900 truncate">
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

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openEditStaffModal(member)}
                          className="p-2 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition cursor-pointer"
                          title="Edit Staff"
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
        <div className="space-y-3">
          {/* Single-Row Desktop/Tablet Toolbar: Search + Status Filters */}
          <div className="bg-white rounded-2xl border border-slate-200 p-2.5 sm:p-3 shadow-2xs flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
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

            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar p-1 bg-slate-100 rounded-xl shrink-0">
              {(
                [
                  { id: 'all', label: 'All', count: orderStatusCounts.all },
                  { id: 'fresh', label: 'Fresh Order', count: orderStatusCounts.fresh },
                  { id: 'dispatched', label: 'Dispatched', count: orderStatusCounts.dispatched },
                  { id: 'delivered', label: 'Delivered', count: orderStatusCounts.delivered },
                ] as const
              ).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setWarehouseStatusFilter(st.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-[11px] font-semibold transition whitespace-nowrap shrink-0 cursor-pointer active:scale-95 flex items-center gap-1.5',
                    warehouseStatusFilter === st.id
                      ? 'bg-slate-900 text-white shadow-2xs'
                      : 'text-slate-600 hover:bg-white/80 hover:text-slate-900'
                  )}
                >
                  <span>{st.label}</span>
                  <span
                    className={cn(
                      'font-mono tabular-nums text-[10px]',
                      warehouseStatusFilter === st.id ? 'text-slate-300' : 'text-slate-400'
                    )}
                  >
                    {st.count}
                  </span>
                </button>
              ))}
            </div>
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

      {/* ============================ ADD / EDIT STAFF MODAL ============================ */}
      {showStaffModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-slate-900" />
                <h3 className="text-sm font-bold text-slate-900">
                  {editingStaffId ? 'Update Staff Details' : 'Add Office / Factory Staff'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowStaffModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveStaffMember} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Full Name *
                </label>
                <input
                  type="text"
                  required
                  value={staffNameInput}
                  onChange={(e) => setStaffNameInput(e.target.value)}
                  placeholder="e.g. Suresh Ramchandra Pawar"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Department *
                </label>
                <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100">
                  {(['Office Staff', 'Factory Staff'] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setStaffCategoryInput(cat)}
                      className={cn(
                        'py-2 px-3 rounded-lg text-xs font-bold transition cursor-pointer',
                        staffCategoryInput === cat
                          ? 'bg-white text-slate-900 shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      )}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Work Role
                </label>
                <input
                  type="text"
                  value={staffWorkRoleInput}
                  onChange={(e) => setStaffWorkRoleInput(e.target.value)}
                  placeholder="e.g. Packing, Helper, Dispatch, Billing Clerk"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {QUICK_WORK_ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setStaffWorkRoleInput(r)}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-medium cursor-pointer"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Mobile Number
                  </label>
                  <input
                    type="tel"
                    value={staffMobileInput}
                    onChange={(e) => setStaffMobileInput(e.target.value)}
                    placeholder="98XXXXXXXX"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Status</label>
                  <select
                    value={staffStatusInput}
                    onChange={(e) =>
                      setStaffStatusInput(e.target.value === 'Inactive' ? 'Inactive' : 'Active')
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowStaffModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingMember}
                  className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-black disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isSavingMember ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{editingStaffId ? 'Update Staff' : 'Save Staff'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
