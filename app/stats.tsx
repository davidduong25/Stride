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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS       = 86_400_000;
const CHART_HEIGHT = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function computeCurrentStreak(days: Set<number>): number {
  const today = todayStart();
  const start = days.has(today) ? today : today - DAY_MS;
  let streak = 0;
  let cursor = start;
  while (days.has(cursor)) { streak++; cursor -= DAY_MS; }
  return streak;
}

function computeLongestStreak(days: Set<number>): number {
  if (!days.size) return 0;
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === DAY_MS) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

function sessionDayMs(session: SessionEntry): number {
  const d = new Date(session.started_at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTotalTime(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
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

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statCellValue}>{value}</Text>
      <Text style={styles.statCellLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// StatsScreen
// ---------------------------------------------------------------------------

export default function StatsScreen() {
  const { sessions }   = useSessionsContext();
  const { recordings } = useRecordingsContext();

  const today = todayStart();

  // ── Day set ──────────────────────────────────────────────────────────────

  const walkedDays = new Set(sessions.map(sessionDayMs));

  // ── Streak ───────────────────────────────────────────────────────────────

  const currentStreak = computeCurrentStreak(walkedDays);
  const longestStreak = computeLongestStreak(walkedDays);

  // ── Last 14 days dots ────────────────────────────────────────────────────

  const last14 = Array.from({ length: 14 }, (_, i) => today - (13 - i) * DAY_MS);

  // ── Last 7 days bar chart ────────────────────────────────────────────────

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const dayMs = today - (6 - i) * DAY_MS;
    const label = new Date(dayMs).toLocaleDateString(undefined, { weekday: 'narrow' });
    const steps = sessions
      .filter(s => sessionDayMs(s) === dayMs)
      .reduce((sum, s) => sum + s.steps, 0);
    return { dayMs, label, steps, isToday: i === 6 };
  });

  const maxDaySteps = Math.max(...last7.map(d => d.steps), 1);

  // ── All-time totals ───────────────────────────────────────────────────────

  const totalWalks    = sessions.length;
  const totalSteps    = sessions.reduce((sum, s) => sum + s.steps, 0);
  const totalThoughts = recordings.length;
  const totalWalkMs   = sessions.reduce((sum, s) => sum + (s.ended_at - s.started_at), 0);

  // ── Best walk ─────────────────────────────────────────────────────────────

  const bestWalk = sessions.reduce<SessionEntry | null>(
    (best, s) => (!best || s.steps > best.steps ? s : best), null
  );

  // ── Top tags ──────────────────────────────────────────────────────────────

  const tagCounts: Record<string, number> = {};
  recordings.forEach(r => {
    if (r.tags) {
      r.tags.split(',').filter(Boolean).forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      });
    }
  });
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>stats</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sessions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No walks yet.</Text>
            <Text style={styles.emptySubtext}>
              Complete your first walk to see stats here.
            </Text>
          </View>
        ) : (
          <>
            {/* ── Streak hero ────────────────────────────────────────────── */}
            <View style={styles.streakCard}>
              <View style={styles.streakHero}>
                <Text style={styles.streakNumber}>{currentStreak}</Text>
                <View>
                  <Text style={styles.streakLabel}>day streak</Text>
                  {longestStreak > 0 && (
                    <Text style={styles.streakBest}>
                      {longestStreak} day best
                    </Text>
                  )}
                </View>
              </View>

              {/* 14-day dot trail */}
              <View style={styles.dotRow}>
                {last14.map(dayMs => {
                  const walked  = walkedDays.has(dayMs);
                  const isToday = dayMs === today;
                  return (
                    <View
                      key={dayMs}
                      style={[
                        styles.dot,
                        walked   && styles.dotWalked,
                        isToday  && styles.dotToday,
                      ]}
                    />
                  );
                })}
              </View>
              <Text style={styles.dotLegend}>last 14 days</Text>
            </View>

            {/* ── Weekly chart ───────────────────────────────────────────── */}
            <SectionHeader label="THIS WEEK" />
            <View style={styles.chartCard}>
              <View style={styles.chartBars}>
                {last7.map(({ dayMs, label, steps, isToday }) => {
                  const barH = Math.max(
                    4,
                    Math.round((steps / maxDaySteps) * CHART_HEIGHT)
                  );
                  return (
                    <View key={dayMs} style={styles.chartCol}>
                      <View style={styles.chartBarArea}>
                        <View
                          style={[
                            styles.chartBar,
                            { height: barH },
                            isToday && styles.chartBarToday,
                          ]}
                        />
                      </View>
                      <Text style={[styles.chartLabel, isToday && styles.chartLabelToday]}>
                        {label}
                      </Text>
                      {steps > 0 && (
                        <Text style={styles.chartSteps}>{formatCount(steps)}</Text>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>

            {/* ── All-time totals ─────────────────────────────────────────── */}
            <SectionHeader label="ALL TIME" />
            <View style={styles.statsGrid}>
              <View style={styles.statsGridRow}>
                <StatCell value={totalWalks.toString()}         label="walks"     />
                <StatCell value={formatCount(totalSteps)}        label="steps"     />
              </View>
              <View style={styles.statsGridDivider} />
              <View style={styles.statsGridRow}>
                <StatCell value={totalThoughts.toString()}       label="thoughts"  />
                <StatCell value={formatTotalTime(totalWalkMs)}   label="walk time" />
              </View>
            </View>

            {/* ── Best walk ──────────────────────────────────────────────── */}
            {bestWalk && (
              <>
                <SectionHeader label="BEST WALK" />
                <View style={styles.bestCard}>
                  <View style={styles.bestRow}>
                    <Text style={styles.bestSteps}>
                      {bestWalk.steps.toLocaleString()}
                    </Text>
                    <Text style={styles.bestStepsLabel}>steps</Text>
                  </View>
                  <Text style={styles.bestMeta}>
                    {formatDate(bestWalk.started_at)}
                    {' · '}
                    {formatDuration(bestWalk.ended_at - bestWalk.started_at)}
                  </Text>
                  {bestWalk.title && (
                    <Text style={styles.bestTitle}>{bestWalk.title}</Text>
                  )}
                </View>
              </>
            )}

            {/* ── Top tags ───────────────────────────────────────────────── */}
            {topTags.length > 0 && (
              <>
                <SectionHeader label="TOP TAGS" />
                <View style={styles.tagsCard}>
                  {topTags.map(([tag, count], i) => (
                    <View key={tag}>
                      {i > 0 && <View style={styles.tagDivider} />}
                      <View style={styles.tagRow}>
                        <Text style={styles.tagName}>{tag}</Text>
                        <Text style={styles.tagCount}>
                          {count} {count === 1 ? 'time' : 'times'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
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
    paddingBottom:     48,
  },

  // ── Section header ────────────────────────────────────────────────────────
  sectionHeader: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginTop:     28,
    marginBottom:  12,
  },

  // ── Streak ────────────────────────────────────────────────────────────────
  streakCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         20,
    gap:             20,
    marginTop:       8,
  },
  streakHero: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            16,
  },
  streakNumber: {
    fontSize:      64,
    fontWeight:    '800',
    color:         C.text,
    letterSpacing: -2,
    lineHeight:    64,
  },
  streakLabel: {
    fontSize:   18,
    fontWeight: '600',
    color:      C.text,
  },
  streakBest: {
    fontSize:  13,
    color:     C.textTertiary,
    marginTop:  2,
  },
  dotRow: {
    flexDirection: 'row',
    gap:            5,
  },
  dot: {
    flex:            1,
    height:          8,
    borderRadius:    4,
    backgroundColor: C.surfaceHigh,
  },
  dotWalked: {
    backgroundColor: C.tint,
  },
  dotToday: {
    borderWidth: 1.5,
    borderColor: C.tint,
  },
  dotLegend: {
    fontSize:  11,
    color:     C.textTertiary,
    textAlign: 'right',
    marginTop: -12,
  },

  // ── Bar chart ─────────────────────────────────────────────────────────────
  chartCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         16,
  },
  chartBars: {
    flexDirection: 'row',
    alignItems:    'flex-end',
    gap:            6,
    height:         CHART_HEIGHT + 36,
  },
  chartCol: {
    flex:       1,
    alignItems: 'center',
    gap:         4,
  },
  chartBarArea: {
    height:         CHART_HEIGHT,
    justifyContent: 'flex-end',
    alignItems:     'center',
  },
  chartBar: {
    width:           10,
    borderRadius:    5,
    backgroundColor: C.tint + '55',
  },
  chartBarToday: {
    backgroundColor: C.tint,
  },
  chartLabel: {
    fontSize:   11,
    color:      C.textTertiary,
    fontWeight: '500',
  },
  chartLabelToday: {
    color: C.tint,
  },
  chartSteps: {
    fontSize: 9,
    color:    C.textTertiary,
  },

  // ── All-time grid ─────────────────────────────────────────────────────────
  statsGrid: {
    backgroundColor: C.surface,
    borderRadius:    16,
    overflow:        'hidden',
  },
  statsGridRow: {
    flexDirection: 'row',
  },
  statsGridDivider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginHorizontal: 16,
  },
  statCell: {
    flex:            1,
    alignItems:      'center',
    paddingVertical: 20,
    gap:              4,
  },
  statCellValue: {
    fontSize:   24,
    fontWeight: '700',
    color:      C.text,
    letterSpacing: -0.5,
  },
  statCellLabel: {
    fontSize: 12,
    color:    C.textSecondary,
  },

  // ── Best walk ─────────────────────────────────────────────────────────────
  bestCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         20,
    gap:              6,
  },
  bestRow: {
    flexDirection: 'row',
    alignItems:    'baseline',
    gap:            6,
  },
  bestSteps: {
    fontSize:      36,
    fontWeight:    '800',
    color:         C.text,
    letterSpacing: -1,
  },
  bestStepsLabel: {
    fontSize:   15,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  bestMeta: {
    fontSize: 13,
    color:    C.textTertiary,
  },
  bestTitle: {
    fontSize:   14,
    color:      C.textSecondary,
    fontStyle:  'italic',
    marginTop:   2,
  },

  // ── Top tags ──────────────────────────────────────────────────────────────
  tagsCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    overflow:        'hidden',
  },
  tagRow: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   14,
  },
  tagDivider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginLeft:      16,
  },
  tagName: {
    fontSize:   15,
    color:      C.text,
    fontWeight: '500',
  },
  tagCount: {
    fontSize: 13,
    color:    C.textTertiary,
  },

  // ── Empty ─────────────────────────────────────────────────────────────────
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
  },
});
