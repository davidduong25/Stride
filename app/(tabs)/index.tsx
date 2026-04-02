import { useCallback, useEffect, useRef } from 'react';
import { Button, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAudioRecording } from '@/hooks/use-audio-recording';
import { usePedometer, type PedometerState } from '@/hooks/use-pedometer';
import { useRecordingsContext } from '@/context/recordings-context';
import { useAIQueue } from '@/context/ai-queue-context';
import { useWalkSession, type WalkSessionSnapshot } from '@/context/walk-session-context';


export default function HomeScreen() {
  const router = useRouter();
  const { pedometerState, stepCount, stepCountRef } = usePedometer();
  const { isRecording, startRecording, stopRecording } = useAudioRecording();
  const { addRecording, recordings } = useRecordingsContext();
  const { enqueueTranscription } = useAIQueue();
  const { isSessionActive, startSession, addRecordingToSession, endSession } = useWalkSession();

  // Stable ref so session transition effect always reads current value
  const isSessionActiveRef = useRef(isSessionActive);
  isSessionActiveRef.current = isSessionActive;

  // Track previous pedometer state to detect transitions
  const prevStateRef = useRef<PedometerState>(pedometerState);

  const navigateToSummary = useCallback(
    (snapshot: WalkSessionSnapshot) => {
      router.push({
        pathname: '/walk-summary',
        params: {
          startedAt: snapshot.startedAt.toString(),
          endedAt: snapshot.endedAt.toString(),
          steps: snapshot.stepCount.toString(),
          recordingIds: snapshot.recordingIds.join(','),
        },
      });
    },
    [router]
  );

  const handleStopRecording = useCallback(async () => {
    const result = await stopRecording(stepCountRef.current);
    if (!result) return;

    const id = await addRecording({
      uri: result.uri,
      filename: result.filename,
      duration: result.duration,
      waveform: result.waveform,
      steps: result.steps,
      transcript: null,
      tags: null,
    });
    if (id) {
      addRecordingToSession(id);
      enqueueTranscription(id, result.uri);
    }
  }, [stopRecording, stepCountRef, addRecording, addRecordingToSession, enqueueTranscription]);

  // Auto-stop recording when pedometer locks
  useEffect(() => {
    if (pedometerState === 'locked' && isRecording) {
      handleStopRecording();
    }
  }, [pedometerState, isRecording, handleStopRecording]);

  // Session lifecycle: start on first unlock, end when locked
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = pedometerState;

    if (pedometerState === 'unlocked' && !isSessionActiveRef.current) {
      startSession(stepCountRef.current);
      return;
    }

    if (
      pedometerState === 'locked' &&
      prev !== 'checking' &&
      prev !== 'unavailable' &&
      isSessionActiveRef.current
    ) {
      // Delay allows any in-progress recording save to complete before we snapshot
      const timer = setTimeout(() => {
        if (!isSessionActiveRef.current) return;
        const snapshot = endSession(stepCountRef.current);
        if (snapshot && snapshot.recordingIds.length > 0) {
          navigateToSummary(snapshot);
        }
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [pedometerState, startSession, endSession, stepCountRef, navigateToSummary]);

  // Build latest session from SQLite recordings for "View last walk" link
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const lastWalkRecordings = (() => {
    if (!recordings.length) return null;
    const group = [recordings[0]];
    for (let i = 1; i < recordings.length; i++) {
      const prevMs = new Date(group[group.length - 1].date).getTime();
      const currMs = new Date(recordings[i].date).getTime();
      if (prevMs - currMs <= SESSION_GAP_MS) group.push(recordings[i]);
      else break;
    }
    return group;
  })();

  function openLastWalk() {
    if (!lastWalkRecordings) return;
    const data = lastWalkRecordings;
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt: new Date(data[data.length - 1].date).getTime().toString(),
        endedAt: (new Date(data[0].date).getTime() + data[0].duration * 1000).toString(),
        steps: (data[0].steps ?? 0).toString(),
        recordingIds: data.map(r => r.id).join(','),
      },
    });
  }

  if (pedometerState === 'checking') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>Checking motion sensor...</Text>

      </View>
    );
  }

  if (pedometerState === 'unavailable') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>Step counter not available on this device.</Text>

      </View>
    );
  }

  if (pedometerState === 'locked') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>LOCKED</Text>
        <Text>Start walking to unlock</Text>
        {lastWalkRecordings && (
          <Pressable onPress={openLastWalk} style={{ marginTop: 24 }}>
            <Text style={{ color: '#0a7ea4', fontSize: 14 }}>View last walk →</Text>
          </Pressable>
        )}

      </View>
    );
  }

  if (pedometerState === 'provisional') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>UNLOCKED (confirming...)</Text>
        <Text>Keep walking — waiting for step confirmation</Text>
        {lastWalkRecordings && (
          <Pressable onPress={openLastWalk} style={{ marginTop: 24 }}>
            <Text style={{ color: '#0a7ea4', fontSize: 14 }}>View last walk →</Text>
          </Pressable>
        )}

      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>UNLOCKED</Text>
      <Button
        title={isRecording ? 'Stop Recording' : 'Record'}
        onPress={isRecording ? handleStopRecording : startRecording}
      />
      {isRecording && <Text>Recording...</Text>}
      {lastWalkRecordings && (
        <Pressable onPress={openLastWalk} style={{ marginTop: 24 }}>
          <Text style={{ color: '#0a7ea4', fontSize: 14 }}>View last walk →</Text>
        </Pressable>
      )}
      <DebugOverlay {...debugProps} />
    </View>
  );
}
