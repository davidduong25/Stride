# Momentum — Project Rules

## Project

React Native / Expo Router app (SDK 54, New Architecture enabled, React Compiler enabled).
Project root: `C:\Users\david\momentum`. All source files live here — ignore the nested `momentum/` subfolder.

## Hard Rules
-->

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
