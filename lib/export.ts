import type { SessionEntry } from '@/hooks/use-sessions';
import type { RecordingEntry } from '@/hooks/use-recordings';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function sessionRecs(session: SessionEntry, recordings: RecordingEntry[]): RecordingEntry[] {
  return recordings.filter(r => {
    const t = new Date(r.date).getTime();
    return t >= session.started_at && t <= session.ended_at + 60_000;
  });
}

export function buildMarkdownExport(sessions: SessionEntry[], recordings: RecordingEntry[]): string {
  const lines: string[] = [
    '# Stride Journal',
    `*Exported ${new Date().toLocaleDateString()}*`,
    '',
  ];

  for (const session of sessions) {
    const recs       = sessionRecs(session, recordings);
    const keyPoints  = parseJsonArray(session.key_points);
    const actions    = parseJsonArray(session.actions);
    const wt         = session.walk_type;
    const durationMs = session.ended_at - session.started_at;

    lines.push('---', '');
    lines.push(`## ${session.title ?? formatDate(session.started_at)}`);

    const meta: string[] = [];
    if (wt) meta.push(wt.charAt(0).toUpperCase() + wt.slice(1));
    meta.push(formatDate(session.started_at));
    if (durationMs > 0) meta.push(formatDuration(durationMs));
    if (session.steps > 0) meta.push(`${session.steps.toLocaleString()} steps`);
    if (meta.length) lines.push(`*${meta.join(' · ')}*`);
    lines.push('');

    if ((wt === 'vent' || wt === 'reflect') && session.summary) {
      lines.push(session.summary, '');
    }
    if (wt === 'untangle') {
      if (keyPoints.length) { keyPoints.forEach(p => lines.push(`- ${p}`)); lines.push(''); }
      if (session.summary) lines.push(`*Leaning toward: ${session.summary}*`, '');
    }
    if ((wt === 'brainstorm' || wt === 'appreciate') && keyPoints.length) {
      keyPoints.forEach(p => lines.push(`- ${p}`));
      lines.push('');
    }
    if (wt === 'plan' && actions.length) {
      actions.forEach(a => lines.push(`- [ ] ${a}`));
      lines.push('');
    }
    if (!wt) {
      if (keyPoints.length) { keyPoints.forEach(p => lines.push(`- ${p}`)); lines.push(''); }
      if (actions.length)   { actions.forEach(a => lines.push(`- [ ] ${a}`)); lines.push(''); }
    }

    const transcripts = recs.filter(r => r.transcript?.trim());
    if (transcripts.length) {
      lines.push('**Thoughts**', '');
      transcripts.forEach((r, i) => lines.push(`> [${i + 1}] ${r.transcript!.trim()}`, ''));
    }
  }

  return lines.join('\n').trim();
}
