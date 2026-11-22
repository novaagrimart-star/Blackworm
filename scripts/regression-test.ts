import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { initializeApp } from 'firebase/app';
import { collection, doc, getDocFromServer, getDocs, limit, query, initializeFirestore, terminate } from 'firebase/firestore';
import { collectVisibleTodaysBirthdays, parseMonthDay } from '../src/lib/birthdayNotifier';
import { computeModuleUpdates, computePricelistFingerprint } from '../src/lib/moduleUpdates';

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
  logStep('Frontend routing, APK WebView, Location/Warehouse invariants, and offline SW verified');
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

  // 4. Godown Incharge sees Warehouse badge when Admin approves an order
  const whRes = computeModuleUpdates({
    profile: warehouseProfile,
    seenMap: { office_staff: { seenAtMs: t0 } },
    orders: [approvedOrder],
  });
  assert.equal(whRes.badges.office_staff?.count, 1, 'Warehouse must see badge 1 for newly approved order');

  // 5. After user opens the module (seenAtMs advances past t1), badges clear cleanly
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
  assert.equal(clearedRes.totalCount, 0, 'Opening modules must clear update badges');

  logStep('Dashboard module update badges, permissions, and clear-on-open verified');
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

  const backupsRes = await fetch(`${baseUrl}/api/sync/backups`);
  assert.equal(backupsRes.status, 200, '/api/sync/backups failed');
  const backupsJson = await backupsRes.json();
  assert.equal(backupsJson.ok, true);
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

async function main() {
  console.log('=== Blackworm Agritech MIS — Full System Regression Suite ===');
  await verifyCoreLocksAndSchemas();
  verifyBirthdayNotifications();
  verifyModuleUpdateBadges();
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

  console.log('🎉 ALL REGRESSION & CORE LOCK CHECKS PASSED!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [REGRESSION FAILURE]:', err);
  process.exit(1);
});
