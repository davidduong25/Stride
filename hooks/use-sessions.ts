import { useEffect, useRef, useState } from 'react';
import * as SQLite from 'expo-sqlite';
import * as Sentry from '@sentry/react-native';

const DB_NAME = 'momentum.db';

export type SessionEntry = {
  id: string;              // startedAt ms as string — matches sessionId used throughout
  started_at: number;      // unix ms
  ended_at: number;        // unix ms
  steps: number;
  title: string | null;    // AI-generated, null until analysis runs
  key_points: string | null; // JSON string of string[]
  actions: string | null;    // JSON string of string[]
  walk_type: string | null;  // confirmed WalkType, set when user triggers analysis
  summary: string | null;    // prose summary for vent/reflect/appreciate/untangle types
  recording_ids: string | null; // comma-separated recording IDs captured at session end
};

type SessionPatch = Partial<Pick<SessionEntry, 'title' | 'key_points' | 'actions' | 'walk_type' | 'summary'>>;

export function useSessions() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const dbRef = useRef<SQLite.SQLiteDatabase | null>(null);

  useEffect(() => {
    async function init() {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS sessions (
          id         TEXT    PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at   INTEGER NOT NULL,
          steps      INTEGER NOT NULL DEFAULT 0,
          title      TEXT,
          key_points TEXT,
          actions    TEXT
        );
      `);

      const sessionMigrations = [
        'ALTER TABLE sessions ADD COLUMN walk_type TEXT',
        'ALTER TABLE sessions ADD COLUMN summary TEXT',
        'ALTER TABLE sessions ADD COLUMN recording_ids TEXT',
      ];
      for (const sql of sessionMigrations) {
        try { await db.execAsync(sql); } catch { /* column already exists */ }
      }
      dbRef.current = db;
      const rows = await db.getAllAsync<SessionEntry>(
        'SELECT * FROM sessions ORDER BY started_at DESC'
      );
      setSessions(rows);
    }
    init();
    return () => {
      dbRef.current?.closeAsync();
      dbRef.current = null;
    };
  }, []);

  async function addSession(
    entry: Pick<SessionEntry, 'id' | 'started_at' | 'ended_at' | 'steps' | 'recording_ids'>
  ): Promise<void> {
    if (!dbRef.current) return;
    const newEntry: SessionEntry = { ...entry, title: null, key_points: null, actions: null, walk_type: null, summary: null };
    try {
      await dbRef.current.runAsync(
        `INSERT OR REPLACE INTO sessions
          (id, started_at, ended_at, steps, title, key_points, actions, walk_type, summary, recording_ids)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        [newEntry.id, newEntry.started_at, newEntry.ended_at, newEntry.steps, newEntry.recording_ids ?? null]
      );
    } catch (e) {
      Sentry.captureException(e, { extra: { fn: 'addSession' } });
      throw e;
    }
    setSessions(prev => [newEntry, ...prev.filter(s => s.id !== newEntry.id)]);
  }

  async function updateSession(id: string, patch: SessionPatch): Promise<void> {
    if (!dbRef.current) return;
    const fields = Object.keys(patch) as Array<keyof SessionPatch>;
    if (fields.length === 0) return;
    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f] ?? null);
    try {
      await dbRef.current.runAsync(
        `UPDATE sessions SET ${setClauses} WHERE id = ?`,
        [...values, id]
      );
    } catch (e) {
      Sentry.captureException(e, { extra: { fn: 'updateSession', id } });
      throw e;
    }
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }

  async function deleteSession(id: string): Promise<void> {
    if (!dbRef.current) return;
    try {
      await dbRef.current.runAsync('DELETE FROM sessions WHERE id = ?', [id]);
    } catch (e) {
      Sentry.captureException(e, { extra: { fn: 'deleteSession', id } });
      throw e;
    }
    setSessions(prev => prev.filter(s => s.id !== id));
  }

  async function clearAllSessions(): Promise<void> {
    if (!dbRef.current) return;
    try {
      await dbRef.current.runAsync('DELETE FROM sessions');
    } catch (e) {
      Sentry.captureException(e, { extra: { fn: 'clearAllSessions' } });
      throw e;
    }
    setSessions([]);
  }

  return { sessions, addSession, updateSession, deleteSession, clearAllSessions };
}
