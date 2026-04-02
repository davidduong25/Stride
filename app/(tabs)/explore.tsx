import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Button,
  Pressable,
  SectionList,
  ScrollView,
  Text,
  TextInput,
  View,
  type SectionListData,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { Svg, Rect, Line } from 'react-native-svg';

import { useRouter } from 'expo-router';

import { useRecordingsContext, type RecordingEntry } from '@/context/recordings-context';
import { useAIQueue, VALID_TAGS, type Tag } from '@/context/ai-queue-context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const SESSION_GAP_MS = 30 * 60 * 1000;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };

const TAG_COLORS: Record<Tag, string> = {
  idea:       '#E3F2FD',
  vent:       '#FCE4EC',
  gratitude:  '#E8F5E9',
  plan:       '#FFF3E0',
  reflection: '#F3E5F5',
  question:   '#E0F7FA',
};

const TAG_BORDER: Record<Tag, string> = {
  idea:       '#90CAF9',
  vent:       '#F48FB1',
  gratitude:  '#A5D6A7',
  plan:       '#FFCC80',
  reflection: '#CE93D8',
  question:   '#80DEEA',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadedSound = { player: AudioPlayer; durationMs: number; sub: { remove: () => void } | null };

type SessionSection = SectionListData<RecordingEntry> & {
  sessionDate: string;
  totalDuration: number;
  steps: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function buildSessions(recordings: RecordingEntry[]): SessionSection[] {
  if (!recordings.length) return [];
  const sections: SessionSection[] = [];
  let group: RecordingEntry[] = [recordings[0]];

  for (let i = 1; i < recordings.length; i++) {
    const prevMs = new Date(group[group.length - 1].date).getTime();
    const currMs = new Date(recordings[i].date).getTime();
    if (prevMs - currMs <= SESSION_GAP_MS) {
      group.push(recordings[i]);
    } else {
      sections.push(toSection(group));
      group = [recordings[i]];
    }
  }
  sections.push(toSection(group));
  return sections;
}

function toSection(entries: RecordingEntry[]): SessionSection {
  return {
    sessionDate: entries[0].date,
    totalDuration: entries.reduce((s, e) => s + e.duration, 0),
    steps: entries[0].steps ?? null,
    data: entries,
  };
}

function normaliseDb(db: number, maxHeight: number): number {
  const FLOOR = -60;
  const clamped = Math.max(FLOOR, Math.min(0, db));
  return Math.max(2, ((clamped - FLOOR) / -FLOOR) * maxHeight);
}

// ---------------------------------------------------------------------------
// WaveformScrubber
// ---------------------------------------------------------------------------

function WaveformScrubber({
  samples,
  positionMs,
  durationMs,
  onSeek,
  disabled,
}: {
  samples: number[];
  positionMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
  disabled: boolean;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const HEIGHT = 56;
  const BAR_COUNT = Math.min(samples.length, 120);
  const step = samples.length / BAR_COUNT;
  const bars = Array.from({ length: BAR_COUNT }, (_, i) =>
    samples[Math.round(i * step)] ?? -60
  );
  const playedFraction = durationMs > 0 ? positionMs / durationMs : 0;
  const w = containerWidth || 1;

  function handlePress(e: { nativeEvent: { locationX: number } }) {
    if (disabled || durationMs === 0 || !containerWidth) return;
    const fraction = Math.max(0, Math.min(1, e.nativeEvent.locationX / containerWidth));
    onSeek(fraction * durationMs);
  }

  return (
    <Pressable
      onPress={handlePress}
      onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      style={{ height: HEIGHT, marginVertical: 6 }}
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

// ---------------------------------------------------------------------------
// LibraryScreen
// ---------------------------------------------------------------------------

export default function LibraryScreen() {
  const router = useRouter();
  const { recordings, updateRecording, deleteRecording } = useRecordingsContext();
  const {
    processingId,
    processingType,
    suggestedTagsMap,
    acceptSuggestion,
    dismissSuggestion,
  } = useAIQueue();

  // Playback
  const [playingId, setPlayingId]   = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed]           = useState(1.0);
  const soundMapRef  = useRef<Map<string, LoadedSound>>(new Map());
  const activeIdRef  = useRef<string | null>(null);
  const updateRecRef = useRef(updateRecording);
  useEffect(() => { updateRecRef.current = updateRecording; });

  // UI
  const [activeFilter, setActiveFilter]               = useState<Tag | null>(null);
  const [renamingId, setRenamingId]                   = useState<string | null>(null);
  const [renameText, setRenameText]                   = useState('');
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());
  const [tagSelections, setTagSelections]             = useState<Record<string, Set<Tag>>>({});

  // Seed tag-selection state when new suggestions arrive
  useEffect(() => {
    setTagSelections(prev => {
      let changed = false;
      const updates: Record<string, Set<Tag>> = {};
      for (const [id, tags] of Object.entries(suggestedTagsMap)) {
        if (!prev[id]) { updates[id] = new Set(tags); changed = true; }
      }
      return changed ? { ...prev, ...updates } : prev;
    });
  }, [suggestedTagsMap]);

  // Audio mode — once on mount
  useEffect(() => {
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }, []);

  // ---------------------------------------------------------------------------
  // Sound loading
  // ---------------------------------------------------------------------------

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

  function unloadSound(id: string) {
    const loaded = soundMapRef.current.get(id);
    if (loaded) {
      loaded.sub?.remove();
      loaded.player.remove();
      soundMapRef.current.delete(id);
    }
  }

  useEffect(() => {
    return () => {
      soundMapRef.current.forEach(({ player, sub }) => { sub?.remove(); player.remove(); });
      soundMapRef.current.clear();
    };
  }, []);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ item: RecordingEntry | null }> }) => {
      viewableItems.forEach(({ item }) => { if (item) loadSound(item); });
    },
    [loadSound]
  );

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  async function stopPlayback() {
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

  async function togglePlayback(entry: RecordingEntry) {
    if (playingId === entry.id) { await stopPlayback(); return; }

    if (activeIdRef.current) {
      const prev = soundMapRef.current.get(activeIdRef.current);
      if (prev) {
        prev.sub?.remove();
        prev.sub = null;
        prev.player.pause();
        await prev.player.seekTo(0);
      }
      activeIdRef.current = null;
    }

    const loaded = loadSound(entry);
    if (!loaded) return;

    activeIdRef.current = entry.id;
    setPlayingId(entry.id);
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
        setPlayingId(null); setPositionMs(0); setDurationMs(0);
        return;
      }
      setPositionMs(status.currentTime * 1000);
    });

    loaded.player.play();
    loaded.player.setPlaybackRate(speed, 'medium');
  }

  async function handleSpeedToggle() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (activeIdRef.current) {
      const loaded = soundMapRef.current.get(activeIdRef.current);
      if (loaded) loaded.player.setPlaybackRate(next, 'medium');
    }
  }

  async function handleSeek(ms: number) {
    if (activeIdRef.current) {
      const loaded = soundMapRef.current.get(activeIdRef.current);
      if (loaded) await loaded.player.seekTo(ms / 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------------------

  function startRename(entry: RecordingEntry) {
    setRenamingId(entry.id);
    setRenameText(entry.filename);
  }

  async function confirmRename(id: string) {
    const trimmed = renameText.trim();
    if (trimmed) await updateRecording(id, { filename: trimmed });
    setRenamingId(null);
    setRenameText('');
  }

  function cancelRename() { setRenamingId(null); setRenameText(''); }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  function confirmDelete(entry: RecordingEntry) {
    Alert.alert('Delete Recording', `Delete "${entry.filename}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          if (playingId === entry.id) await stopPlayback();
          await unloadSound(entry.id);
          deleteRecording(entry.id);
        },
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  function toggleTranscript(id: string) {
    setExpandedTranscripts(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // ---------------------------------------------------------------------------
  // Tag suggestions
  // ---------------------------------------------------------------------------

  function toggleTagSel(recordingId: string, tag: Tag) {
    setTagSelections(prev => {
      const cur = new Set<Tag>(prev[recordingId] ?? []);
      if (cur.has(tag)) cur.delete(tag); else cur.add(tag);
      return { ...prev, [recordingId]: cur };
    });
  }

  async function handleAccept(recordingId: string) {
    const selected = [...(tagSelections[recordingId] ?? new Set<Tag>())];
    if (selected.length > 0) await acceptSuggestion(recordingId, selected);
    else dismissSuggestion(recordingId);
    setTagSelections(prev => { const n = { ...prev }; delete n[recordingId]; return n; });
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const filteredRecordings = activeFilter
    ? recordings.filter(r => r.tags?.split(',').includes(activeFilter))
    : recordings;

  const sections = buildSessions(filteredRecordings);

  // Always derived from unfiltered recordings so the card shows the true latest session
  const latestSection = recordings.length > 0 ? buildSessions(recordings)[0] : null;

  function openLatestSession() {
    if (!latestSection) return;
    const data = latestSection.data;
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt: new Date(data[data.length - 1].date).getTime().toString(),
        endedAt: (new Date(data[0].date).getTime() + data[0].duration * 1000).toString(),
        steps: (latestSection.steps ?? 0).toString(),
        recordingIds: data.map(r => r.id).join(','),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sub-renders
  // ---------------------------------------------------------------------------

  function renderTagChips(tags: string) {
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
        {tags.split(',').filter(Boolean).map(tag => (
          <View
            key={tag}
            style={{
              paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
              backgroundColor: TAG_COLORS[tag as Tag] ?? '#F0F0F0',
              borderWidth: 1, borderColor: TAG_BORDER[tag as Tag] ?? '#CCC',
            }}
          >
            <Text style={{ fontSize: 11 }}>{tag}</Text>
          </View>
        ))}
      </View>
    );
  }

  function renderTranscriptSection(item: RecordingEntry) {
    const isTranscribing = processingId === item.id && processingType === 'transcribe';
    if (isTranscribing) {
      return <Text style={{ color: '#888', fontSize: 12, marginTop: 4 }}>Transcribing…</Text>;
    }
    if (!item.transcript) return null;
    const expanded = expandedTranscripts.has(item.id);
    return (
      <View style={{ marginTop: 4 }}>
        <Pressable onPress={() => toggleTranscript(item.id)}>
          <Text style={{ color: '#007AFF', fontSize: 12 }}>
            {expanded ? '▼ Transcript' : '▶ Transcript'}
          </Text>
        </Pressable>
        {expanded && (
          <Text style={{ fontSize: 12, color: '#333', marginTop: 2 }}>
            {item.transcript}
          </Text>
        )}
      </View>
    );
  }

  function renderTagSuggestions(item: RecordingEntry) {
    const suggested = suggestedTagsMap[item.id];
    const isTagging = processingId === item.id && processingType === 'tag';
    if (isTagging) {
      return <Text style={{ color: '#888', fontSize: 12, marginTop: 4 }}>Generating tags…</Text>;
    }
    if (!suggested) return null;
    const selected = tagSelections[item.id] ?? new Set<Tag>();
    return (
      <View style={{ marginTop: 6, padding: 8, backgroundColor: '#FFFDE7', borderRadius: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: '600', marginBottom: 4 }}>Suggested tags:</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {VALID_TAGS.map(tag => {
            const isSuggested = suggested.includes(tag);
            const isSel = selected.has(tag);
            if (!isSuggested && !isSel) return null;
            return (
              <Pressable
                key={tag}
                onPress={() => toggleTagSel(item.id, tag)}
                style={{
                  paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12,
                  backgroundColor: isSel ? (TAG_COLORS[tag] ?? '#E0E0E0') : '#F5F5F5',
                  borderWidth: 1,
                  borderColor: isSel ? (TAG_BORDER[tag] ?? '#AAA') : '#DDD',
                }}
              >
                <Text style={{ fontSize: 12 }}>{tag}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="Accept" onPress={() => handleAccept(item.id)} />
          <Button title="Dismiss" onPress={() => dismissSuggestion(item.id)} />
        </View>
      </View>
    );
  }

  function renderScrubber(item: RecordingEntry) {
    if (playingId !== item.id) return null;
    const waveformData = item.waveform ? (JSON.parse(item.waveform) as number[]) : null;
    if (waveformData && waveformData.length > 0) {
      return (
        <WaveformScrubber
          samples={waveformData}
          positionMs={positionMs}
          durationMs={durationMs}
          onSeek={handleSeek}
          disabled={durationMs === 0}
        />
      );
    }
    return (
      <Slider
        value={durationMs > 0 ? positionMs : 0}
        minimumValue={0}
        maximumValue={durationMs > 0 ? durationMs : 1}
        onSlidingComplete={handleSeek}
        disabled={durationMs === 0}
      />
    );
  }

  function renderItem({ item }: { item: RecordingEntry }) {
    const isPlaying  = playingId === item.id;
    const isRenaming = renamingId === item.id;
    return (
      <View style={{
        paddingVertical: 12, paddingHorizontal: 16,
        borderBottomWidth: 1, borderColor: '#E0E0E0',
      }}>
        {isRenaming ? (
          <View>
            <TextInput
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              selectTextOnFocus
              style={{
                borderWidth: 1, borderColor: '#aaa', borderRadius: 4,
                padding: 6, marginBottom: 6,
              }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title="Save" onPress={() => confirmRename(item.id)} />
              <Button title="Cancel" onPress={cancelRename} />
            </View>
          </View>
        ) : (
          <Text style={{ fontWeight: '500' }}>{item.filename}</Text>
        )}

        <Text style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
          {formatDate(item.date)} — {formatDuration(item.duration)}
          {item.steps != null ? ` · ${item.steps} steps` : ''}
        </Text>

        {item.tags ? renderTagChips(item.tags) : null}

        {renderScrubber(item)}

        <View style={{
          flexDirection: 'row', alignItems: 'center',
          flexWrap: 'wrap', gap: 8, marginTop: 4,
        }}>
          <Button title={isPlaying ? 'Stop' : 'Play'} onPress={() => togglePlayback(item)} />
          <Button title={`${speed}×`} onPress={handleSpeedToggle} />
          {!isRenaming && <Button title="Rename" onPress={() => startRename(item)} />}
          <Button title="Delete" onPress={() => confirmDelete(item)} />
        </View>

        {renderTranscriptSection(item)}
        {renderTagSuggestions(item)}
      </View>
    );
  }

  function renderSectionHeader({ section }: { section: SessionSection }) {
    return (
      <View style={{
        backgroundColor: '#F5F5F5',
        paddingVertical: 8, paddingHorizontal: 16,
      }}>
        <Text style={{ fontWeight: '700', fontSize: 14 }}>
          {formatDate(section.sessionDate)}
        </Text>
        <Text style={{ fontSize: 12, color: '#555' }}>
          {formatDuration(section.totalDuration)}
          {section.steps != null ? ` · ${section.steps} steps` : ''}
        </Text>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      {latestSection && (
        <Pressable
          onPress={openLatestSession}
          style={{
            marginHorizontal: 12, marginTop: 12, marginBottom: 4,
            padding: 12, borderRadius: 10,
            backgroundColor: '#F0F7FF',
            borderWidth: 1, borderColor: '#BFD7F5',
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: '#0a7ea4', marginBottom: 4, letterSpacing: 0.5 }}>
            LATEST SESSION
          </Text>
          <Text style={{ fontSize: 14, fontWeight: '500', color: '#11181C' }}>
            {formatDate(latestSection.sessionDate)}
          </Text>
          <Text style={{ fontSize: 12, color: '#687076', marginTop: 2 }}>
            {formatDuration(latestSection.totalDuration)}
            {latestSection.steps != null ? ` · ${latestSection.steps} steps` : ''}
          </Text>
        </Pressable>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}
      >
        <Pressable
          onPress={() => setActiveFilter(null)}
          style={{
            paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12,
            backgroundColor: activeFilter === null ? '#007AFF' : '#F0F0F0',
            borderWidth: 1, borderColor: activeFilter === null ? '#007AFF' : '#DDD',
          }}
        >
          <Text style={{ color: activeFilter === null ? '#FFF' : '#333', fontSize: 13 }}>All</Text>
        </Pressable>
        {VALID_TAGS.map(tag => (
          <Pressable
            key={tag}
            onPress={() => setActiveFilter(prev => prev === tag ? null : tag)}
            style={{
              paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12,
              backgroundColor: activeFilter === tag ? TAG_COLORS[tag] : '#F0F0F0',
              borderWidth: 1,
              borderColor: activeFilter === tag ? TAG_BORDER[tag] : '#DDD',
            }}
          >
            <Text style={{ fontSize: 13 }}>{tag}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <SectionList
        sections={sections}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={VIEWABILITY_CONFIG}
        stickySectionHeadersEnabled
        ListEmptyComponent={
          <View style={{ padding: 24 }}>
            <Text style={{ color: '#888', textAlign: 'center' }}>
              {activeFilter
                ? `No recordings tagged "${activeFilter}".`
                : 'No recordings yet. Start walking to record.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}
