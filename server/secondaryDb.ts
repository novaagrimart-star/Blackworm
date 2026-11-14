import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

export interface SyncRecordPayload {
  collection: string;
  id: string;
  doc: Record<string, any>;
  updatedAtMs?: number;
  deleted?: boolean;
  merge?: boolean;
}

export interface SyncDeltaEvent {
  collection: string;
  id: string;
  doc: Record<string, any> | null;
  deleted: boolean;
  updatedAtMs: number;
  revision: number;
}

interface StoredRow {
  collection: string;
  id: string;
  data: string;
  updated_at_ms: number;
  deleted: number;
  revision: number;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'secondary_sync.sqlite');
const FALLBACK_JSON_PATH = path.join(DATA_DIR, 'secondary_sync_backup.json');

// Safe timestamp extractor
function parseTs(val: any): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

class SecondarySyncDatabase {
  private sqliteDb: any = null;
  private memoryStore = new Map<string, StoredRow>();
  private revisionCounter = 0;
  private sseClients = new Set<Response>();
  private supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  private supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.init();
  }

  private keyOf(col: string, id: string): string {
    return `${col}:::${id}`;
  }

  private init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {
      console.warn('[SecondaryDB] Could not create data dir:', e);
    }

    try {
      // Load built-in node:sqlite synchronously if available (Node 22+)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteMod = (globalThis as any).process?.getBuiltinModule?.('node:sqlite');
      if (sqliteMod && sqliteMod.DatabaseSync) {
        this.sqliteDb = new sqliteMod.DatabaseSync(DB_PATH);
        this.sqliteDb.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;
          CREATE TABLE IF NOT EXISTS sync_records (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (collection, id)
          );
          CREATE INDEX IF NOT EXISTS idx_sync_col_updated ON sync_records (collection, updated_at_ms);
          CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_records (updated_at_ms);
          CREATE INDEX IF NOT EXISTS idx_sync_revision ON sync_records (revision);
        `);

        const maxRow = this.sqliteDb.prepare('SELECT COALESCE(MAX(revision), 0) AS maxRev FROM sync_records').get();
        this.revisionCounter = Number(maxRow?.maxRev) || 0;
        console.log(`[SecondaryDB] SQLite WAL initialized (${DB_PATH}), max revision=${this.revisionCounter}`);
        return;
      }
    } catch (err) {
      console.warn('[SecondaryDB] node:sqlite fallback to atomic JSON WAL store:', err);
      this.sqliteDb = null;
    }

    // Fallback atomic JSON store load
    try {
      if (fs.existsSync(FALLBACK_JSON_PATH)) {
        const raw = fs.readFileSync(FALLBACK_JSON_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.rows)) {
          parsed.rows.forEach((r: StoredRow) => {
            this.memoryStore.set(this.keyOf(r.collection, r.id), r);
            if (r.revision > this.revisionCounter) this.revisionCounter = r.revision;
          });
        }
      }
    } catch (e) {
      console.warn('[SecondaryDB] Fallback file load notice:', e);
    }
  }

  private scheduleFallbackPersist() {
    if (this.sqliteDb) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        const tmp = `${FALLBACK_JSON_PATH}.tmp`;
        fs.writeFileSync(
          tmp,
          JSON.stringify({ rows: Array.from(this.memoryStore.values()) }),
          'utf-8'
        );
        fs.renameSync(tmp, FALLBACK_JSON_PATH);
      } catch (e) {
        console.warn('[SecondaryDB] Atomic persist notice:', e);
      }
    }, 300);
  }

  public isSupabaseEnabled(): boolean {
    return Boolean(this.supabaseUrl && this.supabaseKey);
  }

  public addSseClient(res: Response) {
    this.sseClients.add(res);
  }

  public removeSseClient(res: Response) {
    this.sseClients.delete(res);
  }

  private broadcastDelta(evt: SyncDeltaEvent) {
    if (this.sseClients.size === 0) return;
    const payload = `event: delta\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of Array.from(this.sseClients)) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  private async mirrorToSupabase(row: StoredRow) {
    if (!this.isSupabaseEnabled()) return;
    try {
      await fetch(`${this.supabaseUrl}/rest/v1/sync_records`, {
        method: 'POST',
        headers: {
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          collection: row.collection,
          id: row.id,
          data: JSON.parse(row.data),
          updated_at_ms: row.updated_at_ms,
          deleted: row.deleted === 1,
          revision: row.revision,
        }),
      });
    } catch (e) {
      console.warn('[SecondaryDB] Supabase mirror notice (will keep local SQLite copy):', e);
    }
  }

  private getRow(collection: string, id: string): StoredRow | null {
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        'SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records WHERE collection = ? AND id = ?'
      );
      const row = stmt.get(collection, id);
      return row ? (row as StoredRow) : null;
    }
    return this.memoryStore.get(this.keyOf(collection, id)) || null;
  }

  private putRow(row: StoredRow) {
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(`
        INSERT INTO sync_records (collection, id, data, updated_at_ms, deleted, revision)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
          data = excluded.data,
          updated_at_ms = excluded.updated_at_ms,
          deleted = excluded.deleted,
          revision = excluded.revision
      `);
      stmt.run(row.collection, row.id, row.data, row.updated_at_ms, row.deleted, row.revision);
    } else {
      this.memoryStore.set(this.keyOf(row.collection, row.id), row);
      this.scheduleFallbackPersist();
    }
  }

  /**
   * Deterministic Conflict Resolution (Unique ID + Timestamp Last-Write-Wins + Tombstone protection)
   */
  public upsert(input: SyncRecordPayload, broadcast = true): { stored: SyncDeltaEvent; applied: boolean } {
    const col = String(input.collection || '').trim();
    const id = String(input.id || '').trim();
    if (!col || !id) {
      throw new Error('collection and id are required');
    }

    const incomingDoc: Record<string, any> =
      input.doc && typeof input.doc === 'object' ? { ...input.doc, id } : { id };
    const isDeleted = Boolean(input.deleted || incomingDoc.isArchived);
    const incomingTs =
      Number(input.updatedAtMs) ||
      parseTs(incomingDoc.updatedAt) ||
      parseTs(incomingDoc.createdAt) ||
      Date.now();

    const existing = this.getRow(col, id);
    let existingDoc: Record<string, any> | null = null;
    if (existing) {
      try {
        existingDoc = JSON.parse(existing.data);
      } catch {
        existingDoc = null;
      }
    }

    // Conflict check: if existing record is strictly newer, keep newer fields and avoid stale overwrite
    if (existing && existing.updated_at_ms > incomingTs) {
      const mergedDoc =
        existingDoc && incomingDoc
          ? { ...incomingDoc, ...existingDoc, id }
          : existingDoc || incomingDoc;
      return {
        applied: false,
        stored: {
          collection: col,
          id,
          doc: mergedDoc,
          deleted: existing.deleted === 1,
          updatedAtMs: existing.updated_at_ms,
          revision: existing.revision,
        },
      };
    }

    const finalDoc: Record<string, any> =
      input.merge !== false && existingDoc
        ? { ...existingDoc, ...incomingDoc, id }
        : { ...incomingDoc, id };

    if (isDeleted) {
      finalDoc.isArchived = true;
    }
    if (!finalDoc.updatedAt) {
      finalDoc.updatedAt = new Date(incomingTs).toISOString();
    }
    finalDoc._syncUpdatedAtMs = incomingTs;

    this.revisionCounter += 1;
    const row: StoredRow = {
      collection: col,
      id,
      data: JSON.stringify(finalDoc),
      updated_at_ms: incomingTs,
      deleted: isDeleted ? 1 : 0,
      revision: this.revisionCounter,
    };

    this.putRow(row);

    const deltaEvent: SyncDeltaEvent = {
      collection: col,
      id,
      doc: finalDoc,
      deleted: isDeleted,
      updatedAtMs: incomingTs,
      revision: this.revisionCounter,
    };

    if (broadcast) {
      this.broadcastDelta(deltaEvent);
    }

    if (this.isSupabaseEnabled()) {
      void this.mirrorToSupabase(row);
    }

    return { applied: true, stored: deltaEvent };
  }

  public upsertBatch(items: SyncRecordPayload[]): { count: number; latestRevision: number; events: SyncDeltaEvent[] } {
    const events: SyncDeltaEvent[] = [];
    if (!Array.isArray(items) || items.length === 0) {
      return { count: 0, latestRevision: this.revisionCounter, events };
    }

    if (this.sqliteDb) {
      this.sqliteDb.exec('BEGIN');
      try {
        for (const item of items) {
          if (!item?.collection || !item?.id) continue;
          const res = this.upsert(item, false);
          if (res.applied) {
            events.push(res.stored);
          }
        }
        this.sqliteDb.exec('COMMIT');
      } catch (err) {
        try {
          this.sqliteDb.exec('ROLLBACK');
        } catch {}
        throw err;
      }
    } else {
      for (const item of items) {
        if (!item?.collection || !item?.id) continue;
        const res = this.upsert(item, false);
        if (res.applied) {
          events.push(res.stored);
        }
      }
    }

    events.forEach((evt) => this.broadcastDelta(evt));
    return { count: events.length, latestRevision: this.revisionCounter, events };
  }

  public getCollection(
    collection: string,
    options: { sinceMs?: number; limit?: number; offset?: number; includeDeleted?: boolean } = {}
  ): { items: Record<string, any>[]; archivedIds: string[]; total: number; latestUpdatedAtMs: number; revision: number } {
    const col = String(collection || '').trim();
    const sinceMs = Math.max(0, Number(options.sinceMs) || 0);
    const limit = Math.min(5000, Math.max(1, Number(options.limit) || 1000));
    const offset = Math.max(0, Number(options.offset) || 0);

    const items: Record<string, any>[] = [];
    const archivedIds: string[] = [];
    let latestUpdatedAtMs = 0;

    if (this.sqliteDb) {
      const countRow = this.sqliteDb
        .prepare('SELECT COUNT(*) AS cnt FROM sync_records WHERE collection = ? AND updated_at_ms > ?')
        .get(col, sinceMs);
      const total = Number(countRow?.cnt) || 0;

      const rows = this.sqliteDb
        .prepare(
          'SELECT id, data, updated_at_ms, deleted FROM sync_records WHERE collection = ? AND updated_at_ms > ? ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?'
        )
        .all(col, sinceMs, limit, offset) as StoredRow[];

      rows.forEach((r) => {
        if (r.updated_at_ms > latestUpdatedAtMs) latestUpdatedAtMs = r.updated_at_ms;
        if (r.deleted === 1) {
          archivedIds.push(r.id);
          if (options.includeDeleted) {
            try {
              items.push({ ...JSON.parse(r.data), id: r.id, isArchived: true });
            } catch {}
          }
        } else {
          try {
            items.push({ ...JSON.parse(r.data), id: r.id });
          } catch {}
        }
      });

      return { items, archivedIds, total, latestUpdatedAtMs, revision: this.revisionCounter };
    }

    const matching = Array.from(this.memoryStore.values())
      .filter((r) => r.collection === col && r.updated_at_ms > sinceMs)
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);

    const sliced = matching.slice(offset, offset + limit);
    sliced.forEach((r) => {
      if (r.updated_at_ms > latestUpdatedAtMs) latestUpdatedAtMs = r.updated_at_ms;
      if (r.deleted === 1) {
        archivedIds.push(r.id);
      } else {
        try {
          items.push({ ...JSON.parse(r.data), id: r.id });
        } catch {}
      }
    });

    return { items, archivedIds, total: matching.length, latestUpdatedAtMs, revision: this.revisionCounter };
  }

  public getChangesSince(sinceRevision: number, limit = 500): { events: SyncDeltaEvent[]; latestRevision: number } {
    const rev = Math.max(0, Number(sinceRevision) || 0);
    const maxLimit = Math.min(2000, Math.max(1, Number(limit) || 500));
    const events: SyncDeltaEvent[] = [];

    if (this.sqliteDb) {
      const rows = this.sqliteDb
        .prepare(
          'SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records WHERE revision > ? ORDER BY revision ASC LIMIT ?'
        )
        .all(rev, maxLimit) as StoredRow[];

      rows.forEach((r) => {
        try {
          events.push({
            collection: r.collection,
            id: r.id,
            doc: JSON.parse(r.data),
            deleted: r.deleted === 1,
            updatedAtMs: r.updated_at_ms,
            revision: r.revision,
          });
        } catch {}
      });
    } else {
      const matching = Array.from(this.memoryStore.values())
        .filter((r) => r.revision > rev)
        .sort((a, b) => a.revision - b.revision)
        .slice(0, maxLimit);
      matching.forEach((r) => {
        try {
          events.push({
            collection: r.collection,
            id: r.id,
            doc: JSON.parse(r.data),
            deleted: r.deleted === 1,
            updatedAtMs: r.updated_at_ms,
            revision: r.revision,
          });
        } catch {}
      });
    }

    return { events, latestRevision: this.revisionCounter };
  }

  public getStats() {
    let totalRecords = 0;
    if (this.sqliteDb) {
      const row = this.sqliteDb.prepare('SELECT COUNT(*) AS cnt FROM sync_records').get();
      totalRecords = Number(row?.cnt) || 0;
    } else {
      totalRecords = this.memoryStore.size;
    }
    return {
      ok: true,
      engine: this.sqliteDb ? 'sqlite-wal' : 'atomic-json-wal',
      supabaseMirror: this.isSupabaseEnabled(),
      totalRecords,
      latestRevision: this.revisionCounter,
      connectedClients: this.sseClients.size,
    };
  }
}

export const secondarySyncDb = new SecondarySyncDatabase();
