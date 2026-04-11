import React, { createContext, useContext, type PropsWithChildren } from 'react';
import { useSessions, type SessionEntry } from '@/hooks/use-sessions';

export type { SessionEntry };

type SessionsCtx = ReturnType<typeof useSessions>;

const SessionsContext = createContext<SessionsCtx | null>(null);

export function SessionsProvider({ children }: PropsWithChildren) {
  const value = useSessions();
  return (
    <SessionsContext.Provider value={value}>
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessionsContext(): SessionsCtx {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error('useSessionsContext must be used within SessionsProvider');
  return ctx;
}
