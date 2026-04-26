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
export type AnalyzeJob    = { type: 'analyze'; recordingId: string; sessionId: string; transcripts: string[]; walkType: WalkType };
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
// Walk types
// ---------------------------------------------------------------------------

const VALID_WALK_TYPES = ['vent', 'brainstorm', 'plan', 'reflect', 'appreciate', 'untangle'] as const;
export type WalkType = typeof VALID_WALK_TYPES[number];

export const WALK_TYPE_LABELS: Record<WalkType, string> = {
  vent:       'Vent',
  brainstorm: 'Brainstorm',
  plan:       'Plan',
  reflect:    'Reflect',
  appreciate: 'Appreciate',
  untangle:   'Untangle',
};

const TAG_SYSTEM_PROMPT =
  'You are a walk journal classifier. Given a voice transcript, output exactly one word ' +
  'that best describes the walk type. Choose only from: vent, brainstorm, plan, reflect, appreciate, untangle. ' +
  'Output the single word only, nothing else.';

function parseWalkType(response: string): WalkType | null {
  const words = response.toLowerCase().trim().split(/\s+/);
  for (const word of words) {
    if ((VALID_WALK_TYPES as readonly string[]).includes(word)) return word as WalkType;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analysis prompts — one per walk type
// ---------------------------------------------------------------------------

const ANALYZE_PROMPTS: Record<WalkType, string> = {
  vent:
    'You are a compassionate listener. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","summary":"2-3 sentences reflecting their core feeling. No advice.","key_points":[],"actions":[]}\n' +
    'Rules: title max 5 words. summary captures the emotion expressed, not advice or next steps.',

  brainstorm:
    'You are an idea organizer. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","key_points":["idea 1","idea 2","idea 3"],"summary":null,"actions":[]}\n' +
    'Rules: title max 5 words. key_points 3-7 distinct ideas. Capture every idea mentioned. Do not filter or evaluate.',

  plan:
    'You are a task extractor. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","actions":["Do X","Call Y"],"key_points":[],"summary":null}\n' +
    'Rules: title max 5 words. actions 1-6 items starting with a verb. Only include explicit tasks or next steps.',

  reflect:
    'You are a thoughtful journal companion. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","summary":"2-4 sentences capturing the key insight.","key_points":[],"actions":[]}\n' +
    'Rules: title max 5 words. summary synthesizes what they processed. No advice or forward projection.',

  appreciate:
    'You are a grateful observer. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","key_points":["Grateful for X","Appreciates Y"],"summary":null,"actions":[]}\n' +
    'Rules: title max 5 words. key_points 2-6 specific things they expressed appreciation for.',

  untangle:
    'You are a clear-headed advisor. Respond ONLY with a JSON object — no markdown, no explanation.\n' +
    'Format: {"title":"5-word title","key_points":["Option: X","Option: Y"],"summary":"What they seem to lean toward, or null if unclear.","actions":[]}\n' +
    'Rules: title max 5 words, names the decision. key_points lists the options. summary is their leaning, not your opinion.',
};

type AnalysisResult = { title: string; keyPoints: string[]; actions: string[]; summary: string | null };

function parseAnalysisResponse(response: string): AnalysisResult {
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
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
    };
  } catch {
    const titleMatch   = cleaned.match(/"title"\s*:\s*"([^"]+)"/);
    const keyPointsRaw = cleaned.match(/"key_points"\s*:\s*\[([^\]]*)\]/s);
    const actionsRaw   = cleaned.match(/"actions"\s*:\s*\[([^\]]*)\]/s);
    const summaryMatch = cleaned.match(/"summary"\s*:\s*"([^"]+)"/);
    const extractStrings = (raw: string | undefined): string[] =>
      raw ? [...raw.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(Boolean) : [];
    return {
      title:     titleMatch?.[1]?.trim() ?? '',
      keyPoints: extractStrings(keyPointsRaw?.[1]),
      actions:   extractStrings(actionsRaw?.[1]),
      summary:   summaryMatch?.[1]?.trim() ?? null,
    };
  }
}

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
    pcm.push(view.getInt16(i, true) / 32768);
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
  raw = null;

  if (bytes.length < 8) throw new Error(`File too small: ${bytes.length} bytes`);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);

  if (magic === 'RIFF') {
    if (bytes.length < 12) throw new Error('WAV file truncated');
    let offset = 12;
    let dataOffset = -1, dataSize = 0;
    let audioFormat = 1, numChannels = 1, sampleRate = 16000, bitsPerSample = 16;

    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ' && size >= 16) {
        audioFormat   = view.getUint16(offset + 8,  true);
        numChannels   = view.getUint16(offset + 10, true);
        sampleRate    = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      }
      if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset === -1) throw new Error('No data chunk in WAV');

    const end = Math.min(dataOffset + dataSize, bytes.length);
    let pcm: number[];

    if (audioFormat === 3 || bitsPerSample === 32) {
      const floatSamples = extractFloat32PCM(view, dataOffset, end);
      if (numChannels === 2) {
        pcm = [];
        for (let i = 0; i + 1 < floatSamples.length; i += 2) pcm.push((floatSamples[i] + floatSamples[i + 1]) / 2);
      } else {
        pcm = floatSamples;
      }
    } else {
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
        cafSampleRate     = view.getFloat64(offset + 12, false);
        const formatFlags = view.getUint32(offset + 24, false);
        cafIsFloat        = (formatFlags & 0x1) !== 0;
        cafChannels       = view.getUint32(offset + 36, false);
        cafBitsPerChannel = view.getUint32(offset + 40, false);
      }

      if (id === 'data') {
        const dataStart = offset + 12 + 4;
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

  if (magic === 'ftyp') {
    try {
      const { AudioContext } = require('react-native-audio-api');
      const ctx: { decodeAudioData: (b: ArrayBuffer) => Promise<{ sampleRate: number; getChannelData: (c: number) => Float32Array }> }
        = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      const channelData = audioBuffer.getChannelData(0);
      return resampleTo16k(Array.from(channelData), audioBuffer.sampleRate);
    } catch {
      throw new Error('Android m4a transcription requires react-native-audio-api — run: npx expo install react-native-audio-api, then rebuild via EAS.');
    }
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
  const pendingIdRef    = useRef<string | null>(null);
  const wasGeneratingRef = useRef(false);
  const calledErrorRef  = useRef(false);
  const sequenceRef     = useRef('');
  sequenceRef.current   = sequence;

  useEffect(() => {
    onProgress(downloadProgress);
  }, [downloadProgress, onProgress]);

  useEffect(() => {
    onReady(isReady);
  }, [isReady, onReady]);

  useEffect(() => {
    if (error && !calledErrorRef.current) {
      calledErrorRef.current = true;
      pendingIdRef.current = null;
      wasGeneratingRef.current = false;
      onError(error.message ?? String(error));
    }
  }, [error, onError]);

  useEffect(() => {
    if (!isReady || !job || pendingIdRef.current === job.recordingId) return;
    pendingIdRef.current = job.recordingId;
    calledErrorRef.current = false;
    const id = job.recordingId;
    (async () => {
      try {
        const pcm = await decodeAudioToPCM(job.uri);
        if (pcm.length === 0) {
          pendingIdRef.current = null;
          onError('WAV decode produced empty PCM — check file at: ' + job.uri);
          return;
        }
        if (pcm.length < 3200) {
          pendingIdRef.current = null;
          onDone(id, '');
          return;
        }
        const peak = pcm.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        if (peak > 0.01) {
          for (let i = 0; i < pcm.length; i++) pcm[i] /= peak;
        }
        transcribe(pcm);
      } catch (e) {
        pendingIdRef.current = null;
        wasGeneratingRef.current = false;
        onError(e instanceof Error ? e.message : String(e));
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
      { role: 'system', content: ANALYZE_PROMPTS[job.walkType] },
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
  enqueueAnalysis: (sessionId: string, transcripts: string[], walkType: WalkType) => void;
  cancelAnalysis: (sessionId: string) => void;
  processingId: string | null;
  processingType: 'transcribe' | 'tag' | 'analyze' | null;
  modelDownloadProgress: number;
  isModelReady: boolean;
  modelError: string | null;
  failedIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
  analyzingSessionId: string | null;
};

const AIQueueContext = createContext<AIQueueCtx | null>(null);

export function AIQueueProvider({ children }: PropsWithChildren) {
  const { updateRecording }        = useRecordingsContext();
  const { updateSession }          = useSessionsContext();
  const [queue, dispatch]          = useReducer(queueReducer, { active: null, pending: [] });
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [isModelReady, setIsModelReady]                   = useState(false);
  const [modelError, setModelError]                       = useState<string | null>(null);
  const [failedIds, setFailedIds]                         = useState<Set<string>>(new Set());

  const dispatchRef          = useRef(dispatch);
  dispatchRef.current        = dispatch;
  const cancelledAnalysisRef  = useRef<Set<string>>(new Set());
  const moonshineEverReadyRef = useRef(false);

  const handleError = useCallback(
    (err: string) => {
      setModelError(err);
      const active = queue.active;
      if (active) {
        setFailedIds(prev => new Set([...prev, active.recordingId]));
        updateRecording(active.recordingId, { transcript: '' });
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [queue.active, updateRecording]
  );

  const handleModelReady = useCallback((ready: boolean) => {
    if (ready) moonshineEverReadyRef.current = true;
    setIsModelReady(moonshineEverReadyRef.current || ready);
  }, []);

  const handleTranscriptionDone = useCallback(
    async (recordingId: string, transcript: string) => {
      try {
        await updateRecording(recordingId, { transcript: transcript || '', transcript_edited: 0 });
        setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
        if (transcript.trim()) {
          dispatchRef.current({ type: 'NEXT', insertFront: { type: 'tag', recordingId, transcript } });
        } else {
          dispatchRef.current({ type: 'NEXT' });
        }
      } catch {
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateRecording]
  );

  const handleTagsDone = useCallback(
    async (recordingId: string, response: string) => {
      const walkType = parseWalkType(response);
      if (walkType) {
        await updateRecording(recordingId, { tags: walkType });
      }
      dispatchRef.current({ type: 'NEXT' });
    },
    [updateRecording]
  );

  const handleAnalyzeDone = useCallback(
    (sessionId: string, response: string) => {
      if (cancelledAnalysisRef.current.has(sessionId)) {
        cancelledAnalysisRef.current.delete(sessionId);
        dispatchRef.current({ type: 'NEXT' });
        return;
      }
      const { title, keyPoints, actions, summary } = parseAnalysisResponse(response);
      updateSession(sessionId, {
        title:      title || null,
        key_points: keyPoints.length > 0 ? JSON.stringify(keyPoints) : null,
        actions:    actions.length   > 0 ? JSON.stringify(actions)   : null,
        summary:    summary || null,
      });
      if (title) {
        try {
          const Notifications = require('expo-notifications');
          Notifications.scheduleNotificationAsync({
            content: { title: 'Walk summary ready', body: title },
            trigger: null,
          });
        } catch { /* native module not available in this build */ }
      }
      dispatchRef.current({ type: 'NEXT' });
    },
    [updateSession]
  );

  function enqueueTranscription(recordingId: string, uri: string) {
    setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
    dispatch({ type: 'PUSH', job: { type: 'transcribe', recordingId, uri } });
  }

  function enqueueAnalysis(sessionId: string, transcripts: string[], walkType: WalkType) {
    dispatch({ type: 'PUSH', job: { type: 'analyze', recordingId: sessionId, sessionId, transcripts, walkType } });
  }

  function cancelAnalysis(sessionId: string) {
    cancelledAnalysisRef.current.add(sessionId);
  }

  const queuedIds = new Set(
    queue.pending
      .filter((j): j is TranscribeJob => j.type === 'transcribe')
      .map(j => j.recordingId)
  );

  const value: AIQueueCtx = {
    enqueueTranscription,
    enqueueAnalysis,
    cancelAnalysis,
    processingId:         queue.active?.recordingId ?? null,
    processingType:       queue.active?.type ?? null,
    modelDownloadProgress,
    isModelReady,
    modelError,
    failedIds,
    queuedIds,
    analyzingSessionId: queue.active?.type === 'analyze' ? queue.active.sessionId : null,
  };

  return (
    <AIQueueContext.Provider value={value}>
      {children}
      {queue.active?.type !== 'tag' && queue.active?.type !== 'analyze' && (
        <TranscriptionWorker
          job={queue.active?.type === 'transcribe' ? queue.active : null}
          onDone={handleTranscriptionDone}
          onProgress={setModelDownloadProgress}
          onReady={handleModelReady}
          onError={handleError}
        />
      )}
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

export { VALID_WALK_TYPES };
