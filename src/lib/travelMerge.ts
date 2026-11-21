export function isRecordDeleted(doc: any): boolean {
  return Boolean(doc && (doc.isArchived === true || doc.is_deleted === true));
}

export function isTravelRowPopulated(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  return (
    Boolean(String(row.route || '').trim()) ||
    (Number(row.openingKm) || 0) > 0 ||
    (Number(row.closingKm) || 0) > 0 ||
    (Number(row.km) || 0) > 0 ||
    (Number(row.amount) || 0) > 0 ||
    (Number(row.otherExpenses) || 0) > 0
  );
}

function parseDocTs(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  if (typeof obj._syncUpdatedAtMs === 'number' && Number.isFinite(obj._syncUpdatedAtMs)) {
    return obj._syncUpdatedAtMs;
  }
  const str = obj._localSavedAt || obj.updatedAt || obj.createdAt;
  if (typeof str === 'string' && str) {
    const t = Date.parse(str);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

export function mergeTravelRows<T extends Record<string, any>>(
  baseRows: T[],
  incomingRows: T[],
  baseSheetTs = 0,
  incomingSheetTs = 0,
  options?: {
    dirtyDays?: Set<number>;
  }
): T[] {
  const byKey = new Map<string, T>();
  const keyOfRow = (r: any, idx: number) =>
    r?.dayNumber
      ? `day_${Number(r.dayNumber)}`
      : r?.date
        ? `date_${String(r.date).slice(0, 10)}`
        : `idx_${idx}`;

  (Array.isArray(baseRows) ? baseRows : []).forEach((r, idx) => {
    if (r && typeof r === 'object') {
      byKey.set(keyOfRow(r, idx), r);
    }
  });

  (Array.isArray(incomingRows) ? incomingRows : []).forEach((inc, idx) => {
    if (!inc || typeof inc !== 'object') return;
    const key = keyOfRow(inc, idx);
    const base = byKey.get(key);
    if (!base) {
      byKey.set(key, inc);
      return;
    }

    const dayNum = Number(base.dayNumber ?? inc.dayNumber) || 0;
    if (dayNum > 0 && options?.dirtyDays?.has(dayNum)) {
      // Never overwrite a day currently modified/unsaved on this device
      return;
    }

    const basePop = isTravelRowPopulated(base);
    const incPop = isTravelRowPopulated(inc);
    const baseRowTs = Number(base.rowUpdatedAtMs) || 0;
    const incRowTs = Number(inc.rowUpdatedAtMs) || 0;
    const baseClearedTs = Number(base.rowClearedAtMs) || 0;
    const incClearedTs = Number(inc.rowClearedAtMs) || 0;

    if (baseRowTs > 0 && incRowTs > 0) {
      if (baseRowTs > incRowTs) {
        byKey.set(key, base);
      } else if (incRowTs > baseRowTs) {
        byKey.set(key, inc);
      } else {
        byKey.set(key, basePop && !incPop ? base : inc);
      }
      return;
    }

    if (incPop && !basePop) {
      if (baseClearedTs > Math.max(incRowTs, incomingSheetTs)) {
        byKey.set(key, base);
      } else {
        byKey.set(key, inc);
      }
      return;
    }

    if (basePop && !incPop) {
      if (incClearedTs > Math.max(baseRowTs, baseSheetTs)) {
        byKey.set(key, inc);
      } else {
        byKey.set(key, base);
      }
      return;
    }

    if (incPop && basePop) {
      byKey.set(key, incomingSheetTs > baseSheetTs ? inc : base);
      return;
    }

    byKey.set(key, incomingSheetTs > baseSheetTs ? inc : base);
  });

  return Array.from(byKey.values()).sort(
    (a, b) => (Number(a?.dayNumber) || 0) - (Number(b?.dayNumber) || 0)
  );
}

export function mergeTravelSheetDocs<T extends Record<string, any>>(
  baseDoc: T,
  incomingDoc: T,
  options?: {
    dirtyDays?: Set<number>;
    preferIncomingMeta?: boolean;
  }
): T {
  if (!baseDoc) return incomingDoc;
  if (!incomingDoc) return baseDoc;

  const baseTs = parseDocTs(baseDoc);
  const incTs = parseDocTs(incomingDoc);
  const mergedRows = mergeTravelRows(
    Array.isArray(baseDoc.rows) ? baseDoc.rows : [],
    Array.isArray(incomingDoc.rows) ? incomingDoc.rows : [],
    baseTs,
    incTs,
    { dirtyDays: options?.dirtyDays }
  );

  const totalKm = mergedRows.reduce((acc, r) => acc + (Number(r?.km) || 0), 0);
  const totalAmount = mergedRows.reduce((acc, r) => acc + (Number(r?.amount) || 0), 0);
  const totalOtherExpenses = mergedRows.reduce((acc, r) => acc + (Number(r?.otherExpenses) || 0), 0);
  const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
  const averageCostPerKm = totalKm > 0 ? Math.round((subtotalAmount / totalKm) * 100) / 100 : 0;

  const incomingWinsMeta =
    options?.preferIncomingMeta !== undefined
      ? options.preferIncomingMeta
      : incTs >= baseTs;

  const older = incomingWinsMeta ? baseDoc : incomingDoc;
  const newer = incomingWinsMeta ? incomingDoc : baseDoc;
  const maxTs = Math.max(baseTs, incTs);

  return {
    ...older,
    ...newer,
    id: newer.id || older.id,
    rows: mergedRows,
    totalKm,
    totalAmount,
    totalOtherExpenses,
    subtotalAmount,
    totalExpensesAmount: subtotalAmount,
    averageCostPerKm,
    ...(maxTs > 0
      ? {
          _syncUpdatedAtMs: maxTs,
          updatedAt: new Date(maxTs).toISOString(),
        }
      : {}),
  } as T;
}
