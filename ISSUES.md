# Stride — Open Issues

When an issue is found, add it here immediately. When fixed, remove it. No stale entries.

---

## Deployment
- **OTA updates need new build** — switched `runtimeVersion` from `appVersion` to `fingerprint` policy. Requires one `eas build --profile preview --platform ios` to bake in; after that, JS-only OTA updates will land on device.

## Code Bugs
- **`ai-queue-context.tsx:700`** — `enqueueAnalysis` puts `sessionId` into the `recordingId` field of the analyze job. No crash, but a failed analysis won't light up the retry UI (sessionId ends up in `failedIds` instead of recordingId).
- **`use-audio-recording.ts:158`** — `(documentDirectory ?? '') + filename` falls back to a bare filename when `documentDirectory` is null, producing a non-absolute path that silently saves to the wrong location.

## AI / Models
- **LLM mid-download stalls hang silently** (`ai-queue-context.tsx` `AnalyzeWorker`) — 30s timeout catches failed starts (downloadProgress stays 0), but stalls mid-download still hang with no user feedback. `useLLM` swallows these errors internally.
