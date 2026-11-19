import Database from 'better-sqlite3';
import { join } from 'path';
import type {
  AppConfig,
  DictationDelivery,
  DictationHistoryEntry,
  DictationHistoryPage,
  DictationHistoryRow,
  InjectResult,
  TranscriptionProviderId,
} from '../types/ipc';

/** Hard bounds: rows kept on disk, rows per page, and characters per list row. */
export const DICTATION_HISTORY_MAX_ENTRIES = 1000;
export const DICTATION_HISTORY_PAGE_SIZE = 50;
export const DICTATION_HISTORY_PREVIEW_CHARS = 240;

/** The slice of better-sqlite3 (Electron) and bun:sqlite (tests) this store uses. */
export interface HistoryDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number | bigint };
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

type Row = {
  id: number; created_at: string; text: string; raw_text: string | null;
  provider: TranscriptionProviderId; model: string | null; delivery: DictationDelivery; truncated?: number;
};

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS dictation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    text TEXT NOT NULL,
    raw_text TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    delivery TEXT NOT NULL
  );
`;

/**
 * Finished Dictations only, kept apart from the Agent audit. Holds text and metadata, never audio.
 * Retention is read on every write and list, so expiry and Off take effect without a restart.
 */
export class DictationHistory {
  constructor(private readonly db: HistoryDatabase, private readonly retentionDays: () => number) {
    db.exec(SCHEMA);
    this.prune();
  }

  /** Returns the new entry's id, or null when History is off. */
  record(entry: Omit<DictationHistoryEntry, 'id'>): number | null {
    if (this.retentionDays() <= 0) return null;
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO dictation_history (created_at, text, raw_text, provider, model, delivery) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(entry.createdAt, entry.text, entry.rawText, entry.provider, entry.model, entry.delivery);
    this.prune();
    return Number(lastInsertRowid);
  }

  setDelivery(id: number, delivery: DictationDelivery): void {
    this.db.prepare('UPDATE dictation_history SET delivery = ? WHERE id = ?').run(delivery, id);
  }

  /** Deletes rows past retention (all of them when off) and beyond the row cap. */
  prune(): void {
    if (this.retentionDays() <= 0) return this.clear();
    const cutoff = new Date(Date.now() - this.retentionDays() * 86_400_000).toISOString();
    this.db.prepare(`
      DELETE FROM dictation_history WHERE created_at < ?
        OR id NOT IN (SELECT id FROM dictation_history ORDER BY id DESC LIMIT ?)
    `).run(cutoff, DICTATION_HISTORY_MAX_ENTRIES);
  }

  /** Newest first. Matches final or raw text, ignoring ASCII case. */
  list(query: string, beforeId: number | null): DictationHistoryPage {
    this.prune();
    const pattern = `%${query.trim().slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`;
    const rows = this.db.prepare(`
      SELECT id, created_at, substr(text, 1, ?) AS text, length(text) > ? AS truncated, provider, model, delivery
      FROM dictation_history
      WHERE id < ? AND (text LIKE ? ESCAPE '\\' OR raw_text LIKE ? ESCAPE '\\')
      ORDER BY id DESC LIMIT ?
    `).all(
      DICTATION_HISTORY_PREVIEW_CHARS, DICTATION_HISTORY_PREVIEW_CHARS,
      beforeId ?? Number.MAX_SAFE_INTEGER, pattern, pattern, DICTATION_HISTORY_PAGE_SIZE + 1,
    ) as Row[];
    return {
      entries: rows.slice(0, DICTATION_HISTORY_PAGE_SIZE).map((row): DictationHistoryRow => ({
        id: row.id, createdAt: row.created_at, text: row.text, provider: row.provider,
        model: row.model, delivery: row.delivery, truncated: Boolean(row.truncated),
      })),
      hasMore: rows.length > DICTATION_HISTORY_PAGE_SIZE,
    };
  }

  get(id: number): DictationHistoryEntry | null {
    this.prune();
    const row = this.db.prepare('SELECT * FROM dictation_history WHERE id = ?').get(id) as Row | null | undefined;
    return row ? {
      id: row.id, createdAt: row.created_at, text: row.text, rawText: row.raw_text,
      provider: row.provider, model: row.model, delivery: row.delivery,
    } : null;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM dictation_history WHERE id = ?').run(id);
  }

  clear(): void {
    this.db.prepare('DELETE FROM dictation_history').run();
  }
}

/** Opens the store in the profile directory; throws when SQLite cannot load. */
export function openDictationHistory(directory: string, retentionDays: () => number): DictationHistory {
  return new DictationHistory(new Database(join(directory, 'dictation-history.sqlite')), retentionDays);
}

/** Only a target change or fully blocked input proves nothing was sent; other failures may follow the paste. */
export function deliveryOf(result: InjectResult): DictationDelivery {
  if (result.kind === 'input-dispatched') return 'dispatched';
  if (result.kind === 'target-changed') return 'failed';
  return result.kind === 'input-blocked' && result.acceptedEvents === 0 ? 'failed' : 'uncertain';
}

/** The speech model behind the active provider, for display; null where the provider has no model setting. */
export function transcriptionModel(config: AppConfig): string | null {
  const { providers } = config.transcription;
  const models: Record<TranscriptionProviderId, string | null> = {
    'managed-local': config.managedLocal.model,
    'local-whisper-cpp': null,
    openai: providers.openai.model,
    sarvam: providers.sarvam.model,
    'azure-speech': null,
    'google-cloud-speech-v2': providers.googleCloudSpeech.model,
    'nvidia-speech-nim': providers.nvidiaSpeechNim.model,
    'custom-open-ai-compatible': providers.customOpenAiCompatible.model,
    'whisper-live-kit': null,
  };
  return models[config.transcription.activeProvider]?.trim() || null;
}
