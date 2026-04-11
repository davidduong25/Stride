import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { File } from 'expo-file-system';

import { C } from '@/constants/theme';
import { WaveformScrubber } from '@/components/WaveformScrubber';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useRecordingsContext, type RecordingEntry } from '@/context/recordings-context';
import { useSessionsContext } from '@/context/sessions-context';
import { useAIQueue } from '@/context/ai-queue-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatMs(ms: number): string {
  return formatDuration(Math.round(ms / 1000));
}

function formatDurationShort(ms: number): string {
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

function normaliseTranscript(text: string): string {
  const t = text.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadedSound = {
  player:     AudioPlayer;
  durationMs: number;
  sub:        { remove: () => void } | null;
};

// ---------------------------------------------------------------------------
// ClipRow
// ---------------------------------------------------------------------------

function ClipRow({
  item,
  index,
  isActive,
  positionMs,
  durationMs,
  isTranscribing,
  isQueued,
  isFailed,
  onPlay,
  onSeek,
  onRetranscribe,
  onSave,
}: {
  item:            RecordingEntry;
  index:           number;
  isActive:        boolean;
  positionMs:      number;
  durationMs:      number;
  isTranscribing:  boolean;
  isQueued:        boolean;
  isFailed:        boolean;
  onPlay:          (id: string) => void;
  onSeek:          (ms: number) => void;
  onRetranscribe:  (id: string) => void;
  onSave:          (id: string, text: string) => void;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [editing, setEditing]               = useState(false);
  const [editText, setEditText]             = useState('');

  const waveformSamples  = item.waveform ? (JSON.parse(item.waveform) as number[]) : null;
  const displayDurationMs = isActive && durationMs > 0 ? durationMs : item.duration * 1000;

  function startEditing() {
    setEditText(item.transcript ?? '');
    setEditing(true);
  }

  function commitEdit() {
    onSave(item.id, editText.trim());
    setEditing(false);
  }

  const hasTranscript = item.transcript !== null && item.transcript.trim().length > 0;

  return (
    <View style={clipStyles.row}>
      {/* Header: clip label + duration + play button */}
      <View style={clipStyles.header}>
        <View style={clipStyles.headerLeft}>
          <Text style={clipStyles.label}>Clip {index + 1}</Text>
          <Text style={clipStyles.duration}>
            {isActive
              ? `${formatMs(positionMs)} / ${formatMs(displayDurationMs)}`
              : formatDuration(item.duration)}
          </Text>
        </View>
        <Pressable
          style={[clipStyles.playBtn, isActive && clipStyles.playBtnActive]}
          onPress={() => onPlay(item.id)}
          hitSlop={8}
        >
          <IconSymbol
            name={isActive ? 'pause.fill' : 'play.fill'}
            size={12}
            color={isActive ? C.background : C.textSecondary}
          />
        </Pressable>
      </View>

      {/* Waveform scrubber — only when active */}
      {isActive && waveformSamples && waveformSamples.length > 0 && (
        <WaveformScrubber
          samples={waveformSamples}
          positionMs={positionMs}
          durationMs={durationMs}
          onSeek={onSeek}
          height={40}
          maxBars={80}
          marginVertical={6}
        />
      )}

      {/* Transcript toggle */}
      {(hasTranscript || isTranscribing || isQueued || isFailed) && (
        <Pressable
          style={clipStyles.transcriptToggle}
          onPress={() => !editing && setTranscriptOpen(o => !o)}
        >
          <IconSymbol
            name={transcriptOpen ? 'chevron.down' : 'chevron.right'}
            size={11}
            color={C.textTertiary}
          />
          <Text style={clipStyles.transcriptToggleText}>
            {isTranscribing ? 'Transcribing…'
              : isQueued     ? 'Queued…'
              : isFailed     ? 'Failed'
              : 'Transcript'}
          </Text>
          {isFailed && (
            <Pressable
              onPress={() => onRetranscribe(item.id)}
              hitSlop={8}
              style={clipStyles.retryBtn}
            >
              <Text style={clipStyles.retryText}>Retry</Text>
            </Pressable>
          )}
        </Pressable>
      )}

      {/* Transcript body */}
      {transcriptOpen && hasTranscript && !editing && (
        <View style={clipStyles.transcriptBody}>
          <Text style={clipStyles.transcriptText}>
            {normaliseTranscript(item.transcript!)}
          </Text>
          <View style={clipStyles.transcriptActions}>
            <Pressable onPress={startEditing} hitSlop={6}>
              <Text style={clipStyles.transcriptAction}>Edit</Text>
            </Pressable>
            <Pressable onPress={() => onRetranscribe(item.id)} hitSlop={6}>
              <Text style={clipStyles.transcriptAction}>Retranscribe</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Edit mode */}
      {transcriptOpen && editing && (
        <View style={clipStyles.transcriptBody}>
          <TextInput
            style={clipStyles.transcriptInput}
            value={editText}
            onChangeText={setEditText}
            multiline
            autoFocus
            scrollEnabled={false}
          />
          <View style={clipStyles.transcriptActions}>
            <Pressable onPress={commitEdit} hitSlop={6}>
              <Text style={clipStyles.transcriptAction}>Save</Text>
            </Pressable>
            <Pressable onPress={() => setEditing(false)} hitSlop={6}>
              <Text style={[clipStyles.transcriptAction, { color: C.textTertiary }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const clipStyles = StyleSheet.create({
  row: {
    paddingVertical:  14,
    borderTopWidth:   StyleSheet.hairlineWidth,
    borderTopColor:   C.border,
  },
  header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            8,
  },
  label: {
    fontSize:   14,
    fontWeight: '500',
    color:      C.text,
  },
  duration: {
    fontSize: 13,
    color:    C.textSecondary,
  },
  playBtn: {
    width:           28,
    height:          28,
    borderRadius:    14,
    backgroundColor: C.surfaceHigh,
    justifyContent:  'center',
    alignItems:      'center',
  },
  playBtnActive: {
    backgroundColor: C.tint,
  },
  transcriptToggle: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            4,
    marginTop:      8,
  },
  transcriptToggleText: {
    fontSize: 12,
    color:    C.textTertiary,
  },
  retryBtn: {
    marginLeft: 6,
  },
  retryText: {
    fontSize: 12,
    color:    C.tint,
  },
  transcriptBody: {
    marginTop: 8,
    gap:        6,
  },
  transcriptText: {
    fontSize:   14,
    color:      C.textSecondary,
    lineHeight: 21,
  },
  transcriptInput: {
    fontSize:          14,
    color:             C.text,
    lineHeight:        21,
    borderWidth:       1,
    borderColor:       C.border,
    borderRadius:      8,
    padding:           10,
    minHeight:         80,
    textAlignVertical: 'top',
    backgroundColor:   C.surfaceHigh,
  },
  transcriptActions: {
    flexDirection: 'row',
    gap:            16,
  },
  transcriptAction: {
    fontSize: 12,
    color:    C.tint,
  },
});

// ---------------------------------------------------------------------------
// WalkSummaryScreen
// ---------------------------------------------------------------------------

export default function WalkSummaryScreen() {
  const {
    startedAt:    startedAtStr,
    endedAt:      endedAtStr,
    steps:        stepsStr,
    recordingIds: recordingIdsStr,
  } = useLocalSearchParams<{
    startedAt:    string;
    endedAt:      string;
    steps:        string;
    recordingIds: string;
  }>();

  const { recordings, updateRecording } = useRecordingsContext();
  const { sessions }                    = useSessionsContext();
  const {
    enqueueTranscription,
    enqueueAnalysis,
    processingId,
    processingType,
    failedIds,
    queuedIds,
    analyzingSessionId,
  } = useAIQueue();

  const startedAt    = Number(startedAtStr ?? 0);
  const endedAt      = Number(endedAtStr   ?? 0);
  const steps        = Number(stepsStr     ?? 0);
  const recordingIds = recordingIdsStr ? recordingIdsStr.split(',').filter(Boolean) : [];
  const sessionId    = startedAtStr ?? '';

  const durationMs   = endedAt - startedAt;

  const sessionRecordings = recordingIds
    .map(id => recordings.find(r => r.id === id))
    .filter((r): r is RecordingEntry => r !== undefined);

  const session     = sessions.find(s => s.id === sessionId);
  const keyPoints   = parseJsonArray(session?.key_points ?? null);
  const actions     = parseJsonArray(session?.actions    ?? null);
  const hasAI       = session?.title !== null && session?.title !== undefined;
  const isAnalyzing = analyzingSessionId === sessionId;

  const allTranscribed =
    sessionRecordings.length > 0 &&
    sessionRecordings.every(
      r => r.transcript !== null && !queuedIds.has(r.id) && processingId !== r.id
    );

  const hasNonEmptyTranscripts = sessionRecordings.some(
    r => r.transcript && r.transcript.trim().length > 0
  );

  // ── auto-trigger analysis ───────────────────────────────────────────────────

  const [autoTriggered, setAutoTriggered] = useState(false);

  useEffect(() => {
    if (autoTriggered || !allTranscribed || !hasNonEmptyTranscripts || hasAI || isAnalyzing) return;
    const transcripts = sessionRecordings
      .map(r => r.transcript)
      .filter((t): t is string => !!t && t.trim().length > 0);
    if (transcripts.length === 0) return;
    setAutoTriggered(true);
    enqueueAnalysis(sessionId, transcripts);
  }, [autoTriggered, allTranscribed, hasNonEmptyTranscripts, hasAI, isAnalyzing,
      sessionRecordings, sessionId, enqueueAnalysis]);

  // ── playback ────────────────────────────────────────────────────────────────

  const [playingId,  setPlayingId]  = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMsState, setDurationMs] = useState(0);
  const soundMapRef  = useRef<Map<string, LoadedSound>>(new Map());
  const activeIdRef  = useRef<string | null>(null);

  useEffect(() => {
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    return () => {
      soundMapRef.current.forEach(({ player, sub }) => { sub?.remove(); player.remove(); });
      soundMapRef.current.clear();
    };
  }, []);

  function loadSound(entry: RecordingEntry): LoadedSound | null {
    if (soundMapRef.current.has(entry.id)) return soundMapRef.current.get(entry.id)!;
    if (!new File(entry.uri).exists) return null;
    try {
      const player = createAudioPlayer(entry.uri, { updateInterval: 100 });
      const loaded: LoadedSound = { player, durationMs: player.duration * 1000, sub: null };
      soundMapRef.current.set(entry.id, loaded);
      return loaded;
    } catch {
      return null;
    }
  }

  async function stopCurrentPlayback() {
    const id = activeIdRef.current;
    if (id) {
      const loaded = soundMapRef.current.get(id);
      if (loaded) {
        loaded.sub?.remove();
        loaded.sub = null;
        loaded.player.pause();
        await loaded.player.seekTo(0);
      }
      activeIdRef.current = null;
    }
    setPlayingId(null);
    setPositionMs(0);
    setDurationMs(0);
  }

  async function handlePlay(id: string) {
    if (playingId === id) { await stopCurrentPlayback(); return; }
    await stopCurrentPlayback();

    const entry = sessionRecordings.find(r => r.id === id);
    if (!entry) return;

    const loaded = loadSound(entry);
    if (!loaded) {
      Alert.alert('Recording unavailable', 'The audio file for this recording is missing.');
      return;
    }

    activeIdRef.current = id;
    setPlayingId(id);
    setPositionMs(0);
    setDurationMs(loaded.player.duration * 1000);

    let loadTimeout: ReturnType<typeof setTimeout>;

    function abortPlayback(message: string) {
      clearTimeout(loadTimeout);
      loaded.sub?.remove();
      loaded.sub = null;
      soundMapRef.current.delete(id);
      activeIdRef.current = null;
      setPlayingId(null); setPositionMs(0); setDurationMs(0);
      Alert.alert('Playback failed', message);
    }

    loadTimeout = setTimeout(() => {
      if (activeIdRef.current === id) abortPlayback('This recording could not be loaded.');
    }, 5000);

    loaded.sub = loaded.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (!status.isLoaded) return;
      clearTimeout(loadTimeout);
      if (status.duration > 0) {
        setDurationMs(status.duration * 1000);
        loaded.durationMs = status.duration * 1000;
      }
      if (status.didJustFinish) {
        loaded.sub?.remove();
        loaded.sub = null;
        activeIdRef.current = null;
        setPlayingId(null); setPositionMs(0); setDurationMs(0);
        return;
      }
      setPositionMs(status.currentTime * 1000);
    });

    loaded.player.play();
  }

  async function handleSeek(ms: number) {
    if (activeIdRef.current) {
      const loaded = soundMapRef.current.get(activeIdRef.current);
      if (loaded) await loaded.player.seekTo(ms / 1000);
    }
  }

  async function handleSave(id: string, text: string) {
    await updateRecording(id, { transcript: text, transcript_edited: 1 });
  }

  async function handleRetranscribe(id: string) {
    const entry = sessionRecordings.find(r => r.id === id);
    if (!entry) return;

    async function doRetranscribe() {
      await updateRecording(id, { transcript: null, transcript_edited: 0 });
      enqueueTranscription(id, entry!.uri);
    }

    if (entry.transcript_edited) {
      Alert.alert(
        'Replace your edits?',
        'Retranscribing will overwrite the changes you made to this transcript.',
        [
          { text: 'Cancel',       style: 'cancel' },
          { text: 'Retranscribe', style: 'destructive', onPress: doRetranscribe },
        ]
      );
      return;
    }
    await doRetranscribe();
  }

  // ── date label ───────────────────────────────────────────────────────────────

  const dateLabel = startedAt
    ? new Date(startedAt).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
      })
    : '';

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen
        options={{
          title:          session?.title ?? 'Walk',
          headerBackTitle: 'Done',
        }}
      />
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Date */}
          {dateLabel ? (
            <Text style={styles.dateLabel}>{dateLabel}</Text>
          ) : null}

          {/* AI title — shown below date when present */}
          {hasAI && (
            <Text style={styles.aiTitle}>{session!.title}</Text>
          )}

          {/* Stats strip */}
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatDurationShort(durationMs)}</Text>
              <Text style={styles.statLabel}>duration</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{steps.toLocaleString()}</Text>
              <Text style={styles.statLabel}>steps</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{sessionRecordings.length}</Text>
              <Text style={styles.statLabel}>thoughts</Text>
            </View>
          </View>

          {/* ── AI Output ───────────────────────────────────────────────────── */}

          {isAnalyzing && (
            <View style={styles.processingCard}>
              <Text style={styles.processingText}>Analyzing your walk…</Text>
            </View>
          )}

          {autoTriggered && !isAnalyzing && !hasAI && allTranscribed && hasNonEmptyTranscripts && (
            <Pressable
              style={styles.analyzeBtn}
              onPress={() => {
                const transcripts = sessionRecordings
                  .map(r => r.transcript)
                  .filter((t): t is string => !!t && t.trim().length > 0);
                if (transcripts.length > 0) enqueueAnalysis(sessionId, transcripts);
              }}
            >
              <IconSymbol name="sparkles" size={15} color={C.text} />
              <Text style={styles.analyzeBtnText}>Retry analysis</Text>
            </Pressable>
          )}

          {!isAnalyzing && !hasAI && allTranscribed && !hasNonEmptyTranscripts && sessionRecordings.length > 0 && (
            <View style={styles.processingCard}>
              <Text style={styles.processingText}>No speech detected — analysis unavailable.</Text>
            </View>
          )}

          {!isAnalyzing && !hasAI && !allTranscribed && sessionRecordings.length > 0 && (
            <View style={styles.processingCard}>
              <Text style={styles.processingText}>
                Analysis available once transcription completes
              </Text>
            </View>
          )}

          {keyPoints.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>KEY POINTS</Text>
              {keyPoints.map((point, i) => (
                <View key={i} style={styles.bulletRow}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>{point}</Text>
                </View>
              ))}
            </View>
          )}

          {actions.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>ACTIONS</Text>
              {actions.map((action, i) => (
                <View key={i} style={styles.bulletRow}>
                  <View style={styles.checkbox} />
                  <Text style={styles.bulletText}>{action}</Text>
                </View>
              ))}
            </View>
          )}

          {/* ── Thoughts (recordings) ──────────────────────────────────────── */}

          {sessionRecordings.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>THOUGHTS</Text>
              {sessionRecordings.map((item, index) => (
                <ClipRow
                  key={item.id}
                  item={item}
                  index={index}
                  isActive={playingId === item.id}
                  positionMs={positionMs}
                  durationMs={durationMsState}
                  isTranscribing={processingId === item.id && processingType === 'transcribe'}
                  isQueued={queuedIds.has(item.id)}
                  isFailed={failedIds.has(item.id)}
                  onPlay={handlePlay}
                  onSeek={handleSeek}
                  onRetranscribe={handleRetranscribe}
                  onSave={handleSave}
                />
              ))}
            </View>
          )}

          {sessionRecordings.length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No thoughts recorded this walk.</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </>
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
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop:        12,
    paddingBottom:     48,
  },

  // ── Header ─────────────────────────────────────────────────────────────────
  dateLabel: {
    fontSize:  13,
    color:     C.textTertiary,
    textAlign: 'center',
    marginBottom: 4,
  },
  aiTitle: {
    fontSize:      24,
    fontWeight:    '700',
    color:         C.text,
    letterSpacing: -0.3,
    textAlign:     'center',
    marginBottom:  16,
    marginTop:      4,
  },

  // ── Stats ───────────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection:   'row',
    backgroundColor: C.surface,
    borderRadius:    14,
    paddingVertical: 16,
    marginBottom:    24,
  },
  statItem: {
    flex:       1,
    alignItems: 'center',
    gap:         2,
  },
  statValue: {
    fontSize:   18,
    fontWeight: '700',
    color:      C.text,
  },
  statLabel: {
    fontSize: 11,
    color:    C.textSecondary,
  },
  statDivider: {
    width:           StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginVertical:  4,
  },

  // ── AI processing / analyze button ─────────────────────────────────────────
  processingCard: {
    backgroundColor: C.surface,
    borderRadius:    12,
    padding:         14,
    alignItems:      'center',
    marginBottom:    16,
  },
  processingText: {
    fontSize:  13,
    color:     C.textSecondary,
    fontStyle: 'italic',
  },
  analyzeBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:              8,
    backgroundColor: C.tint,
    borderRadius:    14,
    paddingVertical: 14,
    marginBottom:    24,
  },
  analyzeBtnText: {
    fontSize:   16,
    fontWeight: '600',
    color:      C.text,
  },

  // ── Sections ────────────────────────────────────────────────────────────────
  section: {
    marginBottom: 28,
  },
  sectionHeader: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginBottom:  12,
  },
  bulletRow: {
    flexDirection: 'row',
    gap:            10,
    marginBottom:   10,
    alignItems:    'flex-start',
  },
  bulletDot: {
    fontSize:   16,
    color:      C.tint,
    lineHeight: 22,
    marginTop:   1,
  },
  bulletText: {
    flex:       1,
    fontSize:   15,
    color:      C.text,
    lineHeight: 22,
  },
  checkbox: {
    width:        16,
    height:       16,
    borderRadius:  4,
    borderWidth:   1.5,
    borderColor:   C.tint,
    marginTop:     3,
    flexShrink:    0,
  },

  // ── Empty ───────────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingTop:  40,
  },
  emptyText: {
    fontSize: 15,
    color:    C.textSecondary,
  },
});
