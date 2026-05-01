import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFS_KEY = 'stride.notifPrefs';
const STREAK_ID = 'stride.streakNotifId';
const WEEKLY_ID = 'stride.weeklyNotifId';

export type NotifPrefs = {
  streakEnabled: boolean;
  streakHour:    number;  // 0-23
  weeklyEnabled: boolean;
  weeklyDay:     number;  // 1=Sun … 7=Sat
  weeklyHour:    number;  // 0-23
};

const DEFAULTS: NotifPrefs = {
  streakEnabled: false,
  streakHour:    19,
  weeklyEnabled: false,
  weeklyDay:     1,
  weeklyHour:    19,
};

async function cancelStored(key: string) {
  const id = await AsyncStorage.getItem(key);
  if (id) {
    try { await Notifications.cancelScheduledNotificationAsync(id); } catch {}
    await AsyncStorage.removeItem(key);
  }
}

export function useNotifications() {
  const [prefs, setPrefs]             = useState<NotifPrefs>(DEFAULTS);
  const [permGranted, setPermGranted] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY).then(raw => {
      if (raw) setPrefs({ ...DEFAULTS, ...JSON.parse(raw) });
    });
    Notifications.getPermissionsAsync().then(({ status }) =>
      setPermGranted(status === 'granted')
    );
  }, []);

  async function savePrefs(next: NotifPrefs) {
    setPrefs(next);
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next));
  }

  async function requestPerm(): Promise<boolean> {
    if (permGranted) return true;
    const { status } = await Notifications.requestPermissionsAsync();
    const ok = status === 'granted';
    setPermGranted(ok);
    return ok;
  }

  async function scheduleStreak(hour: number) {
    await cancelStored(STREAK_ID);
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Keep your streak alive',
        body:  "Don't forget to go for a walk today!",
      },
      trigger: {
        type:   Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute: 0,
      },
    });
    await AsyncStorage.setItem(STREAK_ID, id);
  }

  async function scheduleWeekly(weekday: number, hour: number) {
    await cancelStored(WEEKLY_ID);
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Your weekly walk recap',
        body:  'Open Stride to see how your week of walks looked.',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday,
        hour,
        minute: 0,
      },
    });
    await AsyncStorage.setItem(WEEKLY_ID, id);
  }

  async function setStreakEnabled(enabled: boolean) {
    const next = { ...prefs, streakEnabled: enabled };
    await savePrefs(next);
    if (enabled && await requestPerm()) {
      await scheduleStreak(next.streakHour);
    } else {
      await cancelStored(STREAK_ID);
    }
  }

  async function setStreakHour(hour: number) {
    const next = { ...prefs, streakHour: hour };
    await savePrefs(next);
    if (next.streakEnabled && permGranted) await scheduleStreak(hour);
  }

  async function setWeeklyEnabled(enabled: boolean) {
    const next = { ...prefs, weeklyEnabled: enabled };
    await savePrefs(next);
    if (enabled && await requestPerm()) {
      await scheduleWeekly(next.weeklyDay, next.weeklyHour);
    } else {
      await cancelStored(WEEKLY_ID);
    }
  }

  async function setWeeklyDay(day: number) {
    const next = { ...prefs, weeklyDay: day };
    await savePrefs(next);
    if (next.weeklyEnabled && permGranted) await scheduleWeekly(day, next.weeklyHour);
  }

  return { prefs, permGranted, setStreakEnabled, setStreakHour, setWeeklyEnabled, setWeeklyDay };
}
