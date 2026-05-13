import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { HERMES_HOME } from "./installer";
import { safeWriteFile } from "./utils";
import Database from "better-sqlite3";
import { t } from "../shared/i18n";
import { getAppLocale } from "./locale";
import { listSessions, type SessionSummary } from "./sessions";

const CACHE_DIR = join(HERMES_HOME, "desktop");
const CACHE_FILE = join(CACHE_DIR, "sessions.json");
const DB_PATH = join(HERMES_HOME, "state.db");
const STARTUP_SYNC_FRESHNESS_SECONDS = 120;

export interface CachedSession {
  id: string;
  title: string;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
}

interface CacheData {
  sessions: CachedSession[];
  lastSync: number;
  lastChecked: number;
}

let cacheDirty = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSession(value: unknown): CachedSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;

  const startedAt =
    typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
      ? value.startedAt
      : 0;
  const messageCount =
    typeof value.messageCount === "number" &&
    Number.isFinite(value.messageCount)
      ? value.messageCount
      : 0;

  return {
    id: value.id,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title
        : t("sessions.newConversation", getAppLocale()),
    startedAt,
    source: typeof value.source === "string" ? value.source : "",
    messageCount,
    model: typeof value.model === "string" ? value.model : "",
  };
}

function normalizeCache(raw: unknown): CacheData {
  if (!isRecord(raw)) return { sessions: [], lastSync: 0, lastChecked: 0 };

  const seen = new Set<string>();
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions
        .map(normalizeSession)
        .filter((s): s is CachedSession => {
          if (!s || seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        })
        .sort((a, b) => b.startedAt - a.startedAt)
    : [];

  const lastSync =
    typeof raw.lastSync === "number" && Number.isFinite(raw.lastSync)
      ? raw.lastSync
      : 0;
  const lastChecked =
    typeof raw.lastChecked === "number" && Number.isFinite(raw.lastChecked)
      ? raw.lastChecked
      : lastSync;

  return {
    sessions,
    // An empty cache must behave like a first sync. Otherwise a bad cache file
    // with a future lastSync can permanently hide real saved sessions.
    lastSync: sessions.length > 0 ? Math.max(0, lastSync) : 0,
    lastChecked: sessions.length > 0 ? Math.max(0, lastChecked) : 0,
  };
}

function getSyncLimit(limit?: number): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), 1000)
    : null;
}

function shouldUseFreshStartupCache(
  cache: CacheData,
  limit: number | undefined,
  now: number,
): boolean {
  return (
    getSyncLimit(limit) !== null &&
    !cacheDirty &&
    cache.sessions.length > 0 &&
    cache.lastChecked > 0 &&
    now - cache.lastChecked < STARTUP_SYNC_FRESHNESS_SECONDS
  );
}

function mergeSessions(
  primary: CachedSession[],
  existing: CachedSession[],
): CachedSession[] {
  const merged = new Map<string, CachedSession>();
  for (const session of [...primary, ...existing]) {
    if (!merged.has(session.id)) merged.set(session.id, session);
  }
  return Array.from(merged.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function fallbackTitle(title: string | null | undefined): string {
  return title && title.trim()
    ? title
    : t("sessions.newConversation", getAppLocale());
}

function listSessionRowsOnly(
  db: Database.Database,
  limit?: number,
): CachedSession[] {
  const syncLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 1000)
      : null;

  const rows = db
    .prepare(
      `SELECT s.id, s.started_at, s.source, s.message_count, s.model, s.title
       FROM sessions s
       ORDER BY s.started_at DESC
       ${syncLimit !== null ? "LIMIT ?" : ""}`,
    )
    .all(...(syncLimit !== null ? [syncLimit] : [])) as Array<{
    id: string;
    started_at: number;
    source: string;
    message_count: number;
    model: string;
    title: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: fallbackTitle(row.title),
    startedAt: row.started_at,
    source: row.source,
    messageCount: row.message_count,
    model: row.model || "",
  }));
}

function cacheFromSummaries(summaries: SessionSummary[]): CachedSession[] {
  return summaries.map((session) => ({
    id: session.id,
    title: fallbackTitle(session.title),
    startedAt: session.startedAt,
    source: session.source,
    messageCount: session.messageCount,
    model: session.model || "",
  }));
}

// Generate a short, readable title from the first user message (like ChatGPT/Claude)
function generateTitle(message: string): string {
  if (!message || !message.trim())
    return t("sessions.newConversation", getAppLocale());

  // Clean up the message
  let text = message.trim();

  // Remove markdown formatting
  text = text.replace(/[#*_`~[\]()]/g, "");
  // Remove URLs
  text = text.replace(/https?:\/\/\S+/g, "");
  // Remove extra whitespace
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return t("sessions.newConversation", getAppLocale());

  // If short enough, use as-is
  if (text.length <= 50) return text;

  // Take first meaningful chunk — aim for ~40-50 chars at word boundary
  const words = text.split(" ");
  let title = "";
  for (const word of words) {
    if ((title + " " + word).trim().length > 45) break;
    title = (title + " " + word).trim();
  }

  return title || text.slice(0, 45) + "...";
}

function readCache(): CacheData {
  try {
    if (!existsSync(CACHE_FILE)) {
      return { sessions: [], lastSync: 0, lastChecked: 0 };
    }
    return normalizeCache(JSON.parse(readFileSync(CACHE_FILE, "utf-8")));
  } catch {
    return { sessions: [], lastSync: 0, lastChecked: 0 };
  }
}

function writeCache(data: CacheData): void {
  try {
    safeWriteFile(CACHE_FILE, JSON.stringify(data));
  } catch {
    // non-fatal
  }
}

export function markSessionCacheDirty(): void {
  cacheDirty = true;
}

function getDb(): Database.Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new Database(DB_PATH, {
      readonly: true,
      fileMustExist: true,
      timeout: 1000,
    });
  } catch {
    return null;
  }
}

// Sync from hermes DB to local cache — only fetches new/updated sessions
export function syncSessionCache(limit?: number): CachedSession[] {
  const cache = readCache();
  const now = Math.floor(Date.now() / 1000);
  if (shouldUseFreshStartupCache(cache, limit, now)) {
    return cache.sessions;
  }

  const syncLimit = getSyncLimit(limit);
  const db = getDb();
  if (!db) {
    const fallbackLimit = syncLimit ?? 1000;
    const fallbackSessions = cacheFromSummaries(listSessions(fallbackLimit, 0));
    if (fallbackSessions.length === 0) {
      if (cache.sessions.length > 0) {
        const updated = { ...cache, lastChecked: now };
        writeCache(updated);
      }
      cacheDirty = false;
      return cache.sessions;
    }
    const updated: CacheData = {
      sessions: mergeSessions(fallbackSessions, cache.sessions),
      lastSync:
        syncLimit !== null && fallbackSessions.length >= syncLimit
          ? cache.lastSync
          : now,
      lastChecked: now,
    };
    writeCache(updated);
    cacheDirty = false;
    return updated.sessions;
  }

  try {
    const params: number[] = [cache.lastSync > 0 ? cache.lastSync - 300 : 0];
    if (syncLimit !== null) params.push(syncLimit);

    // Fetch sessions newer than last sync, or all if first sync
    const rows = db
      .prepare(
        `SELECT s.id, s.started_at, s.source, s.message_count, s.model, s.title
         FROM sessions s
         WHERE s.started_at > ?
         ORDER BY s.started_at DESC
         ${syncLimit !== null ? "LIMIT ?" : ""}`,
      )
      .all(...params) as Array<{
      id: string;
      started_at: number;
      source: string;
      message_count: number;
      model: string;
      title: string | null;
    }>;

    // Index existing sessions by id once so the per-row update below is
    // O(1) instead of O(N). Without this, syncing N existing sessions
    // against N new rows is O(N²) and visibly slows app startup once a
    // user has accumulated thousands of sessions (issue #16).
    const existingById = new Map<string, CachedSession>();
    for (const s of cache.sessions) existingById.set(s.id, s);
    const rowsNeedingTitles = rows
      .filter((row) => !existingById.has(row.id) && !row.title)
      .map((row) => row.id);
    const firstMessagesBySession = new Map<string, string>();

    for (let i = 0; i < rowsNeedingTitles.length; i += 900) {
      const chunk = rowsNeedingTitles.slice(i, i + 900);
      const placeholders = chunk.map(() => "?").join(", ");
      const messageRows = db
        .prepare(
          `SELECT session_id, content
           FROM (
             SELECT session_id, content,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_id
                      ORDER BY timestamp, id
                    ) AS rn
             FROM messages
             WHERE session_id IN (${placeholders})
               AND role = 'user'
               AND content IS NOT NULL
           )
           WHERE rn = 1`,
        )
        .all(...chunk) as Array<{ session_id: string; content: string }>;

      for (const msg of messageRows) {
        firstMessagesBySession.set(msg.session_id, msg.content);
      }
    }

    const newSessions: CachedSession[] = [];

    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing) {
        // Update existing entry (message count may have changed)
        existing.messageCount = row.message_count;
        continue;
      }

      // Generate title from first user message
      let title = row.title || "";
      if (!title) {
        const firstMessage = firstMessagesBySession.get(row.id);
        title = firstMessage
          ? generateTitle(firstMessage)
          : t("sessions.newConversation", getAppLocale());
      }

      newSessions.push({
        id: row.id,
        title,
        startedAt: row.started_at,
        source: row.source,
        messageCount: row.message_count,
        model: row.model || "",
      });
    }

    // Merge: new sessions first (most recent), then existing
    const allSessions = mergeSessions(newSessions, cache.sessions);

    const updated: CacheData = {
      sessions: allSessions,
      // A capped sync is used by the Sessions tab for fast startup. If the
      // query filled the cap, keep lastSync unchanged so a later full sync can
      // still ingest older history instead of treating the partial window as
      // complete.
      lastSync:
        syncLimit !== null && rows.length >= syncLimit ? cache.lastSync : now,
      lastChecked: now,
    };
    writeCache(updated);
    cacheDirty = false;
    return updated.sessions;
  } catch {
    try {
      const fallbackSessions = listSessionRowsOnly(db, limit);
      if (fallbackSessions.length > 0) {
        const updated: CacheData = {
          sessions: mergeSessions(fallbackSessions, cache.sessions),
          lastSync:
            syncLimit !== null && fallbackSessions.length >= syncLimit
              ? cache.lastSync
              : now,
          lastChecked: now,
        };
        writeCache(updated);
        cacheDirty = false;
        return updated.sessions;
      }
      if (cache.sessions.length > 0) {
        const updated = { ...cache, lastChecked: now };
        writeCache(updated);
        cacheDirty = false;
      }
    } catch {
      // keep the original fallback below
    }
    return cache.sessions;
  } finally {
    db.close();
  }
}

// Fast read from cache only (no DB access)
export function listCachedSessions(limit = 50, offset = 0): CachedSession[] {
  const cache = readCache();
  return cache.sessions.slice(offset, offset + limit);
}

// Update title for a specific session
export function updateSessionTitle(sessionId: string, title: string): void {
  const cache = readCache();
  const idx = cache.sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) {
    cache.sessions[idx].title = title;
    writeCache(cache);
  }
}
