import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../lib/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-16 left-4 right-4 md:left-auto md:right-6 md:w-96 z-50 flex items-center gap-3 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xl animate-bounce">
      <WifiOff className="w-4 h-4 shrink-0" />
      <div className="flex-1">
        <p className="font-bold">ऑफलाइन मोड (Offline Mode)</p>
        <p className="text-[11px] font-normal text-amber-100">डेटा सुरक्षितपणे सेव्ह होत आहे. इंटरनेट आल्यावर आपोआप सर्व्हरशी सिंक होईल.</p>
      </div>
    </div>
  );
};
