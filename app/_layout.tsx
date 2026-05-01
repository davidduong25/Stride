import { useEffect } from 'react';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-reanimated';
import * as Sentry from '@sentry/react-native';

import { C } from '@/constants/theme';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.EXPO_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.2,
});
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

function RootLayout() {
  const router = useRouter();

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

    AsyncStorage.getItem('momentum.hasOnboarded').then(val => {
      if (val !== 'true') router.replace('/onboarding');
    });
  }, []);

  return (
    <ThemeProvider value={StrideTheme}>
      <RecordingsProvider>
        <SessionsProvider>
          <AIQueueProvider>
            <WalkSessionProvider>
              <Stack>
                <Stack.Screen name="(tabs)"       options={{ headerShown: false }} />
                <Stack.Screen name="onboarding"   options={{ headerShown: false, gestureEnabled: false }} />
                <Stack.Screen name="settings"     options={{ headerShown: true, title: 'Settings', headerBackTitle: 'Back' }} />
                <Stack.Screen name="walk-summary" options={{ headerShown: true, title: 'Walk Summary', headerBackTitle: 'Done' }} />
                <Stack.Screen name="stats"        options={{ headerShown: true, title: 'Stats', headerBackTitle: 'Back' }} />
              </Stack>
              <StatusBar style="light" />
            </WalkSessionProvider>
          </AIQueueProvider>
        </SessionsProvider>
      </RecordingsProvider>
    </ThemeProvider>
  );
}

export default Sentry.wrap(RootLayout);
