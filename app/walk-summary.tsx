import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { File } from 'expo-file-system';
import * as Calendar from 'expo-calendar';
import { captureRef } from 'react-native-view-shot';

import { C } from '@/constants/theme';
import { WaveformScrubber } from '@/components/WaveformScrubber';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useRecordingsContext, type RecordingEntry } from '@/context/recordings-context';
import { useSessionsContext } from '@/context/sessions-context';
import { useAIQueue, type WalkType, VALID_WALK_TYPES, WALK_TYPE_LABELS, WALK_TYPE_DESCRIPTIONS } from '@/context/ai-queue-context';

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

function dominantWalkType(tags: (string | null)[]): WalkType | null {
  const valid = tags.filter((t): t is WalkType =>
    t !== null && (VALID_WALK_TYPES as readonly string[]).includes(t as string)
  );
  if (valid.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const t of valid) counts[t] = (counts[t] ?? 0) + 1;
  return valid.reduce((a, b) => counts[a] >= counts[b] ? a : b);
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
// TypePicker
// ---------------------------------------------------------------------------

function TypePicker({
  selected,
  onSelect,
}: {
  selected: WalkType | null;
  onSelect: (type: WalkType) => void;
}) {
  return (
    <View style={pickerStyles.grid}>
      {VALID_WALK_TYPES.map(type => (
        <Pressable
          key={type}
          onPress={() => onSelect(type)}
          style={[pickerStyles.chip, selected === type && pickerStyles.chipActive]}
        >
          <Text style={[pickerStyles.chipLabel, selected === type && pickerStyles.chipLabelActive]}>
            {WALK_TYPE_LABELS[type]}
          </Text>
          <Text style={[pickerStyles.chipDesc, selected === type && pickerStyles.chipDescActive]}>
            {WALK_TYPE_DESCRIPTIONS[type]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            8,
    marginTop:      12,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical:   10,
    borderRadius:      12,
    backgroundColor:   C.surfaceHigh,
    borderWidth:       1,
    borderColor:       C.border,
    gap:                2,
  },
  chipActive: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  chipLabel: {
    fontSize:   13,
    fontWeight: '600',
    color:      C.textSecondary,
  },
  chipLabelActive: {
    color: C.text,
  },
  chipDesc: {
    fontSize:   11,
    color:      C.textTertiary,
    lineHeight: 15,
  },
  chipDescActive: {
    color:   C.text,
    opacity: 0.75,
  },
});

// ---------------------------------------------------------------------------
// EditableText — tap to edit AI-generated text inline
// ---------------------------------------------------------------------------

function EditableText({
  value,
  onSave,
  style,
  containerStyle,
  multiline = false,
}: {
  value:           string;
  onSave:          (text: string) => void;
  style?:          any;
  containerStyle?: any;
  multiline?:      boolean;
}) {
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) {
      onSave(trimmed);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      setJustSaved(true);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 1500);
    }
  }

  if (editing) {
    return (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        multiline={multiline}
        autoFocus
        style={[style, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.tint, paddingBottom: 2 }]}
        scrollEnabled={false}
        blurOnSubmit={!multiline}
      />
    );
  }

  return (
    <Pressable onPress={() => { setDraft(value); setEditing(true); }} hitSlop={4} style={containerStyle}>
      <Text style={style}>{value}</Text>
      {justSaved && (
        <Text style={{ fontSize: 11, color: C.green, marginTop: 3 }}>✓ saved</Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// SummaryContent — type-specific summary rendering
// ---------------------------------------------------------------------------

function SummaryContent({
  walkType,
  summary,
  keyPoints,
  actions,
  onUpdateSummary,
  onUpdateKeyPoint,
  onUpdateAction,
}: {
  walkType:         WalkType;
  summary:          string | null;
  keyPoints:        string[];
  actions:          string[];
  onUpdateSummary:  (text: string) => void;
  onUpdateKeyPoint: (index: number, text: string) => void;
  onUpdateAction:   (index: number, text: string) => void;
}) {
  const [checkedItems, setCheckedItems] = useState<Set<number>>(new Set());

  function toggleCheck(i: number) {
    setCheckedItems(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  const hasContent =
    ((walkType === 'vent' || walkType === 'reflect') && !!summary) ||
    ((walkType === 'brainstorm' || walkType === 'appreciate') && keyPoints.length > 0) ||
    (walkType === 'plan' && actions.length > 0) ||
    (walkType === 'untangle' && (keyPoints.length > 0 || !!summary));

  if (!hasContent) {
    return (
      <Text style={summaryStyles.emptyText}>
        Couldn't generate a summary. Tap re-summarise to try again.
      </Text>
    );
  }

  if (walkType === 'vent' || walkType === 'reflect') {
    return summary ? (
      <EditableText
        value={summary}
        onSave={onUpdateSummary}
        style={summaryStyles.prose}
        multiline
      />
    ) : null;
  }

  if (walkType === 'brainstorm') {
    return keyPoints.length > 0 ? (
      <View>
        <Text style={summaryStyles.sectionLabel}>IDEAS</Text>
        {keyPoints.map((p, i) => (
          <View key={i} style={summaryStyles.bulletRow}>
            <Text style={summaryStyles.bulletDot}>•</Text>
            <EditableText
              value={p}
              onSave={(text) => onUpdateKeyPoint(i, text)}
              style={summaryStyles.bulletText}
              containerStyle={{ flex: 1 }}
            />
          </View>
        ))}
      </View>
    ) : null;
  }

  if (walkType === 'plan') {
    return actions.length > 0 ? (
      <View>
        <Text style={summaryStyles.sectionLabel}>ACTIONS</Text>
        {actions.map((a, i) => (
          <View key={i} style={summaryStyles.bulletRow}>
            <Pressable
              onPress={() => toggleCheck(i)}
              hitSlop={8}
              style={[summaryStyles.checkbox, checkedItems.has(i) && summaryStyles.checkboxChecked]}
            >
              {checkedItems.has(i) && (
                <IconSymbol name="checkmark" size={10} color={C.background} />
              )}
            </Pressable>
            <EditableText
              value={a}
              onSave={(text) => onUpdateAction(i, text)}
              style={[summaryStyles.bulletText, checkedItems.has(i) && summaryStyles.bulletTextDone]}
              containerStyle={{ flex: 1 }}
            />
          </View>
        ))}
      </View>
    ) : null;
  }

  if (walkType === 'appreciate') {
    return keyPoints.length > 0 ? (
      <View>
        <Text style={summaryStyles.sectionLabel}>APPRECIATIONS</Text>
        {keyPoints.map((p, i) => (
          <View key={i} style={summaryStyles.bulletRow}>
            <Text style={summaryStyles.bulletDot}>•</Text>
            <EditableText
              value={p}
              onSave={(text) => onUpdateKeyPoint(i, text)}
              style={summaryStyles.bulletText}
              containerStyle={{ flex: 1 }}
            />
          </View>
        ))}
      </View>
    ) : null;
  }

  if (walkType === 'untangle') {
    return (
      <View>
        {keyPoints.length > 0 && (
          <>
            <Text style={summaryStyles.sectionLabel}>OPTIONS</Text>
            {keyPoints.map((p, i) => (
              <View key={i} style={summaryStyles.bulletRow}>
                <Text style={summaryStyles.bulletDot}>•</Text>
                <EditableText
                  value={p}
                  onSave={(text) => onUpdateKeyPoint(i, text)}
                  style={summaryStyles.bulletText}
                  containerStyle={{ flex: 1 }}
                />
              </View>
            ))}
          </>
        )}
        {summary && (
          <>
            <Text style={[summaryStyles.sectionLabel, { marginTop: 16 }]}>LEANING TOWARD</Text>
            <EditableText
              value={summary}
              onSave={onUpdateSummary}
              style={summaryStyles.prose}
              multiline
            />
          </>
        )}
      </View>
    );
  }

  return null;
}

const summaryStyles = StyleSheet.create({
  emptyText: {
    fontSize:  15,
    color:     C.textSecondary,
    lineHeight: 22,
    fontStyle: 'italic',
  },
  prose: {
    fontSize:   15,
    color:      C.text,
    lineHeight: 23,
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginBottom:  10,
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
    width:           16,
    height:          16,
    borderRadius:     4,
    borderWidth:      1.5,
    borderColor:      C.tint,
    marginTop:        3,
    flexShrink:       0,
    alignItems:      'center',
    justifyContent:  'center',
  },
  checkboxChecked: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  bulletTextDone: {
    opacity: 0.4,
    textDecorationLine: 'line-through',
  },
});

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
  onDelete,
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
  onDelete:        (id: string) => void;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [editing, setEditing]               = useState(false);
  const [editText, setEditText]             = useState('');

  const waveformSamples   = item.waveform ? (JSON.parse(item.waveform) as number[]) : null;
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
      <View style={clipStyles.header}>
        <View style={clipStyles.headerLeft}>
          <Text style={clipStyles.label}>Clip {index + 1}</Text>
          <Text style={clipStyles.duration}>
            {isActive
              ? `${formatMs(positionMs)} / ${formatMs(displayDurationMs)}`
              : formatDuration(item.duration)}
          </Text>
        </View>
        <View style={clipStyles.headerRight}>
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
          <Pressable onPress={() => onDelete(item.id)} hitSlop={8}>
            <IconSymbol name="trash" size={14} color={C.textTertiary} />
          </Pressable>
        </View>
      </View>

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
  headerRight: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
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
// ShareSheet
// ---------------------------------------------------------------------------

const CARD_WIDTH = Dimensions.get('window').width - 80;

function ShareSheet({
  visible,
  onClose,
  onShareText,
  title,
  walkType,
  summary,
  keyPoints,
  actions,
  durationMs,
  steps,
  thoughtCount,
}: {
  visible:      boolean;
  onClose:      () => void;
  onShareText:  () => void;
  title:        string | null;
  walkType:     WalkType | null;
  summary:      string | null;
  keyPoints:    string[];
  actions:      string[];
  durationMs:   number;
  steps:        number;
  thoughtCount: number;
}) {
  const cardRef              = useRef<View>(null);
  const [sharing, setSharing] = useState(false);

  const cardItems   = (walkType === 'plan'       ? actions
                    : walkType === 'brainstorm'  ? keyPoints
                    : walkType === 'appreciate'  ? keyPoints
                    : walkType === 'untangle'    ? keyPoints
                    : []).slice(0, 3);
  const cardSummary = (walkType === 'vent' || walkType === 'reflect' || walkType === 'untangle')
    ? summary : null;
  const useCheckbox = walkType === 'plan';

  async function captureAndShare() {
    if (!cardRef.current) return;
    setSharing(true);
    try {
      const uri = await captureRef(cardRef, { format: 'png', quality: 0.95, result: 'tmpfile' });
      await Share.share({ url: uri });
    } catch {
      Alert.alert('Could not share image', 'Try sharing as text instead.');
    } finally {
      setSharing(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={shareSheetStyles.backdrop} onPress={onClose} />
      <View style={shareSheetStyles.sheet}>
        <View style={shareSheetStyles.handle} />
        <Text style={shareSheetStyles.sheetTitle}>Share walk</Text>

        {/* Card — this view is captured as the share image */}
        <View style={shareSheetStyles.cardWrap}>
          <View ref={cardRef} style={shareSheetStyles.card} collapsable={false}>
            <View style={shareSheetStyles.cardHeader}>
              <Text style={shareSheetStyles.cardWordmark}>stride</Text>
              {walkType && (
                <View style={shareSheetStyles.cardBadge}>
                  <Text style={shareSheetStyles.cardBadgeText}>{WALK_TYPE_LABELS[walkType]}</Text>
                </View>
              )}
            </View>

            {title ? (
              <Text style={shareSheetStyles.cardTitle} numberOfLines={2}>{title}</Text>
            ) : null}

            <View style={shareSheetStyles.cardDivider} />
            <View style={shareSheetStyles.cardStats}>
              {durationMs > 0 && (
                <Text style={shareSheetStyles.cardStat}>{formatDurationShort(durationMs)}</Text>
              )}
              {steps > 0 && (
                <Text style={shareSheetStyles.cardStat}>{steps.toLocaleString()} steps</Text>
              )}
              {thoughtCount > 0 && (
                <Text style={shareSheetStyles.cardStat}>
                  {thoughtCount} thought{thoughtCount !== 1 ? 's' : ''}
                </Text>
              )}
            </View>
            <View style={shareSheetStyles.cardDivider} />

            {cardItems.length > 0 && (
              <View style={shareSheetStyles.cardContent}>
                {cardItems.map((item, i) => (
                  <View key={i} style={shareSheetStyles.cardItemRow}>
                    <Text style={shareSheetStyles.cardBullet}>{useCheckbox ? '☐' : '•'}</Text>
                    <Text style={shareSheetStyles.cardItemText} numberOfLines={2}>{item}</Text>
                  </View>
                ))}
              </View>
            )}

            {cardSummary ? (
              <Text style={shareSheetStyles.cardSummary} numberOfLines={3}>{cardSummary}</Text>
            ) : null}

            <Text style={shareSheetStyles.cardAttribution}>stride</Text>
          </View>
        </View>

        <Pressable
          style={[shareSheetStyles.primaryBtn, sharing && { opacity: 0.5 }]}
          onPress={captureAndShare}
          disabled={sharing}
        >
          <IconSymbol name="photo" size={15} color={C.text} />
          <Text style={shareSheetStyles.primaryBtnText}>
            {sharing ? 'Sharing…' : 'Share image'}
          </Text>
        </Pressable>

        <Pressable
          style={shareSheetStyles.textBtn}
          onPress={() => { onClose(); onShareText(); }}
        >
          <Text style={shareSheetStyles.textBtnText}>Share as text</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const shareSheetStyles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor:     C.surface,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    padding:             20,
    paddingBottom:        40,
    gap:                 12,
    alignItems:          'center',
  },
  handle: {
    width:           36,
    height:           4,
    borderRadius:     2,
    backgroundColor:  C.border,
    alignSelf:       'center',
    marginBottom:     4,
  },
  sheetTitle: {
    fontSize:   17,
    fontWeight: '600',
    color:      C.text,
    alignSelf:  'flex-start',
    marginBottom: 4,
  },
  cardWrap: {
    width:      '100%',
    alignItems: 'center',
  },
  card: {
    width:           CARD_WIDTH,
    backgroundColor: C.surfaceHigh,
    borderRadius:    16,
    padding:         20,
    gap:             12,
    borderWidth:     1,
    borderColor:     C.border,
  },
  cardHeader: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  cardWordmark: {
    fontSize:      13,
    fontWeight:    '700',
    color:         C.tint,
    letterSpacing: -0.3,
  },
  cardBadge: {
    backgroundColor: C.tint + '22',
    borderRadius:    6,
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderWidth:     1,
    borderColor:     C.tint + '44',
  },
  cardBadgeText: {
    fontSize:   11,
    fontWeight: '600',
    color:      C.tint,
  },
  cardTitle: {
    fontSize:      20,
    fontWeight:    '700',
    color:         C.text,
    letterSpacing: -0.3,
    lineHeight:    26,
  },
  cardDivider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: C.border,
  },
  cardStats: {
    flexDirection: 'row',
    gap:            12,
    flexWrap:      'wrap',
  },
  cardStat: {
    fontSize:   12,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  cardContent: {
    gap: 6,
  },
  cardItemRow: {
    flexDirection: 'row',
    gap:            8,
    alignItems:    'flex-start',
  },
  cardBullet: {
    fontSize:   13,
    color:      C.tint,
    lineHeight: 19,
  },
  cardItemText: {
    flex:       1,
    fontSize:   13,
    color:      C.text,
    lineHeight: 19,
  },
  cardSummary: {
    fontSize:   13,
    color:      C.textSecondary,
    lineHeight: 20,
    fontStyle:  'italic',
  },
  cardAttribution: {
    fontSize:      10,
    color:         C.textTertiary,
    textAlign:     'right',
    marginTop:      4,
    letterSpacing: 0.5,
  },
  primaryBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:              8,
    backgroundColor: C.tint,
    borderRadius:    12,
    paddingVertical: 14,
    width:           '100%',
  },
  primaryBtnText: {
    fontSize:   15,
    fontWeight: '600',
    color:      C.text,
  },
  textBtn: {
    alignItems:    'center',
    paddingVertical: 8,
    width:         '100%',
  },
  textBtnText: {
    fontSize: 14,
    color:    C.textSecondary,
  },
});

// ---------------------------------------------------------------------------
// RemindersSheet
// ---------------------------------------------------------------------------

const DATE_OPTIONS = [
  { label: 'Today',     offset: 0 },
  { label: 'Tomorrow',  offset: 1 },
  { label: 'In 2 days', offset: 2 },
  { label: 'Next week', offset: 7 },
];

const TIME_OPTIONS = [
  { label: '9 AM',  hour: 9  },
  { label: 'Noon',  hour: 12 },
  { label: '5 PM',  hour: 17 },
  { label: '8 PM',  hour: 20 },
];

function RemindersSheet({
  actions,
  visible,
  onClose,
}: {
  actions: string[];
  visible: boolean;
  onClose: () => void;
}) {
  const [selected,    setSelected]    = useState<Set<number>>(new Set());
  const [dateOffset,  setDateOffset]  = useState(1);
  const [timeHour,    setTimeHour]    = useState(9);
  const [adding,      setAdding]      = useState(false);

  useEffect(() => {
    if (visible) {
      setSelected(new Set(actions.map((_, i) => i)));
      setDateOffset(1);
      setTimeHour(9);
    }
  }, [visible, actions]);

  function toggle(i: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  async function handleAdd() {
    if (selected.size === 0 || adding) return;
    setAdding(true);
    try {
      const { status } = await Calendar.requestRemindersPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Go to Settings → Stride → Reminders to allow access.');
        return;
      }
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
      const cal = calendars.find(c => c.allowsModifications) ?? calendars[0];
      if (!cal) { Alert.alert('No Reminders calendar found.'); return; }

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dateOffset);
      dueDate.setHours(timeHour, 0, 0, 0);

      await Promise.all(
        actions
          .filter((_, i) => selected.has(i))
          .map(title => Calendar.createReminderAsync(cal.id, {
            title,
            dueDate,
            alarms: [{ relativeOffset: 0 }],
          }))
      );
      onClose();
    } catch {
      Alert.alert('Could not add reminders', 'Please try again.');
    } finally {
      setAdding(false);
    }
  }

  const count = selected.size;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={reminderStyles.backdrop} onPress={onClose} />
      <View style={reminderStyles.sheet}>
        <View style={reminderStyles.handle} />
        <Text style={reminderStyles.sheetTitle}>Add to Reminders</Text>

        <View style={reminderStyles.actionList}>
          {actions.map((action, i) => (
            <Pressable key={i} onPress={() => toggle(i)} style={reminderStyles.actionRow}>
              <View style={[reminderStyles.checkbox, selected.has(i) && reminderStyles.checkboxChecked]}>
                {selected.has(i) && <IconSymbol name="checkmark" size={10} color={C.background} />}
              </View>
              <Text style={reminderStyles.actionText}>{action}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={reminderStyles.groupLabel}>DATE</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={reminderStyles.chipRow}>
          {DATE_OPTIONS.map(opt => (
            <Pressable
              key={opt.label}
              onPress={() => setDateOffset(opt.offset)}
              style={[reminderStyles.chip, dateOffset === opt.offset && reminderStyles.chipActive]}
            >
              <Text style={[reminderStyles.chipText, dateOffset === opt.offset && reminderStyles.chipTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={reminderStyles.groupLabel}>TIME</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={reminderStyles.chipRow}>
          {TIME_OPTIONS.map(opt => (
            <Pressable
              key={opt.label}
              onPress={() => setTimeHour(opt.hour)}
              style={[reminderStyles.chip, timeHour === opt.hour && reminderStyles.chipActive]}
            >
              <Text style={[reminderStyles.chipText, timeHour === opt.hour && reminderStyles.chipTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <Pressable
          style={[reminderStyles.addBtn, (count === 0 || adding) && reminderStyles.addBtnDisabled]}
          onPress={handleAdd}
          disabled={count === 0 || adding}
        >
          <IconSymbol name="bell" size={15} color={C.text} />
          <Text style={reminderStyles.addBtnText}>
            {adding ? 'Adding…' : `Add ${count} reminder${count !== 1 ? 's' : ''}`}
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const reminderStyles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor:     C.surface,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    padding:             20,
    paddingBottom:        40,
    gap:                 12,
  },
  handle: {
    width:           36,
    height:           4,
    borderRadius:     2,
    backgroundColor:  C.border,
    alignSelf:       'center',
    marginBottom:     4,
  },
  sheetTitle: {
    fontSize:   17,
    fontWeight: '600',
    color:      C.text,
    marginBottom: 4,
  },
  actionList: {
    gap: 2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
    paddingVertical: 9,
  },
  checkbox: {
    width:           18,
    height:          18,
    borderRadius:     5,
    borderWidth:      1.5,
    borderColor:      C.tint,
    flexShrink:       0,
    alignItems:      'center',
    justifyContent:  'center',
  },
  checkboxChecked: {
    backgroundColor: C.tint,
  },
  actionText: {
    flex:       1,
    fontSize:   15,
    color:      C.text,
    lineHeight: 22,
  },
  groupLabel: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginTop:      4,
    marginBottom:  -4,
  },
  chipRow: {
    flexDirection: 'row',
    gap:            8,
    paddingVertical: 4,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical:    7,
    borderRadius:      20,
    backgroundColor:   C.surfaceHigh,
    borderWidth:       1,
    borderColor:       C.border,
  },
  chipActive: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  chipText: {
    fontSize:   13,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  chipTextActive: {
    color: C.text,
  },
  addBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:              8,
    backgroundColor: C.tint,
    borderRadius:    12,
    paddingVertical: 14,
    marginTop:        8,
  },
  addBtnDisabled: {
    opacity: 0.4,
  },
  addBtnText: {
    fontSize:   15,
    fontWeight: '600',
    color:      C.text,
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

  const { recordings, updateRecording, deleteRecording } = useRecordingsContext();
  const { sessions, updateSession }                       = useSessionsContext();
  const {
    enqueueTranscription,
    enqueueAnalysis,
    cancelAnalysis,
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

  const durationMs = endedAt - startedAt;

  const sessionRecordings = recordingIds
    .map(id => recordings.find(r => r.id === id))
    .filter((r): r is RecordingEntry => r !== undefined);

  const session   = sessions.find(s => s.id === sessionId);
  const keyPoints = parseJsonArray(session?.key_points ?? null);
  const actions   = parseJsonArray(session?.actions    ?? null);
  const hasAI     = session?.title !== null && session?.title !== undefined;
  const isAnalyzing = analyzingSessionId === sessionId;

  const allTranscribed =
    sessionRecordings.length > 0 &&
    sessionRecordings.every(
      r => r.transcript !== null &&
           !queuedIds.has(r.id) &&
           !(processingId === r.id && processingType === 'transcribe')
    );

  const transcribedCount = sessionRecordings.filter(
    r => r.transcript !== null && !queuedIds.has(r.id) && processingId !== r.id
  ).length;

  const totalWordCount = sessionRecordings.reduce((sum, r) => {
    const words = r.transcript?.trim().split(/\s+/).filter(Boolean) ?? [];
    return sum + words.length;
  }, 0);

  // Derive inferred walk type from recording tags (persisted to SQLite)
  const inferredType = dominantWalkType(sessionRecordings.map(r => r.tags));

  // ── Confirmation / re-summarize state ──────────────────────────────────────

  const [localType, setLocalType]               = useState<WalkType | null>(null);
  const [showTypePicker, setShowTypePicker]      = useState(false);
  const [showSummaryOverlay, setShowSummaryOverlay] = useState(false);
  const [isResummarizing, setIsResummarizing]    = useState(false);
  const [cancelling, setCancelling]              = useState(false);
  const [showReminders, setShowReminders]        = useState(false);
  const [showShareSheet, setShowShareSheet]      = useState(false);
  const [classifying, setClassifying]            = useState(false);
  const classifiedRef                            = useRef(false);

  useEffect(() => {
    if (!isAnalyzing) setCancelling(false);
  }, [isAnalyzing]);

  useEffect(() => {
    if (!allTranscribed || hasAI || totalWordCount < 5 || classifiedRef.current) return;
    classifiedRef.current = true;
    setClassifying(true);
    const t = setTimeout(() => setClassifying(false), 1200);
    return () => clearTimeout(t);
  }, [allTranscribed, hasAI, totalWordCount]);

  // Active type for confirmation card: local override → previously confirmed → inferred
  const confirmedType = session?.walk_type as WalkType | null ?? null;
  const activeType    = localType ?? confirmedType ?? inferredType;

  function handleSummarise(typeOverride?: WalkType) {
    const type = typeOverride ?? activeType;
    if (!type) return;
    const transcripts = sessionRecordings
      .map(r => r.transcript)
      .filter((t): t is string => !!t?.trim());
    if (transcripts.length === 0) return;
    updateSession(sessionId, { walk_type: type });
    enqueueAnalysis(sessionId, transcripts, type);
    const effectiveLocalType = typeOverride ?? localType;
    if (effectiveLocalType !== null) {
      for (const r of sessionRecordings) {
        updateRecording(r.id, { tags: effectiveLocalType });
      }
    }
    setIsResummarizing(false);
    setShowTypePicker(false);
    setLocalType(null);
  }

  // ── Edit handlers ───────────────────────────────────────────────────────────

  function handleUpdateTitle(text: string) {
    updateSession(sessionId, { title: text || null });
  }

  function handleUpdateSummary(text: string) {
    updateSession(sessionId, { summary: text || null });
  }

  function handleUpdateKeyPoint(index: number, text: string) {
    const next = [...keyPoints];
    if (text) { next[index] = text; } else { next.splice(index, 1); }
    updateSession(sessionId, { key_points: next.length > 0 ? JSON.stringify(next) : null });
  }

  function handleUpdateAction(index: number, text: string) {
    const next = [...actions];
    if (text) { next[index] = text; } else { next.splice(index, 1); }
    updateSession(sessionId, { actions: next.length > 0 ? JSON.stringify(next) : null });
  }

  // ── Playback ────────────────────────────────────────────────────────────────

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

  async function handleDelete(id: string) {
    Alert.alert(
      'Delete clip?',
      'This permanently removes the recording and its transcript.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (playingId === id) await stopCurrentPlayback();
            const loaded = soundMapRef.current.get(id);
            if (loaded) {
              loaded.sub?.remove();
              loaded.player.remove();
              soundMapRef.current.delete(id);
            }
            await deleteRecording(id);
            const remainingIds = sessionRecordings.filter(r => r.id !== id).map(r => r.id);
            updateSession(sessionId, { recording_ids: remainingIds.join(',') || null });
          },
        },
      ]
    );
  }

  // ── Share ────────────────────────────────────────────────────────────────────

  async function handleShare() {
    const lines: string[] = [];

    lines.push(session?.title ?? new Date(startedAt).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    }));

    const meta: string[] = [];
    if (durationMs > 0) meta.push(formatDurationShort(durationMs));
    if (steps > 0)      meta.push(`${steps.toLocaleString()} steps`);
    if (sessionRecordings.length > 0)
      meta.push(`${sessionRecordings.length} thought${sessionRecordings.length !== 1 ? 's' : ''}`);
    if (meta.length > 0) lines.push(meta.join(' · '));

    const walkType = session?.walk_type as WalkType | null;

    if (walkType === 'vent' || walkType === 'reflect' || walkType === 'untangle') {
      if (session?.summary) {
        lines.push('', session.summary);
      }
    }

    if (walkType === 'brainstorm' && keyPoints.length > 0) {
      lines.push('', 'IDEAS');
      keyPoints.forEach(p => lines.push(`• ${p}`));
    }

    if (walkType === 'appreciate' && keyPoints.length > 0) {
      lines.push('', 'APPRECIATIONS');
      keyPoints.forEach(p => lines.push(`• ${p}`));
    }

    if (walkType === 'plan') {
      if (actions.length > 0) {
        lines.push('', 'ACTIONS');
        actions.forEach(a => lines.push(`☐ ${a}`));
      }
    }

    if (!walkType) {
      if (keyPoints.length > 0) {
        lines.push('', 'KEY POINTS');
        keyPoints.forEach(p => lines.push(`• ${p}`));
      }
      if (actions.length > 0) {
        lines.push('', 'ACTIONS');
        actions.forEach(a => lines.push(`☐ ${a}`));
      }
    }

    const transcripts = sessionRecordings
      .filter(r => r.transcript?.trim())
      .map((r, i) => `[${i + 1}] ${normaliseTranscript(r.transcript!)}`);

    if (transcripts.length > 0) {
      lines.push('', 'THOUGHTS');
      transcripts.forEach(t => lines.push(t));
    }

    await Share.share({ message: lines.join('\n').trim() });
  }

  // ── Date label ───────────────────────────────────────────────────────────────

  const dateLabel = startedAt
    ? new Date(startedAt).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
      })
    : '';

  // ── Render ───────────────────────────────────────────────────────────────────

  const showConfirmCard =
    allTranscribed &&
    !classifying &&
    !isAnalyzing &&
    !hasAI &&
    totalWordCount >= 5 &&
    !isResummarizing;

  const showResummarizeCard = isResummarizing && hasAI && !isAnalyzing;

  const walkType = session?.walk_type as WalkType | null;

  return (
    <>
      <Stack.Screen
        options={{
          title:           session?.title ?? 'Walk',
          headerBackTitle: 'Done',
          headerRight: () => (
            <Pressable onPress={() => setShowShareSheet(true)} style={{ padding: 8, marginTop: 2 }}>
              <IconSymbol name="square.and.arrow.up" size={20} color={C.tint} />
            </Pressable>
          ),
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

          {/* AI title */}
          {hasAI && session?.title != null && (
            <EditableText
              value={session.title}
              onSave={handleUpdateTitle}
              style={styles.aiTitle}
            />
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

          {/* ── Processing states ──────────────────────────────────────────── */}

          {classifying && (
            <View style={styles.processingCard}>
              <View style={styles.processingRow}>
                <IconSymbol name="sparkles" size={13} color={C.tint} />
                <Text style={styles.processingText}>Deriving walk type…</Text>
              </View>
            </View>
          )}

          {!isAnalyzing && !hasAI && !allTranscribed && sessionRecordings.length > 0 && (
            <View style={styles.processingCard}>
              <View style={styles.processingRow}>
                <Text style={styles.processingText}>Transcribing your thoughts</Text>
                <Text style={styles.processingCount}>
                  {transcribedCount} of {sessionRecordings.length}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round((transcribedCount / sessionRecordings.length) * 100)}%` },
                  ]}
                />
              </View>
            </View>
          )}

          {(isAnalyzing || cancelling) && (
            <View style={styles.processingCard}>
              <View style={styles.processingRow}>
                <IconSymbol name="sparkles" size={13} color={C.tint} />
                <Text style={styles.processingText}>
                  {cancelling ? 'Cancelling…' : (walkType
                    ? `Generating ${WALK_TYPE_LABELS[walkType]} summary…`
                    : 'Generating your summary…')}
                </Text>
                {!cancelling && (
                  <Pressable
                    onPress={() => { setCancelling(true); cancelAnalysis(sessionId); }}
                    hitSlop={8}
                  >
                    <Text style={styles.cancelAnalysisText}>cancel</Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: '100%', opacity: 0.5 }]} />
              </View>
            </View>
          )}

          {allTranscribed && !hasAI && !isAnalyzing && totalWordCount < 5 && sessionRecordings.length > 0 && (
            <View style={styles.processingCard}>
              <Text style={styles.processingText}>
                Not enough to summarise — keep talking next time.
              </Text>
            </View>
          )}

          {/* ── Walk type confirmation card ────────────────────────────────── */}

          {(showConfirmCard || showResummarizeCard) && (
            <View style={styles.confirmCard}>
              {activeType ? (
                <>
                  <View style={styles.confirmRow}>
                    <IconSymbol name="sparkles" size={13} color={C.tint} />
                    {showResummarizeCard || localType !== null ? (
                      <Text style={styles.confirmText}>
                        Summarise as{' '}
                        <Text style={styles.confirmTypeLabel}>{WALK_TYPE_LABELS[activeType]}</Text>?
                      </Text>
                    ) : (
                      <Text style={styles.confirmText}>
                        This sounds like a{' '}
                        <Text style={styles.confirmTypeLabel}>{WALK_TYPE_LABELS[activeType]}</Text>
                        {' '}walk. Summarise as that?
                      </Text>
                    )}
                    <Pressable
                      onPress={() => setShowTypePicker(p => !p)}
                      hitSlop={8}
                    >
                      <Text style={styles.changeText}>
                        {showTypePicker ? 'done' : 'change'}
                      </Text>
                    </Pressable>
                  </View>

                  {showTypePicker && (
                    <TypePicker
                      selected={activeType}
                      onSelect={type => {
                        setLocalType(type);
                        setShowTypePicker(false);
                        if (showResummarizeCard) handleSummarise(type);
                      }}
                    />
                  )}

                  <Pressable style={styles.summarizeBtn} onPress={handleSummarise}>
                    <IconSymbol name="sparkles" size={14} color={C.text} />
                    <Text style={styles.summarizeBtnText}>
                      {showResummarizeCard
                        ? `Re-summarise as ${WALK_TYPE_LABELS[activeType]}`
                        : `Yes, summarise as ${WALK_TYPE_LABELS[activeType]}`}
                    </Text>
                  </Pressable>

                  {showResummarizeCard && (
                    <Pressable
                      onPress={() => { setIsResummarizing(false); setLocalType(null); setShowTypePicker(false); }}
                      style={styles.cancelResummarize}
                    >
                      <Text style={styles.cancelResummarizeText}>cancel</Text>
                    </Pressable>
                  )}
                </>
              ) : (
                // No type inferred yet — show picker directly
                <>
                  <Text style={styles.confirmText}>Choose a walk type to summarise</Text>
                  <TypePicker
                    selected={localType}
                    onSelect={type => setLocalType(type)}
                  />
                  {localType && (
                    <Pressable style={styles.summarizeBtn} onPress={handleSummarise}>
                      <IconSymbol name="sparkles" size={14} color={C.text} />
                      <Text style={styles.summarizeBtnText}>
                        Summarise as {WALK_TYPE_LABELS[localType]}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>
          )}

          {/* ── Thoughts (recordings) ──────────────────────────────────────── */}

          {sessionRecordings.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionHeader}>THOUGHTS</Text>
                <View style={styles.sectionHeaderActions}>
                  {hasAI && walkType && !showSummaryOverlay && (
                    <Pressable
                      onPress={() => setShowSummaryOverlay(true)}
                      style={styles.summaryToggleBtn}
                    >
                      <IconSymbol name="sparkles" size={11} color={C.tint} />
                      <Text style={styles.summaryToggleBtnText}>summary</Text>
                    </Pressable>
                  )}
                  {hasAI && !isAnalyzing && !isResummarizing && (
                    <Pressable
                      onPress={() => {
                        setIsResummarizing(true);
                        setLocalType(walkType);
                        setShowTypePicker(false);
                        setShowSummaryOverlay(false);
                      }}
                      hitSlop={8}
                    >
                      <Text style={styles.resummarizeLink}>re-summarise</Text>
                    </Pressable>
                  )}
                </View>
              </View>

              {showSummaryOverlay && walkType ? (
                <View style={styles.summaryOverlay}>
                  <Pressable
                    onPress={() => setShowSummaryOverlay(false)}
                    style={styles.overlayBack}
                  >
                    <IconSymbol name="chevron.left" size={11} color={C.tint} />
                    <Text style={styles.overlayBackText}>thoughts</Text>
                  </Pressable>
                  <SummaryContent
                    walkType={walkType}
                    summary={session?.summary ?? null}
                    keyPoints={keyPoints}
                    actions={actions}
                    onUpdateSummary={handleUpdateSummary}
                    onUpdateKeyPoint={handleUpdateKeyPoint}
                    onUpdateAction={handleUpdateAction}
                  />
                  {Platform.OS === 'ios' && walkType === 'plan' && actions.length > 0 && (
                    <Pressable
                      style={styles.addRemindersBtn}
                      onPress={() => setShowReminders(true)}
                    >
                      <IconSymbol name="bell" size={14} color={C.tint} />
                      <Text style={styles.addRemindersBtnText}>Add to Reminders</Text>
                    </Pressable>
                  )}
                </View>
              ) : (
                sessionRecordings.map((item, index) => (
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
                    onDelete={handleDelete}
                  />
                ))
              )}
            </View>
          )}

          {sessionRecordings.length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No thoughts recorded this walk.</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>

      <RemindersSheet
        actions={actions}
        visible={showReminders}
        onClose={() => setShowReminders(false)}
      />

      <ShareSheet
        visible={showShareSheet}
        onClose={() => setShowShareSheet(false)}
        onShareText={handleShare}
        title={session?.title ?? null}
        walkType={walkType}
        summary={session?.summary ?? null}
        keyPoints={keyPoints}
        actions={actions}
        durationMs={durationMs}
        steps={steps}
        thoughtCount={sessionRecordings.length}
      />
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

  processingCard: {
    backgroundColor: C.surface,
    borderRadius:    12,
    padding:         16,
    marginBottom:    16,
    gap:             12,
  },
  processingRow: {
    flexDirection: 'row',
    alignItems:    'center',
    justifyContent: 'space-between',
    gap:            8,
  },
  processingText: {
    fontSize:  13,
    color:     C.textSecondary,
    flex:       1,
  },
  processingCount: {
    fontSize:   12,
    color:      C.textTertiary,
    fontWeight: '500',
  },
  progressTrack: {
    height:          3,
    borderRadius:    2,
    backgroundColor: C.surfaceHigh,
    overflow:        'hidden',
  },
  progressFill: {
    height:          3,
    borderRadius:    2,
    backgroundColor: C.tint,
  },

  confirmCard: {
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    24,
    gap:              12,
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            8,
  },
  confirmText: {
    flex:       1,
    fontSize:   14,
    color:      C.textSecondary,
  },
  confirmTypeLabel: {
    color:      C.text,
    fontWeight: '600',
  },
  changeText: {
    fontSize:   13,
    color:      C.tint,
    fontWeight: '500',
  },
  summarizeBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:              8,
    backgroundColor: C.tint,
    borderRadius:    12,
    paddingVertical: 13,
  },
  summarizeBtnText: {
    fontSize:   15,
    fontWeight: '600',
    color:      C.text,
  },
  cancelResummarize: {
    alignItems: 'center',
  },
  cancelResummarizeText: {
    fontSize: 13,
    color:    C.textTertiary,
  },
  cancelAnalysisText: {
    fontSize:   13,
    color:      C.textTertiary,
    fontWeight: '500',
    flexShrink: 0,
  },

  section: {
    marginBottom: 28,
  },
  sectionHeaderRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   12,
  },
  sectionHeader: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
  },
  sectionHeaderActions: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            12,
  },
  summaryToggleBtn: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            4,
  },
  summaryToggleBtnText: {
    fontSize:   12,
    color:      C.tint,
    fontWeight: '500',
  },
  resummarizeLink: {
    fontSize:   13,
    color:      C.tint,
    fontWeight: '500',
  },

  summaryOverlay: {
    paddingTop:    4,
    paddingBottom: 8,
    gap:           16,
  },
  overlayBack: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            4,
    marginBottom:   4,
  },
  overlayBackText: {
    fontSize:   13,
    color:      C.tint,
    fontWeight: '500',
  },

  emptyState: {
    alignItems: 'center',
    paddingTop:  40,
  },
  emptyText: {
    fontSize: 15,
    color:    C.textSecondary,
  },

  addRemindersBtn: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:             6,
    paddingVertical: 12,
    borderRadius:   12,
    borderWidth:    1,
    borderColor:    C.tint,
    marginTop:       8,
  },
  addRemindersBtnText: {
    fontSize:   14,
    fontWeight: '500',
    color:      C.tint,
  },
});
