import React, { useMemo, useRef, useState } from 'react';
import html2canvas from 'html2canvas-pro';
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
import { UserProfile, isAdmin, isGodownIncharge } from '../../lib/auth';
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
  formatOrderTotalQuantity,
  getCleanGradeName,
  getOrderLineUnit,
  GodownOrderSlipCard,
  isOrderApprovedForGodown,
  OrderItem,
  resolveOrderLineForBox,
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
  'Godown Helper',
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
  const { orders: rawSharedOrders } = useSharedOrders();
  const { products: sharedMasterProducts } = useSharedMasterPricelist();

  const [activeTab, setActiveTab] = useState<ModuleTab>('attendance');
  const [selectedDate, setSelectedDate] = useState<string>(() => getLocalDateStr());
  const [selectedMonth, setSelectedMonth] = useState<string>(() => getLocalDateStr().slice(0, 7));
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'Office Staff' | 'Factory Staff'>('all');
  const [staffSearch, setStaffSearch] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
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

  // Image capture state for Dispatch Slips tab
  const slipCaptureRef = useRef<HTMLDivElement>(null);
  const [capturingOrder, setCapturingOrder] = useState<OrderItem | null>(null);
  const [downloadingOrderId, setDownloadingOrderId] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);

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

  // Deduplicated, rock-solid Staff Roster:
  // 1. Filters out orphaned staff_user_* entries whose user account was archived/deleted.
  // 2. Deduplicates strictly by linkedUserUid AND normalized (fullName + category) so duplicate names never appear.
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
      if (!m || m.isArchived) return;
      const linkedUid =
        m.linkedUserUid || (m.id.startsWith('staff_user_') ? m.id.replace(/^staff_user_/, '') : '');
      byId.set(m.id, m);
      if (linkedUid) linkedUidSet.add(linkedUid);
    });

    (sharedUsers || []).forEach((u: any) => {
      if (!u || u.isArchived || !u.uid) return;
      if (linkedUidSet.has(u.uid) || byId.has(`staff_user_${u.uid}`)) return;
      const r = String(u.role || '').toLowerCase().trim();
      const d = String(u.designation || '').toLowerCase().trim();
      const isOfficeOrFactory =
        r === 'office_staff' ||
        r === 'factory_staff' ||
        d.includes('office staff') ||
        d.includes('factory staff');
      if (!isOfficeOrFactory) return;

      const cat: 'Office Staff' | 'Factory Staff' =
        r === 'factory_staff' || d.includes('factory') ? 'Factory Staff' : 'Office Staff';
      byId.set(`staff_user_${u.uid}`, {
        id: `staff_user_${u.uid}`,
        fullName: toTitleCase(u.fullName || u.loginId || 'Staff'),
        category: cat,
        workRole: u.designation || cat,
        mobileNumber: u.mobileNumber || '',
        joiningDate: u.joiningDate || '',
        status: u.status === 'Inactive' ? 'Inactive' : 'Active',
        linkedUserUid: u.uid,
        createdAt: u.createdAt || '',
        updatedAt: u.updatedAt || '',
      });
    });

    // Final person-level deduplication (prevents two entries with identical name + category)
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

  // Attendance map for selected date: staffId -> record (with name fallback for legacy linked records)
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
    let unmarked = 0;

    activeRoster.forEach((s) => {
      const rec = dateAttendanceMap.get(s.id);
      if (!rec) unmarked += 1;
      else if (rec.status === 'present') present += 1;
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
      unmarked,
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

  // Approved Orders for Godown Incharge Dispatch Slips
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

  const approvedOrders = useMemo<OrderItem[]>(() => {
    const q = orderSearch.trim().toLowerCase();
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
      })
      .filter((o) => {
        if (!q) return true;
        return (
          String(o.orderNumber || '').toLowerCase().includes(q) ||
          String(o.dealerName || '').toLowerCase().includes(q) ||
          String(o.dealerVillage || '').toLowerCase().includes(q) ||
          String(o.dealerDistrict || '').toLowerCase().includes(q) ||
          String(o.dealerContact || '').includes(q) ||
          (o.items || []).some((it) =>
            String(it.gradeName || it.productName || '').toLowerCase().includes(q)
          )
        );
      });
  }, [rawSharedOrders, orderSearch]);

  if (!canAccess) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-8">
        <p className="text-sm font-bold text-slate-800">
          हा विभाग फक्त गोडाऊन इन्चार्ज आणि अ‍ॅडमिन यांनाच उपलब्ध आहे.
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
        createdByName: existing?.createdByName || profile.fullName || 'Godown Incharge',
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
      title: 'स्टाफ नाव काढायचे का?',
      message: `${member.fullName} (${member.category}) यांचे नाव यादीतून काढायचे का?`,
      confirmText: 'काढून टाका',
      cancelText: 'रद्द करा',
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
        markedByName: profile.fullName || profile.loginId || 'Godown Incharge',
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
        markedByName: profile.fullName || profile.loginId || 'Godown Incharge',
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
    const header = ['Staff Name', 'Category', 'Work Role', 'Present (Days)', 'Half Day', 'Absent', 'Leave', 'Payable Days'];
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
    triggerBlobDownload(blob, `Office_Staff_Attendance_${selectedMonth}.csv`);
  };

  // Dispatch Slip image download & WhatsApp share (No prices/rates)
  const buildSlipShareText = (order: OrderItem) => {
    const resolvedItems = (order.items || []).map((it) =>
      resolveOrderLineForBox(it, findProductForOrderItem(it))
    );
    const itemsListText = resolvedItems
      .map(
        (it, idx) =>
          `${idx + 1}. *${it.productName}* (${it.packingSize}) - *${it.quantity} ${getOrderLineUnit(it)}*`
      )
      .join('\n');
    const locationStr = [order.dealerVillage, order.dealerDistrict].filter(Boolean).join(', ');
    const totalQtyDisplay = formatOrderTotalQuantity(resolvedItems, order.totalQuantity);
    return `*Dealer:* ${order.dealerName}\n*Proprietor Name:* ${order.farmerName || '-'}\n*Contact Number:* ${order.dealerContact || '-'}\n*Location:* ${locationStr || '-'}\n\n*Order Quantity:*\n${itemsListText}\n\n*Total Quantity:* *${totalQtyDisplay}*`;
  };

  const handleCopySlip = async (order: OrderItem) => {
    try {
      await navigator.clipboard.writeText(buildSlipShareText(order));
      setCopiedOrderId(order.id);
      setTimeout(() => setCopiedOrderId(null), 2000);
    } catch {}
  };

  const handleDownloadSlipImage = async (order: OrderItem) => {
    if (downloadingOrderId) return;
    setDownloadingOrderId(order.id);
    setCapturingOrder(order);
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 140)))
      );
      if (!slipCaptureRef.current) return;
      const canvas = await html2canvas(slipCaptureRef.current, {
        scale: 2.5,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      const safeDealer = (order.dealerName || 'Order')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30);
      if (blob) {
        triggerBlobDownload(blob, `${safeDealer || 'Order'}_${order.orderNumber}.png`);
      }
    } finally {
      setDownloadingOrderId(null);
    }
  };

  const handleShareSlipPhoto = async (order: OrderItem) => {
    setIsGeneratingImage(true);
    setCapturingOrder(order);
    setTimeout(async () => {
      try {
        if (slipCaptureRef.current) {
          const canvas = await html2canvas(slipCaptureRef.current, {
            scale: 2.5,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
          });
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (blob) {
            const file = new File([blob], `Order_${order.orderNumber}.png`, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: `Order - ${order.orderNumber}` });
              return;
            }
            triggerBlobDownload(blob, `Order_${order.orderNumber}.png`);
          }
        }
      } finally {
        setIsGeneratingImage(false);
      }
    }, 150);
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
          <button type="button" onClick={() => setSaveToast(false)} className="text-white/80 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Clean Single-Surface Header & Segmented Workspace Switcher */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
        <div className="px-4 py-3.5 sm:px-5 sm:py-4 flex items-center justify-between gap-3 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
              <Warehouse className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold tracking-tight truncate">
                गोडाऊन इन्चार्ज
              </h2>
              <p className="text-xs text-slate-300 truncate">
                हजेरी नोंदणी · मंजूर ऑर्डर्स · मासिक रिपोर्ट
              </p>
            </div>
          </div>

          {activeTab === 'attendance' && (
            <button
              type="button"
              onClick={openAddStaffModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              <span>स्टाफ ॲड करा</span>
            </button>
          )}
        </div>

        {/* Clean 3-Tab Segmented Navigation */}
        <div className="p-1.5 bg-slate-100 grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('attendance')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'attendance'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <ClipboardCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">हजेरी ({activeRoster.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'orders'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <PackageCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">ऑर्डर्स ({approvedOrders.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
              activeTab === 'report'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            )}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">मासिक रिपोर्ट</span>
          </button>
        </div>
      </div>

      {/* ============================ TAB 1: DAILY ATTENDANCE ============================ */}
      {activeTab === 'attendance' && (
        <div className="space-y-3">
          {/* Compact Control Surface: Date Bar + Slim Summary Strip + Search/Filter */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
            {/* Row 1: Date Picker & Mark All Present */}
            <div className="px-3.5 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => shiftDate(-1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 cursor-pointer active:scale-95"
                  title="मागील दिवस"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2 pointer-events-none" />
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value || getLocalDateStr())}
                    className="pl-8 pr-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-900 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => shiftDate(1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 cursor-pointer active:scale-95"
                  title="पुढील दिवस"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDate(getLocalDateStr())}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-800 whitespace-nowrap cursor-pointer"
                >
                  आज
                </button>
              </div>

              {filteredStaff.some((s) => s.status !== 'Inactive') && (
                <button
                  type="button"
                  onClick={() => void handleMarkAllPresent()}
                  disabled={markingAll}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold transition active:scale-95 whitespace-nowrap cursor-pointer"
                >
                  {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>सर्व हजर करा</span>
                </button>
              )}
            </div>

            {/* Row 2: Slim 5-Column Metrics Strip (No card-in-card clutter) */}
            <div className="grid grid-cols-5 divide-x divide-slate-100 bg-slate-50/70 text-center">
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-slate-500">एकूण</p>
                <p className="text-sm font-bold text-slate-900 font-mono tabular-nums">{dailySummary.total}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-emerald-700">हजर</p>
                <p className="text-sm font-bold text-emerald-700 font-mono tabular-nums">{dailySummary.present}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-amber-700">अर्धा</p>
                <p className="text-sm font-bold text-amber-700 font-mono tabular-nums">{dailySummary.halfDay}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-rose-700">गैरहजर</p>
                <p className="text-sm font-bold text-rose-700 font-mono tabular-nums">{dailySummary.absent}</p>
              </div>
              <div className="py-2 px-1">
                <p className="text-[11px] font-medium text-sky-700">रजा</p>
                <p className="text-sm font-bold text-sky-700 font-mono tabular-nums">{dailySummary.leave}</p>
              </div>
            </div>

            {/* Row 3: Search + Department Filter */}
            <div className="px-3.5 py-2.5 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={staffSearch}
                  onChange={(e) => setStaffSearch(e.target.value)}
                  placeholder="नाव, काम किंवा मोबाईल शोधा..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="flex p-0.5 bg-slate-100 rounded-xl shrink-0">
                {([
                  { id: 'all', label: 'सर्व' },
                  { id: 'Office Staff', label: 'ऑफिस' },
                  { id: 'Factory Staff', label: 'फॅक्टरी' },
                ] as const).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategoryFilter(cat.id)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer',
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
                    ? 'या शोधानुसार कोणताही स्टाफ सापडला नाही'
                    : 'अद्याप ऑफिस किंवा फॅक्टरी स्टाफची नोंद नाही'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  नवीन नाव जोडण्यासाठी वरील &quot;स्टाफ ॲड करा&quot; बटणावर क्लिक करा.
                </p>
              </div>
              {!staffSearch && categoryFilter === 'all' && (
                <button
                  type="button"
                  onClick={openAddStaffModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>पहिले नाव ॲड करा</span>
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

                return (
                  <div
                    key={member.id}
                    className={cn(
                      'bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 transition space-y-3',
                      isInactive && 'opacity-60'
                    )}
                  >
                    {/* Top Row: Clean Unboxed Name + Typography Metadata + Quiet Edit/Delete */}
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
                          {member.workRole && member.workRole !== member.category && (
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
                              नोंद: {toTitleCase(currentRec.markedByName)} ·{' '}
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
                          title="माहिती एडिट करा"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteStaffMember(member)}
                          className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                          title="स्टाफ काढून टाका"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Bottom Row: Clean Unified Segmented Attendance Control */}
                    {!isInactive && (
                      <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100">
                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'present')}
                          className={cn(
                            'py-2 px-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95',
                            st === 'present'
                              ? 'bg-emerald-600 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>हजर</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'half_day')}
                          className={cn(
                            'py-2 px-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95',
                            st === 'half_day'
                              ? 'bg-amber-500 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          <span>अर्धा</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'absent')}
                          className={cn(
                            'py-2 px-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95',
                            st === 'absent'
                              ? 'bg-rose-600 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <UserX className="w-3.5 h-3.5 shrink-0" />
                          <span>गैरहजर</span>
                        </button>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => void handleMarkAttendance(member, 'leave')}
                          className={cn(
                            'py-2 px-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer active:scale-95',
                            st === 'leave'
                              ? 'bg-sky-600 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-white/80'
                          )}
                        >
                          <span>रजा</span>
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

      {/* ============================ TAB 2: APPROVED ORDERS SLIPS ============================ */}
      {activeTab === 'orders' && (
        <div className="space-y-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="ऑर्डर नं., डीलर नाव, गाव किंवा प्रॉडक्ट शोधा..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <p className="text-xs font-medium text-slate-500 px-1 shrink-0">
              फक्त Product · Packing · Quantity (Box / Nos.)
            </p>
          </div>

          {approvedOrders.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center space-y-2">
              <PackageCheck className="w-10 h-10 text-slate-300 mx-auto" />
              <p className="text-sm font-bold text-slate-700">
                सध्या कोणतीही मंजूर ऑर्डर नाही
              </p>
              <p className="text-xs text-slate-500">
                Admin ने ऑर्डर Approve केल्यानंतर ती येथे स्लिप डाउनलोडसाठी दिसेल.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {approvedOrders.map((o) => {
                const resolvedCardItems = (o.items || []).map((it) =>
                  resolveOrderLineForBox(it, findProductForOrderItem(it))
                );
                return (
                  <GodownOrderSlipCard
                    key={o.id}
                    order={o}
                    resolvedItems={resolvedCardItems}
                    isDownloading={downloadingOrderId === o.id}
                    isSharing={isGeneratingImage && capturingOrder?.id === o.id}
                    isCopied={copiedOrderId === o.id}
                    onDownloadImage={handleDownloadSlipImage}
                    onSharePhoto={handleShareSlipPhoto}
                    onCopyText={handleCopySlip}
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
          <div className="bg-white rounded-2xl border border-slate-200 p-3.5 shadow-2xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-700" />
              <span className="text-xs font-bold text-slate-800">महिना निवडा:</span>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value || getLocalDateStr().slice(0, 7))}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold bg-slate-50 focus:bg-white"
              />
            </div>

            <button
              type="button"
              onClick={handleExportMonthlyCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold transition active:scale-95 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV डाउनलोड</span>
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 text-[11px] font-bold">
                  <th className="p-3">स्टाफचे नाव</th>
                  <th className="p-3">विभाग</th>
                  <th className="p-3 text-center">हजर</th>
                  <th className="p-3 text-center">अर्धा</th>
                  <th className="p-3 text-center">गैरहजर</th>
                  <th className="p-3 text-center">रजा</th>
                  <th className="p-3 text-right">एकूण दिवस</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {monthlySummaryRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400 font-semibold">
                      या महिन्यात अद्याप कोणतीही हजेरी नोंद नाही.
                    </td>
                  </tr>
                ) : (
                  monthlySummaryRows.map((row) => (
                    <tr key={row.staff.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3">
                        <div className="font-bold text-slate-900">{row.staff.fullName}</div>
                        {row.staff.workRole && row.staff.workRole !== row.staff.category && (
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
                  ))
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
                  {editingStaffId ? 'स्टाफ माहिती अपडेट करा' : 'नवीन ऑफिस / फॅक्टरी स्टाफ ॲड करा'}
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
                  पूर्ण नाव (Full Name) *
                </label>
                <input
                  type="text"
                  required
                  value={staffNameInput}
                  onChange={(e) => setStaffNameInput(e.target.value)}
                  placeholder="उदा. सुरेश रामचंद्र पवार"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  विभाग (Category) *
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
                  काम / पद (Work Role)
                </label>
                <input
                  type="text"
                  value={staffWorkRoleInput}
                  onChange={(e) => setStaffWorkRoleInput(e.target.value)}
                  placeholder="उदा. Packing, Helper, Dispatch, Billing Clerk"
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
                    मोबाईल नंबर
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
                  <label className="block text-xs font-bold text-slate-700 mb-1">स्थिती</label>
                  <select
                    value={staffStatusInput}
                    onChange={(e) =>
                      setStaffStatusInput(e.target.value === 'Inactive' ? 'Inactive' : 'Active')
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    <option value="Active">Active (सक्रिय)</option>
                    <option value="Inactive">Inactive (बंद)</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowStaffModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="submit"
                  disabled={isSavingMember}
                  className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-black disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  {isSavingMember ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{editingStaffId ? 'अपडेट करा' : 'स्टाफ सेव्ह करा'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Hidden Slip Capture Container for PNG Download / Share (Identical to Order Image Format) */}
      <div className="fixed -left-[9999px] top-0 pointer-events-none" aria-hidden="true">
        {capturingOrder && (
          <div
            ref={slipCaptureRef}
            className="w-[420px] bg-white p-5 border-2 border-slate-900 rounded-2xl font-sans text-slate-900 space-y-3"
            style={{ width: '420px' }}
          >
            <div className="flex items-center justify-between border-b-2 border-slate-900 pb-2">
              <div>
                <p className="text-[11px] font-black text-rose-600 uppercase tracking-tight">
                  BLACKWORM AGRITECH PVT LTD
                </p>
                <p className="text-xs font-black text-purple-800 font-mono">
                  {capturingOrder.orderNumber}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-bold text-slate-500">Order Date</p>
                <p className="text-[11px] font-black text-slate-900 font-mono">
                  {new Date(capturingOrder.createdAt).toLocaleDateString('en-GB')}
                </p>
              </div>
            </div>

            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs space-y-1.5">
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Dealer:</span>{' '}
                <strong className="text-sm font-black text-slate-900">
                  {toTitleCase(capturingOrder.dealerName)}
                </strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Proprietor Name:</span>{' '}
                <strong className="text-slate-900">
                  {toTitleCase(capturingOrder.farmerName || '-')}
                </strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Contact Number:</span>{' '}
                <strong className="font-mono text-slate-900">
                  {capturingOrder.dealerContact || '-'}
                </strong>
              </p>
              <p className="text-slate-800">
                <span className="font-bold text-slate-500">Location:</span>{' '}
                <strong className="text-slate-900">
                  {[toTitleCase(capturingOrder.dealerVillage), toTitleCase(capturingOrder.dealerDistrict)]
                    .filter(Boolean)
                    .join(', ') || '-'}
                </strong>
              </p>
            </div>

            <div>
              <p className="text-xs font-black text-slate-800 uppercase tracking-wide mb-1.5">
                Order Quantity:
              </p>
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="bg-slate-900 text-white font-black text-[10px] uppercase">
                    <th className="p-1.5 pl-2"># Product</th>
                    <th className="p-1.5 text-center w-24">Packing</th>
                    <th className="p-1.5 text-center w-24">Quantity</th>
                  </tr>
                </thead>
                {(() => {
                  const resolvedCaptureItems = (capturingOrder.items || []).map((it) =>
                    resolveOrderLineForBox(it, findProductForOrderItem(it))
                  );
                  return (
                    <>
                      <tbody className="divide-y divide-slate-200 border-b border-slate-200 font-semibold">
                        {resolvedCaptureItems.map((it, idx) => (
                          <tr key={idx} className={idx % 2 === 1 ? 'bg-slate-50/70' : ''}>
                            <td className="p-1.5 pl-2 font-bold text-sky-700 text-[11px]">
                              {idx + 1}. {it.gradeName || it.productName}
                            </td>
                            <td className="p-1.5 text-center text-slate-600 text-[10px] font-bold">
                              {it.packingSize}
                            </td>
                            <td className="p-1.5 text-center font-mono font-black text-slate-900 text-xs">
                              {it.quantity} {getOrderLineUnit(it)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-emerald-50 font-black text-emerald-950 text-[11px]">
                        <tr>
                          <td colSpan={2} className="p-2 pl-2 text-right uppercase">
                            Total Quantity:
                          </td>
                          <td className="p-2 text-center font-mono font-black text-sm text-emerald-900">
                            {formatOrderTotalQuantity(
                              resolvedCaptureItems,
                              capturingOrder.totalQuantity
                            )}
                          </td>
                        </tr>
                      </tfoot>
                    </>
                  );
                })()}
              </table>
            </div>

            {capturingOrder.createdByName && (
              <div className="flex justify-between items-center pt-1 border-t border-slate-200 text-[10px] text-slate-500 font-bold">
                <span>Booked by: {toTitleCase(capturingOrder.createdByName)}</span>
                <span>{capturingOrder.cropName ? `Crop: ${capturingOrder.cropName}` : ''}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
