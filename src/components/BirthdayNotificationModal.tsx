import React, { useEffect, useMemo, useState } from 'react';
import { Cake, Phone, Sparkles, X } from 'lucide-react';
import {
  BirthdayPerson,
  collectVisibleTodaysBirthdays,
  formatBirthdayDisplayDate,
  getTodayLocalInfo,
} from '../lib/birthdayNotifier';
import { UserProfile, canAccessModule, isAdmin, isGodownIncharge } from '../lib/auth';
import { useSharedDealers, useSharedOfficeStaff, useSharedUsers } from '../lib/realtimeStore';
import { cn } from '../lib/utils';

const DealerBirthdaySource: React.FC<{ onData: (items: any[]) => void }> = ({ onData }) => {
  const { dealers } = useSharedDealers();
  useEffect(() => {
    onData(dealers);
  }, [dealers, onData]);
  return null;
};

const OfficeStaffBirthdaySource: React.FC<{ onData: (items: any[]) => void }> = ({ onData }) => {
  const { staffMembers } = useSharedOfficeStaff();
  useEffect(() => {
    onData(staffMembers);
  }, [staffMembers, onData]);
  return null;
};

export const DashboardBirthdayWatcher: React.FC<{
  profile: UserProfile;
  onBirthdaysChange: (birthdays: BirthdayPerson[], dateKey: string) => void;
}> = ({ profile, onBirthdaysChange }) => {
  const { users } = useSharedUsers();
  const [dealers, setDealers] = useState<any[]>([]);
  const [officeStaff, setOfficeStaff] = useState<any[]>([]);
  const [dateKey, setDateKey] = useState<string>(() => getTodayLocalInfo().dateKey);

  const canSubscribeDealers = isAdmin(profile) || canAccessModule(profile, 'dealer');
  const canSubscribeStaff =
    isAdmin(profile) || canAccessModule(profile, 'office_staff') || isGodownIncharge(profile);

  useEffect(() => {
    if (!canSubscribeDealers) setDealers([]);
  }, [canSubscribeDealers]);

  useEffect(() => {
    if (!canSubscribeStaff) setOfficeStaff([]);
  }, [canSubscribeStaff]);

  // Refresh dateKey when tab regains focus or after midnight
  useEffect(() => {
    const refreshDate = () => {
      const nextKey = getTodayLocalInfo().dateKey;
      setDateKey((prev) => (prev === nextKey ? prev : nextKey));
    };
    const interval = window.setInterval(refreshDate, 60 * 1000);
    window.addEventListener('focus', refreshDate);
    document.addEventListener('visibilitychange', refreshDate);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshDate);
      document.removeEventListener('visibilitychange', refreshDate);
    };
  }, []);

  const birthdays = useMemo(
    () =>
      collectVisibleTodaysBirthdays({
        profile,
        users,
        dealers: canSubscribeDealers ? dealers : [],
        officeStaff: canSubscribeStaff ? officeStaff : [],
        now: new Date(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, users, dealers, officeStaff, canSubscribeDealers, canSubscribeStaff, dateKey]
  );

  const lastEmittedBirthdaySigRef = React.useRef<string>('');

  useEffect(() => {
    const sig = `${dateKey}::${birthdays.map((b) => `${b.id}:${b.name}`).join(',')}`;
    if (lastEmittedBirthdaySigRef.current === sig) return;
    lastEmittedBirthdaySigRef.current = sig;
    onBirthdaysChange(birthdays, dateKey);
  }, [birthdays, dateKey, onBirthdaysChange]);

  return (
    <>
      {canSubscribeDealers && <DealerBirthdaySource onData={setDealers} />}
      {canSubscribeStaff && <OfficeStaffBirthdaySource onData={setOfficeStaff} />}
    </>
  );
};

interface BirthdayNotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  birthdays: BirthdayPerson[];
}

export const BirthdayNotificationModal: React.FC<BirthdayNotificationModalProps> = ({
  isOpen,
  onClose,
  birthdays,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || birthdays.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200 no-print"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="birthday-popup-title"
    >
      <div
        className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-rose-100 overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Celebratory Header */}
        <div className="bg-gradient-to-r from-rose-600 via-pink-600 to-amber-500 px-5 py-4 text-white relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3.5 right-3.5 p-1.5 rounded-full bg-white/20 hover:bg-white/30 text-white transition cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-3 pr-8">
            <div className="w-11 h-11 rounded-2xl bg-white/20 border border-white/30 flex items-center justify-center shrink-0 shadow-sm">
              <Cake className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-200 shrink-0" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-100">
                  Birthday Notification ({birthdays.length})
                </span>
              </div>
              <h2 id="birthday-popup-title" className="text-base sm:text-lg font-black leading-tight mt-0.5">
                आजचे वाढदिवस (Today&apos;s Birthdays)
              </h2>
            </div>
          </div>
        </div>

        {/* Wishes Note */}
        <div className="px-5 py-2.5 bg-amber-50/80 border-b border-amber-100 text-xs font-bold text-amber-900">
          वाढदिवसाच्या हार्दिक शुभेच्छा! आज खालील व्यक्तींचा वाढदिवस आहे:
        </div>

        {/* Scrollable List */}
        <div className="p-4 space-y-2.5 max-h-[55vh] overflow-y-auto bg-slate-50/50">
          {birthdays.map((person) => {
            const badgeStyle =
              person.source === 'dealer'
                ? 'bg-rose-50 text-rose-700 border-rose-200'
                : person.source === 'staff'
                ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200';

            return (
              <div
                key={person.id}
                className="bg-white rounded-2xl border border-slate-200 p-3.5 shadow-xs flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        'text-[10px] font-black px-2 py-0.5 rounded border',
                        badgeStyle
                      )}
                    >
                      {person.sourceLabel}
                    </span>
                    {person.code && (
                      <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                        {person.code}
                      </span>
                    )}
                  </div>

                  <p className="text-sm font-black text-slate-900 leading-snug break-words">
                    {person.name}
                  </p>

                  {person.subtitle && (
                    <p className="text-xs font-semibold text-slate-600 leading-snug break-words">
                      {person.subtitle}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] font-bold text-slate-500">
                    <span>जन्मदिनांक: {formatBirthdayDisplayDate(person.dateOfBirth)}</span>
                    {person.mobileNumber && (
                      <a
                        href={`tel:${person.mobileNumber}`}
                        className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700 font-black"
                      >
                        <Phone className="w-3 h-3" />
                        <span>{person.mobileNumber}</span>
                      </a>
                    )}
                  </div>
                </div>

                <div className="w-9 h-9 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center shrink-0 text-rose-600">
                  <Cake className="w-4 h-4" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-white border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black shadow-sm transition active:scale-95 cursor-pointer"
          >
            ठीक आहे (OK)
          </button>
        </div>
      </div>
    </div>
  );
};
