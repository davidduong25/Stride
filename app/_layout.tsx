import { useEffect } from 'react';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { C } from '@/constants/theme';
import { RecordingsProvider } from '@/context/recordings-context';
import { SessionsProvider } from '@/context/sessions-context';
import { AIQueueProvider } from '@/context/ai-queue-context';
import { WalkSessionProvider } from '@/context/walk-session-context';

// Stride is always dark — override react-navigation's default dark palette
// so background, card, and border colours match our design system.
const StrideTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: C.background,
    card:        C.surface,
    border:      C.border,
    primary:     C.tint,
    text:        C.text,
    notification: C.tint,
  },
};

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  useEffect(() => {
    try {
      const Notifications = require('expo-notifications');
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: false,
          shouldSetBadge:  false,
        }),
      });
      Notifications.requestPermissionsAsync();
    } catch { /* native module not available in this build */ }
  }, []);

  return (
    <ThemeProvider value={StrideTheme}>
      <RecordingsProvider>
        <SessionsProvider>
          <AIQueueProvider>
            <WalkSessionProvider>
              <Stack>
                <Stack.Screen name="(tabs)"       options={{ headerShown: false }} />
                <Stack.Screen name="walk-summary" options={{ headerShown: true, title: 'Walk Summary', headerBackTitle: 'Done' }} />
              </Stack>
              <StatusBar style="light" />
            </WalkSessionProvider>
          </AIQueueProvider>
        </SessionsProvider>
      </RecordingsProvider>
    </ThemeProvider>
  );
}
