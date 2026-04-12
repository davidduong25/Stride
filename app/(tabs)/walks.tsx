import { useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { C } from '@/constants/theme';
import { useRecordingsContext } from '@/context/recordings-context';
import { useSessionsContext, type SessionEntry } from '@/context/sessions-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { EllipsisMenu } from '@/components/EllipsisMenu';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

type TimeFilter = 'day' | 'week' | 'month' | 'all';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function filterSessions(sessions: SessionEntry[], filter: TimeFilter): SessionEntry[] {
  const today = todayStart();
  return sessions.filter(s => {
    if (filter === 'all')   return true;
    if (filter === 'day')   return s.started_at >= today;
    if (filter === 'week')  return s.started_at >= today - 6 * DAY_MS;
    if (filter === 'month') return s.started_at >= today - 29 * DAY_MS;
    return true;
  });
}

function sessionBadge(startedAt: number): string {
  const today = todayStart();
  if (startedAt >= today)          return 'today';
  if (startedAt >= today - DAY_MS) return 'yesterday';
  return new Date(startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function sessionDateLabel(startedAt: number): string {
  const today   = todayStart();
  const timeStr = new Date(startedAt).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
  if (startedAt >= today)          return `Today · ${timeStr}`;
  if (startedAt >= today - DAY_MS) return `Yesterday · ${timeStr}`;
  const dateStr = new Date(startedAt).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  return `${dateStr} · ${timeStr}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TagChip({ label }: { label: string }) {
  return (
    <View style={chipStyles.chip}>
      <Text style={chipStyles.text}>{label}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    paddingHorizontal: 10,
    paddingVertical:    4,
    borderRadius:      20,
    backgroundColor:   C.tint + '22',
    borderWidth:       1,
    borderColor:       C.tint + '55',
  },
  text: {
    fontSize:   12,
    color:      C.tint,
    fontWeight: '500',
  },
});

// ---------------------------------------------------------------------------
// WalksScreen
// ---------------------------------------------------------------------------

export default function WalksScreen() {
  const router = useRouter();
  const { recordings }  = useRecordingsContext();
  const { sessions, deleteSession } = useSessionsContext();
  const [filter, setFilter]       = useState<TimeFilter>('day');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const filtered = filterSessions(sessions, filter);

  const allTags = [...new Set(filtered.flatMap(s => sessionTags(s)))].sort();

  const displayed = selectedTag
    ? filtered.filter(s => sessionTags(s).includes(selectedTag))
    : filtered;

  const latestSession    = displayed[0] ?? null;
  const previousSessions = displayed.slice(1);

  function sessionRecordingIds(session: SessionEntry): string[] {
    return recordings
      .filter(r => {
        const t = new Date(r.date).getTime();
        return t >= session.started_at && t <= session.ended_at + 60_000;
      })
      .map(r => r.id);
  }

  function sessionThoughtCount(session: SessionEntry): number {
    return recordings.filter(r => {
      const t = new Date(r.date).getTime();
      return t >= session.started_at && t <= session.ended_at + 60_000;
    }).length;
  }

  function sessionTags(session: SessionEntry): string[] {
    const all = recordings
      .filter(r => {
        const t = new Date(r.date).getTime();
        return t >= session.started_at && t <= session.ended_at + 60_000;
      })
      .flatMap(r => (r.tags ? r.tags.split(',') : []))
      .filter(Boolean);
    return [...new Set(all)];
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
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt:    session.started_at.toString(),
        endedAt:      session.ended_at.toString(),
        steps:        session.steps.toString(),
        recordingIds: sessionRecordingIds(session).join(','),
      },
    });
  }

  const FILTERS: { key: TimeFilter; label: string }[] = [
    { key: 'day',   label: 'day'   },
    { key: 'week',  label: 'week'  },
    { key: 'month', label: 'month' },
    { key: 'all',   label: 'all'   },
  ];

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>walks</Text>
        <EllipsisMenu />
      </View>

      {/* Time filter */}
      <View style={styles.filterRow}>
        {FILTERS.map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => { setFilter(key); setSelectedTag(null); }}
            style={[
              styles.filterPill,
              filter === key && styles.filterPillActive,
            ]}
          >
            <Text style={[
              styles.filterText,
              filter === key && styles.filterTextActive,
            ]}>
              {label}
            </Text>
          </Pressable>
        ))}
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
            <Text style={styles.emptyText}>
              {selectedTag ? `No "${selectedTag}" walks this ${filter}.` : `No walks this ${filter}.`}
            </Text>
            <Text style={styles.emptySubtext}>Start walking to record your first stride.</Text>
          </View>
        ) : (
          <>
            {/* Latest walk — featured card */}
            {latestSession && (
              <Pressable
                style={styles.featuredCard}
                onPress={() => openSession(latestSession)}
                onLongPress={() => confirmDeleteSession(latestSession)}
              >
                <View style={styles.featuredCardHeader}>
                  {latestSession.title
                    ? <Text style={styles.featuredTitle}>{latestSession.title}</Text>
                    : <Text style={styles.featuredLabel}>Latest walk</Text>
                  }
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{sessionBadge(latestSession.started_at)}</Text>
                  </View>
                </View>

                <View style={styles.featuredStats}>
                  <View style={styles.featuredStatItem}>
                    <Text style={styles.featuredStatValue}>
                      {latestSession.steps.toLocaleString()}
                    </Text>
                    <Text style={styles.featuredStatLabel}>steps</Text>
                  </View>
                  <View style={styles.featuredStatItem}>
                    <Text style={[styles.featuredStatValue, styles.featuredStatValueLarge]}>
                      {formatDuration(latestSession.ended_at - latestSession.started_at)}
                    </Text>
                    <Text style={styles.featuredStatLabel}>duration</Text>
                  </View>
                  <View style={styles.featuredStatItem}>
                    <Text style={styles.featuredStatValue}>{sessionThoughtCount(latestSession)}</Text>
                    <Text style={styles.featuredStatLabel}>thoughts</Text>
                  </View>
                </View>

                {sessionTags(latestSession).length > 0 && (
                  <View style={styles.tagRow}>
                    {sessionTags(latestSession).map(tag => (
                      <TagChip key={tag} label={tag} />
                    ))}
                  </View>
                )}
              </Pressable>
            )}

            {/* Previous sessions */}
            {previousSessions.length > 0 && (
              <>
                <Text style={styles.sectionHeader}>PREVIOUS</Text>
                {previousSessions.map(session => {
                  const thoughtCount = sessionThoughtCount(session);
                  const tags = sessionTags(session);
                  return (
                    <Pressable
                      key={session.id}
                      style={styles.sessionRow}
                      onPress={() => openSession(session)}
                      onLongPress={() => confirmDeleteSession(session)}
                    >
                      {session.title ? (
                        <>
                          <Text style={styles.sessionDate}>{session.title}</Text>
                          <Text style={styles.sessionDateSub}>
                            {sessionDateLabel(session.started_at)}
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.sessionDate}>
                          {sessionDateLabel(session.started_at)}
                        </Text>
                      )}
                      <View style={styles.sessionStats}>
                        <Text style={styles.sessionStat}>
                          {session.steps.toLocaleString()} steps
                        </Text>
                        <Text style={styles.sessionStatDot}>·</Text>
                        <Text style={styles.sessionStat}>
                          {formatDuration(session.ended_at - session.started_at)}
                        </Text>
                        <Text style={styles.sessionStatDot}>·</Text>
                        <Text style={styles.sessionStat}>
                          {thoughtCount} {thoughtCount === 1 ? 'thought' : 'thoughts'}
                        </Text>
                      </View>
                      {tags.length > 0 && (
                        <View style={[styles.tagRow, { marginTop: 6 }]}>
                          {tags.map(tag => (
                            <TagChip key={tag} label={tag} />
                          ))}
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </>
            )}
          </>
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

  // ── Filter ───────────────────────────────────────────────────────────────
  filterRow: {
    flexDirection:     'row',
    paddingHorizontal: 24,
    gap:               6,
    marginBottom:      16,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical:    6,
    borderRadius:      20,
    backgroundColor:   C.surface,
  },
  filterPillActive: {
    backgroundColor: C.tint,
  },
  filterText: {
    fontSize:   14,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  filterTextActive: {
    color: C.text,
  },

  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom:     32,
    gap:               0,
  },

  // ── Featured card ────────────────────────────────────────────────────────
  featuredCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         18,
    marginBottom:    24,
  },
  featuredCardHeader: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   12,
  },
  featuredLabel: {
    fontSize:   13,
    fontWeight: '600',
    color:      C.textSecondary,
    letterSpacing: 0.3,
  },
  featuredTitle: {
    fontSize:      18,
    fontWeight:    '700',
    color:         C.text,
    letterSpacing: -0.2,
    flex:           1,
  },
  badge: {
    backgroundColor: C.tint,
    paddingHorizontal: 10,
    paddingVertical:    3,
    borderRadius:      12,
  },
  badgeText: {
    fontSize:   12,
    fontWeight: '600',
    color:      C.text,
  },
  featuredStats: {
    flexDirection: 'row',
    gap:           20,
    marginBottom:  12,
  },
  featuredStatItem: {
    gap: 2,
  },
  featuredStatValue: {
    fontSize:   20,
    fontWeight: '700',
    color:      C.text,
  },
  featuredStatValueLarge: {
    fontSize: 24,
  },
  featuredStatLabel: {
    fontSize: 11,
    color:    C.textSecondary,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           6,
  },

  // ── Previous sessions ────────────────────────────────────────────────────
  sectionHeader: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginBottom:  12,
    marginTop:     4,
  },
  sessionRow: {
    paddingVertical: 16,
    borderTopWidth:  StyleSheet.hairlineWidth,
    borderTopColor:  C.border,
  },
  sessionDate: {
    fontSize:   15,
    fontWeight: '500',
    color:      C.text,
    marginBottom: 2,
  },
  sessionDateSub: {
    fontSize:     12,
    color:        C.textTertiary,
    marginBottom:  4,
  },
  sessionStats: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
  },
  sessionStat: {
    fontSize: 13,
    color:    C.textSecondary,
  },
  sessionStatDot: {
    fontSize: 13,
    color:    C.textTertiary,
  },

  // ── Tag filter ───────────────────────────────────────────────────────────
  tagFilterRow: {
    marginBottom: 12,
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

  // ── Empty ────────────────────────────────────────────────────────────────
  emptyState: {
    flex:           1,
    alignItems:     'center',
    paddingTop:     80,
    gap:             8,
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
  },
});
