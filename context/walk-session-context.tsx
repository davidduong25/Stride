import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

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
  endSession: (currentStepCount: number) => WalkSessionSnapshot | null;
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

  const endSession = useCallback((currentStepCount: number): WalkSessionSnapshot | null => {
    if (startedAtRef.current === null) return null;
    const snapshot: WalkSessionSnapshot = {
      startedAt: startedAtRef.current,
      endedAt: Date.now(),
      stepCount: Math.max(0, currentStepCount - stepCountAtStartRef.current),
      recordingIds: [...recordingIdsRef.current],
    };
    startedAtRef.current = null;
    stepCountAtStartRef.current = 0;
    recordingIdsRef.current = [];
    setIsSessionActive(false);
    return snapshot;
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
