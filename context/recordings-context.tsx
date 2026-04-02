import React, { createContext, useContext, type PropsWithChildren } from 'react';
import { useRecordings, type RecordingEntry } from '@/hooks/use-recordings';

export type { RecordingEntry };

type RecordingsCtx = ReturnType<typeof useRecordings>;

const RecordingsContext = createContext<RecordingsCtx | null>(null);

export function RecordingsProvider({ children }: PropsWithChildren) {
  const value = useRecordings();
  return (
    <RecordingsContext.Provider value={value}>
      {children}
    </RecordingsContext.Provider>
  );
}

export function useRecordingsContext(): RecordingsCtx {
  const ctx = useContext(RecordingsContext);
  if (!ctx) throw new Error('useRecordingsContext must be used within RecordingsProvider');
  return ctx;
}
