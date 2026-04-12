import { useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { C } from '@/constants/theme';
import { useSessionsContext, type SessionEntry } from '@/context/sessions-context';
import { EllipsisMenu } from '@/components/EllipsisMenu';
import { useRecordingsContext } from '@/context/recordings-context';
import { useAIQueue } from '@/context/ai-queue-context';
import { IconSymbol } from '@/components/ui/icon-symbol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateLabel(ms: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const timeStr = new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
  if (ms >= todayMs)                      return `Today · ${timeStr}`;
  if (ms >= todayMs - 86_400_000)         return `Yesterday · ${timeStr}`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  }) + ` · ${timeStr}`;
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
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CountChip({ label }: { label: string }) {
  return (
    <View style={chipStyles.chip}>
      <Text style={chipStyles.text}>{label}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    paddingHorizontal: 10,
    paddingVertical:    3,
    borderRadius:      12,
    backgroundColor:   C.tint,
  },
  text: {
    fontSize:   12,
    color:      C.text,
    fontWeight: '600',
  },
});

// ---------------------------------------------------------------------------
// SessionCard
// ---------------------------------------------------------------------------

type CardProps = {
  session:        SessionEntry;
  durationMs:     number;
  recordingCount: number;
  isAnalyzing:    boolean;
  onPress:        () => void;
  onLongPress:    () => void;
  onShare:        () => void;
  onAnalyze:      (() => void) | null;  // null when analysis already exists or unavailable
};

function SessionCard({ session, durationMs, recordingCount, isAnalyzing, onPress, onLongPress, onShare, onAnalyze }: CardProps) {
  const keyPoints = parseJsonArray(session.key_points);
  const actions   = parseJsonArray(session.actions);
  const hasAI     = session.title !== null;

  // Show the first key point as preview text, if available
  const preview = keyPoints[0] ?? null;

  return (
    <Pressable style={cardStyles.card} onPress={onPress} onLongPress={onLongPress}>
      {/* Top row: title + duration */}
      <View style={cardStyles.topRow}>
        <Text style={cardStyles.title} numberOfLines={1}>
          {session.title ?? formatDateLabel(session.started_at)}
        </Text>
        <Text style={cardStyles.duration}>{formatDuration(durationMs)}</Text>
      </View>

      {/* Date sub-label — only shown when AI title is present */}
      {hasAI && (
        <Text style={cardStyles.dateLabel}>
          {formatDateLabel(session.started_at)}
        </Text>
      )}

      {/* Analyzing indicator */}
      {isAnalyzing && !hasAI && (
        <Text style={cardStyles.processingLabel}>Processing…</Text>
      )}

      {/* Preview text */}
      {preview && (
        <Text style={cardStyles.preview} numberOfLines={2}>
          {preview}
        </Text>
      )}

      {/* Bottom row: count chips + action icons */}
      <View style={cardStyles.bottomRow}>
        <View style={cardStyles.chips}>
          {keyPoints.length > 0 && (
            <CountChip
              label={`${keyPoints.length} key point${keyPoints.length !== 1 ? 's' : ''}`}
            />
          )}
          {actions.length > 0 && (
            <CountChip
              label={`${actions.length} action${actions.length !== 1 ? 's' : ''}`}
            />
          )}
          {!hasAI && recordingCount > 0 && (
            <CountChip
              label={`${recordingCount} thought${recordingCount !== 1 ? 's' : ''}`}
            />
          )}
        </View>

        <View style={cardStyles.actionRow}>
          <Pressable onPress={onPress} hitSlop={10} style={cardStyles.actionBtn}>
            <IconSymbol name="play.fill" size={14} color={C.textSecondary} />
          </Pressable>
          <Pressable onPress={onShare} hitSlop={10} style={cardStyles.actionBtn}>
            <IconSymbol name="square.and.arrow.up" size={14} color={C.textSecondary} />
          </Pressable>
          <Pressable
            onPress={onAnalyze ?? onPress}
            hitSlop={10}
            style={cardStyles.actionBtn}
            disabled={isAnalyzing}
          >
            <IconSymbol
              name="sparkles"
              size={14}
              color={onAnalyze && !isAnalyzing ? C.tint : C.textSecondary}
            />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
  },
  topRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    gap:             8,
    marginBottom:    2,
  },
  title: {
    flex:       1,
    fontSize:   16,
    fontWeight: '600',
    color:      C.text,
  },
  duration: {
    fontSize:   13,
    color:      C.textSecondary,
    fontWeight: '400',
    flexShrink: 0,
  },
  dateLabel: {
    fontSize:    13,
    color:       C.textSecondary,
    marginBottom: 8,
  },
  processingLabel: {
    fontSize:    12,
    color:       C.textTertiary,
    marginTop:    4,
    marginBottom: 6,
    fontStyle:   'italic',
  },
  preview: {
    fontSize:    14,
    color:       C.textSecondary,
    lineHeight:  20,
    marginTop:    4,
    marginBottom: 12,
  },
  bottomRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginTop:       8,
  },
  chips: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            6,
    flex:           1,
  },
  actionRow: {
    flexDirection: 'row',
    gap:            12,
    marginLeft:     8,
  },
  actionBtn: {
    padding: 4,
  },
});

// ---------------------------------------------------------------------------
// LogsScreen
// ---------------------------------------------------------------------------

export default function LogsScreen() {
  const router                      = useRouter();
  const { sessions, deleteSession } = useSessionsContext();
  const { recordings }              = useRecordingsContext();
  const { analyzingSessionId, enqueueAnalysis } = useAIQueue();

  const [selectedTag, setSelectedTag]   = useState<string | null>(null);
  const [searchQuery, setSearchQuery]   = useState('');

  function sessionRecs(session: SessionEntry) {
    return recordings.filter(r => {
      const t = new Date(r.date).getTime();
      return t >= session.started_at && t <= session.ended_at + 60_000;
    });
  }

  function sessionTags(session: SessionEntry): string[] {
    const all = sessionRecs(session)
      .flatMap(r => (r.tags ? r.tags.split(',') : []))
      .filter(Boolean);
    return [...new Set(all)];
  }

  const allTags = [...new Set(sessions.flatMap(s => sessionTags(s)))].sort();

  const tagFiltered = selectedTag
    ? sessions.filter(s => sessionTags(s).includes(selectedTag))
    : sessions;

  const displayed = searchQuery.trim()
    ? tagFiltered.filter(session => {
        const q = searchQuery.toLowerCase();
        if (session.title?.toLowerCase().includes(q)) return true;
        return sessionRecs(session).some(r => r.transcript?.toLowerCase().includes(q));
      })
    : tagFiltered;

  function handleShare(session: SessionEntry) {
    const recs = sessionRecs(session);
    const keyPoints = parseJsonArray(session.key_points);
    const actions   = parseJsonArray(session.actions);
    const durationMs = session.ended_at - session.started_at;

    const lines: string[] = [];
    lines.push(session.title ?? formatDateLabel(session.started_at));

    const meta: string[] = [];
    if (durationMs > 0) meta.push(formatDuration(durationMs));
    if (session.steps > 0) meta.push(`${session.steps.toLocaleString()} steps`);
    if (recs.length > 0) meta.push(`${recs.length} thought${recs.length !== 1 ? 's' : ''}`);
    if (meta.length > 0) lines.push(meta.join(' · '));

    if (keyPoints.length > 0) {
      lines.push('', 'KEY POINTS');
      keyPoints.forEach(p => lines.push(`• ${p}`));
    }
    if (actions.length > 0) {
      lines.push('', 'ACTIONS');
      actions.forEach(a => lines.push(`☐ ${a}`));
    }

    const transcripts = recs
      .filter(r => r.transcript?.trim())
      .map((r, i) => `[${i + 1}] ${r.transcript!.trim()}`);
    if (transcripts.length > 0) {
      lines.push('', 'THOUGHTS');
      transcripts.forEach(t => lines.push(t));
    }

    Share.share({ message: lines.join('\n').trim() });
  }

  function handleAnalyze(session: SessionEntry) {
    const transcripts = sessionRecs(session)
      .map(r => r.transcript)
      .filter((t): t is string => !!t?.trim());
    if (transcripts.length > 0) enqueueAnalysis(session.id, transcripts);
  }

  function confirmDeleteSession(session: SessionEntry) {
    Alert.alert(
      'Delete walk?',
      'Removes this walk and its AI summary. Recorded thoughts are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteSession(session.id) },
      ]
    );
  }

  function openSession(session: SessionEntry) {
    // Find recordings that fall within this session's time window
    const sessionRecordings = recordings.filter(r => {
      const t = new Date(r.date).getTime();
      return t >= session.started_at && t <= session.ended_at + 60_000;
    });
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt:    session.started_at.toString(),
        endedAt:      session.ended_at.toString(),
        steps:        session.steps.toString(),
        recordingIds: sessionRecordings.map(r => r.id).join(','),
      },
    });
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>logs</Text>
        <EllipsisMenu />
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <IconSymbol name="magnifyingglass" size={14} color={C.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="search thoughts…"
          placeholderTextColor={C.textTertiary}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {/* Tag filter */}
      {allTags.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tagFilterRow}
          contentContainerStyle={styles.tagFilterContent}
        >
          {allTags.map(tag => (
            <Pressable
              key={tag}
              onPress={() => setSelectedTag(selectedTag === tag ? null : tag)}
              style={[styles.tagPill, selectedTag === tag && styles.tagPillActive]}
            >
              <Text style={[styles.tagPillText, selectedTag === tag && styles.tagPillTextActive]}>
                {tag}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {displayed.length === 0 ? (
          <View style={styles.emptyState}>
            {sessions.length === 0 ? (
              <>
                <Text style={styles.emptyText}>No walks yet.</Text>
                <Text style={styles.emptySubtext}>
                  Complete a walk to see your AI-generated logs here.
                </Text>
              </>
            ) : searchQuery.trim() ? (
              <Text style={styles.emptyText}>No results for "{searchQuery}".</Text>
            ) : (
              <Text style={styles.emptyText}>No "{selectedTag}" walks.</Text>
            )}
          </View>
        ) : (
          displayed.map(session => {
            const recs        = sessionRecs(session);
            const isAnalyzing = analyzingSessionId === session.id;
            const hasAI       = session.title !== null;
            const hasTranscripts = recs.some(r => r.transcript?.trim());
            const canAnalyze  = !hasAI && !isAnalyzing && hasTranscripts;
            return (
              <SessionCard
                key={session.id}
                session={session}
                durationMs={session.ended_at - session.started_at}
                recordingCount={recs.length}
                isAnalyzing={isAnalyzing}
                onPress={() => openSession(session)}
                onLongPress={() => confirmDeleteSession(session)}
                onShare={() => handleShare(session)}
                onAnalyze={canAnalyze ? () => handleAnalyze(session) : null}
              />
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safe: {
    flex:            1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    paddingHorizontal: 24,
    paddingTop:        16,
    paddingBottom:     8,
  },
  title: {
    fontSize:      32,
    fontWeight:    '700',
    color:         C.text,
    letterSpacing: -0.5,
  },
  // ── Search ───────────────────────────────────────────────────────────────
  searchRow: {
    flexDirection:     'row',
    alignItems:        'center',
    marginHorizontal:  24,
    marginBottom:      10,
    backgroundColor:   C.surface,
    borderRadius:      12,
    paddingHorizontal: 12,
    paddingVertical:    9,
    gap:                8,
  },
  searchInput: {
    flex:     1,
    fontSize: 14,
    color:    C.text,
  },

  // ── Tag filter ───────────────────────────────────────────────────────────
  tagFilterRow: {
    marginBottom: 8,
  },
  tagFilterContent: {
    paddingHorizontal: 24,
    gap:                6,
  },
  tagPill: {
    paddingHorizontal: 12,
    paddingVertical:    5,
    borderRadius:      20,
    backgroundColor:   C.surface,
    borderWidth:       1,
    borderColor:       C.border,
  },
  tagPillActive: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  tagPillText: {
    fontSize:   12,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  tagPillTextActive: {
    color: C.text,
  },

  scrollContent: {
    paddingHorizontal: 24,
    paddingTop:        8,
    paddingBottom:     32,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop:  80,
    gap:          8,
  },
  emptyText: {
    fontSize:   17,
    fontWeight: '600',
    color:      C.textSecondary,
  },
  emptySubtext: {
    fontSize:  14,
    color:     C.textTertiary,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
