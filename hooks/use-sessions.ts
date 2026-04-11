import { useEffect, useRef, useState } from 'react';
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'momentum.db';

export type SessionEntry = {
  id: string;              // startedAt ms as string — matches sessionId used throughout
  started_at: number;      // unix ms
  ended_at: number;        // unix ms
  steps: number;
  title: string | null;    // AI-generated, null until mega-prompt runs
  key_points: string | null; // JSON string of string[]
  actions: string | null;    // JSON string of string[]
};

type SessionPatch = Partial<Pick<SessionEntry, 'title' | 'key_points' | 'actions'>>;

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
    entry: Pick<SessionEntry, 'id' | 'started_at' | 'ended_at' | 'steps'>
  ): Promise<void> {
    if (!dbRef.current) return;
    const newEntry: SessionEntry = { ...entry, title: null, key_points: null, actions: null };
    await dbRef.current.runAsync(
      `INSERT OR REPLACE INTO sessions
        (id, started_at, ended_at, steps, title, key_points, actions)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      [newEntry.id, newEntry.started_at, newEntry.ended_at, newEntry.steps]
    );
    setSessions(prev => [newEntry, ...prev.filter(s => s.id !== newEntry.id)]);
  }

  async function updateSession(id: string, patch: SessionPatch): Promise<void> {
    if (!dbRef.current) return;
    const fields = Object.keys(patch) as Array<keyof SessionPatch>;
    if (fields.length === 0) return;
    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f] ?? null);
    await dbRef.current.runAsync(
      `UPDATE sessions SET ${setClauses} WHERE id = ?`,
      [...values, id]
    );
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }

  return { sessions, addSession, updateSession };
}
