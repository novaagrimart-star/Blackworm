import React, { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { getPendingSyncCount } from '../lib/dataService';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState<number>(() => getPendingSyncCount());

  useEffect(() => {
    const syncCount = () => setPendingCount(getPendingSyncCount());
    syncCount();
    window.addEventListener('blackworm_sync_status', syncCount as EventListener);
    window.addEventListener('storage', syncCount);
    window.addEventListener('online', syncCount);
    return () => {
      window.removeEventListener('blackworm_sync_status', syncCount as EventListener);
      window.removeEventListener('storage', syncCount);
      window.removeEventListener('online', syncCount);
    };
  }, []);

  if (isOnline) return null;

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
};
