import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { RecordingsProvider } from '@/context/recordings-context';
import { AIQueueProvider } from '@/context/ai-queue-context';
import { WalkSessionProvider } from '@/context/walk-session-context';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <RecordingsProvider>
        <AIQueueProvider>
          <WalkSessionProvider>
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
              <Stack.Screen name="walk-summary" options={{ headerShown: true }} />
            </Stack>
            <StatusBar style="auto" />
          </WalkSessionProvider>
        </AIQueueProvider>
      </RecordingsProvider>
    </ThemeProvider>
  );
}
