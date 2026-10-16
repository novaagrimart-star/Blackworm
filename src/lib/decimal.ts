/**
 * Decimal & Financial precision utilities.
 * Eliminates floating-point inaccuracies (e.g. 13.370000000000000, 7.240000000000001)
 * across calculations, displays, subtotals, grand totals, reports, and PDF exports.
 */

/**
 * Rounds a value to strictly 2 decimal places using integer-based cents/paisa.
 */
export function toDecimal2(val: number | string | undefined | null): number {
  if (val === undefined || val === null || val === '') return 0;
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/**
 * High-precision integer addition for financial decimals.
 */
export function addDecimal2(...vals: (number | string | undefined | null)[]): number {
  const sumCents = vals.reduce<number>((acc, v) => {
    if (v === undefined || v === null || v === '') return acc;
    const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    if (isNaN(num) || !isFinite(num)) return acc;
    return acc + Math.round((num + Number.EPSILON) * 100);
  }, 0);
  return sumCents / 100;
}

/**
 * High-precision integer subtraction for financial decimals.
 */
export function subtractDecimal2(a: number | string | undefined | null, b: number | string | undefined | null): number {
  const centsA = Math.round((toDecimal2(a) + Number.EPSILON) * 100);
  const centsB = Math.round((toDecimal2(b) + Number.EPSILON) * 100);
  return (centsA - centsB) / 100;
}

/**
 * High-precision multiplication for percentages e.g. achievement * (collectionPercent / 100).
 * Prevents precision errors like 18.1 * 40% becoming 7.240000000000001.
 */
export function multiplyDecimal2(amount: number | string | undefined | null, percent: number | string | undefined | null): number {
  const aCents = Math.round((toDecimal2(amount) + Number.EPSILON) * 100);
  const p = Number(percent) || 0;
  return Math.round((aCents * p) / 100) / 100;
}

/**
 * Formats an amount with strictly up to 2 decimal places (e.g. "13.37", "16.07", "7.24", "0.00").
 */
export function formatAmount(val: number | string | undefined | null, showZero = true): string {
  if (val === undefined || val === null || val === '') {
    return showZero ? '0.00' : '';
  }
  const num = toDecimal2(val);
  if (num === 0 && !showZero) return '';
  return num.toFixed(2);
}

/**
 * Formats a percentage value with strictly 1 decimal place (e.g. "116.2%", "177.0%", "0.0%").
 */
export function formatPercent(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '') return '0.0%';
  const num = Number(val);
  if (isNaN(num) || !isFinite(num) || num <= 0) return '0.0%';
  const rounded = Math.round((num + Number.EPSILON) * 10) / 10;
  return `${rounded.toFixed(1)}%`;
}

/**
 * Calculates (achieved / target) * 100 and formats to 1 decimal place.
 */
export function calcPercent(achieved: number | string | undefined | null, target: number | string | undefined | null): string {
  const ach = toDecimal2(achieved);
  const tgt = toDecimal2(target);
  if (tgt <= 0 || isNaN(tgt)) return '0.0%';
  const pct = (ach / tgt) * 100;
  return formatPercent(pct);
}
