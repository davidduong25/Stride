import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { Svg, Rect, Line } from 'react-native-svg';

import { useRecordingsContext, type RecordingEntry } from '@/context/recordings-context';

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatMs(ms: number): string {
  return formatDuration(Math.round(ms / 1000));
}

function normaliseDb(db: number, maxHeight: number): number {
  const FLOOR = -60;
  const clamped = Math.max(FLOOR, Math.min(0, db));
  return Math.max(2, ((clamped - FLOOR) / -FLOOR) * maxHeight);
}

// ── WaveformBar ───────────────────────────────────────────────────────────────

function WaveformBar({
  samples,
  positionMs,
  durationMs,
  onSeek,
}: {
  samples: number[];
  positionMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const HEIGHT = 48;
  const BAR_COUNT = Math.min(samples.length, 100);
  const step = samples.length / BAR_COUNT;
  const bars = Array.from({ length: BAR_COUNT }, (_, i) =>
    samples[Math.round(i * step)] ?? -60
  );
  const playedFraction = durationMs > 0 ? positionMs / durationMs : 0;
  const w = containerWidth || 1;

  function handlePress(e: { nativeEvent: { locationX: number } }) {
    if (durationMs === 0 || !containerWidth) return;
    const fraction = Math.max(0, Math.min(1, e.nativeEvent.locationX / containerWidth));
    onSeek(fraction * durationMs);
  }

  return (
    <Pressable
      onPress={handlePress}
      onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      style={{ height: HEIGHT, marginVertical: 4 }}
    >
      <Svg width={w} height={HEIGHT}>
        {bars.map((db, i) => {
          const barW = w / BAR_COUNT;
          const bh = normaliseDb(db, HEIGHT - 8);
          const played = i / BAR_COUNT <= playedFraction;
          return (
            <Rect
              key={i}
              x={i * barW + 1}
              y={(HEIGHT - bh) / 2}
              width={Math.max(1, barW - 2)}
              height={bh}
              fill={played ? '#007AFF' : '#C7C7CC'}
              rx={1}
            />
          );
        })}
        <Line
          x1={playedFraction * w}
          y1={0}
          x2={playedFraction * w}
          y2={HEIGHT}
          stroke="#007AFF"
          strokeWidth={2}
        />
      </Svg>
    </Pressable>
  );
}

// ── RecordingItem ─────────────────────────────────────────────────────────────

type LoadedSound = { player: AudioPlayer; durationMs: number; sub: { remove: () => void } | null };

function RecordingItem({
  item,
  index,
  isActive,
  positionMs,
  durationMs,
  onPlay,
  onSeek,
}: {
  item: RecordingEntry;
  index: number;
  isActive: boolean;
  positionMs: number;
  durationMs: number;
  onPlay: (id: string) => void;
  onSeek: (ms: number) => void;
}) {
  const waveformSamples = item.waveform ? (JSON.parse(item.waveform) as number[]) : null;
  const displayDurationMs = isActive && durationMs > 0 ? durationMs : item.duration * 1000;

  return (
    <View style={styles.clipRow}>
      <View style={styles.clipHeader}>
        <Text style={styles.clipTitle}>Clip {index + 1}</Text>
        <Text style={styles.clipDuration}>
          {isActive
            ? `${formatMs(positionMs)} / ${formatMs(displayDurationMs)}`
            : formatDuration(item.duration)}
        </Text>
      </View>

      {isActive && waveformSamples && waveformSamples.length > 0 && (
        <WaveformBar
          samples={waveformSamples}
          positionMs={positionMs}
          durationMs={durationMs}
          onSeek={onSeek}
        />
      )}

      <Pressable
        style={[styles.playButton, isActive && styles.playButtonActive]}
        onPress={() => onPlay(item.id)}
      >
        <Text style={[styles.playButtonText, isActive && styles.playButtonTextActive]}>
          {isActive ? 'Pause' : 'Play'}
        </Text>
      </Pressable>
    </View>
  );
}

// ── WalkSummaryScreen ─────────────────────────────────────────────────────────

export default function WalkSummaryScreen() {
  const {
    startedAt: startedAtStr,
    endedAt: endedAtStr,
    steps: stepsStr,
    recordingIds: recordingIdsStr,
  } = useLocalSearchParams<{
    startedAt: string;
    endedAt: string;
    steps: string;
    recordingIds: string;
  }>();

  const { recordings } = useRecordingsContext();

  const startedAt = Number(startedAtStr ?? 0);
  const endedAt = Number(endedAtStr ?? 0);
  const steps = Number(stepsStr ?? 0);
  const recordingIds = recordingIdsStr ? recordingIdsStr.split(',').filter(Boolean) : [];

  const sessionDurationSec = Math.round((endedAt - startedAt) / 1000);

  // Preserve session recording order (not sorted by date)
  const sessionRecordings = recordingIds
    .map(id => recordings.find(r => r.id === id))
    .filter((r): r is RecordingEntry => r !== undefined);

  // ── playback ──────────────────────────────────────────────────────────────

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const soundMapRef = useRef<Map<string, LoadedSound>>(new Map());
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    return () => {
      soundMapRef.current.forEach(({ player, sub }) => { sub?.remove(); player.remove(); });
      soundMapRef.current.clear();
    };
  }, []);

  const loadSound = useCallback((entry: RecordingEntry): LoadedSound | null => {
    if (soundMapRef.current.has(entry.id)) return soundMapRef.current.get(entry.id)!;
    try {
      const player = createAudioPlayer({ uri: entry.uri });
      const loaded: LoadedSound = { player, durationMs: player.duration * 1000, sub: null };
      soundMapRef.current.set(entry.id, loaded);
      return loaded;
    } catch {
      return null;
    }
  }, []);

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
    if (playingId === id) {
      await stopCurrentPlayback();
      return;
    }

    await stopCurrentPlayback();

    const entry = sessionRecordings.find(r => r.id === id);
    if (!entry) return;

    const loaded = loadSound(entry);
    if (!loaded) return;

    activeIdRef.current = id;
    setPlayingId(id);
    setPositionMs(0);
    setDurationMs(loaded.durationMs);

    loaded.sub = loaded.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (!status.isLoaded) return;
      if (status.duration > 0) {
        setDurationMs(status.duration * 1000);
        loaded.durationMs = status.duration * 1000;
      }
      if (status.didJustFinish) {
        loaded.sub?.remove();
        loaded.sub = null;
        activeIdRef.current = null;
        setPlayingId(null);
        setPositionMs(0);
        setDurationMs(0);
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

  // ── render ────────────────────────────────────────────────────────────────

  const sessionDate = startedAt
    ? new Date(startedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })
    : '';

  return (
    <>
      <Stack.Screen options={{ title: 'Walk Summary', headerBackTitle: 'Done' }} />
      <View style={styles.container}>
        {sessionDate ? <Text style={styles.dateText}>{sessionDate}</Text> : null}

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatDuration(sessionDurationSec)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{steps.toLocaleString()}</Text>
            <Text style={styles.statLabel}>Steps</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{sessionRecordings.length}</Text>
            <Text style={styles.statLabel}>Clips</Text>
          </View>
        </View>

        <FlatList
          data={sessionRecordings}
          keyExtractor={item => item.id}
          renderItem={({ item, index }) => (
            <RecordingItem
              item={item}
              index={index}
              isActive={playingId === item.id}
              positionMs={positionMs}
              durationMs={durationMs}
              onPlay={handlePlay}
              onSeek={handleSeek}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No recordings this walk.</Text>
            </View>
          }
          contentContainerStyle={styles.listContent}
        />
      </View>
    </>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  dateText: {
    fontSize: 14,
    color: '#687076',
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 4,
  },
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingVertical: 16,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#11181C',
  },
  statLabel: {
    fontSize: 12,
    color: '#687076',
    marginTop: 2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: '#C0C0C0',
    marginVertical: 4,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  clipRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  clipHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  clipTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#11181C',
  },
  clipDuration: {
    fontSize: 13,
    color: '#687076',
  },
  playButton: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#F0F0F0',
    alignSelf: 'flex-start',
  },
  playButtonActive: {
    backgroundColor: '#007AFF',
  },
  playButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#11181C',
  },
  playButtonTextActive: {
    color: '#fff',
  },
  emptyContainer: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
    color: '#888',
  },
});
