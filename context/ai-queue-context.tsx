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

function extractInt16PCM(view: DataView, start: number, end: number): number[] {
  const pcm: number[] = [];
  for (let i = start; i + 1 < end; i += 2) {
    pcm.push(view.getInt16(i, true) / 32768); // little-endian Int16 → float32 [-1,1]
  }
  return pcm;
}

async function decodeAudioToPCM(uri: string): Promise<number[]> {
  // fetch() handles file:// URIs reliably across path formats on React Native
  let raw: Uint8Array | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(uri);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 4096) { raw = new Uint8Array(ab); break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!raw || raw.byteLength <= 4096) {
    throw new Error(`Audio file not ready after retries: ${raw?.byteLength ?? 0} bytes at ${uri}`);
  }
  const buffer = raw.buffer;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < 8) throw new Error(`File too small: ${bytes.length} bytes`);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  if (magic === 'RIFF') {
    // WAV — walk RIFF chunks to find 'data'
    if (bytes.length < 12) throw new Error('WAV file truncated');
    let offset = 12;
    let dataOffset = -1, dataSize = 0;
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset === -1) throw new Error('No data chunk in WAV');
    return extractInt16PCM(view, dataOffset, Math.min(dataOffset + dataSize, bytes.length));
  }

  if (magic === 'caff') {
    let offset = 8;
    const log: string[] = [];
    while (offset + 12 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const sizeHigh = view.getInt32(offset + 4, false);
      const sizeLow  = view.getUint32(offset + 8, false);
      const streaming = sizeHigh < 0;
      const size = streaming ? 0 : (sizeHigh * 0x100000000 + sizeLow);
      log.push(`${id}(${streaming ? 'stream' : size})`);
      if (id === 'data') {
        const dataStart = offset + 12 + 4;
        const dataEnd = streaming ? bytes.length : Math.min(offset + 12 + size, bytes.length);
        const pcm = extractInt16PCM(view, dataStart, dataEnd);
        if (pcm.length === 0) throw new Error(`CAF data empty: start=${dataStart} end=${dataEnd} file=${bytes.length} chunks=[${log.join(',')}]`);
        return pcm;
      }
      if (streaming) break;
      offset += 12 + size;
    }
    throw new Error(`No CAF data chunk: file=${bytes.length}b chunks=[${log.join(',')}]`);
  }

  throw new Error(`Unsupported audio format: "${magic}"`);
}

// ---------------------------------------------------------------------------
// Worker components — each mounts exactly one ExecuTorch hook
// ---------------------------------------------------------------------------

function TranscriptionWorker({
  job,
  onDone,
  onProgress,
  onReady,
  onError,
}: {
  job: TranscribeJob | null;
  onDone: (recordingId: string, transcript: string) => void;
  onProgress: (progress: number) => void;
  onReady: (ready: boolean) => void;
  onError: (err: string) => void;
}) {
  const { transcribe, isReady, isGenerating, sequence, downloadProgress, error } = useSpeechToText({
    modelName: 'whisper',
    encoderSource: WHISPER_TINY_ENCODER,
    decoderSource: WHISPER_TINY_DECODER,
    tokenizerSource: WHISPER_TOKENIZER,
  });
  // Capture job ID when transcription starts — never rely on the job prop
  // at completion time since React 18 batching can null it out in the same render
  const pendingIdRef = useRef<string | null>(null);
  const wasGeneratingRef = useRef(false);
  const sequenceRef = useRef('');
  sequenceRef.current = sequence;

  useEffect(() => {
    onProgress(downloadProgress);
  }, [downloadProgress, onProgress]);

  useEffect(() => {
    onReady(isReady);
  }, [isReady, onReady]);

  useEffect(() => {
    if (error) onError(error.message ?? String(error));
  }, [error, onError]);

  useEffect(() => {
    if (!isReady || !job || pendingIdRef.current === job.recordingId) return;
    pendingIdRef.current = job.recordingId;
    const id = job.recordingId;
    (async () => {
      try {
        const pcm = await decodeAudioToPCM(job.uri);
        if (pcm.length === 0) {
          onError('WAV decode produced empty PCM — check file at: ' + job.uri);
          pendingIdRef.current = null;
          onDone(id, '');
          return;
        }
        transcribe(pcm);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        pendingIdRef.current = null;
        onDone(id, '');
      }
    })();
  }, [isReady, job, transcribe, onDone, onError]);

  useEffect(() => {
    if (isGenerating) { wasGeneratingRef.current = true; return; }
    if (wasGeneratingRef.current && pendingIdRef.current) {
      const id = pendingIdRef.current;
      pendingIdRef.current = null;
      wasGeneratingRef.current = false;
      onDone(id, sequenceRef.current);
    }
  }, [isGenerating, onDone]);

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
  const pendingIdRef = useRef<string | null>(null);
  const responseRef = useRef('');
  responseRef.current = response ?? '';

  useEffect(() => {
    if (!isReady || startedRef.current) return;
    startedRef.current = true;
    pendingIdRef.current = recordingId;
    forward(transcript);
  }, [isReady, forward, transcript, recordingId]);

  useEffect(() => {
    if (isGenerating) { wasGeneratingRef.current = true; return; }
    if (wasGeneratingRef.current && pendingIdRef.current) {
      const id = pendingIdRef.current;
      pendingIdRef.current = null;
      wasGeneratingRef.current = false;
      onDone(id, responseRef.current);
    }
  }, [isGenerating, onDone]);

  return null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AIQueueCtx = {
  enqueueTranscription: (recordingId: string, uri: string) => void;
  processingId: string | null;
  processingType: 'transcribe' | 'tag' | null;
  modelDownloadProgress: number;
  isModelReady: boolean;
  modelError: string | null;
  suggestedTagsMap: Record<string, Tag[]>;
  acceptSuggestion: (recordingId: string, tags: Tag[]) => Promise<void>;
  dismissSuggestion: (recordingId: string) => void;
};

const AIQueueContext = createContext<AIQueueCtx | null>(null);

export function AIQueueProvider({ children }: PropsWithChildren) {
  const { updateRecording } = useRecordingsContext();
  const [queue, dispatch] = useReducer(queueReducer, { active: null, pending: [] });
  const [suggestedTagsMap, setSuggestedTagsMap] = useState<Record<string, Tag[]>>({});
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [isModelReady, setIsModelReady] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Ref so memoised callbacks always call the latest dispatch without re-memoising
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const handleError = useCallback(
    (err: string) => {
      setModelError(err);
      // Mark the active job's recording as failed and advance the queue so
      // subsequent recordings are not permanently blocked.
      const active = queue.active;
      if (active) {
        updateRecording(active.recordingId, { transcript: '' });
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [queue.active, updateRecording]
  );

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
    modelDownloadProgress,
    isModelReady,
    modelError,
    suggestedTagsMap,
    acceptSuggestion,
    dismissSuggestion,
  };

  return (
    <AIQueueContext.Provider value={value}>
      {children}
      <TranscriptionWorker
        job={queue.active?.type === 'transcribe' ? queue.active : null}
        onDone={handleTranscriptionDone}
        onProgress={setModelDownloadProgress}
        onReady={setIsModelReady}
        onError={handleError}
      />
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
