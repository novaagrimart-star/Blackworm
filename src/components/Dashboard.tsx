import React, { useState, useEffect } from 'react';

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
  Key
} from 'lucide-react';
import { cn, toTitleCase } from '../lib/utils';
import { UserProfile, isAdmin, canAccessModule } from '../lib/auth';
import { Language, translations } from '../lib/i18n';
import { OfflineIndicator } from './OfflineIndicator';
import { CustomDialogModal } from './CustomDialogModal';
import { useBranding } from '../lib/branding';
import { ErrorBoundary } from './ErrorBoundary';

import { TargetSheetView } from './modules/TargetSheetView';
import { UserManagementView } from './modules/UserManagementView';
import { OrderView } from './modules/OrderView';
import { CollectionView } from './modules/CollectionView';
import { OutstandingView } from './modules/OutstandingView';
import { PriceListView } from './modules/PriceListView';
import { DealerView } from './modules/DealerView';
import { TravelView } from './modules/TravelView';
import { SchemeView } from './modules/SchemeView';
import { ReportView } from './modules/ReportView';
import { SettingView } from './modules/SettingView';

interface DashboardProps {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
  onProfileUpdate?: (profile: UserProfile) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ profile, lang, onLogout, onProfileUpdate }) => {
  const t = translations[lang];
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const { logoUrl, logoSize } = useBranding();
  const [currentUserData, setCurrentUserData] = useState<any>(profile);

  useEffect(() => {
    setCurrentUserData(profile);
  }, [profile]);

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



  const modules = [
    { id: 'target', label: t.targetSheet, icon: Target, color: 'text-blue-500', bg: 'bg-blue-50' },
    { id: 'user', label: 'User Form', icon: UserPlus, color: 'text-emerald-500', bg: 'bg-emerald-50' },
    { id: 'order', label: t.orders, icon: ShoppingBag, color: 'text-purple-500', bg: 'bg-purple-50' },
    { id: 'collection', label: t.collections, icon: IndianRupee, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { id: 'calculator', label: t.outstanding || 'Outstanding', icon: FileText, color: 'text-teal-600', bg: 'bg-teal-50' },
    { id: 'price', label: t.priceList, icon: FileText, color: 'text-sky-500', bg: 'bg-sky-50' },
    { id: 'dealer', label: t.dealer, icon: Users, color: 'text-rose-500', bg: 'bg-rose-50' },
    { id: 'travel', label: 'Traveling', icon: Bike, color: 'text-amber-500', bg: 'bg-amber-50' },
    { id: 'scheme', label: t.scheme, icon: Gift, color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
    { id: 'report', label: t.report, icon: BarChart3, color: 'text-indigo-500', bg: 'bg-indigo-50' },
    { id: 'setting', label: t.setting, icon: Settings, color: 'text-slate-500', bg: 'bg-slate-50' },
  ];

  const isUserAdmin = isAdmin(currentUserData);

  // Filter visible modules:
  // If user is Admin (or has Admin designation now or in future): FULL ACCESS to all modules.
  // If user is not Admin: ONLY show options explicitly permitted by Admin in allowedModules.
  const visibleModules = modules.filter((m) => {
    return canAccessModule(currentUserData, m.id);
  });

  // Guard active tab: If user's permissions change or user navigates to an unpermitted tab, return to dashboard
  useEffect(() => {
    if (activeTab !== 'dashboard') {
      const allowed = canAccessModule(currentUserData, activeTab);
      if (!allowed) {
        setActiveTab('dashboard');
      }
    }
  }, [activeTab, currentUserData]);

  // Handle mobile back button / browser history for modules
  useEffect(() => {
    if (!window.history.state) {
      window.history.replaceState({ tab: 'dashboard' }, '');
    }

    const handlePopState = (e: PopStateEvent) => {
      // If the back event is from an inner modal/subview inside the current tab (e.g., dealer form, user form, order modal), don't jump to dashboard
      if (
        e.state?.dealerFormOpen ||
        e.state?.userFormOpen ||
        e.state?.orderModalOpen ||
        e.state?.payModalOpen ||
        (e.state?.tab && e.state.tab === activeTab)
      ) {
        return;
      }

      if (e.state?.tab && e.state.tab !== 'dashboard') {
        setActiveTab(e.state.tab);
      } else {
        if (activeTab !== 'dashboard') {
          setActiveTab('dashboard');
        } else {
          // If already on dashboard, prevent app from closing immediately
          window.history.pushState({ tab: 'dashboard' }, '');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [activeTab]);

  const handleTabChange = (tab: string) => {
    if (tab !== activeTab) {
      window.history.pushState({ tab }, '');
      setActiveTab(tab);
    }
  };

  const renderContent = () => {
    // If not on dashboard and module is not permitted, fallback to dashboard view
    if (activeTab !== 'dashboard' && !canAccessModule(currentUserData, activeTab)) {
      return (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center max-w-md mx-auto my-12">
          <p className="text-sm font-bold text-slate-800">तुम्हाला या पर्यायासाठी परवानगी नाही (Access Denied)</p>
          <button 
            onClick={() => handleTabChange('dashboard')} 
            className="mt-4 px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold"
          >
            डॅशबोर्डवर परत जा
          </button>
        </div>
      );
    }

    const view = (() => {
      switch (activeTab) {
        case 'target': return <TargetSheetView profile={currentUserData} lang={lang} />;
        case 'user': return <UserManagementView profile={currentUserData} lang={lang} onProfileUpdate={onProfileUpdate} />;
        case 'order': return <OrderView profile={currentUserData} lang={lang} />;
        case 'collection': return <CollectionView profile={currentUserData} lang={lang} />;
        case 'outstanding':
        case 'calculator': return <OutstandingView profile={currentUserData} lang={lang} />;
        case 'price': return <PriceListView profile={currentUserData} lang={lang} />;
        case 'dealer': return <DealerView profile={currentUserData} lang={lang} />;
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
          <ErrorBoundary>{view}</ErrorBoundary>
        </div>
      );
    }
        return (
          <div className="space-y-6">
            {/* Logged-In User Profile: Full Officer Name with Compressed Designation */}
            <div className="flex items-center gap-3 mx-auto max-w-2xl px-2">
              <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm sm:text-base font-black text-slate-900 tracking-tight">
                  {toTitleCase(currentUserData.fullName) || 'User'}
                </span>
                <span className="text-[10px] sm:text-xs font-bold text-slate-600 tracking-tight bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                  {isUserAdmin ? (currentUserData.role === 'owner' ? 'Owner (MD)' : 'Admin') : toTitleCase(currentUserData.designation || currentUserData.role)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 max-w-2xl mx-auto">
              {visibleModules.map((module) => (
                <button
                  key={module.id}
                  onClick={() => handleTabChange(module.id)}
                  className="flex flex-col items-center gap-2 p-3 rounded-2xl bg-white border border-slate-100 hover:border-slate-300 hover:shadow-md transition-all active:scale-95 group"
                >
                  <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center transition-transform group-hover:scale-105 shadow-sm", module.bg)}>
                    <module.icon className={cn("w-6 h-6", module.color)} />
                  </div>
                  <div className="flex items-center gap-1 justify-center">
                    <span className="text-[11px] font-semibold text-slate-700 text-center leading-tight">
                      {module.label}
                    </span>
                    {module.id === 'user' && <UserPlus className="w-3 h-3 text-emerald-500" />}
                  </div>
                </button>
              ))}
              
              <button
                onClick={handleLogoutClick}
                className="flex flex-col items-center gap-2 p-3 rounded-2xl bg-white border border-slate-100 hover:border-rose-200 hover:shadow-md transition-all active:scale-95 group"
              >
                <div className="w-12 h-12 rounded-2xl bg-rose-50 flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
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
      <header className="bg-white border-b border-slate-200 px-4 py-2.5 flex items-center justify-between sticky top-0 z-10 shadow-xs mobile-safe-header">
        <div className="flex items-center gap-3">
          {activeTab !== 'dashboard' && (
            <button
              onClick={() => handleTabChange('dashboard')}
              className="p-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition shrink-0 cursor-pointer"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          
          {/* Logo with dedicated room - Clear and Bigger */}
          <div className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 flex items-center justify-center p-0.5">
            <img 
              src={logoUrl || '/logo.jpg'} 
              alt="Blackworm Agritech Logo"
              className="max-w-full max-h-full object-contain drop-shadow-xs"
            />
          </div>

          {/* Company Title - Updated to full name with increased font size */}
          <div className="flex flex-col justify-center min-w-0">
            <h1 className="text-sm sm:text-base md:text-lg lg:text-xl font-black text-rose-600 tracking-tight leading-tight uppercase break-words sm:whitespace-nowrap">
              BLACKWORM AGRITECH PVT LTD
            </h1>
          </div>
        </div>

        {/* Current Active Logged-In User Badge in Header */}
        <div className="hidden sm:flex items-center gap-1.5 px-3">
          <span className="text-xs font-black text-slate-900 leading-none">
            {toTitleCase(currentUserData.fullName) || 'User'}
          </span>
          <span className="text-[9.5px] font-bold text-slate-600 leading-none bg-slate-100 border border-slate-200 px-1 py-0.5 rounded">
            {currentUserData.role === 'owner' ? 'Owner (MD)' : toTitleCase(currentUserData.designation || currentUserData.role)}
          </span>
        </div>
      </header>

      <main className="px-3 sm:px-4 py-3 sm:py-6 flex-1 max-w-4xl mx-auto w-full">
        {renderContent()}
      </main>

      <OfflineIndicator />

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 pt-2 flex justify-around items-center z-20 shadow-lg mobile-safe-nav">
        <NavItem icon={BarChart3} label={t.dashboard} active={activeTab === 'dashboard'} onClick={() => handleTabChange('dashboard')} />
        {canAccessModule(currentUserData, 'target') && (
          <NavItem icon={Target} label={t.target} active={activeTab === 'target'} onClick={() => handleTabChange('target')} />
        )}
        {canAccessModule(currentUserData, 'order') && (
          <NavItem icon={ShoppingBag} label={t.orders} active={activeTab === 'order'} onClick={() => handleTabChange('order')} />
        )}
        {canAccessModule(currentUserData, 'collection') && (
          <NavItem icon={IndianRupee} label={t.collections} active={activeTab === 'collection'} onClick={() => handleTabChange('collection')} />
        )}
        {canAccessModule(currentUserData, 'dealer') && (
          <NavItem icon={Users} label={t.dealer} active={activeTab === 'dealer'} onClick={() => handleTabChange('dealer')} />
        )}
        {canAccessModule(currentUserData, 'travel') && (
          <NavItem icon={Bike} label={t.travel} active={activeTab === 'travel'} onClick={() => handleTabChange('travel')} />
        )}
      </nav>
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};


interface NavItemProps {
  icon: any;
  label: string;
  active?: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ icon: Icon, label, active, onClick }) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex flex-col items-center justify-center min-w-[50px] transition-all relative py-2 group active:scale-90",
      active ? "text-rose-600" : "text-slate-400 hover:text-slate-600"
    )}
    title={label}
  >
    <Icon className={cn("w-6 h-6 transition-transform", active && "scale-110")} />
    {active && <div className="w-1.5 h-1.5 bg-rose-600 rounded-full absolute -bottom-1" />}
  </button>
);
