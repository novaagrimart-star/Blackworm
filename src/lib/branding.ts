import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { safeFirestoreSet, isQuotaBlocked, setQuotaBlocked, trackFirestoreUsage } from './dataService';
import { subscribeSecondaryCollection, fetchSecondaryCollection, pushToSecondary } from './secondaryDb';

export interface BrandingConfig {
  logoUrl: string;
  logoSize: number;
}

const STORAGE_KEY = 'blackworm_branding_cache';

export const DEFAULT_BRANDING: BrandingConfig = {
  logoUrl: '',
  logoSize: 80,
};

export function getCachedBranding(): BrandingConfig {
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        logoUrl: parsed.logoUrl || '',
        logoSize: Number(parsed.logoSize) || 80,
      };
    }
  } catch (e) {
    console.warn('Failed to load cached branding:', e);
  }
  return DEFAULT_BRANDING;
}

export function setCachedBranding(config: BrandingConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('Failed to cache branding:', e);
  }
}

let sharedUnsub: (() => void) | null = null;
let sharedSecUnsub: (() => void) | null = null;
const brandingSubscribers = new Set<(config: BrandingConfig) => void>();
let currentBrandingState: BrandingConfig = getCachedBranding();

function applyBrandingUpdate(data: any) {
  if (!data) return;
  const fresh: BrandingConfig = {
    logoUrl: data.logoUrl || '',
    logoSize: Number(data.logoSize) || 80,
  };
  currentBrandingState = fresh;
  setCachedBranding(fresh);
  brandingSubscribers.forEach((cb) => cb(fresh));
}

function pullBrandingFromSecondary() {
  void fetchSecondaryCollection('config', { limit: 50 }).then((res) => {
    if (!res.ok) return;
    const match = res.items.find((it) => it?.id === 'branding');
    if (match) applyBrandingUpdate(match);
  });
}

function startSharedBrandingListener() {
  if (!sharedSecUnsub) {
    sharedSecUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'branding' && evt.doc && !evt.deleted) {
          applyBrandingUpdate(evt.doc);
        }
      });
    });
  }

  if (sharedUnsub) return;

  if (isQuotaBlocked()) {
    pullBrandingFromSecondary();
    return;
  }

  try {
    sharedUnsub = onSnapshot(
      doc(db, 'config', 'branding'),
      (snap) => {
        trackFirestoreUsage('read', 1);
        if (snap.exists()) {
          const data = snap.data();
          applyBrandingUpdate(data);
          void pushToSecondary({ collection: 'config', id: 'branding', doc: { ...data, id: 'branding' }, merge: true });
        }
      },
      (err) => {
        console.warn('Shared branding sync notice:', err);
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          setQuotaBlocked(15 * 60 * 1000);
        }
        pullBrandingFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared branding listener:', e);
    pullBrandingFromSecondary();
  }
}

/**
 * Custom React Hook for Instant, Synchronized Company Branding (Shared Singleton Listener)
 */
export function useBranding() {
  const [branding, setBranding] = useState<BrandingConfig>(() => currentBrandingState);

  useEffect(() => {
    brandingSubscribers.add(setBranding);
    startSharedBrandingListener();

    return () => {
      brandingSubscribers.delete(setBranding);
      if (brandingSubscribers.size === 0) {
        if (sharedUnsub) {
          sharedUnsub();
          sharedUnsub = null;
        }
        if (sharedSecUnsub) {
          sharedSecUnsub();
          sharedSecUnsub = null;
        }
      }
    };
  }, []);

  const saveBranding = async (newUrl: string, newSize: number, userId?: string) => {
    const updated: BrandingConfig = { logoUrl: newUrl, logoSize: newSize };
    setBranding(updated);
    currentBrandingState = updated;
    setCachedBranding(updated);

    await safeFirestoreSet(
      'config',
      'branding',
      {
        logoUrl: newUrl,
        logoSize: newSize,
        updatedAt: new Date().toISOString(),
        updatedBy: userId || 'admin',
      },
      { merge: true }
    );
  };

  return { ...branding, saveBranding };
}
