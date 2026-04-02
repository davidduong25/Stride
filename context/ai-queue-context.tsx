/**
 * AI job queue — serialises Whisper transcription and Llama tagging so that
 * only one ExecuTorch model is active at a time.
 *
 * Architecture:
 *   AIQueueProvider maintains a simple FIFO queue of AIJob items.
 *   It renders a single invisible worker component (<TranscriptionWorker> or
 *   <LLMWorker>) based on the active job type.  The worker mounts its
 *   react-native-executorch hook, runs inference, then signals completion so
 *   the queue can advance.  Conditional *rendering* (not conditional hook
 *   calls) ensures only one model is initialised at a time.
 *
 * API assumptions for react-native-executorch (adjust if the published API differs):
 *   useSpeechToText — { transcribe(uri): void, isReady, isTranscribing, transcription, error }
 *   useLLM          — { forward(prompt): void, isReady, isGenerating, response, error }
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  useSpeechToText,
  useLLM,
  WHISPER_TINY_ENCODER,
  WHISPER_TINY_DECODER,
  WHISPER_TOKENIZER,
  LLAMA3_2_1B_QLORA,
  LLAMA3_2_1B_TOKENIZER,
  LLAMA3_2_TOKENIZER_CONFIG,
} from 'react-native-executorch';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';

import { useRecordingsContext } from './recordings-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscribeJob = { type: 'transcribe'; recordingId: string; uri: string };
export type TagJob        = { type: 'tag'; recordingId: string; transcript: string };
export type AIJob         = TranscribeJob | TagJob;

type QueueState = { active: AIJob | null; pending: AIJob[] };
type QueueAction =
  | { type: 'PUSH'; job: AIJob }
  | { type: 'NEXT'; insertFront?: AIJob };

function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'PUSH':
      if (!state.active) return { ...state, active: action.job };
      return { ...state, pending: [...state.pending, action.job] };
    case 'NEXT': {
      const front = action.insertFront ? [action.insertFront] : [];
      const [next, ...rest] = [...front, ...state.pending];
      return { active: next ?? null, pending: rest };
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TAGS = ['idea', 'vent', 'gratitude', 'plan', 'reflection', 'question'] as const;
export type Tag = typeof VALID_TAGS[number];

const TAG_SYSTEM_PROMPT =
  'You are a voice journal tagger. Given a transcript, output 1-3 comma-separated tags ' +
  'and nothing else. Choose only from: idea, vent, gratitude, plan, reflection, question. ' +
  'Example: idea, plan';

function parseTags(response: string): Tag[] {
  return response
    .toLowerCase()
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter((t): t is Tag => (VALID_TAGS as readonly string[]).includes(t))
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Audio decoder — reads a saved audio file and returns a PCM float32 array
// ---------------------------------------------------------------------------

async function decodeAudioToPCM(uri: string): Promise<number[]> {
  // Validate the file is a loadable audio asset via expo-av
  const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
  await sound.unloadAsync();

  // Read raw bytes via expo-file-system
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  // Skip 44-byte WAV header; decode little-endian Int16 samples to float32 [-1, 1]
  const pcm: number[] = [];
  for (let i = 44; i + 1 < bytes.length; i += 2) {
    pcm.push(view.getInt16(i, true) / 32768);
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Worker components — each mounts exactly one ExecuTorch hook
// ---------------------------------------------------------------------------

function TranscriptionWorker({
  recordingId,
  uri,
  onDone,
}: {
  recordingId: string;
  uri: string;
  onDone: (recordingId: string, transcript: string) => void;
}) {
  const { transcribe, isReady, isTranscribing, transcription } = useSpeechToText({
    modelName: 'whisper',
    encoderSource: WHISPER_TINY_ENCODER,
    decoderSource: WHISPER_TINY_DECODER,
    tokenizerSource: WHISPER_TOKENIZER,
  });
  const startedRef = useRef(false);
  const wasTranscribingRef = useRef(false);

  useEffect(() => {
    if (!isReady || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const pcm = await decodeAudioToPCM(uri);
      transcribe(pcm);
    })();
  }, [isReady, transcribe, uri]);

  useEffect(() => {
    if (isTranscribing) { wasTranscribingRef.current = true; return; }
    if (wasTranscribingRef.current) {
      wasTranscribingRef.current = false;
      onDone(recordingId, transcription ?? '');
    }
  }, [isTranscribing, transcription, recordingId, onDone]);

  return null;
}

function LLMWorker({
  recordingId,
  transcript,
  onDone,
}: {
  recordingId: string;
  transcript: string;
  onDone: (recordingId: string, response: string) => void;
}) {
  const { forward, isReady, isGenerating, response } = useLLM({
    modelSource: LLAMA3_2_1B_QLORA,
    tokenizerSource: LLAMA3_2_1B_TOKENIZER,
    tokenizerConfigSource: LLAMA3_2_TOKENIZER_CONFIG,
    systemPrompt: TAG_SYSTEM_PROMPT,
  });
  const startedRef = useRef(false);
  const wasGeneratingRef = useRef(false);

  useEffect(() => {
    if (!isReady || startedRef.current) return;
    startedRef.current = true;
    forward(transcript);
  }, [isReady, forward, transcript]);

  useEffect(() => {
    if (isGenerating) { wasGeneratingRef.current = true; return; }
    if (wasGeneratingRef.current) {
      wasGeneratingRef.current = false;
      onDone(recordingId, response ?? '');
    }
  }, [isGenerating, response, recordingId, onDone]);

  return null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AIQueueCtx = {
  enqueueTranscription: (recordingId: string, uri: string) => void;
  processingId: string | null;
  processingType: 'transcribe' | 'tag' | null;
  suggestedTagsMap: Record<string, Tag[]>;
  acceptSuggestion: (recordingId: string, tags: Tag[]) => Promise<void>;
  dismissSuggestion: (recordingId: string) => void;
};

const AIQueueContext = createContext<AIQueueCtx | null>(null);

export function AIQueueProvider({ children }: PropsWithChildren) {
  const { updateRecording } = useRecordingsContext();
  const [queue, dispatch] = useReducer(queueReducer, { active: null, pending: [] });
  const [suggestedTagsMap, setSuggestedTagsMap] = useState<Record<string, Tag[]>>({});

  // Ref so memoised callbacks always call the latest dispatch without re-memoising
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const handleTranscriptionDone = useCallback(
    async (recordingId: string, transcript: string) => {
      await updateRecording(recordingId, { transcript: transcript || '' });
      const insertFront: TagJob | undefined = transcript
        ? { type: 'tag', recordingId, transcript }
        : undefined;
      dispatchRef.current({ type: 'NEXT', insertFront });
    },
    [updateRecording]
  );

  const handleTagsDone = useCallback(
    (recordingId: string, response: string) => {
      const tags = parseTags(response);
      if (tags.length > 0) {
        setSuggestedTagsMap(prev => ({ ...prev, [recordingId]: tags }));
      }
      dispatchRef.current({ type: 'NEXT' });
    },
    []
  );

  function enqueueTranscription(recordingId: string, uri: string) {
    dispatch({ type: 'PUSH', job: { type: 'transcribe', recordingId, uri } });
  }

  async function acceptSuggestion(recordingId: string, tags: Tag[]) {
    await updateRecording(recordingId, { tags: tags.join(',') });
    setSuggestedTagsMap(prev => { const n = { ...prev }; delete n[recordingId]; return n; });
  }

  function dismissSuggestion(recordingId: string) {
    setSuggestedTagsMap(prev => { const n = { ...prev }; delete n[recordingId]; return n; });
  }

  const value: AIQueueCtx = {
    enqueueTranscription,
    processingId: queue.active?.recordingId ?? null,
    processingType: queue.active?.type ?? null,
    suggestedTagsMap,
    acceptSuggestion,
    dismissSuggestion,
  };

  return (
    <AIQueueContext.Provider value={value}>
      {children}
      {queue.active?.type === 'transcribe' && (
        <TranscriptionWorker
          key={queue.active.recordingId + '-transcribe'}
          recordingId={queue.active.recordingId}
          uri={queue.active.uri}
          onDone={handleTranscriptionDone}
        />
      )}
      {queue.active?.type === 'tag' && (
        <LLMWorker
          key={queue.active.recordingId + '-tag'}
          recordingId={queue.active.recordingId}
          transcript={queue.active.transcript}
          onDone={handleTagsDone}
        />
      )}
    </AIQueueContext.Provider>
  );
}

export function useAIQueue(): AIQueueCtx {
  const ctx = useContext(AIQueueContext);
  if (!ctx) throw new Error('useAIQueue must be used within AIQueueProvider');
  return ctx;
}

export { VALID_TAGS };
