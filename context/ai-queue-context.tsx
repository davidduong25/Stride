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
  LLAMA3_2_1B_SPINQUANT,
  LLAMA3_2_TOKENIZER,
} from 'react-native-executorch';
import * as Sentry from '@sentry/react-native';

const LLM_MODEL_SOURCE     = LLAMA3_2_1B_SPINQUANT;
const LLM_TOKENIZER_SOURCE = LLAMA3_2_TOKENIZER;

// Inline tokenizer config so ResourceFetcher.handleObject() writes it locally,
// bypassing the cached remote file. Template is the official Llama 3.2 format
// without |trim (which fails on-device with "Cannot apply filter 'trim' to
// type: UndefinedValue" — root cause unknown but reproducible).
const LLM_TOKENIZER_CONFIG = {
  bos_token: '<|begin_of_text|>',
  eos_token: '<|eot_id|>',
  chat_template:
    "{{- bos_token }}" +
    "{%- if messages[0]['role'] == 'system' %}" +
    "{%- set system_message = messages[0]['content'] %}" +
    "{%- set messages = messages[1:] %}" +
    "{%- else %}" +
    "{%- set system_message = '' %}" +
    "{%- endif %}" +
    "<|start_header_id|>system<|end_header_id|>\n\n" +
    "Cutting Knowledge Date: December 2023\n\n" +
    "{{ system_message }}<|eot_id|>" +
    "{%- for message in messages %}" +
    "<|start_header_id|>{{ message['role'] }}<|end_header_id|>\n\n" +
    "{{ message['content'] }}<|eot_id|>" +
    "{%- endfor %}" +
    "{%- if add_generation_prompt %}" +
    "<|start_header_id|>assistant<|end_header_id|>\n\n" +
    "{%- endif %}",
};

import { useSessionsContext } from './sessions-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClassifyJob = { type: 'classify'; recordingId: string; sessionId: string; recordingIds: string[]; transcripts: string[] };
export type AnalyzeJob  = { type: 'analyze';  recordingId: string; sessionId: string; transcripts: string[]; walkType: WalkType };
export type AIJob       = ClassifyJob | AnalyzeJob;

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

export function classifyTranscript(transcript: string): WalkType | null {
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
// Classification
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT =
  'You are a walk journal classifier. Given a voice transcript, output exactly one word ' +
  'that best describes the walk type. Choose only from: vent, brainstorm, plan, reflect, ' +
  'appreciate, untangle. Output the single word only, nothing else.';

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
  vent:       'Summarise this vent journal entry. Reply:\nTITLE: [5 words]\nSUMMARY: [2 sentences, no advice]',
  brainstorm: 'Summarise this brainstorm journal. Reply:\nTITLE: [5 words]\nPOINT: [idea]\nPOINT: [idea]\nPOINT: [idea]',
  plan:       'Summarise this planning journal. Reply:\nTITLE: [5 words]\nACTION: [task]\nACTION: [task]',
  reflect:    'Summarise this reflection journal. Reply:\nTITLE: [5 words]\nSUMMARY: [2 sentences]',
  appreciate: 'Summarise this gratitude journal. Reply:\nTITLE: [5 words]\nPOINT: [appreciation]\nPOINT: [appreciation]',
  untangle:   'Summarise this decision journal. Reply:\nTITLE: [5 words]\nOPTION: [A]\nOPTION: [B]\nLEANING: [leaning]',
};

type AnalysisResult = { title: string; keyPoints: string[]; actions: string[]; summary: string | null };

function parseAnalysisResponse(response: string): AnalysisResult {
  const lines      = response.split('\n').map(l => l.trim()).filter(Boolean);
  let title        = '';
  const summaryParts: string[] = [];
  const keyPoints: string[]    = [];
  const actions: string[]      = [];

  for (const line of lines) {
    const u = line.toUpperCase();
    if      (u.startsWith('TITLE:'))   title = line.slice(6).trim().slice(0, 60);
    else if (u.startsWith('SUMMARY:')) summaryParts.push(line.slice(8).trim());
    else if (u.startsWith('LEANING:')) { const v = line.slice(8).trim(); if (v) summaryParts.push(v); }
    else if (u.startsWith('POINT:'))   { const v = line.slice(6).trim(); if (v) keyPoints.push(v); }
    else if (u.startsWith('OPTION:'))  { const v = line.slice(7).trim(); if (v) keyPoints.push(v); }
    else if (u.startsWith('ACTION:'))  { const v = line.slice(7).trim(); if (v) actions.push(v); }
  }

  // Salvage first non-empty line as title if the model skipped the tag
  if (!title && lines.length > 0) {
    title = lines[0].replace(/^[A-Z]+:\s*/, '').trim().slice(0, 60);
  }

  return {
    title,
    keyPoints,
    actions,
    summary: summaryParts.length > 0 ? summaryParts.join(' ') : null,
  };
}

// ---------------------------------------------------------------------------
// LLMAnalyzer — minimal wrapper around useLLM following the official pattern:
// configure() sets the system prompt, sendMessage() runs generation, .finally()
// captures the result after React flushes the final token state.
// ---------------------------------------------------------------------------

function LLMAnalyzer({
  job,
  onDone,
  onError,
  onProgress,
  onReady,
}: {
  job:        AnalyzeJob | null;
  onDone:     (sessionId: string, response: string, walkType: WalkType) => void;
  onError:    (err: string) => void;
  onProgress: (p: number) => void;
  onReady:    (ready: boolean) => void;
}) {
  const {
    configure, sendMessage, interrupt,
    isReady, isGenerating, response, downloadProgress,
  } = useLLM({
    modelSource:           LLM_MODEL_SOURCE,
    tokenizerSource:       LLM_TOKENIZER_SOURCE,
    tokenizerConfigSource: LLM_TOKENIZER_CONFIG,
  });

  const responseRef = useRef('');
  responseRef.current = response ?? '';

  const mountedRef       = useRef(true);
  // Track the last job object processed so the component handles job transitions
  // without remounting — comparing by reference catches same-sessionId re-summarizes.
  const processedJobRef  = useRef<AnalyzeJob | null>(null);
  const doneRef          = useRef(false);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { onProgress(downloadProgress); }, [downloadProgress, onProgress]);
  useEffect(() => { onReady(isReady); }, [isReady, onReady]);

  // 3-min timeout: if a job arrives but inference hasn't started, model failed to load.
  useEffect(() => {
    if (!job) return;
    const t = setTimeout(() => {
      if (processedJobRef.current !== job && mountedRef.current) {
        onError('Model failed to load — reset AI queue and try again');
      }
    }, 3 * 60_000);
    return () => clearTimeout(t);
  }, [job, onError]);

  // 90s generation timeout
  useEffect(() => {
    if (!isGenerating) return;
    const t = setTimeout(() => interrupt(), 90_000);
    return () => clearTimeout(t);
  }, [isGenerating, interrupt]);

  // Run inference when the model is ready and a new (unseen) job arrives.
  // The component stays mounted across jobs, so we compare job identity rather
  // than relying on mount/unmount to reset state between runs.
  useEffect(() => {
    if (!isReady || !job) return;
    if (processedJobRef.current === job) return;
    processedJobRef.current = job;
    doneRef.current = false;

    const sysPrompt = ANALYZE_PROMPTS[job.walkType];
    let combined = job.transcripts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
    if (combined.length > 300) combined = combined.slice(0, 300).replace(/\s\S*$/, '') + '…';

    configure({ chatConfig: { systemPrompt: sysPrompt } });

    let sendErr: unknown = null;
    sendMessage(`Voice notes:\n\n${combined}`)
      .catch(e => { sendErr = e; })
      .finally(() => {
        setTimeout(() => {
          if (doneRef.current || !mountedRef.current) return;
          doneRef.current = true;
          const captured = responseRef.current;
          Sentry.captureMessage(`LLM raw output: ${captured.slice(0, 500)}`, 'debug');
          Sentry.addBreadcrumb({
            message: 'LLMAnalyzer.finally',
            data: { tokens: captured.length, preview: captured.slice(0, 200), error: sendErr ? String(sendErr) : null },
          });
          if (captured.trim()) {
            onDone(job.sessionId, captured, job.walkType);
          } else {
            const msg = sendErr instanceof Error ? sendErr.message
                      : sendErr ? String(sendErr)
                      : 'No output generated';
            Sentry.captureMessage(`LLM analyze failed: ${msg}`, 'error');
            onError(msg);
          }
        }, 0);
      });
  }, [isReady, job, configure, sendMessage, onDone, onError]);

  return null;
}

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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AIQueueCtx = {
  enqueueClassification: (sessionId: string, recordingIds: string[], transcripts: string[]) => void;
  enqueueAnalysis: (sessionId: string, transcripts: string[], walkType: WalkType) => void;
  cancelAnalysis: (sessionId: string) => void;
  resetQueue: () => void;
  startModelDownload: () => void;
  processingId: string | null;
  processingType: 'classify' | 'analyze' | null;
  modelError: string | null;
  isClassifying: boolean;
  analyzingSessionId: string | null;
  llmDownloadProgress: number;
  isLLMReady: boolean;
};

const AIQueueContext = createContext<AIQueueCtx | null>(null);

export function AIQueueProvider({ children }: PropsWithChildren) {
  const { updateSession }  = useSessionsContext();
  const [queue, dispatch]  = useReducer(queueReducer, { active: null, pending: [] });

  const [modelError, setModelError]                   = useState<string | null>(null);
  const [llmDownloadProgress, setLlmDownloadProgress] = useState(0);
  const [isLLMReady, setIsLLMReady]                   = useState(false);
  const [llmWorkerKey, setLlmWorkerKey]               = useState(0);
  const [preloadLLM, setPreloadLLM]                   = useState(true);

  const dispatchRef          = useRef(dispatch);
  dispatchRef.current        = dispatch;
  const cancelledRef         = useRef<Set<string>>(new Set());
  const forcedAdvancedRef    = useRef<Set<string>>(new Set());
  const mountedRef           = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const activeJobRef         = useRef<AIJob | null>(null);
  activeJobRef.current       = queue.active;

  const llmJobActive = queue.active?.type === 'analyze';

  const handleError = useCallback(
    (err: string) => {
      if (!mountedRef.current) return;
      setModelError(err);
      setPreloadLLM(false);
      const active = activeJobRef.current;
      if (active?.type === 'analyze') {
        updateSession(active.sessionId, { title: null });
      }
      setLlmWorkerKey(k => k + 1);
      setIsLLMReady(false);
      dispatchRef.current({ type: 'NEXT' });
    },
    [updateSession]
  );

  const handleReady = useCallback((ready: boolean) => {
    setIsLLMReady(ready);
    // When preload completes with no active job, hide the download progress bar
    // but keep the model mounted so the next job can run without a second loadLLM().
    if (ready && !activeJobRef.current) {
      setLlmDownloadProgress(0);
    }
  }, []);

  const handleDone = useCallback(
    async (sessionId: string, response: string, walkType: WalkType) => {
      if (!mountedRef.current) return;
      if (cancelledRef.current.has(sessionId)) {
        cancelledRef.current.delete(sessionId);
        if (!forcedAdvancedRef.current.has(sessionId)) {
          dispatchRef.current({ type: 'NEXT' });
        }
        forcedAdvancedRef.current.delete(sessionId);
        return;
      }
      const { title, keyPoints, actions, summary } = parseAnalysisResponse(response);
      Sentry.addBreadcrumb({
        message: 'LLM parsed result',
        data: { title, keyPoints, actions, summary },
      });
      if (!title.trim() && keyPoints.length === 0 && actions.length === 0 && !summary) {
        Sentry.captureMessage(`LLM output unparseable: ${response.slice(0, 300)}`, 'error');
        onError('AI generated a response but could not produce a summary — try again');
        return;
      }
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
          } catch { /* expo-notifications unavailable */ }
        }
      } catch (dbErr) {
        Sentry.captureException(dbErr, { extra: { sessionId, title, keyPoints, actions, summary } });
      } finally {
        if (mountedRef.current) dispatchRef.current({ type: 'NEXT' });
      }
    },
    [updateSession]
  );

  function enqueueClassification(sessionId: string, recordingIds: string[], transcripts: string[]) {
    dispatch({ type: 'PUSH', job: { type: 'classify', recordingId: sessionId, sessionId, recordingIds, transcripts } });
  }

  function enqueueAnalysis(sessionId: string, transcripts: string[], walkType: WalkType) {
    setModelError(null);
    setPreloadLLM(true); // Re-mount LLMAnalyzer if it was unmounted after a previous error
    dispatch({ type: 'PUSH', job: { type: 'analyze', recordingId: sessionId, sessionId, transcripts, walkType } });
  }

  function cancelAnalysis(sessionId: string) {
    cancelledRef.current.add(sessionId);
    const active = activeJobRef.current;
    if (active?.type === 'analyze' && active.sessionId === sessionId) {
      forcedAdvancedRef.current.add(sessionId);
      dispatchRef.current({ type: 'NEXT' });
    }
  }

  function resetQueue() {
    const active = activeJobRef.current;
    if (active?.type === 'analyze') {
      cancelledRef.current.add(active.sessionId);
      forcedAdvancedRef.current.add(active.sessionId);
    }
    dispatch({ type: 'RESET' });
    setLlmWorkerKey(k => k + 1);
    setIsLLMReady(false);
    setModelError(null);
    setLlmDownloadProgress(0);
  }

  function startModelDownload() {
    setPreloadLLM(true);
    setModelError(null);
  }

  const value: AIQueueCtx = {
    enqueueClassification,
    enqueueAnalysis,
    cancelAnalysis,
    resetQueue,
    startModelDownload,
    processingId:       queue.active?.recordingId ?? null,
    processingType:     queue.active?.type ?? null,
    modelError,
    isClassifying:      queue.active?.type === 'classify',
    analyzingSessionId: queue.active?.type === 'analyze' ? queue.active.sessionId : null,
    llmDownloadProgress,
    isLLMReady,
  };

  return (
    <AIQueueContext.Provider value={value}>
      {children}
      {preloadLLM && (
        <AIWorkerErrorBoundary key={llmWorkerKey} onError={handleError}>
          <LLMAnalyzer
            job={llmJobActive ? queue.active as AnalyzeJob : null}
            onDone={handleDone}
            onError={handleError}
            onProgress={setLlmDownloadProgress}
            onReady={handleReady}
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
