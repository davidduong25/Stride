import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { C } from '@/constants/theme';
import { useAudioRecording } from '@/hooks/use-audio-recording';
import { usePedometer, type PedometerState } from '@/hooks/use-pedometer';
import { useRecordingsContext } from '@/context/recordings-context';
import { useSessionsContext } from '@/context/sessions-context';
import { useAIQueue } from '@/context/ai-queue-context';
import { useWalkSession, type WalkSessionSnapshot } from '@/context/walk-session-context';
import { IconSymbol } from '@/components/ui/icon-symbol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function computeStreak(sessionStartTimes: number[]): number {
  if (!sessionStartTimes.length) return 0;
  const DAY_MS = 86_400_000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const days = new Set(
    sessionStartTimes.map(ms => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })
  );
  let streak = 0;
  let cursor = todayStart.getTime();
  while (days.has(cursor)) { streak++; cursor -= DAY_MS; }
  return streak;
}

// ---------------------------------------------------------------------------
// LiveWaveform — simple amplitude bars for the recording screen
// ---------------------------------------------------------------------------

function LiveWaveform({ samples, color }: { samples: number[]; color: string }) {
  const BAR_COUNT = 28;
  const BAR_WIDTH = 3;
  const BAR_GAP   = 2;
  const MAX_HEIGHT = 40;
  const FLOOR_DB   = -60;

  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    const sample = samples[samples.length - BAR_COUNT + i] ?? FLOOR_DB;
    const clamped = Math.max(FLOOR_DB, Math.min(0, sample));
    return Math.max(4, ((clamped - FLOOR_DB) / -FLOOR_DB) * MAX_HEIGHT);
  });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: MAX_HEIGHT, gap: BAR_GAP }}>
      {bars.map((h, i) => (
        <View
          key={i}
          style={{
            width:        BAR_WIDTH,
            height:       h,
            borderRadius: BAR_WIDTH / 2,
            backgroundColor: color,
            opacity: 0.7 + (i / BAR_COUNT) * 0.3,
          }}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// HomeScreen
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const router   = useRouter();
  const { pedometerState, stepCount, stepCountRef, distanceMiles, graceSecondsLeft,
          pauseIntentionally, resumeFromPause } = usePedometer();
  const { isRecording, liveWaveform, recordingSeconds,
          startRecording, stopRecording }      = useAudioRecording();
  const { addRecording, recordings }           = useRecordingsContext();
  const { sessions, addSession }               = useSessionsContext();
  const { enqueueTranscription, processingType, modelDownloadProgress,
          isModelReady, modelError }            = useAIQueue();
  const { isSessionActive, startSession,
          addRecordingToSession, endSession }   = useWalkSession();

  const [testMode, setTestMode] = useState(false);

  const isSessionActiveRef = useRef(isSessionActive);
  isSessionActiveRef.current = isSessionActive;
  const isStoppingRef  = useRef(false);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const prevStateRef   = useRef<PedometerState>(pedometerState);

  // ── Derived display state ─────────────────────────────────────────────────

  const isLocked = !testMode && (
    pedometerState === 'locked' ||
    pedometerState === 'checking' ||
    pedometerState === 'unavailable'
  );
  const displayState: 'locked' | 'ready' | 'recording' =
    isRecording ? 'recording' : isLocked ? 'locked' : 'ready';

  // ── Ring colour ──────────────────────────────────────────────────────────

  const ringColor = (() => {
    if (displayState === 'locked')    return C.surfaceHigh;
    if (displayState === 'recording') {
      if (pedometerState === 'paused') return C.yellow;
      if (graceSecondsLeft !== null && graceSecondsLeft < 60) return C.yellow;
      return C.green;
    }
    return C.tint;
  })();

  // ── Stats (home screen) ──────────────────────────────────────────────────

  const totalRecordings = recordings.length;
  const streak          = computeStreak(sessions.map(s => s.started_at));
  const totalSteps      = sessions.reduce((sum, s) => sum + s.steps, 0);

  // ── Last walk (for "view last walk" on locked screen) ────────────────────

  const SESSION_GAP_MS = 30 * 60 * 1000;
  const lastWalkRecordings = (() => {
    if (!recordings.length) return null;
    const group = [recordings[0]];
    for (let i = 1; i < recordings.length; i++) {
      if (new Date(group[group.length - 1].date).getTime() -
          new Date(recordings[i].date).getTime() <= SESSION_GAP_MS) {
        group.push(recordings[i]);
      } else break;
    }
    return group;
  })();

  function openLastWalk() {
    if (!lastWalkRecordings) return;
    const data = lastWalkRecordings;
    const firstSteps = data[data.length - 1].steps ?? 0;
    const lastSteps  = data[0].steps ?? 0;
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt:    new Date(data[data.length - 1].date).getTime().toString(),
        endedAt:      (new Date(data[0].date).getTime() + data[0].duration * 1000).toString(),
        steps:        Math.max(0, lastSteps - firstSteps).toString(),
        recordingIds: data.map(r => r.id).join(','),
      },
    });
  }

  // ── Recording handlers ───────────────────────────────────────────────────

  const navigateToSummary = useCallback(
    (snapshot: WalkSessionSnapshot) => {
      router.push({
        pathname: '/walk-summary',
        params: {
          startedAt:    snapshot.startedAt.toString(),
          endedAt:      snapshot.endedAt.toString(),
          steps:        snapshot.stepCount.toString(),
          recordingIds: snapshot.recordingIds.join(','),
        },
      });
    },
    [router]
  );

  const handleStopRecording = useCallback(() => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    const savePromise = (async () => {
      const result = await stopRecording(stepCountRef.current);
      isStoppingRef.current = false;
      if (!result) return;
      let id: string | undefined;
      try {
        id = await addRecording({
          uri: result.uri, filename: result.filename,
          duration: result.duration, waveform: result.waveform,
          steps: result.steps, transcript: null,
          tags: null, transcript_edited: null,
        });
      } catch {
        Alert.alert('Save failed', 'Could not save the recording. Please try again.');
        return;
      }
      if (id) { addRecordingToSession(id); enqueueTranscription(id, result.uri); }
    })();
    pendingSaveRef.current = savePromise;
  }, [stopRecording, stepCountRef, addRecording, addRecordingToSession, enqueueTranscription]);

  const handleEndSession = useCallback(async () => {
    if (isRecording) handleStopRecording();
    await pendingSaveRef.current;
    if (!isSessionActiveRef.current) return;
    const snapshot = await endSession(stepCountRef.current);
    if (snapshot && snapshot.recordingIds.length > 0) {
      await addSession({
        id: snapshot.startedAt.toString(),
        started_at: snapshot.startedAt,
        ended_at:   snapshot.endedAt,
        steps:      snapshot.stepCount,
      });
      navigateToSummary(snapshot);
    }
  }, [isRecording, handleStopRecording, endSession, stepCountRef, addSession, navigateToSummary]);

  // ── Pedometer-driven effects ─────────────────────────────────────────────

  useEffect(() => {
    if (pedometerState === 'locked' && isRecording && !testMode) handleStopRecording();
  }, [pedometerState, isRecording, testMode, handleStopRecording]);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = pedometerState;
    if ((pedometerState === 'provisional' || pedometerState === 'unlocked') &&
        !isSessionActiveRef.current) {
      startSession(stepCountRef.current);
      return;
    }
    if (pedometerState === 'locked' && prev !== 'checking' && prev !== 'unavailable' &&
        isSessionActiveRef.current) {
      let cancelled = false;
      (async () => {
        await pendingSaveRef.current;
        if (cancelled || !isSessionActiveRef.current) return;
        const snapshot = await endSession(stepCountRef.current);
        if (snapshot && snapshot.recordingIds.length > 0) {
          await addSession({
            id: snapshot.startedAt.toString(),
            started_at: snapshot.startedAt,
            ended_at:   snapshot.endedAt,
            steps:      snapshot.stepCount,
          });
          navigateToSummary(snapshot);
        }
      })();
      return () => { cancelled = true; };
    }
  }, [pedometerState, startSession, endSession, stepCountRef, addSession, navigateToSummary]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background') handleStopRecording();
    });
    return () => sub.remove();
  }, [handleStopRecording]);

  // ── AI status label ──────────────────────────────────────────────────────

  const aiStatus = modelError
    ? `AI error: ${modelError}`
    : !isModelReady && modelDownloadProgress > 0
    ? `Preparing AI… ${Math.round(modelDownloadProgress * 100)}%`
    : !isModelReady
    ? 'Loading AI model…'
    : processingType === 'transcribe' ? 'Transcribing…'
    : processingType === 'tag'        ? 'Tagging…'
    : null;

  // ── Grace period label ───────────────────────────────────────────────────

  const graceLabel = (() => {
    if (pedometerState === 'paused') return 'paused intentionally';
    if (graceSecondsLeft !== null && graceSecondsLeft < 60)
      return `stopping in ${graceSecondsLeft}s`;
    return pedometerState === 'unlocked' ? 'moving' : null;
  })();

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.appName}>stride</Text>
        <Pressable hitSlop={12}>
          <IconSymbol name="ellipsis" size={20} color={C.icon} />
        </Pressable>
      </View>

      {displayState === 'locked' || displayState === 'ready' ? (
        /* ══════════════════════════════════════════════════════════════════
           LOCKED / READY — home screen
        ══════════════════════════════════════════════════════════════════ */
        <>
          {/* Stats trio */}
          <View style={styles.statsRow}>
            {[
              { value: formatCount(totalRecordings), label: 'recordings' },
              { value: streak.toString(),             label: 'day streak' },
              { value: formatCount(totalSteps),       label: 'steps'     },
            ].map(({ value, label }) => (
              <View key={label} style={styles.statCard}>
                <Text style={styles.statValue}>{value}</Text>
                <Text style={styles.statLabel}>{label}</Text>
              </View>
            ))}
          </View>

          {/* Movement ring */}
          <View style={styles.ringContainer}>
            <View style={[styles.ring, { borderColor: ringColor }]}>
              <IconSymbol
                name="mic.fill"
                size={48}
                color={displayState === 'ready' ? C.tint : C.textTertiary}
              />
            </View>
          </View>

          {/* CTA */}
          <View style={styles.ctaSection}>
            <Text style={styles.ctaTitle}>start stride</Text>
            <Text style={styles.ctaSubtitle}>
              {pedometerState === 'unavailable'
                ? 'step counter not available on this device'
                : pedometerState === 'checking'
                ? 'checking motion sensor…'
                : displayState === 'ready'
                ? 'tap record to capture a thought'
                : 'walk to unlock recording'}
            </Text>
            {displayState === 'ready' && (
              <Pressable
                style={styles.recordButton}
                onPress={startRecording}
              >
                <Text style={styles.recordButtonText}>record</Text>
              </Pressable>
            )}
            {lastWalkRecordings && displayState === 'locked' && (
              <Pressable onPress={openLastWalk} style={{ marginTop: 20 }}>
                <Text style={styles.lastWalkLink}>view last walk →</Text>
              </Pressable>
            )}
            {aiStatus && (
              <Text style={styles.aiStatus}>{aiStatus}</Text>
            )}
          </View>

          {/* Test mode — small hidden tap target bottom-right */}
          {!testMode && (
            <Pressable
              onPress={() => setTestMode(true)}
              hitSlop={12}
              style={styles.testModeBtn}
            >
              <Text style={styles.testModeText}>⚙</Text>
            </Pressable>
          )}
        </>

      ) : (
        /* ══════════════════════════════════════════════════════════════════
           RECORDING — stride in progress
        ══════════════════════════════════════════════════════════════════ */
        <>
          {/* Timer ring */}
          <View style={styles.timerRingContainer}>
            <View style={[styles.timerRing, { borderColor: ringColor }]}>
              <Text style={styles.timerText}>{formatDuration(recordingSeconds)}</Text>
              {graceLabel && (
                <View style={styles.statusDot}>
                  <View style={[styles.dot, { backgroundColor: ringColor }]} />
                  <Text style={[styles.statusText, { color: ringColor }]}>{graceLabel}</Text>
                </View>
              )}
            </View>
          </View>

          {/* Step count */}
          <View style={styles.stepSection}>
            <Text style={styles.stepCount}>{stepCount.toLocaleString()}</Text>
            <Text style={styles.stepLabel}>steps this stride</Text>
            <Text style={styles.distanceLabel}>
              {distanceMiles.toFixed(2)} mi · keep going
            </Text>
          </View>

          {/* Live waveform */}
          <View style={styles.waveformContainer}>
            <LiveWaveform samples={liveWaveform} color={ringColor} />
          </View>

          {/* Controls */}
          <View style={styles.controls}>
            <Pressable
              style={styles.pauseButton}
              onPress={pedometerState === 'paused' ? resumeFromPause : pauseIntentionally}
            >
              <Text style={styles.pauseButtonText}>
                {pedometerState === 'paused' ? 'resume' : 'pause intentionally'}
              </Text>
            </Pressable>

            <Pressable style={styles.endButton} onPress={handleEndSession}>
              <Text style={styles.endButtonText}>end & summarise</Text>
            </Pressable>
          </View>

          {aiStatus && (
            <Text style={[styles.aiStatus, { textAlign: 'center' }]}>{aiStatus}</Text>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const RING_SIZE       = 220;
const TIMER_RING_SIZE = 180;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    paddingHorizontal: 24,
    paddingTop:     16,
    paddingBottom:  8,
  },
  appName: {
    fontSize:   32,
    fontWeight: '700',
    color:      C.text,
    letterSpacing: -0.5,
  },

  // ── Stats ────────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection:    'row',
    gap:              10,
    marginHorizontal: 24,
    marginTop:        12,
  },
  statCard: {
    flex:            1,
    backgroundColor: C.surface,
    borderRadius:    12,
    paddingVertical:   14,
    paddingHorizontal: 10,
    alignItems:      'center',
  },
  statValue: {
    fontSize:   20,
    fontWeight: '700',
    color:      C.text,
  },
  statLabel: {
    fontSize:  11,
    color:     C.textSecondary,
    marginTop: 2,
    textAlign: 'center',
  },

  // ── Locked / Ready ───────────────────────────────────────────────────────
  ringContainer: {
    flex:           1,
    justifyContent: 'center',
    alignItems:     'center',
  },
  ring: {
    width:        RING_SIZE,
    height:       RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth:  2,
    justifyContent: 'center',
    alignItems:     'center',
    backgroundColor: C.surface,
  },
  ctaSection: {
    alignItems:    'center',
    paddingBottom: 32,
    paddingHorizontal: 32,
    gap: 6,
  },
  ctaTitle: {
    fontSize:   24,
    fontWeight: '700',
    color:      C.text,
    letterSpacing: -0.3,
  },
  ctaSubtitle: {
    fontSize: 14,
    color:    C.textSecondary,
    textAlign: 'center',
  },
  recordButton: {
    marginTop:       16,
    backgroundColor: C.tint,
    paddingVertical:   14,
    paddingHorizontal: 48,
    borderRadius:    30,
  },
  recordButtonText: {
    fontSize:   16,
    fontWeight: '600',
    color:      C.text,
    letterSpacing: 0.3,
  },
  lastWalkLink: {
    fontSize: 14,
    color:    C.tint,
  },
  testModeBtn: {
    position: 'absolute',
    bottom:   32,
    right:    24,
  },
  testModeText: {
    fontSize: 18,
    color:    C.textTertiary,
  },

  // ── Recording ────────────────────────────────────────────────────────────
  timerRingContainer: {
    alignItems:  'center',
    marginTop:   24,
    marginBottom: 8,
  },
  timerRing: {
    width:        TIMER_RING_SIZE,
    height:       TIMER_RING_SIZE,
    borderRadius: TIMER_RING_SIZE / 2,
    borderWidth:  3,
    justifyContent: 'center',
    alignItems:     'center',
    backgroundColor: C.surface,
    gap: 4,
  },
  timerText: {
    fontSize:   36,
    fontWeight: '700',
    color:      C.text,
    letterSpacing: -1,
  },
  statusDot: {
    flexDirection: 'row',
    alignItems:    'center',
    gap: 4,
  },
  dot: {
    width:        6,
    height:       6,
    borderRadius: 3,
  },
  statusText: {
    fontSize:   12,
    fontWeight: '500',
  },
  stepSection: {
    alignItems: 'center',
    marginTop:  8,
  },
  stepCount: {
    fontSize:   52,
    fontWeight: '800',
    color:      C.text,
    letterSpacing: -1.5,
  },
  stepLabel: {
    fontSize:  13,
    color:     C.textSecondary,
    marginTop: -4,
  },
  distanceLabel: {
    fontSize:  13,
    color:     C.textTertiary,
    marginTop: 2,
  },
  waveformContainer: {
    alignItems:    'center',
    marginTop:     20,
    marginBottom:  12,
  },
  controls: {
    paddingHorizontal: 24,
    gap: 10,
    marginTop: 8,
  },
  pauseButton: {
    backgroundColor: C.surfaceHigh,
    paddingVertical: 16,
    borderRadius:    14,
    alignItems:      'center',
  },
  pauseButtonText: {
    fontSize:   16,
    fontWeight: '600',
    color:      C.text,
  },
  endButton: {
    backgroundColor: 'transparent',
    paddingVertical: 14,
    borderRadius:    14,
    alignItems:      'center',
    borderWidth:     1,
    borderColor:     C.border,
  },
  endButtonText: {
    fontSize:   15,
    fontWeight: '500',
    color:      C.textSecondary,
  },
  aiStatus: {
    fontSize:  12,
    color:     C.textTertiary,
    marginTop: 12,
    paddingHorizontal: 24,
  },
});
