import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { C } from '@/constants/theme';
import { useSessionsContext, type SessionEntry } from '@/context/sessions-context';
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
};

function SessionCard({ session, durationMs, recordingCount, isAnalyzing, onPress }: CardProps) {
  const keyPoints = parseJsonArray(session.key_points);
  const actions   = parseJsonArray(session.actions);
  const hasAI     = session.title !== null;

  // Show the first key point as preview text, if available
  const preview = keyPoints[0] ?? null;

  return (
    <Pressable style={cardStyles.card} onPress={onPress}>
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
            <IconSymbol name="play.fill"  size={14} color={C.textSecondary} />
          </Pressable>
          <Pressable onPress={onPress} hitSlop={10} style={cardStyles.actionBtn}>
            <IconSymbol name="doc.text"   size={14} color={C.textSecondary} />
          </Pressable>
          <Pressable onPress={onPress} hitSlop={10} style={cardStyles.actionBtn}>
            <IconSymbol name="sparkles"   size={14} color={C.textSecondary} />
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
  const { sessions }                = useSessionsContext();
  const { recordings }              = useRecordingsContext();
  const { analyzingSessionId }      = useAIQueue();

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
        <Pressable hitSlop={12}>
          <IconSymbol name="ellipsis" size={20} color={C.icon} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sessions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No walks yet.</Text>
            <Text style={styles.emptySubtext}>
              Complete a walk to see your AI-generated logs here.
            </Text>
          </View>
        ) : (
          sessions.map(session => {
            const durationMs = session.ended_at - session.started_at;
            const sessionRecordings = recordings.filter(r => {
              const t = new Date(r.date).getTime();
              return t >= session.started_at && t <= session.ended_at + 60_000;
            });
            return (
              <SessionCard
                key={session.id}
                session={session}
                durationMs={durationMs}
                recordingCount={sessionRecordings.length}
                isAnalyzing={analyzingSessionId === session.id}
                onPress={() => openSession(session)}
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
