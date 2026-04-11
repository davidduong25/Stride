import { useEffect, useRef, useState } from 'react';
import * as SQLite from 'expo-sqlite';
import { File } from 'expo-file-system';

const DB_NAME = 'momentum.db';

export type RecordingEntry = {
  id: string;
  filename: string;
  uri: string;
  duration: number;          // seconds
  date: string;              // ISO string
  transcript: string | null;
  tags: string | null;       // comma-separated, e.g. "idea,plan"
  steps: number | null;      // cumulative pedometer count at stop time
  waveform: string | null;   // JSON array of dB samples
  transcript_edited: number | null; // 1 if user has manually edited the transcript
};

type PatchFields = Partial<Pick<RecordingEntry,
  'duration' | 'filename' | 'transcript' | 'tags' | 'steps' | 'waveform' | 'transcript_edited'
>>;

export function useRecordings() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);
  const dbRef = useRef<SQLite.SQLiteDatabase | null>(null);

  useEffect(() => {
    async function init() {
      const db = await SQLite.openDatabaseAsync(DB_NAME);

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS recordings (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          uri TEXT NOT NULL,
          duration INTEGER NOT NULL,
          date TEXT NOT NULL
        );
      `);

      // Schema migrations — ALTER TABLE has no IF NOT EXISTS; catch duplicate-column errors
      const migrations = [
        'ALTER TABLE recordings ADD COLUMN transcript TEXT',
        'ALTER TABLE recordings ADD COLUMN tags TEXT',
        'ALTER TABLE recordings ADD COLUMN steps INTEGER',
        'ALTER TABLE recordings ADD COLUMN waveform TEXT',
        'ALTER TABLE recordings ADD COLUMN transcript_edited INTEGER',
      ];
      for (const sql of migrations) {
        try { await db.execAsync(sql); } catch { /* column already exists */ }
      }

      dbRef.current = db;
      const rows = await db.getAllAsync<RecordingEntry>(
        'SELECT * FROM recordings ORDER BY date DESC'
      );
      setRecordings(rows);
    }
    init();
    return () => {
      dbRef.current?.closeAsync();
      dbRef.current = null;
    };
  }, []);

  async function addRecording(entry: Omit<RecordingEntry, 'id' | 'date'>): Promise<string | undefined> {
    if (!dbRef.current) throw new Error('Database not ready — try again in a moment');
    const newEntry: RecordingEntry = {
      ...entry,
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      date: new Date().toISOString(),
    };
    await dbRef.current.runAsync(
      `INSERT INTO recordings
        (id, filename, uri, duration, date, transcript, tags, steps, waveform, transcript_edited)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newEntry.id, newEntry.filename, newEntry.uri,
        newEntry.duration, newEntry.date,
        newEntry.transcript ?? null, newEntry.tags ?? null,
        newEntry.steps ?? null, newEntry.waveform ?? null,
        newEntry.transcript_edited ?? null,
      ]
    );
    setRecordings(prev => [newEntry, ...prev]);
    return newEntry.id;
  }

  async function updateRecording(id: string, patch: PatchFields) {
    if (!dbRef.current) return;
    const fields = Object.keys(patch) as Array<keyof PatchFields>;
    if (fields.length === 0) return;
    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (patch[f] !== undefined ? patch[f] : null));
    await dbRef.current.runAsync(
      `UPDATE recordings SET ${setClauses} WHERE id = ?`,
      [...values, id]
    );
    setRecordings(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }

  async function deleteRecording(id: string) {
    if (!dbRef.current) return;
    const entry = recordings.find(r => r.id === id);
    await dbRef.current.runAsync('DELETE FROM recordings WHERE id = ?', [id]);
    setRecordings(prev => prev.filter(r => r.id !== id));
    if (entry) {
      try { new File(entry.uri).delete(); }
      catch (e) { console.warn('[momentum] Failed to delete recording file:', e); }
    }
  }

  return { recordings, addRecording, updateRecording, deleteRecording };
}
