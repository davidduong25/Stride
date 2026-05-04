# Stride — Project Rules

## Current Version

`1.0.3` — baseline. Bump `version` in `app.json` with every OTA push or EAS build, then log it below.

## Edit Log

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-05-02 | Baseline — crash-safe transcription, swipe-to-delete, sort/filter sheet |
| 1.0.1 | 2026-05-02 | Fix summarize loop; enable Sentry in EAS builds |
| 1.0.2 | 2026-05-02 | Switch LLM from QLORA to SPINQUANT; add 30s error timeout for stuck analyze worker |
| 1.0.3 | 2026-05-03 | Self-host LLM model files on GitHub Releases; switch runtimeVersion to fingerprint |

> **Convention:** After every set of edits that gets pushed (OTA or EAS), increment the version in `app.json` and add a row here. Keep entries short — one line per version.

## Project

React Native / Expo Router app (SDK 54, New Architecture enabled, React Compiler enabled).
Project root: `C:\Users\david\stride`. All source files live here — ignore the nested `momentum/` subfolder.

## Hard Rules

- **Version bumping is mandatory.** Whenever you make edits that David intends to push (OTA update or EAS build), you MUST:
  1. Increment `version` in `app.json` — patch bump (e.g. `1.0.0` → `1.0.1`) for fixes/tweaks, minor bump (e.g. `1.0.x` → `1.1.0`) for new features.
  2. Update the "Current Version" line at the top of this file.
  3. Add a row to the Edit Log table with the new version, today's date, and a one-line description.
- The version shown in Settings → About (`app/settings.tsx:31`) reads directly from `app.json` via `Constants.expoConfig?.version` — no other wiring needed.
- Never skip the version bump even if the change feels small. David uses the version number to verify OTA updates landed on the device.

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

Once resolved, remove the entry. Don't leave stale entries. Add new issues here as soon as they're found — include file:line if it's a code bug, or a plain description for deployment/operational issues.

### Deployment
- **OTA updates need new build** — switched `runtimeVersion` from `appVersion` to `fingerprint` policy. Requires one `eas build --profile preview --platform ios` to bake in the new policy; after that, JS-only OTA updates will land on device.

### Code Bugs
- **`ai-queue-context.tsx:700`** — `enqueueAnalysis` puts `sessionId` into the `recordingId` field of the analyze job (both fields set to same value; no crash, but logic bug if `recordingId` is ever read expecting a real recording ID).
- **`use-audio-recording.ts:158`** — `(documentDirectory ?? '') + filename` falls back to a bare filename when `documentDirectory` is null, producing a non-absolute path that silently saves to the wrong location.

### AI / Models
- **LLM mid-download stalls hang silently** (`ai-queue-context.tsx` `AnalyzeWorker`) — model files now self-hosted on GitHub Releases (`models-v1` tag). 30s timeout catches failed starts (downloadProgress stays 0), but stalls mid-download still hang with no user feedback. `useLLM` swallows these errors internally.
