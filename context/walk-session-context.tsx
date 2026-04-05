import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { Pedometer } from 'expo-sensors';

export type WalkSessionSnapshot = {
  startedAt: number;
  endedAt: number;
  stepCount: number;
  recordingIds: string[];
};

type WalkSessionCtx = {
  isSessionActive: boolean;
  startSession: (currentStepCount: number) => void;
  addRecordingToSession: (recordingId: string) => void;
  endSession: (currentStepCount: number) => Promise<WalkSessionSnapshot | null>;
};

const WalkSessionContext = createContext<WalkSessionCtx | null>(null);

export function WalkSessionProvider({ children }: PropsWithChildren) {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const stepCountAtStartRef = useRef(0);
  const recordingIdsRef = useRef<string[]>([]);

  const startSession = useCallback((currentStepCount: number) => {
    startedAtRef.current = Date.now();
    stepCountAtStartRef.current = currentStepCount;
    recordingIdsRef.current = [];
    setIsSessionActive(true);
  }, []);

  const addRecordingToSession = useCallback((recordingId: string) => {
    if (startedAtRef.current === null) return;
    recordingIdsRef.current = [...recordingIdsRef.current, recordingId];
  }, []);

  const endSession = useCallback(async (currentStepCount: number): Promise<WalkSessionSnapshot | null> => {
    if (startedAtRef.current === null) return null;
    const startedAt = startedAtRef.current;
    const endedAt = Date.now();
    const fallbackSteps = Math.max(0, currentStepCount - stepCountAtStartRef.current);
    const recordingIds = [...recordingIdsRef.current];

    startedAtRef.current = null;
    stepCountAtStartRef.current = 0;
    recordingIdsRef.current = [];
    setIsSessionActive(false);

    // Query iOS Health for the authoritative step count over the session window.
    // Falls back to subscription-relative count if HealthKit is unavailable.
    let stepCount = fallbackSteps;
    try {
      const result = await Pedometer.getStepCountAsync(new Date(startedAt), new Date(endedAt));
      stepCount = result.steps;
    } catch { /* keep fallback */ }

    return { startedAt, endedAt, stepCount, recordingIds };
  }, []);

  return (
    <WalkSessionContext.Provider value={{ isSessionActive, startSession, addRecordingToSession, endSession }}>
      {children}
    </WalkSessionContext.Provider>
  );
}

export function useWalkSession(): WalkSessionCtx {
  const ctx = useContext(WalkSessionContext);
  if (!ctx) throw new Error('useWalkSession must be used within WalkSessionProvider');
  return ctx;
}
