import { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import {
  documentDirectory,
  copyAsync,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';

import { C } from '@/constants/theme';
import { useRecordingsContext } from '@/context/recordings-context';
import { useSessionsContext } from '@/context/sessions-context';
import { useNotifications } from '@/hooks/use-notifications';
import { buildMarkdownExport } from '@/lib/export';
import { IconSymbol } from '@/components/ui/icon-symbol';

const version = Constants.expoConfig?.version ?? '1.0.0';
const PRIVACY_POLICY_URL = 'https://davidduong25.github.io/stride/privacy';

const BACKUP_TS_KEY = 'stride.lastBackupTs';
const DB_PATH       = `${documentDirectory ?? ''}SQLite/momentum.db`;
const BACKUP_PATH   = `${documentDirectory ?? ''}stride_backup.db`;

// Hour options for notification time picker
const HOUR_OPTIONS = [
  { label: '7 AM',  value: 7  },
  { label: '8 AM',  value: 8  },
  { label: '12 PM', value: 12 },
  { label: '5 PM',  value: 17 },
  { label: '6 PM',  value: 18 },
  { label: '7 PM',  value: 19 },
  { label: '8 PM',  value: 20 },
];

const DAY_OPTIONS = [
  { label: 'Sun', value: 1 },
  { label: 'Mon', value: 2 },
  { label: 'Tue', value: 3 },
  { label: 'Wed', value: 4 },
  { label: 'Thu', value: 5 },
  { label: 'Fri', value: 6 },
  { label: 'Sat', value: 7 },
];

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
  label:        string;
  value?:       string;
  destructive?: boolean;
  chevron?:     boolean;
  switchValue?: boolean;
  onSwitch?:    (v: boolean) => void;
  onPress?:     () => void;
};

function SettingsRow({ label, value, destructive, chevron, switchValue, onSwitch, onPress }: RowProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
      onPress={onPress}
      disabled={!onPress && onSwitch === undefined}
    >
      <Text style={[styles.rowLabel, destructive && styles.rowLabelDestructive]}>
        {label}
      </Text>
      {value !== undefined && (
        <Text style={styles.rowValue}>{value}</Text>
      )}
      {onSwitch !== undefined && (
        <Switch
          value={switchValue}
          onValueChange={onSwitch}
          trackColor={{ false: C.surfaceHigh, true: C.tint }}
          thumbColor={C.text}
        />
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

function ChipRow<T extends number>({
  options,
  selected,
  onSelect,
}: {
  options:  { label: string; value: T }[];
  selected: T;
  onSelect: (v: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRowContent}
      style={styles.chipRow}
    >
      {options.map(o => (
        <Pressable
          key={o.value}
          onPress={() => onSelect(o.value)}
          style={[styles.chip, selected === o.value && styles.chipActive]}
        >
          <Text style={[styles.chipText, selected === o.value && styles.chipTextActive]}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const router = useRouter();
  const { recordings, clearAllRecordings } = useRecordingsContext();
  const { sessions, clearAllSessions }     = useSessionsContext();

  const [testMode, setTestMode]       = useState(false);
  const [lastBackup, setLastBackup]   = useState<number | null>(null);
  const [backingUp, setBackingUp]     = useState(false);

  const {
    prefs,
    setStreakEnabled,
    setStreakHour,
    setWeeklyEnabled,
    setWeeklyDay,
  } = useNotifications();

  useEffect(() => {
    AsyncStorage.getItem('momentum.testMode').then(val => setTestMode(val === 'true'));
    AsyncStorage.getItem(BACKUP_TS_KEY).then(val => val && setLastBackup(Number(val)));
  }, []);

  async function toggleTestMode(value: boolean) {
    setTestMode(value);
    await AsyncStorage.setItem('momentum.testMode', value ? 'true' : 'false');
  }

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

  async function handleExport() {
    if (sessions.length === 0) {
      Alert.alert('Nothing to export', 'Complete a walk first.');
      return;
    }
    const markdown = buildMarkdownExport(sessions, recordings);
    await Share.share({ message: markdown });
  }

  async function handleBackup() {
    setBackingUp(true);
    try {
      const info = await getInfoAsync(DB_PATH);
      if (!info.exists) {
        Alert.alert('Backup failed', 'Database file not found.');
        return;
      }
      await deleteAsync(BACKUP_PATH, { idempotent: true }).catch(() => {});
      await copyAsync({ from: DB_PATH, to: BACKUP_PATH });
      const ts = Date.now();
      await AsyncStorage.setItem(BACKUP_TS_KEY, ts.toString());
      setLastBackup(ts);
    } catch {
      Alert.alert('Backup failed', 'Could not copy the database. Try again.');
    } finally {
      setBackingUp(false);
    }
  }

  function backupLabel(): string {
    if (backingUp) return 'Backing up…';
    if (!lastBackup) return 'Back up now';
    return `Backed up ${new Date(lastBackup).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Notifications */}
        <SectionHeader label="NOTIFICATIONS" />
        <SettingsGroup>
          <SettingsRow
            label="Streak reminder"
            switchValue={prefs.streakEnabled}
            onSwitch={setStreakEnabled}
          />
          {prefs.streakEnabled && (
            <ChipRow
              options={HOUR_OPTIONS}
              selected={prefs.streakHour}
              onSelect={setStreakHour}
            />
          )}
          <RowDivider />
          <SettingsRow
            label="Weekly recap"
            switchValue={prefs.weeklyEnabled}
            onSwitch={setWeeklyEnabled}
          />
          {prefs.weeklyEnabled && (
            <ChipRow
              options={DAY_OPTIONS}
              selected={prefs.weeklyDay}
              onSelect={setWeeklyDay}
            />
          )}
        </SettingsGroup>

        {/* Data */}
        <SectionHeader label="DATA" />
        <SettingsGroup>
          <SettingsRow
            label="Export journal"
            chevron
            onPress={handleExport}
          />
          <RowDivider />
          <SettingsRow
            label={backupLabel()}
            chevron={!backingUp}
            onPress={backingUp ? undefined : handleBackup}
          />
          <RowDivider />
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

        {/* Developer */}
        <SectionHeader label="DEVELOPER" />
        <SettingsGroup>
          <SettingsRow
            label="Test mode"
            switchValue={testMode}
            onSwitch={toggleTestMode}
          />
        </SettingsGroup>

        {/* Help */}
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
          <RowDivider />
          <SettingsRow
            label="Privacy Policy"
            chevron
            onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
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

  chipRow: {
    paddingBottom: 12,
  },
  chipRowContent: {
    paddingHorizontal: 16,
    gap:                6,
    flexDirection:     'row',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical:    5,
    borderRadius:      20,
    backgroundColor:   C.surfaceHigh,
    borderWidth:       1,
    borderColor:       C.border,
  },
  chipActive: {
    backgroundColor: C.tint,
    borderColor:     C.tint,
  },
  chipText: {
    fontSize:   12,
    color:      C.textSecondary,
    fontWeight: '500',
  },
  chipTextActive: {
    color: C.text,
  },
});
