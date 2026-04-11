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
  MOONSHINE_TINY_ENCODER,
  MOONSHINE_TINY_DECODER,
  MOONSHINE_TOKENIZER,
  LLAMA3_2_1B_QLORA,
  LLAMA3_2_1B_TOKENIZER,
  LLAMA3_2_TOKENIZER_CONFIG,
} from 'react-native-executorch';

import { useRecordingsContext } from './recordings-context';
import { useSessionsContext } from './sessions-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscribeJob = { type: 'transcribe'; recordingId: string; uri: string };
export type TagJob        = { type: 'tag'; recordingId: string; transcript: string };
export type AnalyzeJob    = { type: 'analyze'; recordingId: string; sessionId: string; transcripts: string[] };
export type AIJob         = TranscribeJob | TagJob | AnalyzeJob;

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

// Single "mega-prompt" that generates title + key points + actions in one LLM pass,
// avoiding a second model load and saving 5–10 s of inference latency.
const ANALYZE_SYSTEM_PROMPT =
  'You are a voice journal analyzer. Respond ONLY with a JSON object — no markdown, no explanation.\n\n' +
  'Format: {"title":"5-word session title","key_points":["insight 1","insight 2"],"actions":["action 1"]}\n\n' +
  'Rules:\n' +
  '- title: max 5 words, captures the main theme\n' +
  '- key_points: 2–5 complete-sentence insights, include names/places/decisions\n' +
  '- actions: 0–3 action items starting with a verb (e.g. "Email Sarah about proposal"); use [] if none';

type AnalysisResult = { title: string; keyPoints: string[]; actions: string[] };

function parseAnalysisResponse(response: string): AnalysisResult {
  // Strip markdown code fences LLaMA sometimes emits
  const cleaned = response.replace(/```(?:json)?\n?/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '',
      keyPoints: Array.isArray(parsed.key_points)
        ? parsed.key_points.filter((s: unknown): s is string => typeof s === 'string')
        : [],
      actions: Array.isArray(parsed.actions)
        ? parsed.actions.filter((s: unknown): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    // Regex fallback for imperfect JSON output from smaller models
    const titleMatch    = cleaned.match(/"title"\s*:\s*"([^"]+)"/);
    const keyPointsRaw  = cleaned.match(/"key_points"\s*:\s*\[([^\]]*)\]/s);
    const actionsRaw    = cleaned.match(/"actions"\s*:\s*\[([^\]]*)\]/s);
    const extractStrings = (raw: string | undefined): string[] =>
      raw ? [...raw.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(Boolean) : [];
    return {
      title:     titleMatch?.[1]?.trim() ?? '',
      keyPoints: extractStrings(keyPointsRaw?.[1]),
      actions:   extractStrings(actionsRaw?.[1]),
    };
  }
}

// Adds key→value to a record, evicting the lexicographically smallest key when
// the entry count would exceed limit. Recording/session IDs are timestamp-prefixed
// so the smallest key is always the oldest.
function cappedMapAdd<T>(prev: Record<string, T>, key: string, value: T, limit: number): Record<string, T> {
  const next = { ...prev, [key]: value };
  const keys = Object.keys(next);
  if (keys.length <= limit) return next;
  const oldest = keys.sort()[0];
  const { [oldest]: _evicted, ...rest } = next;
  return rest;
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

function extractFloat32PCM(view: DataView, start: number, end: number): number[] {
  const pcm: number[] = [];
  for (let i = start; i + 3 < end; i += 4) {
    pcm.push(view.getFloat32(i, true));
  }
  return pcm;
}

// Linear interpolation resample — avoids aliasing artifacts from nearest-neighbour
function resampleTo16k(pcm: number[], fromRate: number): number[] {
  if (fromRate === 16000) return pcm;
  const ratio = fromRate / 16000;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Array<number>(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    out[i] = pcm[lo] + (pcm[hi] - pcm[lo]) * (pos - lo);
  }
  return out;
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
  // Release the Uint8Array wrapper — bytes/view keep the ArrayBuffer alive, but
  // dropping raw lets the GC reclaim this reference before the pcm[] grows.
  raw = null;

  if (bytes.length < 8) throw new Error(`File too small: ${bytes.length} bytes`);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  if (magic === 'RIFF') {
    if (bytes.length < 12) throw new Error('WAV file truncated');
    let offset = 12;
    let dataOffset = -1, dataSize = 0;
    // fmt defaults (fallback if fmt chunk missing)
    let audioFormat = 1, numChannels = 1, sampleRate = 16000, bitsPerSample = 16;

    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ' && size >= 16) {
        audioFormat  = view.getUint16(offset + 8,  true); // 1=PCM, 3=IEEE float
        numChannels  = view.getUint16(offset + 10, true);
        sampleRate   = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      }
      if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset === -1) throw new Error('No data chunk in WAV');

    const end = Math.min(dataOffset + dataSize, bytes.length);
    let pcm: number[];

    if (audioFormat === 3 || bitsPerSample === 32) {
      // IEEE 754 32-bit float PCM (format 3) or 32-bit reported as PCM
      const floatSamples = extractFloat32PCM(view, dataOffset, end);
      if (numChannels === 2) {
        pcm = [];
        for (let i = 0; i + 1 < floatSamples.length; i += 2) pcm.push((floatSamples[i] + floatSamples[i + 1]) / 2);
      } else {
        pcm = floatSamples;
      }
    } else {
      // 16-bit integer PCM (most common)
      pcm = extractInt16PCM(view, dataOffset, end);
      if (numChannels === 2) {
        const mono: number[] = [];
        for (let i = 0; i + 1 < pcm.length; i += 2) mono.push((pcm[i] + pcm[i + 1]) / 2);
        pcm = mono;
      }
    }
    return resampleTo16k(pcm, sampleRate);
  }

  if (magic === 'caff') {
    let offset = 8;
    const log: string[] = [];
    // desc chunk values — defaults match our recording options
    let cafSampleRate = 16000;
    let cafChannels = 1;
    let cafBitsPerChannel = 16;
    let cafIsFloat = false;

    while (offset + 12 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const sizeHigh = view.getInt32(offset + 4, false);
      const sizeLow  = view.getUint32(offset + 8, false);
      const streaming = sizeHigh < 0;
      const size = streaming ? 0 : (sizeHigh * 0x100000000 + sizeLow);
      log.push(`${id}(${streaming ? 'stream' : size})`);

      if (id === 'desc' && size >= 32) {
        // AudioStreamBasicDescription layout (big-endian, chunk data starts at offset+12):
        //   +0  sampleRate        float64  → offset+12
        //   +8  formatID          uint32   → offset+20
        //   +12 formatFlags       uint32   → offset+24  (bit 0 = kAudioFormatFlagIsFloat)
        //   +16 bytesPerPacket    uint32   → offset+28
        //   +20 framesPerPacket   uint32   → offset+32
        //   +24 channelsPerFrame  uint32   → offset+36
        //   +28 bitsPerChannel    uint32   → offset+40
        cafSampleRate = view.getFloat64(offset + 12, false);
        const formatFlags = view.getUint32(offset + 24, false);
        cafIsFloat = (formatFlags & 0x1) !== 0;
        cafChannels = view.getUint32(offset + 36, false);
        cafBitsPerChannel = view.getUint32(offset + 40, false);
      }

      if (id === 'data') {
        const dataStart = offset + 12 + 4; // skip 4-byte edit count
        const dataEnd = streaming ? bytes.length : Math.min(offset + 12 + size, bytes.length);
        let pcm: number[];
        if (cafIsFloat || cafBitsPerChannel === 32) {
          const floatSamples = extractFloat32PCM(view, dataStart, dataEnd);
          if (cafChannels === 2) {
            pcm = [];
            for (let i = 0; i + 1 < floatSamples.length; i += 2) pcm.push((floatSamples[i] + floatSamples[i + 1]) / 2);
          } else {
            pcm = floatSamples;
          }
        } else {
          pcm = extractInt16PCM(view, dataStart, dataEnd);
          if (cafChannels === 2) {
            const mono: number[] = [];
            for (let i = 0; i + 1 < pcm.length; i += 2) mono.push((pcm[i] + pcm[i + 1]) / 2);
            pcm = mono;
          }
        }
        if (pcm.length === 0) throw new Error(`CAF data empty: start=${dataStart} end=${dataEnd} file=${bytes.length} chunks=[${log.join(',')}]`);
        return resampleTo16k(pcm, cafSampleRate);
      }
      if (streaming) break;
      offset += 12 + size;
    }
    throw new Error(`No CAF data chunk: file=${bytes.length}b chunks=[${log.join(',')}]`);
  }

  // m4a/AAC (Android) starts with 'ftyp' — decoding AAC requires a native module
  // or a separate codec library; pure-JS decoding is not supported here.
  if (magic === 'ftyp') {
    throw new Error('Android m4a recordings cannot be transcribed: AAC decoding requires a native module. Add react-native-audio-api (Web Audio decodeAudioData) or a similar library to support Android.');
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
    modelName: 'moonshine',
    encoderSource: MOONSHINE_TINY_ENCODER,
    decoderSource: MOONSHINE_TINY_DECODER,
    tokenizerSource: MOONSHINE_TOKENIZER,
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
          return; // onError already advances the queue
        }
        // < 0.2 s at 16 kHz — too short for Moonshine to produce meaningful output
        if (pcm.length < 3200) {
          pendingIdRef.current = null;
          onDone(id, '');
          return;
        }
        // Peak-normalise in-place so quiet recordings (phone in pocket, arm at side)
        // land in the amplitude range Moonshine was trained on. In-place avoids
        // allocating a second ~38 MB array alongside the first. Skip if near-silent
        // to avoid amplifying pure noise.
        const peak = pcm.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        if (peak > 0.01) {
          for (let i = 0; i < pcm.length; i++) pcm[i] /= peak;
        }
        transcribe(pcm);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        pendingIdRef.current = null;
        // onError already advances the queue — don't also call onDone
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

function TagWorker({
  recordingId,
  transcript,
  onDone,
}: {
  recordingId: string;
  transcript: string;
  onDone: (recordingId: string, response: string) => void;
}) {
  const { generate, isReady, isGenerating, response, error } = useLLM({
    modelSource: LLAMA3_2_1B_QLORA,
    tokenizerSource: LLAMA3_2_1B_TOKENIZER,
    tokenizerConfigSource: LLAMA3_2_TOKENIZER_CONFIG,
  });
  const startedRef      = useRef(false);
  const wasGeneratingRef = useRef(false);
  const pendingIdRef    = useRef<string | null>(null);
  const calledDoneRef   = useRef(false);
  const responseRef     = useRef('');
  responseRef.current   = response ?? '';

  function callDoneOnce(id: string, res: string) {
    if (calledDoneRef.current) return;
    calledDoneRef.current = true;
    onDone(id, res);
  }

  useEffect(() => {
    if (!isReady || startedRef.current) return;
    startedRef.current = true;
    pendingIdRef.current = recordingId;
    generate([
      { role: 'system', content: TAG_SYSTEM_PROMPT },
      { role: 'user',   content: transcript },
    ]);
  }, [isReady, generate, transcript, recordingId]);

  useEffect(() => {
    if (isGenerating) { wasGeneratingRef.current = true; return; }
    if (wasGeneratingRef.current && pendingIdRef.current) {
      const id = pendingIdRef.current;
      pendingIdRef.current = null;
      wasGeneratingRef.current = false;
      callDoneOnce(id, responseRef.current);
    }
  }, [isGenerating, onDone]);

  // If the LLM errors (model download failed, inference error, etc.)
  // advance the queue so it isn't blocked forever.
  useEffect(() => {
    if (!error) return;
    callDoneOnce(recordingId, '');
  }, [error, recordingId]);

  return null;
}

function AnalyzeWorker({
  job,
  onDone,
}: {
  job: AnalyzeJob;
  onDone: (sessionId: string, response: string) => void;
}) {
  const { generate, isReady, isGenerating, response, error } = useLLM({
    modelSource: LLAMA3_2_1B_QLORA,
    tokenizerSource: LLAMA3_2_1B_TOKENIZER,
    tokenizerConfigSource: LLAMA3_2_TOKENIZER_CONFIG,
  });
  const startedRef       = useRef(false);
  const wasGeneratingRef = useRef(false);
  const pendingIdRef     = useRef<string | null>(null);
  const calledDoneRef    = useRef(false);
  const responseRef      = useRef('');
  responseRef.current    = response ?? '';

  function callDoneOnce(id: string, res: string) {
    if (calledDoneRef.current) return;
    calledDoneRef.current = true;
    onDone(id, res);
  }

  useEffect(() => {
    if (!isReady || startedRef.current) return;
    startedRef.current = true;
    pendingIdRef.current = job.sessionId;
    const userMessage = job.transcripts
      .map((t, i) => `[${i + 1}]: ${t}`)
      .join('\n');
    generate([
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      { role: 'user',   content: `Analyze these voice notes:\n\n${userMessage}` },
    ]);
  }, [isReady, generate, job]);

  useEffect(() => {
    if (isGenerating) { wasGeneratingRef.current = true; return; }
    if (wasGeneratingRef.current && pendingIdRef.current) {
      const id = pendingIdRef.current;
      pendingIdRef.current = null;
      wasGeneratingRef.current = false;
      callDoneOnce(id, responseRef.current);
    }
  }, [isGenerating, onDone]);

  // If the LLM errors (model download failed, inference error, context too long, etc.)
  // advance the queue so it isn't blocked forever.
  useEffect(() => {
    if (!error) return;
    callDoneOnce(job.sessionId, '');
  }, [error, job.sessionId]);

  return null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AIQueueCtx = {
  enqueueTranscription: (recordingId: string, uri: string) => void;
  enqueueAnalysis: (sessionId: string, transcripts: string[]) => void;
  processingId: string | null;
  processingType: 'transcribe' | 'tag' | 'analyze' | null;
  modelDownloadProgress: number;
  isModelReady: boolean;
  modelError: string | null;
  suggestedTagsMap: Record<string, Tag[]>;
  acceptSuggestion: (recordingId: string, tags: Tag[]) => Promise<void>;
  dismissSuggestion: (recordingId: string) => void;
  failedIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
  analyzingSessionId: string | null;
};

const AIQueueContext = createContext<AIQueueCtx | null>(null);

export function AIQueueProvider({ children }: PropsWithChildren) {
  const { updateRecording } = useRecordingsContext();
  const { updateSession } = useSessionsContext();
  const [queue, dispatch] = useReducer(queueReducer, { active: null, pending: [] });
  const [suggestedTagsMap, setSuggestedTagsMap] = useState<Record<string, Tag[]>>({});
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [isModelReady, setIsModelReady] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());

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
        setFailedIds(prev => new Set([...prev, active.recordingId]));
        updateRecording(active.recordingId, { transcript: '' });
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [queue.active, updateRecording]
  );

  const handleTranscriptionDone = useCallback(
    async (recordingId: string, transcript: string) => {
      await updateRecording(recordingId, { transcript: transcript || '', transcript_edited: 0 });
      setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
      if (transcript.trim()) {
        dispatchRef.current({ type: 'NEXT', insertFront: { type: 'tag', recordingId, transcript } });
      } else {
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateRecording]
  );

  const handleTagsDone = useCallback(
    (recordingId: string, response: string) => {
      const tags = parseTags(response);
      if (tags.length > 0) {
        setSuggestedTagsMap(prev => cappedMapAdd(prev, recordingId, tags, 20));
      }
      dispatchRef.current({ type: 'NEXT' });
    },
    []
  );

  const handleAnalyzeDone = useCallback(
    (sessionId: string, response: string) => {
      const { title, keyPoints, actions } = parseAnalysisResponse(response);
      updateSession(sessionId, {
        title:      title || null,
        key_points: keyPoints.length > 0 ? JSON.stringify(keyPoints) : null,
        actions:    actions.length   > 0 ? JSON.stringify(actions)   : null,
      });
      dispatchRef.current({ type: 'NEXT' });
    },
    [updateSession]
  );

  function enqueueTranscription(recordingId: string, uri: string) {
    setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
    dispatch({ type: 'PUSH', job: { type: 'transcribe', recordingId, uri } });
  }

  function enqueueAnalysis(sessionId: string, transcripts: string[]) {
    dispatch({ type: 'PUSH', job: { type: 'analyze', recordingId: sessionId, sessionId, transcripts } });
  }

  async function acceptSuggestion(recordingId: string, tags: Tag[]) {
    await updateRecording(recordingId, { tags: tags.join(',') });
    setSuggestedTagsMap(prev => { const n = { ...prev }; delete n[recordingId]; return n; });
  }

  function dismissSuggestion(recordingId: string) {
    setSuggestedTagsMap(prev => { const n = { ...prev }; delete n[recordingId]; return n; });
  }

  const queuedIds = new Set(
    queue.pending
      .filter((j): j is TranscribeJob => j.type === 'transcribe')
      .map(j => j.recordingId)
  );

  const value: AIQueueCtx = {
    enqueueTranscription,
    enqueueAnalysis,
    processingId: queue.active?.recordingId ?? null,
    processingType: queue.active?.type ?? null,
    modelDownloadProgress,
    isModelReady,
    modelError,
    suggestedTagsMap,
    acceptSuggestion,
    dismissSuggestion,
    failedIds,
    queuedIds,
    analyzingSessionId: queue.active?.type === 'analyze' ? queue.active.sessionId : null,
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
        <TagWorker
          recordingId={queue.active.recordingId}
          transcript={queue.active.transcript}
          onDone={handleTagsDone}
        />
      )}
      {queue.active?.type === 'analyze' && (
        <AnalyzeWorker
          job={queue.active}
          onDone={handleAnalyzeDone}
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
