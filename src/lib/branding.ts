import { useState, useEffect } from 'react';
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

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
const brandingSubscribers = new Set<(config: BrandingConfig) => void>();
let currentBrandingState: BrandingConfig = getCachedBranding();

function startSharedBrandingListener() {
  if (sharedUnsub) return;
  try {
    sharedUnsub = onSnapshot(
      doc(db, 'config', 'branding'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const fresh: BrandingConfig = {
            logoUrl: data.logoUrl || '',
            logoSize: Number(data.logoSize) || 80,
          };
          currentBrandingState = fresh;
          setCachedBranding(fresh);
          brandingSubscribers.forEach((cb) => cb(fresh));
        }
      },
      (err) => {
        console.warn('Shared branding sync notice:', err);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared branding listener:', e);
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
      if (brandingSubscribers.size === 0 && sharedUnsub) {
        sharedUnsub();
        sharedUnsub = null;
      }
    };
  }, []);

  const saveBranding = async (newUrl: string, newSize: number, userId?: string) => {
    const updated: BrandingConfig = { logoUrl: newUrl, logoSize: newSize };
    setBranding(updated);
    setCachedBranding(updated);

    try {
      await updateDoc(doc(db, 'config', 'branding'), {
        logoUrl: newUrl,
        logoSize: newSize,
        updatedAt: new Date().toISOString(),
        updatedBy: userId || 'admin',
      });
    } catch {
      // If doc doesn't exist yet, use setDoc
      await setDoc(doc(db, 'config', 'branding'), {
        logoUrl: newUrl,
        logoSize: newSize,
        updatedAt: new Date().toISOString(),
        updatedBy: userId || 'admin',
      }, { merge: true });
    }
  };

  return { ...branding, saveBranding };
}
