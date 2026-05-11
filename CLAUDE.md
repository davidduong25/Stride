# Stride — Project Rules

## Current Version

`1.2.1` — last pushed version. Only bump `version` in `app.json` when doing an EAS build, not for OTA-only pushes.

## Edit Log

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-05-02 | Baseline — crash-safe transcription, swipe-to-delete, sort/filter sheet |
| 1.0.1 | 2026-05-02 | Fix summarize loop; enable Sentry in EAS builds |
| 1.0.2 | 2026-05-02 | Switch LLM from QLORA to SPINQUANT; add 30s error timeout for stuck analyze worker |
| 1.0.3 | 2026-05-03 | Self-host LLM model files on GitHub Releases; switch runtimeVersion to fingerprint |
| 1.0.4 | 2026-05-03 | Fix queue stuck on cancel+delete; add reset AI queue to Settings |
| 1.0.5 | 2026-05-03 | Delete cascade on session swipe; plan keyword fix; live transcript streaming; high-pass audio filter; Notes-style transcript editing; paragraph detection |
| 1.0.6 | 2026-05-03 | OTA pipeline test — version now reads from constants/version.ts |
| 1.0.7 | 2026-05-03 | LLM progress feedback + 3-min load timeout replacing broken 30s download-only timeout |
| 1.0.8 | 2026-05-03 | Fix summarize re-summarise loop: error effect now ignores pre-generation errors; handleError writes null title |
| 1.0.9 | 2026-05-04 | Switch LLM to official HuggingFace URLs (was self-hosted GitHub); add Clear model cache to Settings |
| 1.1.0 | 2026-05-04 | Revert LLM to QLORA (was SPINQUANT); eager background download with inline progress bar; remove blocking overlay |
| 1.1.1 | 2026-05-04 | Fix summarize loop: route LLM runAsync error through onError instead of onDone; reset LLM worker on analyze failure |
| 1.1.2 | 2026-05-04 | Switch LLM from Llama 3.2 1B QLORA to Qwen 2.5 0.5B quantized (~350MB vs ~1.1GB) |
| 1.1.3 | 2026-05-05 | Fix runAsync crash: revert AnalyzeWorker to conditional mount (was always-mounted since 1.1.0, caused stale GPU resources after app backgrounding) |
| 1.1.4 | 2026-05-07 | Enable background recording: remove AppState stop-on-background; UIBackgroundModes audio + staysActiveInBackground already declared |
| 1.1.5 | 2026-05-07 | Fix runAsync crash: remove LLMPreloaderWorker, always-mount AnalyzeWorker, bump llmWorkerKey on foreground resume; tighten enqueueAnalysis gate to !isLLMReady |
| 1.1.6 | 2026-05-07 | Fix runAsync root cause: restore 1500ms analyzeWorkerReady delay (dropped in 1.1.0), revert to conditional AnalyzeWorker mount, fix generate().catch() for unhandled rejections, remove isLLMReady gate from confirm card |
| 1.1.7 | 2026-05-07 | Fix LLM model: revert from Qwen 2.5 0.5B (8da4w incompatible with A14/ExecuTorch 0.4.10) back to Llama 3.2 1B SPINQUANT |
| 1.1.8 | 2026-05-08 | Switch LLM back to Qwen 2.5 0.5B: root cause of runAsync error is OOM (Moonshine unreleasable; 1.1GB Llama + Moonshine exceeds device limit; Qwen at 350MB fits comfortably) |
| 1.1.9 | 2026-05-10 | Fix stuck "preparing AI models…" bar: only show when analyze job is active or LLM is downloading; fix Settings cache size label (~350MB not ~1.1GB) |
| 1.2.0 | 2026-05-10 | Replace Moonshine STT with Apple on-device speech recognition (expo-speech-recognition): removes ExecuTorch GPU context contention that caused runAsync crashes; eliminates ~100MB model download; removes WAV/CAF PCM decoding code |
| 1.2.1 | 2026-05-11 | Real-time transcription: STT runs live during recording (continuous mic, not file-based); transcript saved on stop; live 5-word fade display during recording; remove post-recording transcription queue |

> **Convention:** After every push (OTA or EAS), bump `APP_VERSION` in `constants/version.ts` and add a row here. Also bump `version` in `app.json` only for EAS builds. Keep entries short — one line per version.

## Project

React Native / Expo Router app (SDK 54, New Architecture enabled, React Compiler enabled).
Project root: `C:\Users\david\stride`. All source files live here — ignore the nested `momentum/` subfolder.

## Hard Rules

- **Version bumping rules (fingerprint runtimeVersion policy):**
  - **Every push (OTA or EAS build):** bump `APP_VERSION` in `constants/version.ts` — this is what Settings displays and what David uses to verify updates landed on device.
  - **EAS build only:** also bump `version` in `app.json` (patch for fixes, minor for features). This controls the fingerprint hash and the App Store build number. Do NOT bump `app.json` for OTA-only pushes — it shifts the fingerprint and the update silently skips every installed device.
  - Update the "Current Version" line at the top of this file and add a row to the Edit Log on every push.
  - To verify an OTA landed: Settings → About will show the new `APP_VERSION`.

## Architecture

- Navigation: Expo Router v6 (file-based). Tabs live in `app/(tabs)/`, stack screens at `app/`.
- State: React context providers in `context/`. No Redux or Zustand.
- Storage: SQLite via `expo-sqlite` (see `hooks/use-recordings.ts`). Schema changes go through the migration pattern already in that file.
- Audio: `expo-audio` (`useAudioRecorder`, `createAudioPlayer`).
- Sensors: `expo-sensors` (`Pedometer`, `Accelerometer`).

## Conventions

- File names: kebab-case (`walk-summary.tsx`, `use-pedometer.ts`).
- Path alias `@/` maps to the project root.
- Hooks in `hooks/`, context providers in `context/`, shared components in `components/`.
- No `console.log` in committed code.
- Do not add `useMemo`/`useCallback` manually — the React Compiler handles memoization.
- Do not add comments unless the logic is genuinely non-obvious.

## UI / Theme

**Dark-only.** No light mode. Never add light/dark branching logic.

**Colors:** Import `C` from `@/constants/theme` — use it for every color value, no raw hex strings.

| Token | Value | Use |
|-------|-------|-----|
| `C.background` | `#000000` | Screen backgrounds |
| `C.surface` | `#111111` | Cards, grouped rows |
| `C.surfaceHigh` | `#1C1C1E` | Modals, pressed states |
| `C.text` | `#FFFFFF` | Primary text |
| `C.textSecondary` | `#8E8E93` | Supporting text |
| `C.textTertiary` | `#48484A` | Section headers, hints |
| `C.tint` | `#2D6EF5` | Active states, links |
| `C.green / .yellow / .red` | — | Status indicators |
| `C.border` | `#2C2C2E` | `StyleSheet.hairlineWidth` dividers |

**Typography shortcuts:**
- Section headers: 11px, weight 600, all-caps, `C.textTertiary`, letterSpacing 1.2
- Row labels: 16px, `C.text`; values/secondary: 16px, `C.textSecondary`
- Use `ThemedText` for general text (types: `default`, `defaultSemiBold`, `title`, `subtitle`, `link`)

**Spacing rules of thumb:** 16px horizontal screen padding · 14px vertical row padding · `borderRadius: 14` for cards · `borderRadius: 20` for chips · `StyleSheet.hairlineWidth` for dividers · 48px bottom padding on scrollable screens.

**Icons:** `IconSymbol` from `@/components/ui/icon-symbol` — SF Symbols on iOS, Material fallback on Android. Add new symbol mappings to `icon-symbol.tsx` if Android needs them.

**Shared components worth reusing:** `WaveformScrubber`, `EllipsisMenu`, `HapticTab`, `ExternalLink`, `Collapsible`.

## Fragile Areas

These are areas where subtle invariants make casual edits risky — read the relevant file before touching.

- **`TranscriptionWorker` key** (`context/ai-queue-context.tsx`): The worker's `key` prop only increments on error, never between normal jobs. Bumping it unnecessarily tears down the native model and causes a crash.
- **`pendingSaveRef`** (`app/(tabs)/index.tsx`): Must be set *synchronously* (not after an await) inside `handleStopRecording`. The pedometer auto-end path awaits it — any async gap risks a race where the session ends before the recording is saved.
- **`endSession()` idempotency**: Returns `null` on second call by design. Don't add guards around it assuming it's broken.
- **Schema migrations** (`hooks/use-recordings.ts`, `hooks/use-sessions.ts`): Use the existing try/catch `ALTER TABLE` pattern. Never recreate tables or drop columns.
- **`eas update` command**: Always `--channel preview --platform ios`. Omitting `--platform ios` bundles web, which fails because `react-native-executorch` has no CommonJS build.

## Open Issues

Tracked in `ISSUES.md` — read that file at the start of every session. Add issues there immediately when found, remove them when fixed.
