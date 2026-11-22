import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats a string to Title Case (First letter capitalized, rest lowercase for each word)
 * e.g. "GANESH KRISHI SEVA KENDRA MANERAJURI" -> "Ganesh Krishi Seva Kendra Manerajuri"
 * Preserves specific corporate abbreviations like MD, PVT, LTD, GST, PAN, IFSC.
 */
export function toTitleCase(str: string | undefined | null): string {
  if (!str) return '';
  const s = String(str).trim();
  if (!s) return '';

  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      return word
        .split('-')
        .map((subWord) => {
          return subWord
            .split('/')
            .map((part) => {
              const lower = part.toLowerCase();
              if (['md', 'pvt', 'ltd', 'gst', 'gstin', 'pan', 'ifsc', 'cin'].includes(lower)) {
                return lower.toUpperCase();
              }
              return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            })
            .join('/');
        })
        .join('-');
    })
    .join(' ');
}

/**
 * Safely opens external links (like WhatsApp, tel, downloads) in web and iframe environments
 * without getting blocked by popup blockers or sandbox restrictions.
 */
export function openExternalLinkSafely(url: string): void {
  if (!url || typeof window === 'undefined') return;
  const trimmed = String(url).trim();
  const isSafeProtocol = /^(https?:|tel:|mailto:|whatsapp:|blob:|data:image\/|data:application\/pdf)/i.test(trimmed);
  if (!isSafeProtocol) return;

  try {
    const link = document.createElement('a');
    link.href = trimmed;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch {
    try {
      window.open(trimmed, '_blank', 'noopener,noreferrer');
    } catch {
      if (/^(tel:|mailto:|whatsapp:)/i.test(trimmed)) {
        window.location.assign(trimmed);
      }
    }
  }
}
