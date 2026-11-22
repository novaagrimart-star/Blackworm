import firebaseConfig from '../../firebase-applet-config.json';
import { safeClearTransientCaches } from './localVault';

export const APP_VERSION: string =
  (import.meta as any)?.env?.VITE_APP_VERSION || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.1');
export const APP_BUILD_ID: string =
  (import.meta as any)?.env?.VITE_APP_BUILD_ID || (typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev');
export const APP_BUILD_TIME: string =
  (import.meta as any)?.env?.VITE_APP_BUILD_TIME || (typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : '');

export const SINGLE_SOURCE_OF_TRUTH = {
  firebaseProjectId: firebaseConfig.projectId,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
} as const;

export interface RemoteVersionInfo {
  ok?: boolean;
  version: string;
  buildId: string;
  builtAt?: string;
  serverEpoch?: string;
  firebaseProjectId?: string;
  firestoreDatabaseId?: string;
}

const ORIGIN_STORAGE_KEY = 'blackworm_remote_api_origin';
const ATTEMPTED_BUILD_KEY = 'blackworm_last_attempted_build_id';
const ATTEMPTED_TIME_KEY = 'blackworm_last_attempted_build_at';
const DEFAULT_HOSTED_ORIGIN = 'https://ais-pre-iw3yky5ptkk4x6kyc3qgt2-71953473277.asia-east1.run.app';

let autoVersionStarted = false;
let isCheckingVersion = false;
let lastVersionCheckAt = 0;
let versionPollTimer: ReturnType<typeof setInterval> | null = null;
let latestRemoteInfo: RemoteVersionInfo | null = null;

export function isPackagedApkShell(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const proto = String(window.location.protocol || '').toLowerCase();
    const host = String(window.location.hostname || '').toLowerCase();
    if (
      proto === 'file:' ||
      proto === 'capacitor:' ||
      proto === 'ionic:' ||
      proto === 'app:' ||
      proto === 'asset:' ||
      proto === 'content:'
    ) {
      return true;
    }
    if (host === 'appassets.androidplatform.net' || host.endsWith('.androidplatform.net')) {
      return true;
    }
    if ((host === 'localhost' || host === '127.0.0.1') && window.location.port !== '3000') {
      return true;
    }
    const w = window as any;
    if (w?.Capacitor?.isNativePlatform?.() || w?.cordova || w?.AndroidBridge || w?.ReactNativeWebView) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isLocalOrDevOrigin(orig: string): boolean {
  return orig.includes('ais-dev-') || orig.includes('://localhost') || orig.includes('://127.0.0.1');
}

function clearPoisonedOriginCache(badOrigin: string): void {
  try {
    const saved = String(localStorage.getItem(ORIGIN_STORAGE_KEY) || '').trim().replace(/\/+$/, '');
    if (saved && saved === badOrigin.replace(/\/+$/, '')) {
      localStorage.removeItem(ORIGIN_STORAGE_KEY);
    }
  } catch {}
}

export function getHostedWebAppOrigin(): string {
  if (typeof window === 'undefined') return DEFAULT_HOSTED_ORIGIN;
  try {
    const envOrigin = String((import.meta as any)?.env?.VITE_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (envOrigin && envOrigin.startsWith('http')) return envOrigin;
    const saved = String(localStorage.getItem(ORIGIN_STORAGE_KEY) || '').trim().replace(/\/+$/, '');
    const inPackagedShell = isPackagedApkShell();
    if (saved && saved.startsWith('http') && (!inPackagedShell || !isLocalOrDevOrigin(saved))) {
      return saved;
    }
    if (!inPackagedShell) {
      const origin = String(window.location.origin || '').trim().replace(/\/+$/, '');
      if (origin && origin.startsWith('http')) return origin;
    }
  } catch {}
  return DEFAULT_HOSTED_ORIGIN;
}

/**
 * Resolves the API base origin cleanly for Web, TWA, Android WebView, and packaged Capacitor APKs.
 * Same-origin HTTPS web/TWA uses '' (relative path); local file:///capacitor:// & https://localhost/appassets APK shells route to the hosted backend.
 */
export function getSyncApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    if (isPackagedApkShell()) {
      return getHostedWebAppOrigin();
    }
    const proto = String(window.location.protocol || '').toLowerCase();
    const host = String(window.location.hostname || '').toLowerCase();

    // Normal Web / PWA / TWA / Vite dev server running on HTTPS or localhost:3000 -> relative paths
    if (proto === 'https:' || (proto === 'http:' && host !== 'localhost' && host !== '127.0.0.1')) {
      return '';
    }
    if (proto === 'http:' && (host === 'localhost' || host === '127.0.0.1') && window.location.port === '3000') {
      return '';
    }

    return getHostedWebAppOrigin();
  } catch {
    return '';
  }
}

export function resolveApiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getSyncApiBaseUrl();
  return base ? `${base}${cleanPath}` : cleanPath;
}

export function getLatestRemoteVersionInfo(): RemoteVersionInfo | null {
  return latestRemoteInfo;
}

async function fetchRemoteVersionPayload(): Promise<{
  info: RemoteVersionInfo | null;
  saw404: boolean;
  source: 'api-version' | 'version-json' | 'health' | 'none';
}> {
  const bust = Date.now();
  const base = getSyncApiBaseUrl();
  const candidates: Array<{ url: string; source: 'api-version' | 'version-json' | 'health' }> = [
    { url: resolveApiUrl(`/api/app-version?t=${bust}`), source: 'api-version' },
    { url: resolveApiUrl(`/version.json?t=${bust}`), source: 'version-json' },
    { url: resolveApiUrl(`/api/health?t=${bust}`), source: 'health' },
  ];

  let saw404 = false;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);
    try {
      const res = await fetch(candidate.url, {
        cache: 'no-store',
        credentials: base ? 'omit' : 'same-origin',
        signal: controller.signal,
      });
      if (res.status === 404) {
        saw404 = true;
        continue;
      }
      if (!res.ok) continue;
      if (res.url && res.url.includes('__cookie_check')) continue;
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('json') && !ct.includes('text/plain')) continue;

      const rawText = await res.text().catch(() => '');
      if (!rawText || rawText.trim().startsWith('<')) continue;
      const json = JSON.parse(rawText) as RemoteVersionInfo;
      if (json && typeof json.buildId === 'string' && json.buildId.trim()) {
        // Persist confirmed healthy non-local public origin for future packaged launches
        if (!base && typeof window !== 'undefined') {
          try {
            const orig = String(window.location.origin || '').trim().replace(/\/+$/, '');
            if (orig && orig.startsWith('https://') && !isLocalOrDevOrigin(orig) && !orig.includes('null')) {
              localStorage.setItem(ORIGIN_STORAGE_KEY, orig);
            }
          } catch {}
        }
        return { info: json, saw404: false, source: candidate.source };
      }
    } catch {
      // Try next endpoint candidate
    } finally {
      clearTimeout(timer);
    }
  }

  if (saw404 && base) {
    clearPoisonedOriginCache(base);
  }
  return { info: null, saw404, source: 'none' };
}

function canAttemptReloadForBuild(targetBuildId: string, manual = false): boolean {
  if (manual) {
    try {
      sessionStorage.setItem(ATTEMPTED_BUILD_KEY, targetBuildId);
      sessionStorage.setItem(ATTEMPTED_TIME_KEY, String(Date.now()));
    } catch {}
    return true;
  }
  try {
    const prevBuild = sessionStorage.getItem(ATTEMPTED_BUILD_KEY) || '';
    const prevAt = Number(sessionStorage.getItem(ATTEMPTED_TIME_KEY) || '0');
    if (prevBuild === targetBuildId && Date.now() - prevAt < 5 * 60 * 1000) {
      return false;
    }
    sessionStorage.setItem(ATTEMPTED_BUILD_KEY, targetBuildId);
    sessionStorage.setItem(ATTEMPTED_TIME_KEY, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

async function isOriginHtmlReachable(origin: string): Promise<boolean> {
  const probes = [`${origin}/?probe=${Date.now()}`, `${origin}/index.html?probe=${Date.now()}`];
  for (const probeUrl of probes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(probeUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!res.ok) continue;
      if (res.url && res.url.includes('__cookie_check')) continue;
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('text/html')) continue;
      const bodySnippet = (await res.text().catch(() => '')).slice(0, 4096);
      if (
        bodySnippet.includes('id="root"') ||
        bodySnippet.includes("id='root'") ||
        bodySnippet.includes('Blackworm Agritech')
      ) {
        return true;
      }
    } catch {
      // Try next probe
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

export async function applyRemoteAppUpdate(remoteBuildId?: string, version?: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  const tag = String(remoteBuildId || Date.now()).trim();

  try {
    window.dispatchEvent(
      new CustomEvent('blackworm_remote_updating', {
        detail: { from: APP_BUILD_ID, to: tag, version: version || APP_VERSION },
      })
    );
  } catch {}

  // Update active Service Worker smoothly while preserving offline precache safety
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 1800))]);
      }
    }
  } catch {}

  await Promise.race([
    safeClearTransientCaches({ includeServiceWorker: false }),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  await new Promise((r) => setTimeout(r, 250));

  try {
    if (isPackagedApkShell()) {
      const hostedOrigin = getHostedWebAppOrigin();
      const reachable = await isOriginHtmlReachable(hostedOrigin);
      if (reachable) {
        const target = new URL(`${hostedOrigin}/`);
        target.searchParams.set('v', tag);
        target.searchParams.set('apk_ota', '1');
        window.location.replace(target.toString());
        return true;
      }
      return false;
    }

    const origin = window.location.origin;
    if (origin && origin.startsWith('http')) {
      const reachable = await isOriginHtmlReachable(origin);
      if (reachable) {
        const nextUrl = new URL(`${origin}/`);
        nextUrl.searchParams.set('v', tag);
        if (window.location.hash) {
          nextUrl.hash = window.location.hash;
        }
        window.location.replace(nextUrl.toString());
        return true;
      }
      // Same-origin API confirmed a new build, reload current document cleanly without redirecting
      window.location.reload();
      return true;
    }

    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export async function checkRemoteAppVersion(options: {
  manual?: boolean;
  bypassThrottle?: boolean;
  forceReloadOnUpdate?: boolean;
} = {}): Promise<{
  checked: boolean;
  hasUpdate: boolean;
  reloaded: boolean;
  localBuildId: string;
  remoteBuildId?: string;
  remote?: RemoteVersionInfo | null;
  error?: string;
  source?: string;
}> {
  if (typeof window === 'undefined') {
    return { checked: false, hasUpdate: false, reloaded: false, localBuildId: APP_BUILD_ID };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { checked: false, hasUpdate: false, reloaded: false, localBuildId: APP_BUILD_ID, error: 'offline' };
  }

  const now = Date.now();
  if (!options.manual && !options.bypassThrottle && (isCheckingVersion || now - lastVersionCheckAt < 10000)) {
    return {
      checked: false,
      hasUpdate: Boolean(latestRemoteInfo && latestRemoteInfo.buildId !== APP_BUILD_ID),
      reloaded: false,
      localBuildId: APP_BUILD_ID,
      remoteBuildId: latestRemoteInfo?.buildId,
      remote: latestRemoteInfo,
    };
  }

  isCheckingVersion = true;
  lastVersionCheckAt = now;

  try {
    const result = await fetchRemoteVersionPayload();
    const remote = result.info;
    if (!remote) {
      return {
        checked: false,
        hasUpdate: false,
        reloaded: false,
        localBuildId: APP_BUILD_ID,
        error: result.saw404 ? 'hosted_origin_404' : 'unreachable',
        source: result.source,
      };
    }
    latestRemoteInfo = remote;

    const remoteBuildId = String(remote.buildId || '').trim();
    const hasUpdate = Boolean(remoteBuildId && remoteBuildId !== APP_BUILD_ID);

    if (hasUpdate && options.forceReloadOnUpdate !== false) {
      if (canAttemptReloadForBuild(remoteBuildId, Boolean(options.manual))) {
        const reloaded = await applyRemoteAppUpdate(remoteBuildId, remote.version);
        return {
          checked: true,
          hasUpdate: true,
          reloaded,
          localBuildId: APP_BUILD_ID,
          remoteBuildId,
          remote,
          source: result.source,
        };
      }
    }

    return {
      checked: true,
      hasUpdate,
      reloaded: false,
      localBuildId: APP_BUILD_ID,
      remoteBuildId,
      remote,
      source: result.source,
    };
  } finally {
    isCheckingVersion = false;
  }
}

export function triggerVersionCheckFromSse(remoteBuildId?: string): void {
  const cleanRemote = String(remoteBuildId || '').trim();
  if (!cleanRemote || cleanRemote === APP_BUILD_ID) return;
  void checkRemoteAppVersion({ bypassThrottle: true, forceReloadOnUpdate: true });
}

export function startAutoVersionControl(): void {
  if (typeof window === 'undefined' || autoVersionStarted) return;
  autoVersionStarted = true;

  // Initial non-blocking check right after boot
  setTimeout(() => {
    void checkRemoteAppVersion({ bypassThrottle: true, forceReloadOnUpdate: true });
  }, 900);

  const onWake = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void checkRemoteAppVersion({ forceReloadOnUpdate: true });
  };

  window.addEventListener('focus', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('pageshow', onWake);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onWake();
    });
  }

  // Zero-Firebase-credit lightweight check every 20s when active
  versionPollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void checkRemoteAppVersion({ forceReloadOnUpdate: true });
  }, 20 * 1000);
}
