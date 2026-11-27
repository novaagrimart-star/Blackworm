import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import {
  safeFirestoreSet,
  isQuotaBlocked,
  setQuotaBlocked,
  trackFirestoreUsage,
  toTimestampMs,
} from './dataService';
import {
  subscribeSecondaryCollection,
  fetchSecondaryCollection,
  pushToSecondary,
} from './secondaryDb';

export interface ModuleOptionOverride {
  label?: string;
  hidden?: boolean;
  order?: number;
}

export interface CustomDashboardOption {
  id: string;
  label: string;
  subtitle?: string;
  description?: string;
  url?: string;
  color?: string;
  bg?: string;
  enabled: boolean;
  order: number;
}

export type LayoutDensity = 'compact' | 'standard' | 'spacious';
export type GridColumns = 2 | 3 | 4;

export interface UiLayoutConfig {
  appTitle: string;
  gridColumns: GridColumns;
  layoutDensity: LayoutDensity;
  moduleOverrides: Record<string, ModuleOptionOverride>;
  customOptions: CustomDashboardOption[];
  updatedAtMs?: number;
}

const STORAGE_KEY = 'blackworm_ui_layout_cache_v1';

export const DEFAULT_UI_CONFIG: UiLayoutConfig = {
  appTitle: 'BLACKWORM AGRITECH PVT LTD',
  gridColumns: 3,
  layoutDensity: 'standard',
  moduleOverrides: {},
  customOptions: [],
};

function sanitizeUiConfig(raw: any): UiLayoutConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_UI_CONFIG };

  const gridNum = Number(raw.gridColumns);
  const gridColumns: GridColumns = gridNum === 2 || gridNum === 4 ? gridNum : 3;

  const rawDensity = String(raw.layoutDensity || 'standard').toLowerCase();
  const layoutDensity: LayoutDensity =
    rawDensity === 'compact' || rawDensity === 'spacious' ? rawDensity : 'standard';

  const appTitle =
    typeof raw.appTitle === 'string' && raw.appTitle.trim()
      ? raw.appTitle.trim()
      : DEFAULT_UI_CONFIG.appTitle;

  const moduleOverrides: Record<string, ModuleOptionOverride> = {};
  if (raw.moduleOverrides && typeof raw.moduleOverrides === 'object' && !Array.isArray(raw.moduleOverrides)) {
    for (const [k, v] of Object.entries(raw.moduleOverrides)) {
      if (!v || typeof v !== 'object') continue;
      const ov = v as any;
      moduleOverrides[String(k)] = {
        ...(typeof ov.label === 'string' && ov.label.trim() ? { label: ov.label.trim() } : {}),
        ...(typeof ov.hidden === 'boolean' ? { hidden: ov.hidden } : {}),
        ...(typeof ov.order === 'number' && Number.isFinite(ov.order) ? { order: ov.order } : {}),
      };
    }
  }

  const customOptions: CustomDashboardOption[] = Array.isArray(raw.customOptions)
    ? raw.customOptions
        .filter((opt: any) => opt && typeof opt === 'object' && String(opt.label || '').trim())
        .map((opt: any, idx: number) => ({
          id: String(opt.id || `opt_${idx + 1}`).trim(),
          label: String(opt.label).trim(),
          subtitle: typeof opt.subtitle === 'string' ? opt.subtitle.trim() : '',
          description: typeof opt.description === 'string' ? opt.description.trim() : '',
          url: typeof opt.url === 'string' ? opt.url.trim() : '',
          color: typeof opt.color === 'string' && opt.color.trim() ? opt.color.trim() : 'text-indigo-600',
          bg: typeof opt.bg === 'string' && opt.bg.trim() ? opt.bg.trim() : 'bg-indigo-50',
          enabled: opt.enabled !== false,
          order: typeof opt.order === 'number' && Number.isFinite(opt.order) ? opt.order : idx + 100,
        }))
    : [];

  return {
    appTitle,
    gridColumns,
    layoutDensity,
    moduleOverrides,
    customOptions,
    updatedAtMs: Math.max(
      Number(raw._syncUpdatedAtMs) || 0,
      toTimestampMs(raw.updatedAt || raw.createdAt),
      Number(raw.updatedAtMs) || 0
    ),
  };
}

export function getCachedUiConfig(): UiLayoutConfig {
  try {
    if (typeof window === 'undefined') return { ...DEFAULT_UI_CONFIG };
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      return sanitizeUiConfig(JSON.parse(cached));
    }
  } catch {}
  return { ...DEFAULT_UI_CONFIG };
}

function setCachedUiConfig(cfg: UiLayoutConfig) {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

let sharedUiUnsub: (() => void) | null = null;
let sharedUiSecUnsub: (() => void) | null = null;
let uiResyncAttached = false;
let uiSecPulledOnce = false;
let uiConfigDocTs = 0;
const uiSubscribers = new Set<(cfg: UiLayoutConfig) => void>();
let currentUiState: UiLayoutConfig = getCachedUiConfig();

function applyUiConfigUpdate(data: any, authoritativeServer = false) {
  if (!data || typeof data !== 'object') return;
  const incomingTs = Math.max(
    Number(data._syncUpdatedAtMs) || 0,
    toTimestampMs(data.updatedAt || data.createdAt),
    Number(data.updatedAtMs) || 0
  );
  if (!authoritativeServer && uiConfigDocTs > 0 && incomingTs > 0 && uiConfigDocTs > incomingTs + 500) {
    return;
  }
  if (incomingTs > 0) uiConfigDocTs = incomingTs;

  const fresh = sanitizeUiConfig(data);
  try {
    if (JSON.stringify(currentUiState) === JSON.stringify(fresh)) {
      return;
    }
  } catch {}

  currentUiState = fresh;
  setCachedUiConfig(fresh);
  uiSubscribers.forEach((cb) => cb(fresh));
}

function pullUiConfigFromSecondary() {
  void fetchSecondaryCollection('config', { limit: 1000 }).then((res) => {
    if (!res.ok) return;
    const match = res.items.find((it) => it?.id === 'ui_layout');
    if (match) applyUiConfigUpdate(match, false);
  });
}

function ensureUiResyncHooks() {
  if (typeof window === 'undefined' || uiResyncAttached) return;
  uiResyncAttached = true;

  window.addEventListener('blackworm_local_record_mutation', (e: any) => {
    const d = e?.detail;
    if (d?.collection === 'config' && d?.id === 'ui_layout' && d?.doc && !d?.deleted) {
      applyUiConfigUpdate(
        { ...d.doc, ...(d.updatedAtMs ? { _syncUpdatedAtMs: d.updatedAtMs } : {}) },
        false
      );
    }
  });
  window.addEventListener('blackworm_data_refresh', pullUiConfigFromSecondary);
  window.addEventListener('blackworm_secondary_resync', pullUiConfigFromSecondary);
  window.addEventListener('blackworm_quota_blocked', pullUiConfigFromSecondary);
  window.addEventListener('blackworm_quota_cleared', () => {
    if (uiSubscribers.size > 0) startSharedUiConfigListener();
  });
}

function startSharedUiConfigListener() {
  ensureUiResyncHooks();

  if (!sharedUiSecUnsub) {
    sharedUiSecUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'ui_layout' && evt.doc && !evt.deleted) {
          applyUiConfigUpdate(
            { ...evt.doc, ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}) },
            false
          );
        }
      });
    });
  }

  if (!uiSecPulledOnce) {
    uiSecPulledOnce = true;
    pullUiConfigFromSecondary();
  }

  if (sharedUiUnsub) return;

  if (isQuotaBlocked()) {
    pullUiConfigFromSecondary();
    return;
  }

  try {
    sharedUiUnsub = onSnapshot(
      doc(db, 'config', 'ui_layout'),
      (snap) => {
        trackFirestoreUsage('read', 1);
        if (snap.exists()) {
          const data = snap.data();
          applyUiConfigUpdate(data, !snap.metadata?.fromCache);
          if (!snap.metadata?.fromCache) {
            void pushToSecondary({
              collection: 'config',
              id: 'ui_layout',
              doc: { ...data, id: 'ui_layout' },
              merge: true,
            });
          }
        }
      },
      (err) => {
        console.warn('Shared UI layout sync notice:', err);
        if (sharedUiUnsub) {
          try {
            sharedUiUnsub();
          } catch {}
          sharedUiUnsub = null;
        }
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          setQuotaBlocked(2 * 60 * 1000);
        }
        pullUiConfigFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared UI layout listener:', e);
    sharedUiUnsub = null;
    pullUiConfigFromSecondary();
  }
}

/**
 * Real-time synchronized UI design, layout & dynamic Dashboard options hook.
 * Propagates Admin changes instantly (<1s) across all connected browsers & APKs with zero reload.
 */
export function useUiConfig() {
  const [uiConfig, setUiConfig] = useState<UiLayoutConfig>(() => currentUiState);

  useEffect(() => {
    uiSubscribers.add(setUiConfig);
    startSharedUiConfigListener();

    return () => {
      uiSubscribers.delete(setUiConfig);
      if (uiSubscribers.size === 0 && sharedUiUnsub) {
        sharedUiUnsub();
        sharedUiUnsub = null;
      }
    };
  }, []);

  const saveUiConfig = async (nextConfig: Partial<UiLayoutConfig>, userId?: string) => {
    const merged = sanitizeUiConfig({
      ...currentUiState,
      ...nextConfig,
      updatedAtMs: Date.now(),
    });
    uiConfigDocTs = merged.updatedAtMs || Date.now();
    currentUiState = merged;
    setCachedUiConfig(merged);
    uiSubscribers.forEach((cb) => cb(merged));

    await safeFirestoreSet(
      'config',
      'ui_layout',
      {
        appTitle: merged.appTitle,
        gridColumns: merged.gridColumns,
        layoutDensity: merged.layoutDensity,
        moduleOverrides: merged.moduleOverrides,
        customOptions: merged.customOptions,
        updatedAt: new Date().toISOString(),
        updatedBy: userId || 'admin',
      },
      { merge: true }
    );
  };

  const resetUiConfig = async (userId?: string) => {
    await saveUiConfig({ ...DEFAULT_UI_CONFIG }, userId);
  };

  return { uiConfig, saveUiConfig, resetUiConfig };
}
