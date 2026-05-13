import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { HERMES_HOME, HERMES_PYTHON } from "./installer";

const DB_PATH = join(HERMES_HOME, "state.db");

export interface SessionSummary {
  id: string;
  source: string;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  model: string;
  title: string | null;
  preview: string;
}

export interface SessionMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
}

export interface SearchResult {
  sessionId: string;
  title: string | null;
  startedAt: number;
  source: string;
  messageCount: number;
  model: string;
  snippet: string;
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

function runSqliteFallback<T>(
  operation: "list" | "search" | "messages",
  payload: Record<string, unknown>,
): T | null {
  if (!existsSync(DB_PATH)) return null;

  const python = existsSync(HERMES_PYTHON)
    ? HERMES_PYTHON
    : process.platform === "win32"
      ? "python"
      : "python3";
  const script = String.raw`
import json
import sqlite3
import sys

db_path = sys.argv[1]
operation = sys.argv[2]
payload = json.loads(sys.argv[3])

con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
con.row_factory = sqlite3.Row

def as_float(value):
    return float(value) if value is not None else None

def as_int(value):
    return int(value) if value is not None else 0

try:
    if operation == "list":
        limit = max(1, min(int(payload.get("limit", 30)), 1000))
        offset = max(0, int(payload.get("offset", 0)))
        rows = con.execute(
            """
            SELECT id, source, started_at, ended_at, message_count, model, title
            FROM sessions
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
        result = [
            {
                "id": row["id"],
                "source": row["source"] or "",
                "startedAt": as_float(row["started_at"]),
                "endedAt": as_float(row["ended_at"]),
                "messageCount": as_int(row["message_count"]),
                "model": row["model"] or "",
                "title": row["title"],
                "preview": "",
            }
            for row in rows
        ]
    elif operation == "messages":
        session_id = str(payload.get("sessionId", ""))
        rows = con.execute(
            """
            SELECT id, role, content, timestamp
            FROM messages
            WHERE session_id = ?
              AND role IN ('user', 'assistant')
              AND content IS NOT NULL
            ORDER BY timestamp, id
            """,
            (session_id,),
        ).fetchall()
        result = [
            {
                "id": as_int(row["id"]),
                "role": row["role"],
                "content": row["content"] or "",
                "timestamp": as_float(row["timestamp"]),
            }
            for row in rows
        ]
    elif operation == "search":
        query = str(payload.get("query", "")).strip()
        limit = max(1, min(int(payload.get("limit", 20)), 100))
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
        ).fetchone()
        if not query or table is None:
            result = []
        else:
            sanitized = " ".join(
                f'"{word.replace(chr(34), "")}"*'
                for word in query.split()
                if word
            )
            if not sanitized:
                result = []
            else:
                rows = con.execute(
                    """
                    SELECT DISTINCT
                      m.session_id,
                      s.title,
                      s.started_at,
                      s.source,
                      s.message_count,
                      s.model,
                      snippet(messages_fts, 0, '<<', '>>', '...', 40) as snippet
                    FROM messages_fts
                    JOIN messages m ON m.id = messages_fts.rowid
                    JOIN sessions s ON s.id = m.session_id
                    WHERE messages_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (sanitized, limit),
                ).fetchall()
                result = [
                    {
                        "sessionId": row["session_id"],
                        "title": row["title"],
                        "startedAt": as_float(row["started_at"]),
                        "source": row["source"] or "",
                        "messageCount": as_int(row["message_count"]),
                        "model": row["model"] or "",
                        "snippet": row["snippet"] or "",
                    }
                    for row in rows
                ]
    else:
        result = []
    print(json.dumps(result))
finally:
    con.close()
`;

  try {
    const output = execFileSync(
      python,
      ["-c", script, DB_PATH, operation, JSON.stringify(payload)],
      {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function listSessionsFallback(limit = 30, offset = 0): SessionSummary[] {
  return runSqliteFallback<SessionSummary[]>("list", { limit, offset }) ?? [];
}

function searchSessionsFallback(query: string, limit = 20): SearchResult[] {
  return runSqliteFallback<SearchResult[]>("search", { query, limit }) ?? [];
}

function getSessionMessagesFallback(sessionId: string): SessionMessage[] {
  return runSqliteFallback<SessionMessage[]>("messages", { sessionId }) ?? [];
}

export function listSessions(limit = 30, offset = 0): SessionSummary[] {
  const db = getDb();
  if (!db) return listSessionsFallback(limit, offset);

  try {
    // Simple query without correlated subquery — titles come from session cache
    const rows = db
      .prepare(
        `SELECT
          s.id,
          s.source,
          s.started_at,
          s.ended_at,
          s.message_count,
          s.model,
          s.title
        FROM sessions s
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      id: string;
      source: string;
      started_at: number;
      ended_at: number | null;
      message_count: number;
      model: string;
      title: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      messageCount: r.message_count,
      model: r.model || "",
      title: r.title,
      preview: "",
    }));
  } catch {
    return listSessionsFallback(limit, offset);
  } finally {
    db.close();
  }
}

export function searchSessions(query: string, limit = 20): SearchResult[] {
  const db = getDb();
  if (!db) return searchSessionsFallback(query, limit);

  try {
    // Check if FTS table exists
    const tableCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
      )
      .get() as { name: string } | undefined;

    if (!tableCheck) return [];

    // Sanitize query for FTS5: wrap each word with quotes for safety, add * for prefix
    const sanitized = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, "")}"*`)
      .join(" ");

    if (!sanitized) return [];

    const rows = db
      .prepare(
        `SELECT DISTINCT
          m.session_id,
          s.title,
          s.started_at,
          s.source,
          s.message_count,
          s.model,
          snippet(messages_fts, 0, '<<', '>>', '...', 40) as snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{
      session_id: string;
      title: string | null;
      started_at: number;
      source: string;
      message_count: number;
      model: string;
      snippet: string;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title,
      startedAt: r.started_at,
      source: r.source,
      messageCount: r.message_count,
      model: r.model || "",
      snippet: r.snippet || "",
    }));
  } catch {
    return searchSessionsFallback(query, limit);
  } finally {
    db.close();
  }
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const db = getDb();
  if (!db) return getSessionMessagesFallback(sessionId);

  try {
    const rows = db
      .prepare(
        `SELECT id, role, content, timestamp
         FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
         ORDER BY timestamp, id`,
      )
      .all(sessionId) as Array<{
      id: number;
      role: string;
      content: string;
      timestamp: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      content: r.content,
      timestamp: r.timestamp,
    }));
  } catch {
    return getSessionMessagesFallback(sessionId);
  } finally {
    db.close();
  }
}
