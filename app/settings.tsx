import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import { C } from '@/constants/theme';
import { useRecordingsContext } from '@/context/recordings-context';
import { useSessionsContext } from '@/context/sessions-context';
import { IconSymbol } from '@/components/ui/icon-symbol';

const version = Constants.expoConfig?.version ?? '1.0.0';

// ---------------------------------------------------------------------------
// Row building blocks
// ---------------------------------------------------------------------------

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

type RowProps = {
  label:       string;
  value?:      string;
  destructive?: boolean;
  chevron?:    boolean;
  onPress?:    () => void;
};

function SettingsRow({ label, value, destructive, chevron, onPress }: RowProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.rowLabel, destructive && styles.rowLabelDestructive]}>
        {label}
      </Text>
      {value !== undefined && (
        <Text style={styles.rowValue}>{value}</Text>
      )}
      {chevron && (
        <IconSymbol name="chevron.right" size={13} color={C.textTertiary} />
      )}
    </Pressable>
  );
}

function RowDivider() {
  return <View style={styles.rowDivider} />;
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const router = useRouter();
  const { recordings, clearAllRecordings } = useRecordingsContext();
  const { sessions, clearAllSessions }     = useSessionsContext();

  // ── Handlers ──────────────────────────────────────────────────────────────

  function confirmClearWalks() {
    Alert.alert(
      'Clear all walks?',
      `This will permanently delete ${sessions.length} walk${sessions.length !== 1 ? 's' : ''} and their AI summaries. Recorded thoughts are kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear walks', style: 'destructive', onPress: clearAllSessions },
      ]
    );
  }

  function confirmClearThoughts() {
    Alert.alert(
      'Clear all thoughts?',
      `This will permanently delete ${recordings.length} recording${recordings.length !== 1 ? 's' : ''} and their transcripts.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear thoughts', style: 'destructive', onPress: clearAllRecordings },
      ]
    );
  }

  function confirmClearEverything() {
    Alert.alert(
      'Clear everything?',
      'This permanently deletes all walks, recordings, and AI summaries. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear everything',
          style: 'destructive',
          onPress: async () => {
            await Promise.all([clearAllSessions(), clearAllRecordings()]);
          },
        },
      ]
    );
  }

  async function resetOnboarding() {
    await AsyncStorage.removeItem('momentum.hasOnboarded');
    router.replace('/onboarding');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Data */}
        <SectionHeader label="DATA" />
        <SettingsGroup>
          <SettingsRow
            label="Clear all walks"
            destructive
            onPress={confirmClearWalks}
          />
          <RowDivider />
          <SettingsRow
            label="Clear all thoughts"
            destructive
            onPress={confirmClearThoughts}
          />
          <RowDivider />
          <SettingsRow
            label="Clear everything"
            destructive
            onPress={confirmClearEverything}
          />
        </SettingsGroup>

        {/* Onboarding */}
        <SectionHeader label="HELP" />
        <SettingsGroup>
          <SettingsRow
            label="Replay onboarding"
            chevron
            onPress={resetOnboarding}
          />
        </SettingsGroup>

        {/* About */}
        <SectionHeader label="ABOUT" />
        <SettingsGroup>
          <SettingsRow label="Version" value={version} />
          <RowDivider />
          <SettingsRow
            label={`${recordings.length} thought${recordings.length !== 1 ? 's' : ''} · ${sessions.length} walk${sessions.length !== 1 ? 's' : ''}`}
          />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safe: {
    flex:            1,
    backgroundColor: C.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop:        12,
    paddingBottom:     48,
  },

  // ── Section ───────────────────────────────────────────────────────────────
  sectionHeader: {
    fontSize:      11,
    fontWeight:    '600',
    color:         C.textTertiary,
    letterSpacing: 1.2,
    marginTop:     28,
    marginBottom:   8,
    marginLeft:     4,
  },
  group: {
    backgroundColor: C.surface,
    borderRadius:    14,
    overflow:        'hidden',
  },

  // ── Row ───────────────────────────────────────────────────────────────────
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   14,
    gap:                8,
  },
  rowPressed: {
    backgroundColor: C.surfaceHigh,
  },
  rowLabel: {
    flex:     1,
    fontSize: 15,
    color:    C.text,
  },
  rowLabelDestructive: {
    color: C.red,
  },
  rowValue: {
    fontSize: 15,
    color:    C.textSecondary,
  },
  rowDivider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginLeft:      16,
  },
});
