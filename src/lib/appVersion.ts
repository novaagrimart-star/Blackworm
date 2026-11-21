import firebaseConfig from '../../firebase-applet-config.json';
import { safeClearTransientCaches } from './localVault';

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.1';
export const APP_BUILD_ID: string =
  typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev';
export const APP_BUILD_TIME: string =
  typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : '';

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
    if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:' || proto === 'app:') {
      return true;
    }
    if (proto === 'http:' && (host === 'localhost' || host === '127.0.0.1') && window.location.port !== '3000') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getHostedWebAppOrigin(): string {
  if (typeof window === 'undefined') return DEFAULT_HOSTED_ORIGIN;
  try {
    const envOrigin = String((import.meta as any)?.env?.VITE_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (envOrigin && envOrigin.startsWith('http')) return envOrigin;
    const saved = String(localStorage.getItem(ORIGIN_STORAGE_KEY) || '').trim().replace(/\/+$/, '');
    if (saved && saved.startsWith('http')) return saved;
    if (!isPackagedApkShell()) {
      const origin = String(window.location.origin || '').trim().replace(/\/+$/, '');
      if (origin && origin.startsWith('http')) return origin;
    }
  } catch {}
  return DEFAULT_HOSTED_ORIGIN;
}

/**
 * Resolves the API base origin cleanly for Web, TWA, Android WebView, and packaged Capacitor APKs.
 * Same-origin HTTPS web/TWA uses '' (relative path); local file:///capacitor:// shells route to the hosted backend.
 */
export function getSyncApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const proto = String(window.location.protocol || '').toLowerCase();
    const host = String(window.location.hostname || '').toLowerCase();

    // Normal Web / PWA / TWA / Vite dev server running on HTTPS or localhost:3000 -> relative paths
    if (proto === 'https:' || (proto === 'http:' && host !== 'localhost' && host !== '127.0.0.1')) {
      try {
        if (window.location.origin && !window.location.origin.includes('null')) {
          localStorage.setItem(ORIGIN_STORAGE_KEY, window.location.origin);
        }
      } catch {}
      return '';
    }
    if (proto === 'http:' && (host === 'localhost' || host === '127.0.0.1') && window.location.port === '3000') {
      return '';
    }

    // Packaged APK WebView / Capacitor (capacitor://localhost, file://, or http://localhost without port 3000)
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

async function fetchRemoteVersionPayload(): Promise<RemoteVersionInfo | null> {
  const bust = Date.now();
  const candidates = [
    resolveApiUrl(`/api/app-version?t=${bust}`),
    resolveApiUrl(`/version.json?t=${bust}`),
  ];

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as RemoteVersionInfo;
      if (json && typeof json.buildId === 'string' && json.buildId.trim()) {
        return json;
      }
    } catch {}
  }
  return null;
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`${origin}/index.html?probe=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function applyRemoteAppUpdate(remoteBuildId?: string, version?: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const tag = String(remoteBuildId || Date.now()).trim();

  try {
    window.dispatchEvent(
      new CustomEvent('blackworm_remote_updating', {
        detail: { from: APP_BUILD_ID, to: tag, version: version || APP_VERSION },
      })
    );
  } catch {}

  await Promise.race([
    safeClearTransientCaches(),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  await new Promise((r) => setTimeout(r, 350));

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
      window.location.reload();
      return true;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('v', tag);
    window.location.replace(nextUrl.toString());
    return true;
  } catch {
    try {
      window.location.reload();
      return true;
    } catch {
      return false;
    }
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
    const remote = await fetchRemoteVersionPayload();
    if (!remote) {
      return { checked: false, hasUpdate: false, reloaded: false, localBuildId: APP_BUILD_ID, error: 'unreachable' };
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
