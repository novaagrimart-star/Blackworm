import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { initializeApp } from 'firebase/app';
import { collection, doc, getDocFromServer, getDocs, limit, query, initializeFirestore, terminate } from 'firebase/firestore';
import { collectVisibleTodaysBirthdays, parseMonthDay } from '../src/lib/birthdayNotifier';
import {
  areModuleSeenMapsEqual,
  computeModuleUpdates,
  computePricelistFingerprint,
  getDefaultInitialBaselineMs,
  getSeenCloudDocId,
  mergeModuleSeenMaps,
} from '../src/lib/moduleUpdates';
import { isUserRecord } from '../src/lib/auth';
import {
  deduplicateOrders,
  deriveOrderCreatedAt,
  mergeOrderBaseFields,
} from '../src/lib/dataService';
import {
  GOOGLE_APPS_SCRIPT_TEMPLATE,
  SHEETS_FAILOVER_COLLECTIONS,
  sanitizeDocForSheets,
} from '../src/lib/sheetsFailover';

const ROOT = process.cwd();

function sha256File(relPath: string): string {
  const abs = path.join(ROOT, relPath);
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function logStep(label: string) {
  console.log(`✅ [PASS] ${label}`);
}

async function verifyCoreLocksAndSchemas() {
  const lockRaw = fs.readFileSync(path.join(ROOT, '.core-lock.json'), 'utf-8');
  const lock = JSON.parse(lockRaw) as {
    lockedFiles: Record<string, string>;
    requiredCollections: string[];
  };

  for (const [relPath, expectedHash] of Object.entries(lock.lockedFiles)) {
    const actualHash = sha256File(relPath);
    assert.equal(actualHash, expectedHash, `Core lock mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`);
  }
  logStep(`Core file lock verified (${Object.keys(lock.lockedFiles).length} protected files untouched)`);

  const rulesText = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf-8');
  const secDbText = fs.readFileSync(path.join(ROOT, 'server/secondaryDb.ts'), 'utf-8');
  for (const col of lock.requiredCollections) {
    assert.ok(rulesText.includes(`match /${col}/`), `Missing Firestore rule for collection: ${col}`);
    assert.ok(secDbText.includes(`'${col}'`), `Missing SQLite allowlist entry for collection: ${col}`);
  }
  logStep(`Collection schema parity verified (${lock.requiredCollections.length} collections across Firestore rules & SQLite)`);

  const appVersionText = fs.readFileSync(path.join(ROOT, 'src/lib/appVersion.ts'), 'utf-8');
  assert.ok(appVersionText.includes('appassets.androidplatform.net'), 'APK detection must include appassets.androidplatform.net');
  assert.ok(appVersionText.includes('capacitor:'), 'APK detection must include capacitor:');
  assert.ok(appVersionText.includes('/api/health'), 'Remote version check must fall back to /api/health');

  const dashboardText = fs.readFileSync(path.join(ROOT, 'src/components/Dashboard.tsx'), 'utf-8');
  assert.ok(dashboardText.includes('isPackagedApkShell'), 'Dashboard routing must guard pathname inside packaged APK shells');

  const viteText = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
  assert.ok(viteText.includes("navigateFallback: '/index.html'"), 'Workbox must define SPA navigateFallback');
  assert.ok(viteText.includes('/^\\/data\\//'), 'Workbox navigateFallbackDenylist must exclude /data/');
  assert.ok(!dashboardText.includes("id: 'birthday'"), 'Dashboard must not add a dedicated birthday module grid button');
  assert.ok(dashboardText.includes('todaysBirthdays.length > 0'), 'Birthday icon must only appear conditionally on birthday days');

  const locationViewText = fs.readFileSync(path.join(ROOT, 'src/components/modules/LocationView.tsx'), 'utf-8');
  assert.ok(locationViewText.includes('useSharedLocationDealers'), 'LocationView must use separate location_dealers store');
  assert.ok(!locationViewText.includes('useSharedDealers'), 'LocationView must stay strictly unlinked from Dealer Management');
  assert.ok(!locationViewText.includes('LGD:'), 'LocationView must not display LGD badges');
  assert.ok(!locationViewText.includes('नवीन तालुका'), 'LocationView must not display add taluka button');
  assert.ok(!locationViewText.includes('नवीन गाव Add करा'), 'LocationView must not display add village button');

  const godownViewText = fs.readFileSync(path.join(ROOT, 'src/components/modules/GodownInchargeView.tsx'), 'utf-8');
  assert.ok(godownViewText.includes('warehouseTab'), 'GodownInchargeView must track sub-tabs in history state for mobile Back navigation');

  assert.ok(!dashboardText.includes('<ModuleUpdatePopup'), 'Dashboard must NOT mount floating ModuleUpdatePopup box');
  assert.ok(dashboardText.includes('badgeCount > 0'), 'Dashboard must retain red numbered badges on module grid');
  assert.ok(dashboardText.includes('badgeCount={moduleBadges.order?.count}'), 'Dashboard bottom nav must retain order badgeCount');

  const orderViewText = fs.readFileSync(path.join(ROOT, 'src/components/modules/OrderView.tsx'), 'utf-8');
  assert.ok(orderViewText.includes('createdByUid'), 'OrderView must preserve createdByUid metadata');
  assert.ok(orderViewText.includes('updatedByUid'), 'OrderView must preserve updatedByUid metadata');
  assert.ok(orderViewText.includes('_syncUpdatedAtMs'), 'OrderView must preserve _syncUpdatedAtMs metadata');
  assert.ok(orderViewText.includes('formatDisplayDate'), 'OrderView must use safe formatDisplayDate helper');
  assert.ok(orderViewText.includes('userSelectedStatusFilterRef'), 'OrderView must switch off empty Pending (0) automatically');

  logStep('Frontend routing, APK WebView, Location/Warehouse/Order/Dashboard invariants, and offline SW verified');
}

function verifyBirthdayNotifications() {
  assert.deepEqual(parseMonthDay('1992-05-15'), { year: 1992, month: 5, day: 15 });
  assert.deepEqual(parseMonthDay('15/05/1990'), { year: 1990, month: 5, day: 15 });
  assert.deepEqual(parseMonthDay('15-05-1990T00:00:00Z'), { year: 1990, month: 5, day: 15 });
  assert.equal(parseMonthDay(''), null);

  const may15 = new Date(2026, 4, 15, 9, 30, 0);
  const may16 = new Date(2026, 4, 16, 9, 30, 0);
  const feb28NonLeap = new Date(2026, 1, 28, 9, 30, 0);

  const sampleUsers = [
    { uid: 'u_admin', fullName: 'Admin User', role: 'admin', status: 'Active', dateOfBirth: '1980-01-01', createdAt: '' },
    { uid: 'u_emp1', fullName: 'Ramesh Patil', role: 'sales_officer', userCode: 'EMP-02', status: 'Active', dateOfBirth: '1991-05-15', createdAt: '' },
    { uid: 'u_emp2', fullName: 'Suresh Kulkarni', role: 'sales_officer', userCode: 'EMP-03', status: 'Active', dateOfBirth: '1993-05-15', createdAt: '' },
    { uid: 'u_incharge', fullName: 'Vikram Shinde', role: 'godown_incharge', userCode: 'EMP-04', status: 'Active', dateOfBirth: '1989-05-15', createdAt: '' },
    { uid: 'u_archived', fullName: 'Old Employee', role: 'sales_officer', status: 'Active', isArchived: true, dateOfBirth: '1990-05-15', createdAt: '' },
    { uid: 'u_inactive', fullName: 'Inactive Employee', role: 'sales_officer', status: 'Inactive', dateOfBirth: '1990-05-15', createdAt: '' },
  ];

  const sampleStaff = [
    // Linked duplicate to u_incharge -> should be deduplicated
    { id: 'staff_user_u_incharge', linkedUserUid: 'u_incharge', fullName: 'Vikram Shinde', category: 'Office Staff', status: 'Active', dateOfBirth: '1989-05-15' },
    { id: 'staff_1', fullName: 'Mahesh Jadhav', category: 'Factory Staff', workRole: 'Operator', status: 'Active', dateOfBirth: '15/05/1995' },
    { id: 'staff_arch', fullName: 'Archived Staff', category: 'Office Staff', status: 'Active', isArchived: true, dateOfBirth: '1992-05-15' },
  ];

  const sampleDealers = [
    { id: 'd_1', firmName: 'Krishi Seva Kendra', proprietorName: 'Anil Deshmukh', dealerCode: 'D-101', village: 'Tasgaon', createdByUid: 'u_emp1', dateOfBirth: '1985-05-15' },
    { id: 'd_2', firmName: 'Shetkari Agro', proprietorName: 'Prakash Pawar', dealerCode: 'D-102', village: 'Miraj', createdByUid: 'u_emp2', dateOfBirth: '1987-05-15' },
    { id: 'd_arch', firmName: 'Closed Agro', proprietorName: 'Deleted Dealer', dealerCode: 'D-103', createdByUid: 'u_emp1', isArchived: true, dateOfBirth: '1988-05-15' },
    { id: 'd_leap', firmName: 'Leap Agro', proprietorName: 'Leap Proprietor', dealerCode: 'D-104', createdByUid: 'u_emp1', dateOfBirth: '1996-02-29' },
  ];

  // 1. Admin sees all 3 active employees + 1 non-duplicate staff + 2 active dealers = 6
  const adminResults = collectVisibleTodaysBirthdays({
    profile: sampleUsers[0],
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: may15,
  });
  assert.equal(adminResults.length, 6, `Admin expected 6 birthdays, got ${adminResults.length}`);

  // 2. Non-admin Field Officer (with dealer access) sees ONLY self + own dealer (d_1) = 2
  const emp1Profile = { ...sampleUsers[1], allowedModules: ['dealer', 'order'] };
  const emp1Results = collectVisibleTodaysBirthdays({
    profile: emp1Profile,
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: may15,
  });
  assert.deepEqual(
    emp1Results.map((r) => r.id),
    ['user:u_emp1', 'dealer:d_1'],
    'Field officer must only see own form and own dealer birthdays'
  );

  // 3. Non-admin Field Officer WITHOUT dealer module access sees ONLY self (never dealers/staff)
  const emp1NoDealer = collectVisibleTodaysBirthdays({
    profile: { ...sampleUsers[1], allowedModules: ['target'] },
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: may15,
  });
  assert.deepEqual(emp1NoDealer.map((r) => r.id), ['user:u_emp1']);

  // 4. Godown Incharge sees self + active staff, never dealers
  const inchargeResults = collectVisibleTodaysBirthdays({
    profile: { ...sampleUsers[3], allowedModules: ['office_staff'] },
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: may15,
  });
  assert.deepEqual(inchargeResults.map((r) => r.id), ['user:u_incharge', 'staff:staff_1']);

  // 5. Non-birthday day returns empty array
  const noneResults = collectVisibleTodaysBirthdays({
    profile: sampleUsers[0],
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: may16,
  });
  assert.equal(noneResults.length, 0);

  // 6. Feb 29 matches on Feb 28 in non-leap year 2026
  const leapResults = collectVisibleTodaysBirthdays({
    profile: sampleUsers[0],
    users: sampleUsers,
    officeStaff: sampleStaff,
    dealers: sampleDealers,
    now: feb28NonLeap,
  });
  assert.deepEqual(leapResults.map((r) => r.id), ['dealer:d_leap']);

  logStep('Birthday notification visibility, deduplication, and date matching verified');
}

function verifyModuleUpdateBadges() {
  const t0 = 1_795_000_000_000;
  const t1 = t0 + 10_000;
  const adminProfile = { uid: 'u_admin', fullName: 'Admin User', role: 'admin' };
  const officerProfile = {
    uid: 'u_off1',
    fullName: 'Ramesh Patil',
    role: 'sales_officer',
    allowedModules: ['dealer', 'order', 'price', 'setting'],
  };
  const noPriceOfficer = {
    uid: 'u_off2',
    fullName: 'Suresh Kulkarni',
    role: 'sales_officer',
    allowedModules: ['target'],
  };
  const warehouseProfile = {
    uid: 'u_godown',
    fullName: 'Vikram Shinde',
    role: 'godown_incharge',
    allowedModules: ['office_staff'],
  };

  const oldProducts = [{ id: 'p1', dealerRate: 500 }];
  const newProducts = [{ id: 'p1', dealerRate: 550 }];
  const oldPriceFp = computePricelistFingerprint(oldProducts, '2026-11-01', t0);

  const newDealer = {
    id: 'd_new',
    firmName: 'Jai Kisan Agro',
    createdByUid: 'u_off1',
    createdAt: new Date(t1).toISOString(),
  };
  const pendingOrder = {
    id: 'o_pending',
    dealerName: 'Jai Kisan Agro',
    userId: 'u_off1',
    createdByUid: 'u_off1',
    status: 'pending_approval',
    createdAt: new Date(t1).toISOString(),
  };
  const approvedOrder = {
    id: 'o_approved',
    dealerName: 'Kisan Kendra',
    userId: 'u_off1',
    status: 'approved',
    warehouseStatus: 'fresh',
    createdAt: new Date(t0 - 5000).toISOString(),
    approvedAt: new Date(t1).toISOString(),
  };

  // 1. Admin sees officer's new dealer form + pending order (not self-authored)
  const adminRes = computeModuleUpdates({
    profile: adminProfile,
    seenMap: {
      dealer: { seenAtMs: t0 },
      order: { seenAtMs: t0 },
      price: { seenAtMs: t1, fingerprint: computePricelistFingerprint(newProducts, '2026-11-22', t1) },
    },
    dealers: [newDealer],
    orders: [pendingOrder],
    pricelist: { products: newProducts, validityDate: '2026-11-22', updatedAtMs: t1 },
  });
  assert.equal(adminRes.badges.dealer?.count, 1, 'Admin must see 1 badge on dealer when user fills form');
  assert.equal(adminRes.badges.order?.count, 1, 'Admin must see 1 badge on order for new pending order');
  assert.equal(adminRes.badges.price, undefined, 'Admin who already saw price update must not get badge');

  // 2. Officer sees Admin's Price List update + Approved Order + Setting update, but NOT self-filled dealer form
  const offRes = computeModuleUpdates({
    profile: officerProfile,
    seenMap: {
      dealer: { seenAtMs: t0 },
      order: { seenAtMs: t0 },
      price: { seenAtMs: t0, fingerprint: oldPriceFp },
      setting: { seenAtMs: t0, fingerprint: 'b_old|0' },
    },
    dealers: [newDealer],
    orders: [pendingOrder, approvedOrder],
    pricelist: { products: newProducts, validityDate: '2026-11-22', updatedAtMs: t1 },
    remoteAppVersion: { hasUpdate: true, remoteBuildId: 'b_new' },
  });
  assert.equal(offRes.badges.dealer, undefined, 'Officer must not get self-notification for own dealer form');
  assert.equal(offRes.badges.price?.count, 1, 'Officer must see badge 1 when Admin updates Price List');
  assert.equal(offRes.badges.order?.count, 1, 'Officer must see badge 1 when Admin approves their order');
  assert.equal(offRes.badges.setting?.count, 1, 'User must see badge 1 on Setting when new app update arrives');

  // 3. Officer without Price List permission does not receive Price List badge
  const restrictedRes = computeModuleUpdates({
    profile: noPriceOfficer,
    seenMap: { price: { seenAtMs: t0, fingerprint: oldPriceFp } },
    pricelist: { products: newProducts, validityDate: '2026-11-22', updatedAtMs: t1 },
  });
  assert.equal(restrictedRes.badges.price, undefined);

  // 4. Godown Incharge sees Warehouse badge for 'approved' and 'complete' fresh orders
  const completeOrder = {
    id: 'o_complete',
    dealerName: 'Green Valley Agro',
    userId: 'u_off1',
    status: 'complete',
    warehouseStatus: 'fresh',
    createdAt: new Date(t0 - 2000).toISOString(),
    updatedAt: new Date(t1 + 500).toISOString(),
  };
  const whRes = computeModuleUpdates({
    profile: warehouseProfile,
    seenMap: { office_staff: { seenAtMs: t0 } },
    orders: [approvedOrder, completeOrder],
  });
  assert.equal(whRes.badges.office_staff?.count, 2, 'Warehouse must see badge 2 for approved + complete fresh orders');

  // 5. Per-record viewedRecords decrements badge step-by-step (2 -> 1 -> 0) and preserves actorName + actionLabel
  const secondPendingOrder = {
    id: 'o_pending_2',
    dealerName: 'Sahyadri Agro',
    userId: 'u_off1',
    createdByUid: 'u_off1',
    created_by_name: 'Ramesh Patil',
    status: 'pending_approval',
    createdAt: new Date(t1 + 1000).toISOString(),
  };
  const adminTwoRes = computeModuleUpdates({
    profile: adminProfile,
    seenMap: { order: { seenAtMs: t0 } },
    orders: [pendingOrder, secondPendingOrder],
  });
  assert.equal(adminTwoRes.badges.order?.count, 2, 'Admin must see 2 unread orders initially');
  assert.equal(adminTwoRes.badges.order?.unreadRecords?.[0]?.actorName, 'Ramesh Patil');
  assert.ok(Boolean(adminTwoRes.badges.order?.unreadRecords?.[0]?.actionLabel), 'Unread order must carry actionLabel');

  const adminOneViewedRes = computeModuleUpdates({
    profile: adminProfile,
    seenMap: {
      order: {
        seenAtMs: t0,
        viewedRecords: { o_pending: t1 + 500 },
      },
    },
    orders: [pendingOrder, secondPendingOrder],
  });
  assert.equal(adminOneViewedRes.badges.order?.count, 1, 'Viewing 1 order must decrement badge from 2 -> 1');
  assert.equal(adminOneViewedRes.badges.order?.unreadRecords?.[0]?.id, 'o_pending_2', 'Remaining unread order must stay highlighted');

  const adminAllViewedRes = computeModuleUpdates({
    profile: adminProfile,
    seenMap: {
      order: {
        seenAtMs: t0,
        viewedRecords: { o_pending: t1 + 500, o_pending_2: t1 + 1500 },
      },
    },
    orders: [pendingOrder, secondPendingOrder],
  });
  assert.equal(adminAllViewedRes.badges.order, undefined, 'Viewing all orders must clear badge to 0');

  // 6. After user opens/clears singleton/module, badges clear cleanly
  const clearedRes = computeModuleUpdates({
    profile: officerProfile,
    seenMap: {
      dealer: { seenAtMs: t1 + 1000 },
      order: { seenAtMs: t1 + 1000 },
      price: { seenAtMs: t1 + 1000, fingerprint: computePricelistFingerprint(newProducts, '2026-11-22', t1) },
      setting: { seenAtMs: t1 + 1000, fingerprint: 'b_new|0' },
    },
    dealers: [newDealer],
    orders: [pendingOrder, approvedOrder],
    pricelist: { products: newProducts, validityDate: '2026-11-22', updatedAtMs: t1 },
    remoteAppVersion: { hasUpdate: true, remoteBuildId: 'b_new' },
  });
  assert.equal(clearedRes.totalCount, 0, 'Clearing module seen markers must clear update badges');

  // 7. Monotonic cross-device seenMap merge preserves views across Device A & Device B + fixes pending approval seenAt
  const mergedSeen = mergeModuleSeenMaps(
    {
      order: { seenAtMs: t0, viewedRecords: { o_pending: t1 + 500, o_old: t0 - 100 } },
      price: { seenAtMs: t1, fingerprint: 'fp_new' },
    },
    {
      order: { seenAtMs: t0, viewedRecords: { o_pending_2: t1 + 1500 } },
      dealer: { seenAtMs: t1 + 2000 },
      price: { seenAtMs: t0, fingerprint: 'fp_old' },
    }
  );
  assert.equal(mergedSeen.order?.viewedRecords?.o_pending, t1 + 500);
  assert.equal(mergedSeen.order?.viewedRecords?.o_pending_2, t1 + 1500);
  assert.equal(mergedSeen.order?.viewedRecords?.o_old, undefined, 'Stale viewedRecords <= seenAtMs must be pruned');
  assert.equal(mergedSeen.dealer?.seenAtMs, t1 + 2000);
  assert.equal(mergedSeen.price?.fingerprint, 'fp_new', 'Higher seenAtMs fingerprint must win');
  assert.equal(areModuleSeenMapsEqual(mergedSeen, mergeModuleSeenMaps(mergedSeen, mergedSeen)), true);
  assert.equal(getSeenCloudDocId('uid/with..bad\\chars'), 'user_seen_uid_with__bad_chars');

  const pendingReqCleared = computeModuleUpdates({
    profile: adminProfile,
    seenMap: { user: { seenAtMs: t1 + 5000 } },
    userApprovalRequests: [
      {
        id: 'req_1',
        requestedByName: 'Officer One',
        fullName: 'Officer One',
        status: 'pending',
        createdAt: new Date(t1).toISOString(),
        updatedAt: new Date(t1).toISOString(),
      },
    ],
  });
  assert.equal(pendingReqCleared.badges.user, undefined, 'Viewed pending user approval requests <= seenAtMs must stay cleared');

  logStep('Dashboard module update badges, per-record viewedRecords decrement (2->1->0), cross-device merge, and permissions verified');
}

function verifyOrderVisibilityAndDeduplication() {
  const officer = {
    uid: 'user_rushi',
    fullName: 'RUSHIKESH MARUTI JADHAV',
    loginId: 'Rushikesh2004',
    userCode: 'EMP-005',
    role: 'sales_officer',
    allowedModules: ['order', 'dealer', 'travel', 'location'],
  };
  const admin = {
    uid: 'user_admin',
    fullName: 'SHIDHAR BALKRUSHNA SHINDE',
    role: 'admin',
  };

  // 1. Orphaned order missing primary owner metadata still matches updater; owned order approved by Admin stays with officer
  assert.equal(
    isUserRecord({ id: 'o_orphaned', updatedByUid: 'user_rushi', updatedByName: 'RUSHIKESH MARUTI JADHAV' }, officer),
    true,
    'Orphaned order with only updatedByUid/Name must still match officer'
  );
  assert.equal(
    isUserRecord(
      { id: 'o_owned', userId: 'user_other', createdByUid: 'user_other', updatedByUid: 'user_rushi' },
      officer
    ),
    false,
    'Order owned by another officer must NOT match a different updater'
  );

  // 2. deriveOrderCreatedAt recovers timestamp from order_<ms> ID cleanly
  const sampleMs = 1795406022287;
  assert.equal(
    deriveOrderCreatedAt({ id: `order_${sampleMs}` }),
    new Date(sampleMs).toISOString(),
    'deriveOrderCreatedAt must recover exact ISO timestamp from order_<ms> ID'
  );

  // 3. deduplicateOrders must NOT collapse two different dealers that happen to have colliding random BW- numbers
  const dedupDiffDealers = deduplicateOrders([
    { id: 'order_1', orderNumber: 'BW-111222', dealerId: 'd_a', dealerName: 'ALPHA AGRO', totalAmount: 5000, createdAt: '2026-11-23T10:00:00Z' },
    { id: 'order_2', orderNumber: 'BW-111222', dealerId: 'd_b', dealerName: 'BETA AGRO', totalAmount: 9000, createdAt: '2026-11-24T10:00:00Z' },
  ]);
  assert.equal(dedupDiffDealers.length, 2, 'Colliding orderNumber across different dealers must preserve BOTH orders');

  // 4. deduplicateOrders + mergeOrderBaseFields must preserve base creator/orderNumber/createdAt when newer patch omits them
  const dedupMerged = deduplicateOrders([
    {
      id: 'order_3',
      orderNumber: 'BW-333444',
      dealerId: 'd_a',
      dealerName: 'ALPHA AGRO',
      userId: 'user_rushi',
      createdByUid: 'user_rushi',
      createdByName: 'RUSHIKESH MARUTI JADHAV',
      createdAt: '2026-11-20T10:00:00Z',
    },
    {
      id: 'order_3',
      dealerId: 'd_a',
      dealerName: 'ALPHA AGRO',
      updatedByUid: 'user_admin',
      updatedByName: 'Admin',
      updatedAt: '2026-11-24T10:00:00Z',
    },
  ]);
  assert.equal(dedupMerged.length, 1);
  assert.equal(dedupMerged[0].userId, 'user_rushi');
  assert.equal(dedupMerged[0].createdByUid, 'user_rushi');
  assert.equal(dedupMerged[0].orderNumber, 'BW-333444');
  assert.equal(dedupMerged[0].createdAt, '2026-11-20T10:00:00Z');
  assert.equal(
    mergeOrderBaseFields({ id: 'x', userId: 'u1', orderNumber: 'BW-1' }, { id: 'x', totalAmount: 200 }).userId,
    'u1'
  );

  // 5. Post-approval edit & Warehouse dispatch attribution + fresh baseline visibility for recent updates
  const now = Date.now();
  const oneHourAgoIso = new Date(now - 3600_000).toISOString();
  const threeHoursAgoIso = new Date(now - 3 * 3600_000).toISOString();
  const fourHoursAgoIso = new Date(now - 4 * 3600_000).toISOString();

  const postApprovalEdited = {
    id: 'o_edit_after_app',
    orderNumber: 'BW-900001',
    dealerName: 'BHOOMI AGRO',
    userId: 'user_rushi',
    createdByUid: 'user_rushi',
    createdByName: 'RUSHIKESH MARUTI JADHAV',
    status: 'complete',
    approvedBy: 'SHIDHAR BALKRUSHNA SHINDE',
    approvedAt: threeHoursAgoIso,
    createdAt: fourHoursAgoIso,
    updatedAt: oneHourAgoIso,
    updatedByUid: 'user_rushi',
    updatedByName: 'RUSHIKESH MARUTI JADHAV',
  };
  const whDispatchedWithStaleUid = {
    id: 'o_wh_disp',
    orderNumber: 'BW-900002',
    dealerName: 'GANESH AGRO',
    userId: 'user_rushi',
    createdByUid: 'user_rushi',
    createdByName: 'RUSHIKESH MARUTI JADHAV',
    status: 'complete',
    warehouseStatus: 'dispatched',
    warehouseDispatchedBy: 'Vishal Shinde',
    warehouseDispatchedAt: oneHourAgoIso,
    approvedBy: 'SHIDHAR BALKRUSHNA SHINDE',
    approvedAt: threeHoursAgoIso,
    createdAt: fourHoursAgoIso,
    updatedAt: oneHourAgoIso,
    updatedByUid: 'user_admin',
  };

  assert.ok(getDefaultInitialBaselineMs(now) < now - 20 * 3600_000);
  const freshAdminRes = computeModuleUpdates({
    profile: admin,
    seenMap: {},
    orders: [postApprovalEdited, whDispatchedWithStaleUid],
  });
  assert.equal(freshAdminRes.badges.order?.count, 2, 'Admin fresh baseline must still surface recent officer edit & warehouse dispatch');
  const editedMeta = freshAdminRes.badges.order?.unreadRecords?.find((r) => r.id === 'o_edit_after_app');
  assert.equal(editedMeta?.actorName, 'Rushikesh Maruti Jadhav');
  assert.equal(editedMeta?.actionLabel, 'Updated Order');
  const whMeta = freshAdminRes.badges.order?.unreadRecords?.find((r) => r.id === 'o_wh_disp');
  assert.equal(whMeta?.actorName, 'Vishal Shinde');
  assert.equal(whMeta?.actionLabel, 'Dispatched');

  logStep('Order deduplication, orphaned-order ownership, post-approval edit/dispatch attribution, and fresh-baseline updates verified');
}

async function verifyDistArtifacts() {
  const requiredDist = ['dist/index.html', 'dist/server.js', 'dist/version.json', 'dist/manifest.webmanifest', 'dist/sw.js', 'dist/pwa-192x192.png'];
  for (const f of requiredDist) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `Missing build artifact: ${f}`);
  }
  const versionMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/version.json'), 'utf-8'));
  assert.ok(versionMeta.buildId && typeof versionMeta.buildId === 'string', 'dist/version.json missing buildId');
  assert.ok(versionMeta.firebaseProjectId, 'dist/version.json missing firebaseProjectId');
  logStep(`Production build artifacts verified (buildId=${versionMeta.buildId})`);
  return versionMeta;
}

async function verifyFirestoreLive() {
  const fbConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase-applet-config.json'), 'utf-8'));
  const app = initializeApp(fbConfig, `regression_${Date.now()}`);
  const db = initializeFirestore(app, {}, fbConfig.firestoreDatabaseId);

  await getDocFromServer(doc(db, 'test', 'connection'));
  const usersSnap = await getDocs(query(collection(db, 'users'), limit(5)));
  const ordersSnap = await getDocs(query(collection(db, 'orders'), limit(5)));
  const dealersSnap = await getDocs(query(collection(db, 'dealers_application'), limit(5)));

  assert.ok(usersSnap.size > 0, 'Firestore users collection returned 0 docs');
  logStep(`Live Firestore verified (users>=${usersSnap.size}, orders>=${ordersSnap.size}, dealers>=${dealersSnap.size})`);
  await terminate(db);
}

async function verifyHttpServer(baseUrl: string, expectedBuildId?: string) {
  const spaRoutes = [
    '/',
    '/index.html',
    '/dashboard',
    '/orders',
    '/warehouse',
    '/travel',
    '/target',
    '/dealers',
    '/collections',
    '/outstanding',
    '/pricelist',
    '/location',
    '/scheme',
    '/reports',
    '/settings',
    '/unknown-spa-route',
  ];

  for (const route of spaRoutes) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `SPA route ${route} returned ${res.status}`);
    const ct = String(res.headers.get('content-type') || '');
    assert.ok(ct.includes('text/html'), `SPA route ${route} non-HTML content-type: ${ct}`);
    const html = await res.text();
    assert.ok(html.includes('id="root"'), `SPA route ${route} missing #root`);
  }
  logStep(`All ${spaRoutes.length} SPA routes returned 200 HTML cleanly on ${baseUrl}`);

  const staticAssets = ['/manifest.webmanifest', '/robots.txt', '/favicon.ico', '/logo.jpg', '/pwa-192x192.png'];
  for (const asset of staticAssets) {
    const res = await fetch(`${baseUrl}${asset}`);
    assert.equal(res.status, 200, `Static asset ${asset} returned ${res.status}`);
  }
  logStep(`Static & PWA endpoints verified on ${baseUrl}`);

  const verRes = await fetch(`${baseUrl}/api/app-version`);
  assert.equal(verRes.status, 200, '/api/app-version failed');
  const verJson = await verRes.json();
  assert.equal(verJson.ok, true);
  assert.ok(verJson.buildId);
  if (expectedBuildId) {
    assert.equal(verJson.buildId, expectedBuildId, 'Server buildId mismatch with dist/version.json');
  }

  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200, '/api/health failed');
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.buildId, verJson.buildId);

  const syncHealthRes = await fetch(`${baseUrl}/api/sync/health`);
  assert.equal(syncHealthRes.status, 200, '/api/sync/health failed');
  const syncHealthJson = await syncHealthRes.json();
  assert.equal(syncHealthJson.ok, true);

  const syncSummaryRes = await fetch(`${baseUrl}/api/sync/summary`);
  assert.equal(syncSummaryRes.status, 200, '/api/sync/summary failed');
  const syncSummaryJson = await syncSummaryRes.json();
  assert.equal(syncSummaryJson.ok, true);
  assert.ok((syncSummaryJson.collections?.users || 0) > 0, 'SQLite secondary users count is 0');

  let backupsRes = await fetch(`${baseUrl}/api/sync/backups`);
  assert.equal(backupsRes.status, 200, '/api/sync/backups failed');
  let backupsJson = await backupsRes.json();
  assert.equal(backupsJson.ok, true);
  if (!Array.isArray(backupsJson.backups) || backupsJson.backups.length === 0) {
    const createBackupRes = await fetch(`${baseUrl}/api/sync/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'auto_probe' }),
    });
    assert.equal(createBackupRes.status, 200, 'POST /api/sync/backup failed');
    backupsRes = await fetch(`${baseUrl}/api/sync/backups`);
    assert.equal(backupsRes.status, 200, '/api/sync/backups re-check failed');
    backupsJson = await backupsRes.json();
  }
  assert.ok(backupsJson.backups.length > 0, 'No disk backups found');

  // Verify APK Cross-Origin headers work for Capacitor / WebViewAssetLoader / file:// ('null')
  for (const apkOrigin of ['https://localhost', 'https://appassets.androidplatform.net', 'capacitor://localhost', 'null']) {
    const corsRes = await fetch(`${baseUrl}/api/sync/health`, {
      headers: { Origin: apkOrigin },
    });
    assert.equal(corsRes.status, 200);
    assert.equal(corsRes.headers.get('access-control-allow-origin'), apkOrigin, `Missing CORS header for APK origin ${apkOrigin}`);

    const verCorsRes = await fetch(`${baseUrl}/api/app-version`, {
      headers: { Origin: apkOrigin },
    });
    assert.equal(verCorsRes.status, 200);
    assert.ok(verCorsRes.headers.get('access-control-allow-origin'), `Missing version CORS header for ${apkOrigin}`);
  }
  logStep(`APK CORS origins & API health/sync endpoints verified on ${baseUrl}`);

  // Auth validation checks (no mutations, check bad input & non-existent user)
  const badAuthRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: '', password: '' }),
  });
  assert.equal(badAuthRes.status, 400);

  const wrongAuthRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: '__nonexistent_user_probe__', password: 'wrong' }),
  });
  assert.equal(wrongAuthRes.status, 401);

  // Clean 404 boundaries
  const missingApiRes = await fetch(`${baseUrl}/api/unknown-endpoint-check`);
  assert.equal(missingApiRes.status, 404);
  assert.ok(String(missingApiRes.headers.get('content-type') || '').includes('application/json'));

  const missingDataRes = await fetch(`${baseUrl}/data/nonexistent.json`);
  assert.equal(missingDataRes.status, 404);
  assert.ok(String(missingDataRes.headers.get('content-type') || '').includes('application/json'));

  const postUnknownRes = await fetch(`${baseUrl}/nonexistent-post-path`, { method: 'POST' });
  assert.equal(postUnknownRes.status, 404);
  logStep(`Auth validation & crisp 404 boundaries verified on ${baseUrl}`);
}

async function withTempProdServer(fn: (url: string) => Promise<void>) {
  const port = 3099;
  const proc: ChildProcess = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, 'Temporary production server failed to become ready on port 3099');
    await fn(baseUrl);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
}

function verifySyncContinuityAndStability() {
  // 1. Zero programmatic deleteDoc() & zero { merge: false } across src/
  const walkFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(full, acc);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  const srcFiles = walkFiles(path.join(ROOT, 'src'));
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(
      !/\bmerge\s*:\s*false\b/.test(content),
      `Unsafe { merge: false } found in ${path.relative(ROOT, file)}`
    );
    const nonCommentLines = content
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.ok(
      !/\bdeleteDoc\s*\(/.test(nonCommentLines),
      `Unsafe deleteDoc() call found in ${path.relative(ROOT, file)}`
    );
  }

  // 2. React loop-prevention & hook stability invariants
  const appText = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf-8');
  assert.ok(appText.includes('JSON.stringify(prev) === JSON.stringify(merged)'), 'App.tsx must short-circuit identical profile objects');

  const dashText = fs.readFileSync(path.join(ROOT, 'src/components/Dashboard.tsx'), 'utf-8');
  assert.ok(dashText.includes('lastBadgesSigRef'), 'Dashboard.tsx must guard module badge updates with lastBadgesSigRef');
  assert.ok(dashText.includes('lastBirthdaysSigRef'), 'Dashboard.tsx must guard birthday updates with lastBirthdaysSigRef');

  const popupText = fs.readFileSync(path.join(ROOT, 'src/components/ModuleUpdatePopup.tsx'), 'utf-8');
  assert.ok(popupText.includes('seenMapRef'), 'ModuleUpdatePopup.tsx must avoid side-effects inside setSeenMap updaters');
  assert.ok(popupText.includes('lastEmittedBadgesSigRef'), 'ModuleUpdatePopup.tsx must guard badge emission with lastEmittedBadgesSigRef');
  assert.ok(popupText.includes('cloudHydrated'), 'ModuleUpdatePopup.tsx must gate baseline initialization on cloudHydrated');
  assert.ok(popupText.includes("'target', 'price', 'scheme', 'setting'"), 'ModuleUpdatePopup.tsx must auto-mark singleton modules including target');

  const bannerText = fs.readFileSync(path.join(ROOT, 'src/components/ModuleUpdateBanner.tsx'), 'utf-8');
  assert.ok(!bannerText.includes('[profile, seenMap, moduleId, partialInput]'), 'ModuleUpdateBanner must destructure partialInput deps');
  assert.ok(!bannerText.includes('सर्व पाहिले'), 'ModuleUpdateBanner must NOT render सर्व पाहिले button');
  assert.ok(!bannerText.includes('नवीन अपडेट्स'), 'ModuleUpdateBanner must NOT render नवीन अपडेट्स banner');

  // 3. Immediate cross-device build propagation & dynamic UI invariants
  const serverText = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf-8');
  assert.ok(!serverText.includes('const SERVER_BUILD_INFO ='), 'server.ts must resolve build metadata dynamically per request');
  assert.ok(serverText.includes("broadcastEvent('build_update'"), 'server.ts must push live build_update SSE events');
  assert.ok(serverText.includes('CDN-Cache-Control'), 'server.ts must send CDN-Cache-Control: no-store');

  const viteText = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8');
  assert.ok(
    viteText.includes('ignoreURLParametersMatching: [/^utm_/, /^fbclid$/]'),
    'Workbox must NOT strip ?v= or ?apk_ota= cache-busting parameters'
  );

  const mainText = fs.readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf-8');
  assert.ok(mainText.includes('startAutoVersionControl();'), 'main.tsx must run startAutoVersionControl() unconditionally');

  const appVerText = fs.readFileSync(path.join(ROOT, 'src/lib/appVersion.ts'), 'utf-8');
  assert.ok(!appVerText.includes('isDevPair'), 'appVersion.ts must not suppress new build reloads via isDevPair');
  assert.ok(appVerText.includes('purgeStaleServiceWorkerAndCachesSafely'), 'appVersion.ts must purge stale SW/Workbox caches on online updates');

  const dashUiText = fs.readFileSync(path.join(ROOT, 'src/components/Dashboard.tsx'), 'utf-8');
  assert.ok(dashUiText.includes('useUiConfig'), 'Dashboard.tsx must consume real-time useUiConfig()');

  const settingUiText = fs.readFileSync(path.join(ROOT, 'src/components/modules/SettingView.tsx'), 'utf-8');
  assert.ok(settingUiText.includes('useUiConfig'), 'SettingView.tsx must expose Admin UI & Options live editor');

  // 4. Google Sheets Failover collection coverage & sanitization
  for (const col of ['orders', 'dealers_application', 'collection_entries', 'travel_sheets', 'users']) {
    assert.ok(SHEETS_FAILOVER_COLLECTIONS.has(col), `SHEETS_FAILOVER_COLLECTIONS missing ${col}`);
  }
  const bigDataUri = 'data:image/png;base64,' + 'A'.repeat(15000);
  const sanitized = sanitizeDocForSheets({
    id: 'ord_1',
    orderNumber: 'ORD-101',
    dealerName: 'Kisan Agro',
    logoUrl: bigDataUri,
    nested: { avatar: bigDataUri, city: 'Pune' },
  });
  assert.equal(sanitized.orderNumber, 'ORD-101');
  assert.equal(sanitized.dealerName, 'Kisan Agro');
  assert.equal(sanitized.logoUrl, '[binary_omitted]');
  assert.equal(sanitized.nested.avatar, '[binary_omitted]');
  assert.equal(sanitized.nested.city, 'Pune');
  assert.ok(GOOGLE_APPS_SCRIPT_TEMPLATE.includes('function doGet'));
  assert.ok(GOOGLE_APPS_SCRIPT_TEMPLATE.includes('function doPost'));
  assert.ok(GOOGLE_APPS_SCRIPT_TEMPLATE.includes('LockService.getScriptLock()'));

  logStep('Zero-data-loss, loop-prevention, live update sync, and Google Sheets failover verified');
}

async function main() {
  console.log('=== Blackworm Agritech MIS — Full System Regression Suite ===');
  await verifyCoreLocksAndSchemas();
  verifySyncContinuityAndStability();
  verifyBirthdayNotifications();
  verifyModuleUpdateBadges();
  verifyOrderVisibilityAndDeduplication();
  const distMeta = await verifyDistArtifacts();
  await verifyFirestoreLive();

  await withTempProdServer(async (prodUrl) => {
    await verifyHttpServer(prodUrl, distMeta.buildId);
    const swRes = await fetch(`${prodUrl}/sw.js`);
    assert.equal(swRes.status, 200, 'Production /sw.js failed');
    const verJsonRes = await fetch(`${prodUrl}/version.json`);
    assert.equal(verJsonRes.status, 200, 'Production /version.json failed');
    const verJson = await verJsonRes.json();
    assert.equal(verJson.buildId, distMeta.buildId);
    logStep('Production /sw.js and /version.json parity verified');
  });

  // Also test running dev server on port 3000 if active
  try {
    const devCheck = await fetch('http://127.0.0.1:3000/api/health');
    if (devCheck.ok) {
      await verifyHttpServer('http://127.0.0.1:3000');
    }
  } catch {
    console.log('ℹ️ [INFO] Dev server port 3000 not currently active during script run');
  }

  await verify25DevicesRealTimeSync(distMeta);

  console.log('🎉 ALL REGRESSION & CORE LOCK CHECKS PASSED!');
  process.exit(0);
}

interface SsePacket {
  event: string;
  data: any;
}

async function verify25DevicesRealTimeSync(distMeta: { version: string; buildId: string; firebaseProjectId: string; firestoreDatabaseId: string }) {
  const DEVICE_COUNT = 25;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-25dev-'));
  const tempDataDir = path.join(tempRoot, 'data');
  const tempVersionFile = path.join(tempRoot, 'version.json');
  fs.mkdirSync(tempDataDir, { recursive: true });

  const prodSqlite = path.join(ROOT, 'data', 'secondary_sync.sqlite');
  if (fs.existsSync(prodSqlite)) {
    fs.copyFileSync(prodSqlite, path.join(tempDataDir, 'secondary_sync.sqlite'));
  }
  const initialBuildId = `${distMeta.buildId}_init`;
  fs.writeFileSync(
    tempVersionFile,
    JSON.stringify({ ...distMeta, buildId: initialBuildId, builtAt: new Date().toISOString() }, null, 2),
    'utf-8'
  );

  const port = 3098;
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      BLACKWORM_DATA_DIR: tempDataDir,
      BLACKWORM_VERSION_FILE: tempVersionFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const controllers: AbortController[] = [];
  const clientEvents: SsePacket[][] = Array.from({ length: DEVICE_COUNT }, () => []);

  const waitForAllDevices = async (
    label: string,
    predicate: (events: SsePacket[]) => boolean,
    timeoutMs = 5000
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const matched = clientEvents.filter((evts) => predicate(evts)).length;
      if (matched === DEVICE_COUNT) {
        return;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const matched = clientEvents.filter((evts) => predicate(evts)).length;
    assert.equal(matched, DEVICE_COUNT, `${label}: only ${matched}/${DEVICE_COUNT} devices received update`);
  };

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, 'Isolated 25-device verification server failed to start');

    // Verify strict no-store headers on live HTML, version, & SW endpoints
    for (const ep of ['/', '/version.json', '/api/app-version', '/sw.js']) {
      const r = await fetch(`${baseUrl}${ep}`);
      assert.equal(r.status, 200);
      const cc = String(r.headers.get('cache-control') || '').toLowerCase();
      assert.ok(cc.includes('no-store'), `${ep} missing Cache-Control: no-store (got ${cc})`);
    }

    // Connect 25 simultaneous SSE clients representing 25 devices (web, PWA, Android APK)
    await Promise.all(
      Array.from({ length: DEVICE_COUNT }, async (_, idx) => {
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const res = await fetch(`${baseUrl}/api/sync/stream?sinceRevision=0`, {
          signal: ctrl.signal,
          headers: { Accept: 'text/event-stream' },
        });
        assert.equal(res.status, 200, `Device #${idx + 1} SSE failed`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Pump stream asynchronously until aborted
        void (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const frames = buffer.split('\n\n');
              buffer = frames.pop() || '';
              for (const frame of frames) {
                const lines = frame.split('\n');
                let eventName = 'message';
                let dataStr = '';
                for (const ln of lines) {
                  if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
                  else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
                }
                if (dataStr) {
                  try {
                    clientEvents[idx].push({ event: eventName, data: JSON.parse(dataStr) });
                  } catch {}
                }
              }
            }
          } catch {}
        })();
      })
    );

    await waitForAllDevices('Initial 25-device SSE connect', (evts) =>
      evts.some((e) => e.event === 'connected' && e.data?.buildId === initialBuildId)
    );
    logStep(`All ${DEVICE_COUNT} concurrent devices connected via SSE stream`);

    // 1. Admin adds a custom UI option, renames built-in 'order', changes gridColumns=4 & layoutDensity='compact'
    const tAdd = Date.now();
    const upsertAddRes = await fetch(`${baseUrl}/api/sync/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'config',
        id: 'ui_layout',
        updatedAtMs: tAdd,
        doc: {
          id: 'ui_layout',
          appTitle: 'BLACKWORM AGRITECH LIVE',
          gridColumns: 4,
          layoutDensity: 'compact',
          moduleOverrides: { order: { label: 'Live Orders' } },
          customOptions: [{ id: 'custom_circular_1', label: 'Daily Circular', enabled: true, order: 100 }],
          updatedAt: new Date(tAdd).toISOString(),
        },
      }),
    });
    assert.equal(upsertAddRes.status, 200);

    await waitForAllDevices('UI Option ADD + Layout Change -> 25/25 devices', (evts) =>
      evts.some(
        (e) =>
          e.event === 'delta' &&
          e.data?.collection === 'config' &&
          e.data?.id === 'ui_layout' &&
          e.data?.doc?.gridColumns === 4 &&
          e.data?.doc?.layoutDensity === 'compact' &&
          e.data?.doc?.moduleOverrides?.order?.label === 'Live Orders' &&
          Array.isArray(e.data?.doc?.customOptions) &&
          e.data.doc.customOptions.length === 1 &&
          e.data.doc.customOptions[0].label === 'Daily Circular'
      )
    );
    logStep(`UI option ADD + layout resize propagated immediately to ${DEVICE_COUNT}/${DEVICE_COUNT} devices`);

    // 2. Admin deletes custom option and modifies title & gridColumns=3
    const tDel = tAdd + 500;
    const upsertDelRes = await fetch(`${baseUrl}/api/sync/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'config',
        id: 'ui_layout',
        updatedAtMs: tDel,
        doc: {
          id: 'ui_layout',
          appTitle: 'BLACKWORM AGRITECH PVT LTD',
          gridColumns: 3,
          layoutDensity: 'standard',
          moduleOverrides: { order: { label: 'Orders' } },
          customOptions: [],
          updatedAt: new Date(tDel).toISOString(),
        },
      }),
    });
    assert.equal(upsertDelRes.status, 200);

    await waitForAllDevices('UI Option DELETE + Modify -> 25/25 devices', (evts) =>
      evts.some(
        (e) =>
          e.event === 'delta' &&
          e.data?.collection === 'config' &&
          e.data?.id === 'ui_layout' &&
          e.data?.updatedAtMs === tDel &&
          e.data?.doc?.gridColumns === 3 &&
          Array.isArray(e.data?.doc?.customOptions) &&
          e.data.doc.customOptions.length === 0
      )
    );
    logStep(`UI option DELETE + layout modify propagated immediately to ${DEVICE_COUNT}/${DEVICE_COUNT} devices`);

    // 3. Admin updates an officer's permissions (allowedModules) & company branding
    const tPerm = tDel + 500;
    await fetch(`${baseUrl}/api/sync/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'users',
        id: 'sim_officer_25',
        updatedAtMs: tPerm,
        doc: {
          id: 'sim_officer_25',
          uid: 'sim_officer_25',
          fullName: 'Simulated Officer',
          role: 'sales_officer',
          allowedModules: ['order', 'dealer', 'travel', 'scheme'],
          updatedAt: new Date(tPerm).toISOString(),
        },
      }),
    });
    await waitForAllDevices('User allowedModules change -> 25/25 devices', (evts) =>
      evts.some(
        (e) =>
          e.event === 'delta' &&
          e.data?.collection === 'users' &&
          e.data?.id === 'sim_officer_25' &&
          Array.isArray(e.data?.doc?.allowedModules) &&
          e.data.doc.allowedModules.includes('scheme')
      )
    );
    logStep(`User permission update propagated immediately to ${DEVICE_COUNT}/${DEVICE_COUNT} devices`);

    // 4. Cross-device per-user seen-state monotonic merge across concurrent devices -> 25/25 devices
    const tSeen1 = tPerm + 400;
    const tSeen2 = tSeen1 + 200;
    await fetch(`${baseUrl}/api/sync/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'config',
        id: 'user_seen_u_admin_25',
        updatedAtMs: tSeen1,
        doc: {
          id: 'user_seen_u_admin_25',
          uid: 'u_admin_25',
          seenMap: { order: { seenAtMs: 1000, viewedRecords: { ord_a: tSeen1 } } },
          bdaySeen: { '2026-11-25': ['user:u_1'] },
          isArchived: false,
        },
      }),
    });
    await fetch(`${baseUrl}/api/sync/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'config',
        id: 'user_seen_u_admin_25',
        updatedAtMs: tSeen2,
        doc: {
          id: 'user_seen_u_admin_25',
          uid: 'u_admin_25',
          seenMap: { order: { seenAtMs: 1000, viewedRecords: { ord_b: tSeen2 } } },
          bdaySeen: { '2026-11-25': ['dealer:d_1'] },
          isArchived: false,
        },
      }),
    });
    await waitForAllDevices('Cross-device user_seen monotonic merge -> 25/25 devices', (evts) =>
      evts.some(
        (e) =>
          e.event === 'delta' &&
          e.data?.collection === 'config' &&
          e.data?.id === 'user_seen_u_admin_25' &&
          e.data?.doc?.seenMap?.order?.viewedRecords?.ord_a === tSeen1 &&
          e.data?.doc?.seenMap?.order?.viewedRecords?.ord_b === tSeen2 &&
          Array.isArray(e.data?.doc?.bdaySeen?.['2026-11-25']) &&
          e.data.doc.bdaySeen['2026-11-25'].includes('user:u_1') &&
          e.data.doc.bdaySeen['2026-11-25'].includes('dealer:d_1')
      )
    );
    logStep(`Cross-device per-user seen/birthday monotonic merge verified across ${DEVICE_COUNT}/${DEVICE_COUNT} live devices`);

    // 5. Simulate new Website build deployment -> verify server pushes event: build_update to ALL 25 devices without APK update or manual refresh
    const nextBuildId = `${distMeta.buildId}_ota_next`;
    fs.writeFileSync(
      tempVersionFile,
      JSON.stringify({ ...distMeta, buildId: nextBuildId, builtAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
    await waitForAllDevices(
      'Automatic build_update SSE broadcast -> 25/25 devices',
      (evts) => evts.some((e) => e.event === 'build_update' && e.data?.buildId === nextBuildId),
      6000
    );
    logStep(`Automatic build_update OTA push verified across ${DEVICE_COUNT}/${DEVICE_COUNT} live devices`);
  } finally {
    controllers.forEach((c) => {
      try {
        c.abort();
      } catch {}
    });
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('❌ [REGRESSION FAILURE]:', err);
  process.exit(1);
});
