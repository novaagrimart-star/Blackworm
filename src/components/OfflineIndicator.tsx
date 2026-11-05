import React, { useState } from 'react';
import { WifiOff, CheckCircle2, RefreshCw } from 'lucide-react';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { getPendingSyncCount, triggerFullDataRefresh } from '../lib/dataService';
import { cn } from '../lib/utils';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pendingCount = getPendingSyncCount();

  if (isOnline && pendingCount === 0) return null;

  const handleManualSync = async () => {
    setIsRefreshing(true);
    try {
      await triggerFullDataRefresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 800);
    }
  };

  if (!isOnline) {
    return (
      <div className="fixed bottom-16 left-4 right-4 md:left-auto md:right-6 md:w-96 z-50 flex items-center gap-3 rounded-xl bg-amber-600/95 backdrop-blur-md px-4 py-2.5 text-xs font-medium text-white shadow-2xl border border-amber-400/30">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-200 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white"></span>
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white flex items-center gap-1.5">
            <WifiOff className="w-3.5 h-3.5 inline" /> ऑफलाइन मोड सक्रिय (Offline Mode)
          </p>
          <p className="text-[11px] text-amber-100 truncate">
            {pendingCount > 0 
              ? `${pendingCount} नोंदी स्थानिक सेव्ह आहेत, नेट आल्यावर सिंक होतील` 
              : 'डीलर व ट्रॅव्हलिंग शीट पूर्णपणे वापरू शकता'}
          </p>
        </div>
      </div>
    );
  }

  // When back online with pending syncs
  return (
    <div className="fixed bottom-16 left-4 right-4 md:left-auto md:right-6 md:w-96 z-50 flex items-center justify-between gap-3 rounded-xl bg-emerald-600/95 backdrop-blur-md px-4 py-2 text-xs font-medium text-white shadow-2xl border border-emerald-400/30 animate-fade-in">
      <div className="flex items-center gap-2 min-w-0">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-200" />
        <span className="truncate">{pendingCount} ऑफलाइन नोंदी सिंक होत आहेत...</span>
      </div>
      <button
        onClick={handleManualSync}
        disabled={isRefreshing}
        className="flex items-center gap-1 bg-white/20 hover:bg-white/30 px-2 py-1 rounded text-[11px] font-bold text-white transition-all cursor-pointer"
      >
        <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
        सिंक
      </button>
    </div>
  );
};
