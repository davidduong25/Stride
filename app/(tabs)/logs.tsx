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
import { useAIQueue, type WalkType, VALID_WALK_TYPES, WALK_TYPE_LABELS } from '@/context/ai-queue-context';
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
  if (ms >= todayMs)              return `Today · ${timeStr}`;
  if (ms >= todayMs - 86_400_000) return `Yesterday · ${timeStr}`;
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

function sessionWalkType(
  session: SessionEntry,
  recordings: ReturnType<typeof useRecordingsContext>['recordings']
): WalkType | null {
  if (session.walk_type && (VALID_WALK_TYPES as readonly string[]).includes(session.walk_type)) {
    return session.walk_type as WalkType;
  }
  const tags = recordings
    .filter(r => {
      const t = new Date(r.date).getTime();
      return t >= session.started_at && t <= session.ended_at + 60_000;
    })
    .map(r => r.tags)
    .filter((t): t is string => t !== null && (VALID_WALK_TYPES as readonly string[]).includes(t));
  if (tags.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
  return tags.reduce((a, b) => counts[a] >= counts[b] ? a : b) as WalkType;
}

type SortOption = 'recent' | 'longest';

// ---------------------------------------------------------------------------
// SessionCard
// ---------------------------------------------------------------------------

type CardProps = {
  session:        SessionEntry;
  durationMs:     number;
  recordingCount: number;
  walkType:       WalkType | null;
  isAnalyzing:    boolean;
  hasPendingSummary: boolean;
  onPress:        () => void;
  onLongPress:    () => void;
  onShare:        () => void;
};

function SessionCard({
  session,
  durationMs,
  recordingCount,
  walkType,
  isAnalyzing,
  hasPendingSummary,
  onPress,
  onLongPress,
  onShare,
}: CardProps) {
  const keyPoints = parseJsonArray(session.key_points);
  const hasAI     = session.title !== null;
  const preview   = keyPoints[0] ?? null;

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

      {isAnalyzing && !hasAI && (
        <Text style={cardStyles.processingLabel}>Processing…</Text>
      )}

      {preview && (
        <Text style={cardStyles.preview} numberOfLines={2}>
          {preview}
        </Text>
      )}

      {/* Bottom row: walk type badge + action icons */}
      <View style={cardStyles.bottomRow}>
        <View style={cardStyles.chips}>
          {walkType && (
            <View style={cardStyles.walkTypeBadge}>
              <Text style={cardStyles.walkTypeBadgeText}>
                {WALK_TYPE_LABELS[walkType]}
              </Text>
            </View>
          )}
          {!hasAI && recordingCount > 0 && !walkType && (
            <View style={[cardStyles.walkTypeBadge, cardStyles.walkTypeBadgeMuted]}>
              <Text style={[cardStyles.walkTypeBadgeText, cardStyles.walkTypeBadgeTextMuted]}>
                {recordingCount} thought{recordingCount !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>

        <View style={cardStyles.actionRow}>
          <Pressable onPress={onPress} hitSlop={10} style={cardStyles.actionBtn}>
            <IconSymbol name="play.fill" size={14} color={C.textSecondary} />
          </Pressable>
          <Pressable onPress={onShare} hitSlop={10} style={[cardStyles.actionBtn, {marginTop: 2 }]}>
            <IconSymbol name="square.and.arrow.up" size={14} color={C.textSecondary} />
          </Pressable>
          {/* Sparkle navigates to walk-summary where summary confirmation lives */}
          <Pressable onPress={onPress} hitSlop={10} style={cardStyles.actionBtn} disabled={isAnalyzing}>
            <IconSymbol
              name="sparkles"
              size={14}
              color={hasPendingSummary && !isAnalyzing ? C.tint : C.textSecondary}
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
  walkTypeBadge: {
    paddingHorizontal: 10,
    paddingVertical:    3,
    borderRadius:      12,
    backgroundColor:   C.tint,
  },
  walkTypeBadgeMuted: {
    backgroundColor: C.surfaceHigh,
  },
  walkTypeBadgeText: {
    fontSize:   12,
    color:      C.text,
    fontWeight: '600',
  },
  walkTypeBadgeTextMuted: {
    color: C.textSecondary,
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
  const { analyzingSessionId }      = useAIQueue();

  const [sortBy, setSortBy]           = useState<SortOption>('recent');
  const [filterType, setFilterType]   = useState<WalkType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  function sessionRecs(session: SessionEntry) {
    return recordings.filter(r => {
      const t = new Date(r.date).getTime();
      return t >= session.started_at && t <= session.ended_at + 60_000;
    });
  }

  const searched = searchQuery.trim()
    ? sessions.filter(session => {
        const q = searchQuery.toLowerCase();
        if (session.title?.toLowerCase().includes(q)) return true;
        return sessionRecs(session).some(r => r.transcript?.toLowerCase().includes(q));
      })
    : sessions;

  const filtered = filterType
    ? searched.filter(s => sessionWalkType(s, recordings) === filterType)
    : searched;

  const sorted = sortBy === 'longest'
    ? [...filtered].sort((a, b) => (b.ended_at - b.started_at) - (a.ended_at - a.started_at))
    : filtered; // 'recent' — already sorted by started_at DESC from SQLite

  function handleShare(session: SessionEntry) {
    const recs       = sessionRecs(session);
    const keyPoints  = parseJsonArray(session.key_points);
    const actions    = parseJsonArray(session.actions);
    const durationMs = session.ended_at - session.started_at;
    const wt         = session.walk_type as WalkType | null;

    const lines: string[] = [];
    lines.push(session.title ?? formatDateLabel(session.started_at));

    const meta: string[] = [];
    if (durationMs > 0)     meta.push(formatDuration(durationMs));
    if (session.steps > 0)  meta.push(`${session.steps.toLocaleString()} steps`);
    if (recs.length > 0)    meta.push(`${recs.length} thought${recs.length !== 1 ? 's' : ''}`);
    if (meta.length > 0)    lines.push(meta.join(' · '));

    if ((wt === 'vent' || wt === 'reflect' || wt === 'untangle') && session.summary) {
      lines.push('', session.summary);
    }
    if (wt === 'brainstorm' && keyPoints.length > 0) {
      lines.push('', 'IDEAS');
      keyPoints.forEach(p => lines.push(`• ${p}`));
    }
    if (wt === 'appreciate' && keyPoints.length > 0) {
      lines.push('', 'APPRECIATIONS');
      keyPoints.forEach(p => lines.push(`• ${p}`));
    }
    if (wt === 'plan' && actions.length > 0) {
      lines.push('', 'ACTIONS');
      actions.forEach(a => lines.push(`☐ ${a}`));
    }
    if (!wt) {
      if (keyPoints.length > 0) { lines.push('', 'KEY POINTS'); keyPoints.forEach(p => lines.push(`• ${p}`)); }
      if (actions.length   > 0) { lines.push('', 'ACTIONS');    actions.forEach(a => lines.push(`☐ ${a}`)); }
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

      {/* Search + Sort */}
      <View style={styles.searchSortRow}>
        <View style={styles.searchBar}>
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
        <Pressable
          style={styles.sortButton}
          onPress={() => setSortBy(prev => prev === 'recent' ? 'longest' : 'recent')}
        >
          <IconSymbol name="arrow.up.arrow.down" size={11} color={C.textSecondary} />
          <Text style={styles.sortButtonText}>
            {sortBy === 'recent' ? 'Recent' : 'Longest'}
          </Text>
        </Pressable>
      </View>

      {/* Walk type filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScrollRow}
        contentContainerStyle={styles.filterScrollContent}
      >
        <Pressable
          onPress={() => setFilterType(null)}
          style={[styles.filterChip, filterType === null && styles.filterChipActive]}
        >
          <Text style={[styles.filterChipText, filterType === null && styles.filterChipTextActive]}>
            All
          </Text>
        </Pressable>
        {VALID_WALK_TYPES.map(type => (
          <Pressable
            key={type}
            onPress={() => setFilterType(prev => prev === type ? null : type)}
            style={[styles.filterChip, filterType === type && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, filterType === type && styles.filterChipTextActive]}>
              {WALK_TYPE_LABELS[type]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sorted.length === 0 ? (
          <View style={styles.emptyState}>
            {sessions.length === 0 ? (
              <>
                <Text style={styles.emptyText}>No walks yet.</Text>
                <Text style={styles.emptySubtext}>
                  Complete a walk to see your AI-generated logs here.
                </Text>
              </>
            ) : (
              <Text style={styles.emptyText}>No results for "{searchQuery}".</Text>
            )}
          </View>
        ) : (
          sorted.map(session => {
            const recs            = sessionRecs(session);
            const isAnalyzing     = analyzingSessionId === session.id;
            const hasAI           = session.title !== null;
            const hasTranscripts  = recs.some(r => r.transcript?.trim());
            const wt              = sessionWalkType(session, recordings);
            const hasPendingSummary = !hasAI && !isAnalyzing && hasTranscripts;
            return (
              <SessionCard
                key={session.id}
                session={session}
                durationMs={session.ended_at - session.started_at}
                recordingCount={recs.length}
                walkType={wt}
                isAnalyzing={isAnalyzing}
                hasPendingSummary={hasPendingSummary}
                onPress={() => openSession(session)}
                onLongPress={() => confirmDeleteSession(session)}
                onShare={() => handleShare(session)}
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
  searchSortRow: {
    flexDirection:    'row',
    alignItems:       'center',
    marginHorizontal: 24,
    marginBottom:     10,
    gap:               8,
  },
  searchBar: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
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
  sortButton: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:                5,
    backgroundColor:   C.surface,
    borderRadius:      12,
    paddingHorizontal: 12,
    paddingVertical:    9,
  },
  sortButtonText: {
    fontSize:   13,
    color:      C.textSecondary,
    fontWeight: '500',
  },

  filterScrollRow: {
    marginBottom: 10,
  },
  filterScrollContent: {
    paddingHorizontal: 24,
    gap:                6,
    flexDirection:     'row',
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical:    5,
    borderRadius:      20,
    backgroundColor:   C.surface,
    borderWidth:       1,
    borderColor:       C.border,
  },
  filterChipActive: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  filterChipText: {
    fontSize:   12,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  filterChipTextActive: {
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
