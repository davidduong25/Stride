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
  useLLM,
  QWEN2_5_0_5B_QUANTIZED,
  QWEN2_5_TOKENIZER,
  QWEN2_5_TOKENIZER_CONFIG,
} from 'react-native-executorch';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

const LLM_MODEL_SOURCE     = QWEN2_5_0_5B_QUANTIZED;
const LLM_TOKENIZER_SOURCE = QWEN2_5_TOKENIZER;
const LLM_TOKENIZER_CONFIG = QWEN2_5_TOKENIZER_CONFIG;

import { useRecordingsContext } from './recordings-context';
import { useSessionsContext } from './sessions-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscribeJob = { type: 'transcribe'; recordingId: string; uri: string };
export type AnalyzeJob    = { type: 'analyze'; recordingId: string; sessionId: string; transcripts: string[]; walkType: WalkType };
export type AIJob         = TranscribeJob | AnalyzeJob;

type QueueState = { active: AIJob | null; pending: AIJob[] };
type QueueAction =
  | { type: 'PUSH'; job: AIJob }
  | { type: 'NEXT'; insertFront?: AIJob }
  | { type: 'RESET' };

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
    case 'RESET':
      return { active: null, pending: [] };
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

export const WALK_TYPE_DESCRIPTIONS: Record<WalkType, string> = {
  vent:       'Get it off your chest',
  brainstorm: 'Think out loud, capture every idea',
  plan:       'Turn thoughts into action items',
  reflect:    'Process an experience or feeling',
  appreciate: 'Notice what\'s good around you',
  untangle:   'Work through a hard decision',
};

const WALK_TYPE_KEYWORDS: Record<WalkType, string[]> = {
  vent: [
    'frustrated', 'frustrating', 'angry', 'anger', 'annoyed', 'annoying',
    'stressed', 'stress', 'overwhelmed', 'upset', 'hate', 'ridiculous',
    'unfair', 'exhausted', 'pissed', 'irritated', 'irritating', 'ugh',
    'venting', 'rant', 'ranting', 'complain', 'complaining', 'awful',
    'terrible', 'sick of', 'tired of', 'fed up', "can't stand",
  ],
  brainstorm: [
    'idea', 'ideas', 'what if', 'brainstorm', 'explore', 'possibilities',
    'imagine', 'concept', 'hypothetically', 'wonder', 'wondering',
    'thought about', 'thinking of', 'could be', 'might work', 'creative',
  ],
  plan: [
    'schedule', 'deadline', 'task', 'next step', 'plan', 'planning',
    'todo', 'appointment', 'milestone', 'priority', 'action item',
    'agenda', 'follow up', 'check in', 'due date', 'set a reminder',
  ],
  reflect: [
    'realized', 'realize', 'learned', 'learning', 'feeling', 'felt',
    'understand', 'understanding', 'processed', 'processing',
    'experience', 'growth', 'lesson', 'insight', 'perspective',
    'reflection', 'reflecting', 'looking back', 'makes me think',
  ],
  appreciate: [
    'grateful', 'gratitude', 'thankful', 'appreciate', 'appreciation',
    'love', 'beautiful', 'amazing', 'blessed', 'blessing', 'happy',
    'joy', 'joyful', 'wonderful', 'lucky', 'glad', 'fortunate',
    'awesome', 'fantastic', 'incredible',
  ],
  untangle: [
    'decision', 'decide', 'deciding', 'choice', 'choices', 'either',
    'confused', 'confusion', 'not sure', 'unsure', 'weighing',
    'pros and cons', 'dilemma', 'should i', 'on the other hand',
    'conflicted', 'torn', 'hard to decide', 'both sides',
  ],
};

function classifyTranscript(transcript: string): WalkType | null {
  const text = transcript.toLowerCase();
  const scores: Record<WalkType, number> = {
    vent: 0, brainstorm: 0, plan: 0, reflect: 0, appreciate: 0, untangle: 0,
  };
  for (const type of VALID_WALK_TYPES) {
    for (const keyword of WALK_TYPE_KEYWORDS[type]) {
      let pos = 0;
      while ((pos = text.indexOf(keyword, pos)) !== -1) {
        scores[type]++;
        pos += keyword.length;
      }
    }
  }
  let best: WalkType | null = null;
  let bestScore = 0;
  for (const type of VALID_WALK_TYPES) {
    if (scores[type] > bestScore) { bestScore = scores[type]; best = type; }
  }
  return best;
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


// ---------------------------------------------------------------------------
// Worker components
// ---------------------------------------------------------------------------

class AIWorkerErrorBoundary extends React.Component<
  PropsWithChildren<{ onError: (err: string) => void }>,
  { hasError: boolean }
> {
  constructor(props: PropsWithChildren<{ onError: (err: string) => void }>) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) { this.props.onError(error.message); }
  render() { return this.state.hasError ? null : this.props.children; }
}

function TranscriptionWorker({
  job,
  onDone,
  onProgress,
  onReady,
  onError,
  onLiveSequence,
}: {
  job: TranscribeJob | null;
  onDone: (recordingId: string, transcript: string) => void;
  onProgress: (progress: number) => void;
  onReady: (ready: boolean) => void;
  onError: (err: string) => void;
  onLiveSequence: (text: string) => void;
}) {
  const pendingIdRef       = useRef<string | null>(null);
  const finalTranscriptRef = useRef('');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    ExpoSpeechRecognitionModule.requestPermissionsAsync().then(({ granted }) => {
      if (granted) {
        setIsReady(true);
        onProgress(1);
        onReady(true);
      } else {
        onError('Speech recognition permission denied — enable it in Settings → Privacy → Speech Recognition');
      }
    });
    return () => {
      onReady(false);
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript ?? '';
    if (event.isFinal) {
      finalTranscriptRef.current = text;
    } else if (text) {
      onLiveSequence(text);
    }
  });

  useSpeechRecognitionEvent('end', () => {
    const id = pendingIdRef.current;
    if (!id) return;
    pendingIdRef.current = null;
    onDone(id, finalTranscriptRef.current);
  });

  useSpeechRecognitionEvent('error', (event) => {
    const id = pendingIdRef.current;
    if (!id) return;
    pendingIdRef.current = null;
    if (event.error === 'no-speech') {
      onDone(id, '');
    } else {
      onError(event.message || event.error || 'Speech recognition failed');
    }
  });

  useEffect(() => {
    if (!isReady || !job || pendingIdRef.current === job.recordingId) return;
    pendingIdRef.current = job.recordingId;
    finalTranscriptRef.current = '';
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      audioSource: { uri: job.uri },
    });
  }, [isReady, job]);

  return null;
}


function AnalyzeWorker({
  job,
  onDone,
  onError,
  onProgress,
  onReady,
}: {
  job: AnalyzeJob | null;
  onDone: (sessionId: string, response: string, walkType: WalkType) => void;
  onError: (err: string) => void;
  onProgress: (p: number) => void;
  onReady: (ready: boolean) => void;
}) {
  const { generate, interrupt, isReady, isGenerating, response, error, downloadProgress } = useLLM({
    modelSource: LLM_MODEL_SOURCE,
    tokenizerSource: LLM_TOKENIZER_SOURCE,
    tokenizerConfigSource: LLM_TOKENIZER_CONFIG,
  });
  const startedRef       = useRef(false);
  const wasGeneratingRef = useRef(false);
  const pendingIdRef     = useRef<string | null>(null);
  const calledDoneRef    = useRef(false);
  const currentJobIdRef  = useRef<string | null>(null);
  const walkTypeRef      = useRef<WalkType | null>(null);
  const responseRef      = useRef('');
  responseRef.current    = response ?? '';

  // Reset per-job refs when a new job arrives — worker stays mounted across jobs.
  useEffect(() => {
    const newId = job?.sessionId ?? null;
    if (newId === currentJobIdRef.current) return;
    currentJobIdRef.current = newId;
    if (newId !== null) {
      startedRef.current = false;
      calledDoneRef.current = false;
      wasGeneratingRef.current = false;
      pendingIdRef.current = null;
    }
  }, [job?.sessionId]);

  // 3-min load timeout — only fires when there's an actual job, not during preload.
  useEffect(() => {
    if (!job) return;
    const timer = setTimeout(() => {
      if (!startedRef.current) {
        onError('LLM model failed to load — reset AI queue and try again');
      }
    }, 3 * 60_000);
    return () => clearTimeout(timer);
  }, [job?.sessionId, onError]);

  useEffect(() => {
    onProgress(downloadProgress);
  }, [downloadProgress, onProgress]);

  useEffect(() => {
    onReady(isReady);
  }, [isReady, onReady]);

  // Interrupt native generation if the job is cancelled while generating.
  useEffect(() => {
    if (!job && isGenerating) interrupt();
  }, [job, isGenerating, interrupt]);

  // If generation runs for 90s without completing, interrupt the native model.
  useEffect(() => {
    if (!isGenerating) return;
    const timer = setTimeout(() => interrupt(), 90_000);
    return () => clearTimeout(timer);
  }, [isGenerating, interrupt]);

  function callDoneOnce(id: string, res: string) {
    if (calledDoneRef.current) return;
    calledDoneRef.current = true;
    onDone(id, res, walkTypeRef.current!);
  }

  useEffect(() => {
    if (!isReady || !job || startedRef.current) return;
    const systemPrompt = ANALYZE_PROMPTS[job.walkType];
    if (!systemPrompt) {
      onError(`Unknown walk type: ${job.walkType}`);
      return;
    }
    startedRef.current = true;
    pendingIdRef.current = job.sessionId;
    walkTypeRef.current = job.walkType;
    const userMessage = job.transcripts
      .map((t, i) => `[${i + 1}]: ${t}`)
      .join('\n');
    generate([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Analyze these voice notes:\n\n${userMessage}` },
    ]).catch(e => {
      pendingIdRef.current = null;
      startedRef.current = false;
      wasGeneratingRef.current = false;
      onError(e instanceof Error ? e.message : String(e));
    });
  }, [isReady, generate, job, onError]);

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
    if (!error || !startedRef.current || !job) return;
    startedRef.current = false;
    onError(error.message ?? 'LLM generation failed');
  }, [error, job?.sessionId, onError]);

  return null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AIQueueCtx = {
  enqueueTranscription: (recordingId: string, uri: string) => void;
  enqueueAnalysis: (sessionId: string, transcripts: string[], walkType: WalkType) => void;
  cancelAnalysis: (sessionId: string) => void;
  resetQueue: () => void;
  processingId: string | null;
  processingType: 'transcribe' | 'analyze' | null;
  modelDownloadProgress: number;
  isModelReady: boolean;
  modelError: string | null;
  failedIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
  analyzingSessionId: string | null;
  liveTranscript: string;
  llmDownloadProgress: number;
  isLLMReady: boolean;
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
  const [transcriptionKey, setTranscriptionKey]           = useState(0);
  const [liveTranscript, setLiveTranscript]               = useState('');
  const [llmDownloadProgress, setLlmDownloadProgress]     = useState(0);

  const [isLLMReady, setIsLLMReady]         = useState(false);
  const [llmWorkerKey, setLlmWorkerKey]     = useState(0);
  const [analyzeWorkerReady, setAnalyzeWorkerReady] = useState(false);

  const dispatchRef          = useRef(dispatch);
  dispatchRef.current        = dispatch;
  const cancelledAnalysisRef  = useRef<Set<string>>(new Set());
  const forcedAdvancedRef     = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const activeJobRef          = useRef<AIJob | null>(null);
  activeJobRef.current        = queue.active;

  // 1500ms delay before mounting AnalyzeWorker — lets TranscriptionWorker fully
  // unmount and Apple STT abort() resolve before the LLM starts loading.
  useEffect(() => {
    if (queue.active?.type !== 'analyze') { setAnalyzeWorkerReady(false); return; }
    const t = setTimeout(() => setAnalyzeWorkerReady(true), 1500);
    return () => clearTimeout(t);
  }, [queue.active?.type]);

  const handleError = useCallback(
    (err: string) => {
      if (!mountedRef.current) return;
      setLiveTranscript('');
      setModelError(err);
      const active = activeJobRef.current;
      if (active) {
        if (active.type === 'transcribe') {
          setFailedIds(prev => new Set([...prev, active.recordingId]));
          updateRecording(active.recordingId, { transcript: '' });
          setTranscriptionKey(k => k + 1);
        } else if (active.type === 'analyze') {
          updateSession(active.sessionId, { title: null });
          setLlmWorkerKey(k => k + 1);
          setIsLLMReady(false);
        }
        dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateRecording, updateSession]
  );


  const handleTranscriptionDone = useCallback(
    async (recordingId: string, transcript: string) => {
      setLiveTranscript('');
      try {
        const walkType = transcript.trim() ? classifyTranscript(transcript) : null;
        await updateRecording(recordingId, {
          transcript: transcript || '',
          transcript_edited: 0,
          ...(walkType ? { tags: walkType } : {}),
        });
        if (!mountedRef.current) return;
        setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
      } catch {
        if (!mountedRef.current) return;
        setFailedIds(prev => new Set([...prev, recordingId]));
      } finally {
        if (mountedRef.current) dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateRecording]
  );

const handleAnalyzeDone = useCallback(
    async (sessionId: string, response: string, walkType: WalkType) => {
      if (!mountedRef.current) return;
      if (cancelledAnalysisRef.current.has(sessionId)) {
        cancelledAnalysisRef.current.delete(sessionId);
        if (!forcedAdvancedRef.current.has(sessionId)) {
          dispatchRef.current({ type: 'NEXT' });
        }
        forcedAdvancedRef.current.delete(sessionId);
        return;
      }
      const { title, keyPoints, actions, summary } = parseAnalysisResponse(response);
      try {
        await updateSession(sessionId, {
          title:      title.trim() || null,
          key_points: keyPoints.length > 0 ? JSON.stringify(keyPoints) : null,
          actions:    actions.length   > 0 ? JSON.stringify(actions)   : null,
          summary:    summary || null,
          walk_type:  walkType,
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
      } catch {
        // DB write failed — Sentry captured inside updateSession; advance queue
      } finally {
        if (mountedRef.current) dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateSession]
  );

  function enqueueTranscription(recordingId: string, uri: string) {
    const alreadyActive = queue.active?.type === 'transcribe' && queue.active.recordingId === recordingId;
    const alreadyPending = queue.pending.some(j => j.type === 'transcribe' && j.recordingId === recordingId);
    if (alreadyActive || alreadyPending) return;
    setFailedIds(prev => { const n = new Set(prev); n.delete(recordingId); return n; });
    dispatch({ type: 'PUSH', job: { type: 'transcribe', recordingId, uri } });
  }

  function enqueueAnalysis(sessionId: string, transcripts: string[], walkType: WalkType) {
    dispatch({ type: 'PUSH', job: { type: 'analyze', recordingId: sessionId, sessionId, transcripts, walkType } });
  }

  function cancelAnalysis(sessionId: string) {
    cancelledAnalysisRef.current.add(sessionId);
    const active = activeJobRef.current;
    if (active?.type === 'analyze' && active.sessionId === sessionId) {
      forcedAdvancedRef.current.add(sessionId);
      dispatchRef.current({ type: 'NEXT' });
    }
  }

  function resetQueue() {
    const active = activeJobRef.current;
    if (active?.type === 'analyze') {
      cancelledAnalysisRef.current.add(active.sessionId);
      forcedAdvancedRef.current.add(active.sessionId);
    }
    dispatch({ type: 'RESET' });
    setTranscriptionKey(k => k + 1);
    setLlmWorkerKey(k => k + 1);
    setIsLLMReady(false);
    setFailedIds(new Set());
    setModelError(null);
    setLlmDownloadProgress(0);
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
    resetQueue,
    processingId:         queue.active?.recordingId ?? null,
    processingType:       queue.active?.type ?? null,
    modelDownloadProgress,
    isModelReady,
    modelError,
    failedIds,
    queuedIds,
    analyzingSessionId: queue.active?.type === 'analyze' ? queue.active.sessionId : null,
    liveTranscript,
    llmDownloadProgress,
    isLLMReady,
  };

  return (
    <AIQueueContext.Provider value={value}>
      {children}
      {queue.active?.type !== 'analyze' && (
        <AIWorkerErrorBoundary key={transcriptionKey} onError={handleError}>
          <TranscriptionWorker
            job={queue.active?.type === 'transcribe' ? queue.active : null}
            onDone={handleTranscriptionDone}
            onProgress={setModelDownloadProgress}
            onReady={setIsModelReady}
            onError={handleError}
            onLiveSequence={setLiveTranscript}
          />
        </AIWorkerErrorBoundary>
      )}
      {queue.active?.type === 'analyze' && analyzeWorkerReady && (
        <AIWorkerErrorBoundary key={llmWorkerKey} onError={handleError}>
          <AnalyzeWorker
            job={queue.active as AnalyzeJob}
            onDone={handleAnalyzeDone}
            onError={handleError}
            onProgress={setLlmDownloadProgress}
            onReady={setIsLLMReady}
          />
        </AIWorkerErrorBoundary>
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
