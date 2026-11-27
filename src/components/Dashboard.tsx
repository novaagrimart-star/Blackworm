import React, { useState, useEffect, useRef, useCallback } from 'react';

import { 
  Target, 
  User as UserIcon, 
  ShoppingBag, 
  Calculator, 
  FileText, 
  Users, 
  MapPin, 
  Gift, 
  BarChart3, 
  Settings, 
  LogOut,
  ArrowLeft,
  IndianRupee,
  UserPlus,
  Bike,
  ShieldCheck,
  Phone,
  Key,
  Warehouse,
  Bell
} from 'lucide-react';
import { cn, toTitleCase } from '../lib/utils';
import { UserProfile, isAdmin, canAccessModule } from '../lib/auth';
import { Language, translations } from '../lib/i18n';
import { OfflineIndicator } from './OfflineIndicator';
import { CustomDialogModal } from './CustomDialogModal';
import { BirthdayNotificationModal, DashboardBirthdayWatcher } from './BirthdayNotificationModal';
import { BirthdayPerson, getTodayLocalInfo } from '../lib/birthdayNotifier';
import { DashboardModuleUpdateWatcher } from './ModuleUpdatePopup';
import { ModuleUpdateBadge } from '../lib/moduleUpdates';
import {
  BLACKWORM_BDAY_SEEN_EVENT,
  loadSyncedBirthdaySeenIds,
  markBirthdaySeenSynced,
  useModuleSeenCloudSync,
} from '../lib/moduleSeenSync';
import { useBranding } from '../lib/branding';
import { useUiConfig, CustomDashboardOption } from '../lib/uiConfig';
import { isPackagedApkShell } from '../lib/appVersion';
import { ErrorBoundary } from './ErrorBoundary';

import { TargetSheetView } from './modules/TargetSheetView';
import { UserManagementView } from './modules/UserManagementView';
import { OrderView } from './modules/OrderView';
import { CollectionView } from './modules/CollectionView';
import { OutstandingView } from './modules/OutstandingView';
import { PriceListView } from './modules/PriceListView';
import { DealerView } from './modules/DealerView';
import { LocationView } from './modules/LocationView';
import { TravelView } from './modules/TravelView';
import { SchemeView } from './modules/SchemeView';
import { ReportView } from './modules/ReportView';
import { SettingView } from './modules/SettingView';
import { GodownInchargeView } from './modules/GodownInchargeView';

interface DashboardProps {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
  onProfileUpdate?: (profile: UserProfile) => void;
}

const ROUTE_TO_TAB: Record<string, string> = {
  '': 'dashboard',
  dashboard: 'dashboard',
  'index.html': 'dashboard',
  login: 'dashboard',
  target: 'target',
  targets: 'target',
  user: 'user',
  users: 'user',
  office_staff: 'office_staff',
  warehouse: 'office_staff',
  godown: 'office_staff',
  order: 'order',
  orders: 'order',
  collection: 'collection',
  collections: 'collection',
  outstanding: 'calculator',
  calculator: 'calculator',
  price: 'price',
  pricelist: 'price',
  dealer: 'dealer',
  dealers: 'dealer',
  location: 'location',
  locations: 'location',
  travel: 'travel',
  traveling: 'travel',
  scheme: 'scheme',
  schemes: 'scheme',
  report: 'report',
  reports: 'report',
  setting: 'setting',
  settings: 'setting',
};

const TAB_TO_HASH: Record<string, string> = {
  dashboard: '',
  target: '#/target',
  user: '#/user',
  office_staff: '#/warehouse',
  order: '#/orders',
  collection: '#/collections',
  calculator: '#/outstanding',
  price: '#/pricelist',
  dealer: '#/dealers',
  location: '#/location',
  travel: '#/travel',
  scheme: '#/scheme',
  report: '#/reports',
  setting: '#/settings',
};

function canUseCleanHistoryUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = String(window.location.protocol || '').toLowerCase();
  return proto === 'http:' || proto === 'https:';
}

function buildRouteUrl(tab: string): string {
  const hash = TAB_TO_HASH[tab] || '';
  if (typeof window !== 'undefined') {
    if (isPackagedApkShell()) {
      const currentPath = window.location.pathname || '/';
      return `${currentPath}${hash}`;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('v');
      url.searchParams.delete('apk_ota');
      url.pathname = '/';
      url.hash = hash;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {}
  }
  return `/${hash}`;
}

function resolveTabFromLocation(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const rawHash = String(window.location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
    if (rawHash) {
      const hashSeg = rawHash.split('/')[0] || '';
      if (ROUTE_TO_TAB[hashSeg]) return ROUTE_TO_TAB[hashSeg];
    }
    const rawPath = String(window.location.pathname || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    const pathSeg = rawPath.split('/')[0] || '';
    return ROUTE_TO_TAB[pathSeg] ?? null;
  } catch {
    return null;
  }
}

export const Dashboard: React.FC<DashboardProps> = ({ profile, lang, onLogout, onProfileUpdate }) => {
  const t = translations[lang];
  const tabStorageKey = `blackworm_active_tab_${profile.uid}`;
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      const fromUrl = resolveTabFromLocation();
      if (fromUrl && fromUrl !== 'dashboard' && canAccessModule(profile, fromUrl)) {
        return fromUrl;
      }
      const saved = sessionStorage.getItem(`blackworm_active_tab_${profile.uid}`);
      if (saved && saved !== 'dashboard' && canAccessModule(profile, saved)) {
        return saved;
      }
    } catch {}
    return 'dashboard';
  });
  const activeTabRef = useRef<string>(activeTab);
  const [pendingOpenDealerId, setPendingOpenDealerId] = useState<string | null>(null);
  const { logoUrl, logoSize } = useBranding();
  const { uiConfig } = useUiConfig();
  const [selectedCustomOption, setSelectedCustomOption] = useState<CustomDashboardOption | null>(null);
  const [currentUserData, setCurrentUserData] = useState<any>(profile);
  const [isApplyingRemoteUpdate, setIsApplyingRemoteUpdate] = useState(false);
  const [todaysBirthdays, setTodaysBirthdays] = useState<BirthdayPerson[]>([]);
  const [birthdayDateKey, setBirthdayDateKey] = useState<string>(() => getTodayLocalInfo().dateKey);
  const [isBirthdayModalOpen, setIsBirthdayModalOpen] = useState(false);
  const autoShownBirthdayIdsRef = useRef<Set<string>>(new Set());
  const [moduleBadges, setModuleBadges] = useState<Record<string, ModuleUpdateBadge>>({});
  const lastBadgesSigRef = useRef<string>('');
  const lastBirthdaysSigRef = useRef<string>('');

  const handleModuleBadgesChange = useCallback(
    (badges: Record<string, ModuleUpdateBadge>, _items?: ModuleUpdateBadge[], signature?: string) => {
      const sig =
        typeof signature === 'string'
          ? signature
          : Object.entries(badges)
              .map(([k, v]) => `${k}:${v?.count || 0}:${v?.latestAtMs || 0}`)
              .sort()
              .join('|');
      if (lastBadgesSigRef.current === sig) return;
      lastBadgesSigRef.current = sig;
      setModuleBadges(badges);
    },
    []
  );

  const handleBirthdaysChange = useCallback((items: BirthdayPerson[], dateKey: string) => {
    const sig = `${dateKey}::${items.map((b) => `${b.id}:${b.name}`).join(',')}`;
    if (lastBirthdaysSigRef.current === sig) return;
    lastBirthdaysSigRef.current = sig;
    setTodaysBirthdays(items);
    setBirthdayDateKey((prev) => {
      if (prev !== dateKey) {
        autoShownBirthdayIdsRef.current.clear();
      }
      return dateKey;
    });
  }, []);

  const activeSeenUid = currentUserData?.uid || profile.uid || 'user';
  const { cloudHydrated: seenCloudHydrated } = useModuleSeenCloudSync(activeSeenUid);

  useEffect(() => {
    if (!seenCloudHydrated || activeTab !== 'dashboard' || todaysBirthdays.length === 0) return;
    const persistedSet = new Set(loadSyncedBirthdaySeenIds(activeSeenUid, birthdayDateKey));
    const hasUnseenBirthday = todaysBirthdays.some(
      (b) => !persistedSet.has(b.id) && !autoShownBirthdayIdsRef.current.has(b.id)
    );
    if (hasUnseenBirthday) {
      todaysBirthdays.forEach((b) => autoShownBirthdayIdsRef.current.add(b.id));
      setIsBirthdayModalOpen(true);
    }
  }, [seenCloudHydrated, activeTab, todaysBirthdays, birthdayDateKey, activeSeenUid]);

  // If the same login dismissed today's birthday modal on another device, close it here too
  useEffect(() => {
    if (!isBirthdayModalOpen || todaysBirthdays.length === 0) return;
    const onBdaySeenSync = () => {
      const persistedSet = new Set(loadSyncedBirthdaySeenIds(activeSeenUid, birthdayDateKey));
      if (todaysBirthdays.every((b) => persistedSet.has(b.id))) {
        setIsBirthdayModalOpen(false);
      }
    };
    window.addEventListener(BLACKWORM_BDAY_SEEN_EVENT, onBdaySeenSync);
    return () => window.removeEventListener(BLACKWORM_BDAY_SEEN_EVENT, onBdaySeenSync);
  }, [isBirthdayModalOpen, activeSeenUid, birthdayDateKey, todaysBirthdays]);

  const handleCloseBirthdayModal = useCallback(() => {
    setIsBirthdayModalOpen(false);
    markBirthdaySeenSynced(
      activeSeenUid,
      birthdayDateKey,
      todaysBirthdays.map((b) => b.id)
    );
  }, [activeSeenUid, birthdayDateKey, todaysBirthdays]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    try {
      if (activeTab && activeTab !== 'dashboard') {
        sessionStorage.setItem(tabStorageKey, activeTab);
      } else {
        sessionStorage.removeItem(tabStorageKey);
      }
    } catch {}
  }, [activeTab, tabStorageKey]);

  useEffect(() => {
    setCurrentUserData(profile);
  }, [profile]);

  useEffect(() => {
    const onRemoteUpdating = () => setIsApplyingRemoteUpdate(true);
    window.addEventListener('blackworm_remote_updating', onRemoteUpdating);
    return () => window.removeEventListener('blackworm_remote_updating', onRemoteUpdating);
  }, []);

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

  const handleLogoutClick = () => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Logout Confirmation',
      message: 'Are you sure you want to logout?',
      confirmText: 'Logout',
      cancelText: 'Cancel',
      onConfirm: () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        onLogout();
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };



  const baseModules = [
    { id: 'target', label: t.targetSheet, icon: Target, color: 'text-blue-500', bg: 'bg-blue-50' },
    { id: 'user', label: 'User Form', icon: UserPlus, color: 'text-emerald-500', bg: 'bg-emerald-50' },
    { id: 'office_staff', label: 'Warehouse Incharge', icon: Warehouse, color: 'text-indigo-600', bg: 'bg-indigo-50' },
    { id: 'order', label: t.orders, icon: ShoppingBag, color: 'text-purple-500', bg: 'bg-purple-50' },
    { id: 'collection', label: t.collections, icon: IndianRupee, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { id: 'calculator', label: t.outstanding || 'Outstanding', icon: FileText, color: 'text-teal-600', bg: 'bg-teal-50' },
    { id: 'price', label: t.priceList, icon: FileText, color: 'text-sky-500', bg: 'bg-sky-50' },
    { id: 'dealer', label: t.dealer, icon: Users, color: 'text-rose-500', bg: 'bg-rose-50' },
    { id: 'location', label: t.location || 'Location Mapping', icon: MapPin, color: 'text-orange-600', bg: 'bg-orange-50' },
    { id: 'travel', label: 'Traveling', icon: Bike, color: 'text-amber-500', bg: 'bg-amber-50' },
    { id: 'scheme', label: t.scheme, icon: Gift, color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
    { id: 'report', label: t.report, icon: BarChart3, color: 'text-indigo-500', bg: 'bg-indigo-50' },
    { id: 'setting', label: t.setting, icon: Settings, color: 'text-slate-500', bg: 'bg-slate-50' },
  ];

  const isUserAdmin = isAdmin(currentUserData);

  const modules = baseModules
    .map((m, idx) => {
      const ov = uiConfig.moduleOverrides?.[m.id];
      return {
        ...m,
        label: ov?.label || m.label,
        hidden: Boolean(ov?.hidden && !(m.id === 'setting' && isUserAdmin)),
        sortOrder: typeof ov?.order === 'number' ? ov.order : idx,
        isCustom: false as const,
      };
    })
    .filter((m) => !m.hidden);

  const visibleCustomOptions = (uiConfig.customOptions || [])
    .filter((opt) => opt.enabled !== false)
    .map((opt, idx) => ({
      id: opt.id,
      label: opt.label,
      subtitle: opt.subtitle,
      description: opt.description,
      url: opt.url,
      icon: Bell,
      color: opt.color || 'text-indigo-600',
      bg: opt.bg || 'bg-indigo-50',
      sortOrder: typeof opt.order === 'number' ? opt.order : 100 + idx,
      isCustom: true as const,
      raw: opt,
    }));

  // Filter visible modules:
  // If user is Admin (or has Admin designation now or in future): FULL ACCESS to all non-hidden modules.
  // If user is not Admin: ONLY show options explicitly permitted by Admin in allowedModules.
  const visibleModules = [
    ...modules.filter((m) => canAccessModule(currentUserData, m.id)),
    ...visibleCustomOptions,
  ].sort((a, b) => a.sortOrder - b.sortOrder);

  const gridColsClass =
    uiConfig.gridColumns === 2
      ? 'grid-cols-2'
      : uiConfig.gridColumns === 4
        ? 'grid-cols-2 sm:grid-cols-4'
        : 'grid-cols-3';
  const cardDensityClass =
    uiConfig.layoutDensity === 'compact'
      ? 'p-2 gap-1.5 rounded-xl'
      : uiConfig.layoutDensity === 'spacious'
        ? 'p-4 gap-2.5 rounded-2xl'
        : 'p-3 gap-2 rounded-2xl';
  const iconBoxDensityClass =
    uiConfig.layoutDensity === 'compact'
      ? 'w-10 h-10 rounded-xl'
      : uiConfig.layoutDensity === 'spacious'
        ? 'w-14 h-14 rounded-2xl'
        : 'w-12 h-12 rounded-2xl';

  // Guard active tab: If user's permissions change or user navigates to an unpermitted tab, return to dashboard
  useEffect(() => {
    if (activeTab !== 'dashboard') {
      const allowed = canAccessModule(currentUserData, activeTab);
      if (!allowed) {
        setActiveTab('dashboard');
      }
    }
  }, [activeTab, currentUserData]);

  // Handle mobile back button / browser history & URL routing cleanly without cross-tab popstate races
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('v') || url.searchParams.has('apk_ota')) {
        url.searchParams.delete('v');
        url.searchParams.delete('apk_ota');
      }
      if (canUseCleanHistoryUrl()) {
        if (!isPackagedApkShell()) {
          url.pathname = '/';
        }
        url.hash = TAB_TO_HASH[activeTabRef.current] || '';
        window.history.replaceState({ tab: activeTabRef.current }, '', url.toString());
      } else if (!window.history.state?.tab) {
        window.history.replaceState({ tab: activeTabRef.current }, '');
      }
    } catch {
      if (!window.history.state?.tab) {
        window.history.replaceState({ tab: activeTabRef.current }, '');
      }
    }

    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;
      const fromLocation = canUseCleanHistoryUrl() ? resolveTabFromLocation() : null;
      const targetTab = state?.tab || fromLocation;
      const currentTab = activeTabRef.current;

      // Ignore sub-view / inner-hub back events inside office_staff when GodownInchargeView is active and handling its own sub-tab
      if (targetTab && targetTab === currentTab) {
        return;
      }

      // Guard against stale async history.back() from a previously left tab
      if (
        (state?.warehouseStaffFormOpen ||
          state?.dealerFormOpen ||
          state?.userFormOpen ||
          state?.orderModalOpen ||
          state?.payModalOpen ||
          state?.modalOpen) &&
        targetTab !== currentTab
      ) {
        if (canUseCleanHistoryUrl()) {
          window.history.replaceState({ tab: currentTab }, '', buildRouteUrl(currentTab));
        } else {
          window.history.replaceState({ tab: currentTab }, '');
        }
        return;
      }

      if (targetTab && targetTab !== 'dashboard') {
        setActiveTab(targetTab);
      } else {
        if (currentTab !== 'dashboard') {
          setActiveTab('dashboard');
        } else {
          // If already on dashboard, keep dashboard on top of history stack
          if (canUseCleanHistoryUrl()) {
            window.history.pushState({ tab: 'dashboard' }, '', buildRouteUrl('dashboard'));
          } else {
            window.history.pushState({ tab: 'dashboard' }, '');
          }
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const handleTabChange = (tab: string) => {
    if (tab !== activeTab) {
      if (canUseCleanHistoryUrl()) {
        window.history.pushState({ tab }, '', buildRouteUrl(tab));
      } else {
        window.history.pushState({ tab }, '');
      }
      setActiveTab(tab);
    }
  };

  const renderContent = () => {
    // If not on dashboard and module is not permitted, fallback to dashboard view
    if (activeTab !== 'dashboard' && !canAccessModule(currentUserData, activeTab)) {
      return (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-12">
          <p className="text-sm font-bold text-slate-800">You do not have permission to access this module (Access Denied)</p>
          <button 
            onClick={() => handleTabChange('dashboard')} 
            className="mt-4 px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold cursor-pointer"
          >
            Back to Dashboard
          </button>
        </div>
      );
    }

    const view = (() => {
      switch (activeTab) {
        case 'target': return <TargetSheetView profile={currentUserData} lang={lang} />;
        case 'user': return <UserManagementView profile={currentUserData} lang={lang} onProfileUpdate={onProfileUpdate} />;
        case 'office_staff': return <GodownInchargeView profile={currentUserData} lang={lang} />;
        case 'order': return <OrderView profile={currentUserData} lang={lang} />;
        case 'collection': return <CollectionView profile={currentUserData} lang={lang} />;
        case 'outstanding':
        case 'calculator': return <OutstandingView profile={currentUserData} lang={lang} />;
        case 'price': return <PriceListView profile={currentUserData} lang={lang} />;
        case 'dealer': return (
          <DealerView
            profile={currentUserData}
            lang={lang}
            initialDealerId={pendingOpenDealerId}
            onConsumeInitialDealerId={() => setPendingOpenDealerId(null)}
          />
        );
        case 'location': return (
          <LocationView
            profile={currentUserData}
            lang={lang}
          />
        );
        case 'travel': return <TravelView profile={currentUserData} lang={lang} />;
        case 'scheme': return <SchemeView profile={currentUserData} lang={lang} />;
        case 'report': return <ReportView profile={currentUserData} lang={lang} />;
        case 'setting': return <SettingView profile={currentUserData} lang={lang} onLogout={onLogout} />;
        default: return null;
      }
    })();

    if (view) {
      return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <ErrorBoundary key={activeTab} resetKey={activeTab}>{view}</ErrorBoundary>
        </div>
      );
    }
        return (
          <div className="space-y-6">
            {/* Logged-In User Profile: Full Officer Name with Compressed Designation on Single Line */}
            {(() => {
              const displayName = toTitleCase(currentUserData.fullName) || 'User';
              const displayRole = isUserAdmin
                ? (currentUserData.role === 'owner' ? 'Owner (MD)' : 'Admin')
                : toTitleCase(currentUserData.designation || currentUserData.role);
              const showRoleChip =
                Boolean(displayRole) &&
                displayRole.trim().toLowerCase() !== displayName.trim().toLowerCase();
              return (
                <div className="flex items-center gap-2 mx-auto max-w-2xl px-1 sm:px-2">
                  <div className="min-w-0 flex-1 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
                    <span className="text-[clamp(11px,3.5vw,15px)] sm:text-base font-black text-slate-900 tracking-tight whitespace-nowrap shrink-0">
                      {displayName}
                    </span>
                    {showRoleChip && (
                      <span className="text-[9px] sm:text-xs font-bold text-slate-600 tracking-tight bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded whitespace-nowrap shrink-0">
                        {displayRole}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className={cn("grid gap-3 max-w-2xl mx-auto", gridColsClass)}>
              {visibleModules.map((module: any) => {
                const badgeCount = !module.isCustom ? (moduleBadges[module.id]?.count || 0) : 0;
                return (
                  <button
                    key={module.id}
                    onClick={() => {
                      if (module.isCustom) {
                        setSelectedCustomOption(module.raw);
                      } else {
                        handleTabChange(module.id);
                      }
                    }}
                    className={cn(
                      "relative flex flex-col items-center bg-white border border-slate-100 hover:border-slate-300 hover:shadow-md transition-all active:scale-95 group cursor-pointer",
                      cardDensityClass
                    )}
                  >
                    <div className={cn("relative flex items-center justify-center transition-transform group-hover:scale-105 shadow-sm", iconBoxDensityClass, module.bg)}>
                      <module.icon className={cn("w-6 h-6", module.color)} />
                      {badgeCount > 0 && (
                        <span
                          className="absolute -top-1.5 -right-1.5 min-w-[20px] h-[20px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-black flex items-center justify-center shadow-md ring-2 ring-white leading-none"
                          title={moduleBadges[module.id]?.message || `${badgeCount} नवीन अपडेट`}
                        >
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-center gap-0.5 justify-center">
                      <div className="flex items-center gap-1 justify-center">
                        <span className="text-[11px] font-semibold text-slate-700 text-center leading-tight">
                          {module.label}
                        </span>
                        {module.id === 'user' && <UserPlus className="w-3 h-3 text-emerald-500" />}
                      </div>
                      {module.isCustom && module.subtitle && (
                        <span className="text-[9.5px] text-slate-400 font-medium text-center leading-tight">
                          {module.subtitle}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              
              <button
                onClick={handleLogoutClick}
                className={cn(
                  "flex flex-col items-center bg-white border border-slate-100 hover:border-rose-200 hover:shadow-md transition-all active:scale-95 group cursor-pointer",
                  cardDensityClass
                )}
              >
                <div className={cn("bg-rose-50 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform", iconBoxDensityClass)}>
                  <LogOut className="w-6 h-6 text-rose-500" />
                </div>
                <span className="text-[11px] font-semibold text-slate-700 text-center leading-tight">
                  {t.logout}
                </span>
              </button>
            </div>
          </div>
        );
  };

  return (
    <div className="flex flex-col min-h-dvh bg-slate-50 mobile-safe-container">
      <header className="bg-white border-b border-slate-200 px-3 sm:px-5 py-2 flex items-center justify-between gap-2 sticky top-0 z-10 shadow-xs mobile-safe-header">
        {activeTab !== 'dashboard' && (
          <button
            onClick={() => handleTabChange('dashboard')}
            className="p-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition shrink-0 cursor-pointer"
            title="Back to Dashboard"
          >
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>
        )}

        <div className="flex items-center justify-center gap-2 sm:gap-3.5 min-w-0 flex-1 px-1 sm:px-3">
          {/* Logo scales smoothly with screen size while keeping title on one line */}
          <div
            className={cn(
              "w-auto shrink-0 flex items-center justify-center",
              activeTab !== 'dashboard'
                ? "h-11 sm:h-20 md:h-24 max-w-[66px] sm:max-w-[148px] md:max-w-[172px]"
                : "h-12 sm:h-20 md:h-24 max-w-[74px] sm:max-w-[148px] md:max-w-[172px]"
            )}
          >
            <img 
              src={logoUrl || '/logo.jpg'} 
              alt="Blackworm Agritech Logo"
              className="h-full w-auto max-w-full object-contain drop-shadow-xs"
            />
          </div>

          {/* Company Title - Larger readable responsive single-line title */}
          <h1
            className={cn(
              "font-black text-red-600 tracking-tight leading-none uppercase whitespace-nowrap sm:text-xl md:text-2xl lg:text-[26px]",
              activeTab !== 'dashboard'
                ? "text-[clamp(10.5px,3.2vw,17px)]"
                : "text-[clamp(11.5px,3.65vw,19px)]"
            )}
          >
            {uiConfig.appTitle || 'BLACKWORM AGRITECH PVT LTD'}
          </h1>
        </div>

        {/* Conditional Birthday Notification Icon (shown ONLY on days with visible birthdays) + Active User Badge */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {todaysBirthdays.length > 0 && (
            <button
              type="button"
              onClick={() => setIsBirthdayModalOpen(true)}
              className="relative p-2 rounded-xl bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 transition active:scale-95 cursor-pointer no-print"
              title={`आजचे वाढदिवस (${todaysBirthdays.length})`}
              aria-label={`आजचे वाढदिवस (${todaysBirthdays.length})`}
            >
              <Bell className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-black flex items-center justify-center shadow-xs leading-none">
                {todaysBirthdays.length}
              </span>
            </button>
          )}

          {(() => {
            const headerName = toTitleCase(currentUserData.fullName) || 'User';
            const headerRole =
              currentUserData.role === 'owner'
                ? 'Owner (MD)'
                : toTitleCase(currentUserData.designation || currentUserData.role);
            const showHeaderRole =
              Boolean(headerRole) &&
              headerRole.trim().toLowerCase() !== headerName.trim().toLowerCase();
            return (
              <div className="hidden sm:flex items-center gap-1.5 px-2 shrink-0">
                <span className="text-xs font-black text-slate-900 leading-none">
                  {headerName}
                </span>
                {showHeaderRole && (
                  <span className="text-[9.5px] font-bold text-slate-600 leading-none bg-slate-100 border border-slate-200 px-1 py-0.5 rounded">
                    {headerRole}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      </header>

      <main className={cn(
        'px-2 sm:px-4 py-3 sm:py-6 flex-1 mx-auto w-full',
        activeTab === 'office_staff' || activeTab === 'order' ? 'max-w-6xl' : 'max-w-4xl'
      )}>
        {renderContent()}
      </main>

      <OfflineIndicator />
      {isApplyingRemoteUpdate && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white px-4 py-2 rounded-xl shadow-lg text-xs font-bold flex items-center gap-2 border border-slate-700 animate-pulse">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>नवीन ॲप अपडेट लागू होत आहे...</span>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 pt-2 flex justify-around items-center z-20 shadow-lg mobile-safe-nav">
        <NavItem icon={BarChart3} label={t.dashboard} active={activeTab === 'dashboard'} onClick={() => handleTabChange('dashboard')} />
        {canAccessModule(currentUserData, 'target') && (
          <NavItem icon={Target} label={t.target} active={activeTab === 'target'} badgeCount={moduleBadges.target?.count} onClick={() => handleTabChange('target')} />
        )}
        {canAccessModule(currentUserData, 'order') && (
          <NavItem icon={ShoppingBag} label={t.orders} active={activeTab === 'order'} badgeCount={moduleBadges.order?.count} onClick={() => handleTabChange('order')} />
        )}
        {canAccessModule(currentUserData, 'collection') && (
          <NavItem icon={IndianRupee} label={t.collections} active={activeTab === 'collection'} badgeCount={moduleBadges.collection?.count} onClick={() => handleTabChange('collection')} />
        )}
        {canAccessModule(currentUserData, 'dealer') && (
          <NavItem icon={Users} label={t.dealer} active={activeTab === 'dealer'} badgeCount={moduleBadges.dealer?.count} onClick={() => handleTabChange('dealer')} />
        )}
        {canAccessModule(currentUserData, 'travel') && (
          <NavItem icon={Bike} label={t.travel} active={activeTab === 'travel'} badgeCount={moduleBadges.travel?.count} onClick={() => handleTabChange('travel')} />
        )}
        {!isUserAdmin && canAccessModule(currentUserData, 'office_staff') && (
          <NavItem icon={Warehouse} label="Warehouse" active={activeTab === 'office_staff'} badgeCount={moduleBadges.office_staff?.count} onClick={() => handleTabChange('office_staff')} />
        )}
      </nav>
      <CustomDialogModal {...dialogConfig} />
      <DashboardBirthdayWatcher
        profile={currentUserData}
        onBirthdaysChange={handleBirthdaysChange}
      />
      <BirthdayNotificationModal
        isOpen={isBirthdayModalOpen}
        onClose={handleCloseBirthdayModal}
        birthdays={todaysBirthdays}
      />
      <DashboardModuleUpdateWatcher
        profile={currentUserData}
        activeTab={activeTab}
        onBadgesChange={handleModuleBadgesChange}
      />
      {selectedCustomOption && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setSelectedCustomOption(null)}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="text-base font-black text-slate-900">{selectedCustomOption.label}</h3>
                {selectedCustomOption.subtitle && (
                  <p className="text-xs font-semibold text-slate-500 mt-0.5">{selectedCustomOption.subtitle}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedCustomOption(null)}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 cursor-pointer"
              >
                बंद करा
              </button>
            </div>
            {selectedCustomOption.description && (
              <p className="text-xs sm:text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                {selectedCustomOption.description}
              </p>
            )}
            {selectedCustomOption.url && /^(https?:\/\/|\/)/i.test(selectedCustomOption.url) && (
              <a
                href={selectedCustomOption.url}
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-full py-2.5 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black transition"
              >
                लिंक उघडा
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};


interface NavItemProps {
  icon: any;
  label: string;
  active?: boolean;
  badgeCount?: number;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ icon: Icon, label, active, badgeCount, onClick }) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex flex-col items-center justify-center min-w-[50px] transition-all relative py-2 group active:scale-90",
      active ? "text-rose-600" : "text-slate-400 hover:text-slate-600"
    )}
    title={label}
  >
    <div className="relative">
      <Icon className={cn("w-6 h-6 transition-transform", active && "scale-110")} />
      {Boolean(badgeCount && badgeCount > 0) && (
        <span className="absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-rose-600 text-white text-[9px] font-black flex items-center justify-center shadow-xs leading-none">
          {badgeCount! > 99 ? '99+' : badgeCount}
        </span>
      )}
    </div>
    {active && <div className="w-1.5 h-1.5 bg-rose-600 rounded-full absolute -bottom-1" />}
  </button>
);
