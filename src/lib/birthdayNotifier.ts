import {
  UserProfile,
  isAdmin,
  canAccessModule,
  isGodownIncharge,
  isUserRecord,
} from './auth';
import { toTitleCase } from './utils';

export type BirthdaySource = 'employee' | 'staff' | 'dealer';

export interface BirthdayPerson {
  id: string;
  source: BirthdaySource;
  sourceLabel: string;
  name: string;
  subtitle: string;
  mobileNumber?: string;
  dateOfBirth: string;
  code?: string;
  age?: number | null;
}

export interface TodayLocalInfo {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dateKey: string; // YYYY-MM-DD
}

export interface ParsedMonthDay {
  year: number | null;
  month: number; // 1-12
  day: number; // 1-31
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function getTodayLocalInfo(now: Date = new Date()): TodayLocalInfo {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    year,
    month,
    day,
    dateKey: `${year}-${mm}-${dd}`,
  };
}

/**
 * Parses common DOB formats safely without UTC timezone shift:
 * - YYYY-MM-DD or YYYY/MM/DD or ISO timestamp (e.g. 1992-05-14T00:00:00.000Z)
 * - DD-MM-YYYY or DD/MM/YYYY
 */
export function parseMonthDay(rawDob: unknown): ParsedMonthDay | null {
  if (!rawDob) return null;
  const raw = String(rawDob).trim();
  if (!raw) return null;

  // 1. YYYY-MM-DD or YYYY/MM/DD (with optional ISO time suffix)
  const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
    return null;
  }

  // 2. DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s].*)?$/);
  if (dmyMatch) {
    const p1 = parseInt(dmyMatch[1], 10);
    const p2 = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);
    // In India, DD-MM-YYYY is standard; handle MM-DD-YYYY only if middle > 12
    let day = p1;
    let month = p2;
    if (p2 > 12 && p1 >= 1 && p1 <= 12) {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
    return null;
  }

  return null;
}

export function isBirthdayToday(rawDob: unknown, today: TodayLocalInfo): boolean {
  const parsed = parseMonthDay(rawDob);
  if (!parsed) return false;
  if (parsed.month === today.month && parsed.day === today.day) {
    return true;
  }
  // Celebrate Feb 29 birthdays on Feb 28 in non-leap years so they aren't skipped
  if (
    parsed.month === 2 &&
    parsed.day === 29 &&
    !isLeapYear(today.year) &&
    today.month === 2 &&
    today.day === 28
  ) {
    return true;
  }
  return false;
}

function computeDisplayAge(parsed: ParsedMonthDay | null, currentYear: number): number | null {
  if (!parsed || !parsed.year) return null;
  const age = currentYear - parsed.year;
  if (age >= 15 && age <= 100) return age;
  return null;
}

function normalizeName(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeCode(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^emp-/, '');
}

function isSameUserProfile(candidate: any, profile: Partial<UserProfile>): boolean {
  if (!candidate || !profile) return false;

  const myUid = String(profile.uid || '').trim().toLowerCase();
  const cUid = String(candidate.uid || candidate.id || '').trim().toLowerCase();
  if (myUid && cUid && myUid === cUid) return true;

  const myLogin = String(profile.loginId || '').trim().toLowerCase();
  const cLogin = String(candidate.loginId || '').trim().toLowerCase();
  if (myLogin && cLogin && cLogin !== 'admin' && myLogin === cLogin) return true;

  const myCode = normalizeCode(profile.userCode);
  const cCode = normalizeCode(candidate.userCode);
  if (myCode && cCode && myCode === cCode) return true;

  const myName = normalizeName(profile.fullName);
  const cName = normalizeName(candidate.fullName);
  if (myName && cName && myName === cName) return true;

  return false;
}

/**
 * Matches DealerView's exact officer-ownership rules so non-admin users only
 * see birthday notifications for dealer forms they filled / own.
 */
function isDealerOwnedByUser(dealer: any, profile: Partial<UserProfile>): boolean {
  if (!dealer || !profile) return false;
  if (isAdmin(profile)) return true;

  const myUid = String(profile.uid || '').trim().toLowerCase();
  const creatorId = String(
    dealer.created_by_user_id ||
      dealer.createdByUid ||
      dealer.userId ||
      dealer.ownerId ||
      dealer.assignedOfficerUid ||
      ''
  )
    .trim()
    .toLowerCase();
  if (myUid && creatorId && creatorId === myUid) return true;

  const myName = normalizeName(profile.fullName);
  const dealerOfficerName = normalizeName(dealer.officerName || dealer.created_by_name);
  if (myName && dealerOfficerName && dealerOfficerName === myName) return true;

  const myLogin = String(profile.loginId || '').trim().toLowerCase();
  const dealerLogin = String(dealer.loginId || '').trim().toLowerCase();
  if (myLogin && dealerLogin && dealerLogin !== 'admin' && dealerLogin === myLogin) return true;

  const myCode = normalizeCode(profile.userCode);
  const dealerCode = normalizeCode(dealer.userCode || dealer.createdByUserCode);
  if (myCode && dealerCode && myCode === dealerCode) return true;

  return isUserRecord(dealer, profile);
}

export interface CollectBirthdaysParams {
  profile: Partial<UserProfile> | null | undefined;
  users?: any[];
  dealers?: any[];
  officeStaff?: any[];
  now?: Date;
}

/**
 * Collects today's birthdays strictly according to the logged-in user's
 * module permissions and form ownership:
 * - Admin/Owner: All active Employees (Users), Office/Factory Staff, and Dealers.
 * - Non-Admin: Only their own User Form + Dealer forms belonging to them (if Dealer module permitted)
 *   + Office/Factory Staff roster (if Warehouse/Office Staff module permitted).
 */
export function collectVisibleTodaysBirthdays({
  profile,
  users = [],
  dealers = [],
  officeStaff = [],
  now = new Date(),
}: CollectBirthdaysParams): BirthdayPerson[] {
  if (!profile) return [];

  const today = getTodayLocalInfo(now);
  const userIsAdmin = isAdmin(profile);
  const result: BirthdayPerson[] = [];
  const seenUserUids = new Set<string>();
  const seenNameDateKeys = new Set<string>();

  // 1. User Forms (Employees / Officers / Self)
  const candidateUsers: any[] = Array.isArray(users) ? [...users] : [];
  if (!userIsAdmin && profile.uid) {
    const hasOwnInList = candidateUsers.some((u) => isSameUserProfile(u, profile));
    if (!hasOwnInList && (profile as any).dateOfBirth) {
      candidateUsers.push(profile);
    }
  }

  candidateUsers.forEach((u) => {
    if (!u || u.isArchived || u.status === 'Inactive') return;
    if (String(u.role || '').toLowerCase() === 'dealer' && !isSameUserProfile(u, profile)) {
      return;
    }
    if (!userIsAdmin && !isSameUserProfile(u, profile)) {
      return;
    }
    if (!isBirthdayToday(u.dateOfBirth, today)) return;

    const uid = String(u.uid || u.id || '').trim();
    if (uid && seenUserUids.has(uid)) return;
    if (uid) seenUserUids.add(uid);

    const normName = normalizeName(u.fullName);
    const parsed = parseMonthDay(u.dateOfBirth);
    if (normName && parsed) {
      seenNameDateKeys.add(`${normName}|${parsed.month}-${parsed.day}`);
    }

    const displayName = toTitleCase(u.fullName || u.loginId || 'Employee');
    const roleOrDesig =
      u.role === 'owner'
        ? 'Owner (MD)'
        : toTitleCase(u.designation || u.role || 'Employee');
    const center = toTitleCase(u.center || '');
    const subtitleParts = [roleOrDesig, center ? `Center: ${center}` : ''].filter(Boolean);

    result.push({
      id: `user:${uid || normName}`,
      source: 'employee',
      sourceLabel: 'कर्मचारी (Employee)',
      name: displayName,
      subtitle: subtitleParts.join(' • '),
      mobileNumber: String(u.mobileNumber || '').trim() || undefined,
      dateOfBirth: String(u.dateOfBirth || ''),
      code: String(u.userCode || '').trim() || undefined,
      age: computeDisplayAge(parsed, today.year),
    });
  });

  // 2. Office / Factory Staff Forms (Warehouse Incharge Roster)
  const canSeeStaff =
    userIsAdmin ||
    canAccessModule(profile, 'office_staff') ||
    isGodownIncharge(profile);

  if (canSeeStaff && Array.isArray(officeStaff)) {
    officeStaff.forEach((s) => {
      if (!s || s.isArchived || s.status === 'Inactive') return;

      const linkedUid = String(
        s.linkedUserUid ||
          (String(s.id || '').startsWith('staff_user_')
            ? String(s.id).replace(/^staff_user_/, '')
            : '')
      ).trim();

      if (linkedUid && seenUserUids.has(linkedUid)) return;
      if (!isBirthdayToday(s.dateOfBirth, today)) return;

      const normName = normalizeName(s.fullName);
      const parsed = parseMonthDay(s.dateOfBirth);
      const nameDateKey = normName && parsed ? `${normName}|${parsed.month}-${parsed.day}` : '';
      if (nameDateKey && seenNameDateKeys.has(nameDateKey)) return;

      if (linkedUid) seenUserUids.add(linkedUid);
      if (nameDateKey) seenNameDateKeys.add(nameDateKey);

      const categoryLabel =
        s.category === 'Factory Staff'
          ? 'फॅक्टरी स्टाफ (Factory Staff)'
          : 'ऑफिस स्टाफ (Office Staff)';
      const workRole = toTitleCase(s.workRole || s.designation || s.category || 'Staff');
      const place = toTitleCase(s.center || s.village || '');
      const subtitleParts = [workRole, place].filter(Boolean);

      result.push({
        id: `staff:${String(s.id || normName)}`,
        source: 'staff',
        sourceLabel: categoryLabel,
        name: toTitleCase(s.fullName || 'Staff Member'),
        subtitle: subtitleParts.join(' • '),
        mobileNumber: String(s.mobileNumber || '').trim() || undefined,
        dateOfBirth: String(s.dateOfBirth || ''),
        code: String(s.staffCode || s.userCode || '').trim() || undefined,
        age: computeDisplayAge(parsed, today.year),
      });
    });
  }

  // 3. Dealer Forms (Strictly filtered per logged-in user if non-admin)
  const canSeeDealers = userIsAdmin || canAccessModule(profile, 'dealer');

  if (canSeeDealers && Array.isArray(dealers)) {
    const seenDealerIds = new Set<string>();
    dealers.forEach((d) => {
      if (!d || d.isArchived) return;
      if (!isDealerOwnedByUser(d, profile)) return;
      if (!isBirthdayToday(d.dateOfBirth, today)) return;

      const dId = String(d.id || '').trim();
      if (dId && seenDealerIds.has(dId)) return;
      if (dId) seenDealerIds.add(dId);

      const parsed = parseMonthDay(d.dateOfBirth);
      const proprietor = toTitleCase(d.proprietorName || '');
      const firm = toTitleCase(d.firmName || '');
      const displayName = proprietor || firm || 'Dealer';
      const place = [toTitleCase(d.village || ''), toTitleCase(d.taluka || '')]
        .filter(Boolean)
        .join(', ');
      const subtitleParts = [
        proprietor && firm ? firm : '',
        place,
      ].filter(Boolean);

      result.push({
        id: `dealer:${dId || normalizeName(displayName)}`,
        source: 'dealer',
        sourceLabel: 'डीलर (Dealer)',
        name: displayName,
        subtitle: subtitleParts.join(' • ') || 'Dealership Form',
        mobileNumber: String(d.contactNumber || d.mobileNumber || '').trim() || undefined,
        dateOfBirth: String(d.dateOfBirth || ''),
        code: String(d.dealerCode || '').trim() || undefined,
        age: computeDisplayAge(parsed, today.year),
      });
    });
  }

  const sourceOrder: Record<BirthdaySource, number> = {
    employee: 0,
    staff: 1,
    dealer: 2,
  };

  return result.sort((a, b) => {
    const orderDiff = sourceOrder[a.source] - sourceOrder[b.source];
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name);
  });
}

export function formatBirthdayDisplayDate(rawDob: string): string {
  const parsed = parseMonthDay(rawDob);
  if (!parsed) return rawDob;
  const dd = String(parsed.day).padStart(2, '0');
  const mm = String(parsed.month).padStart(2, '0');
  return parsed.year ? `${dd}/${mm}/${parsed.year}` : `${dd}/${mm}`;
}
