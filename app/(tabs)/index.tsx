import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Pressable, Text, View } from 'react-native';
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
  const { enqueueTranscription, processingType, modelDownloadProgress, isModelReady, modelError } = useAIQueue();
  const { isSessionActive, startSession, addRecordingToSession, endSession } = useWalkSession();

  const [testMode, setTestMode] = useState(false);

  // Stable ref so session transition effect always reads current value
  const isSessionActiveRef = useRef(isSessionActive);
  isSessionActiveRef.current = isSessionActive;

  // Guard against double-stop if pedometer state bounces at lock boundary
  const isStoppingRef = useRef(false);

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
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    const result = await stopRecording(stepCountRef.current);
    isStoppingRef.current = false;
    if (!result) return;

    let id: string | undefined;
    try {
      id = await addRecording({
        uri: result.uri,
        filename: result.filename,
        duration: result.duration,
        waveform: result.waveform,
        steps: result.steps,
        transcript: null,
        tags: null,
      });
    } catch {
      Alert.alert('Save failed', 'Could not save the recording. Please try again.');
      return;
    }
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

  // Session lifecycle: start on first motion (provisional or unlocked), end when locked
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = pedometerState;

    if ((pedometerState === 'provisional' || pedometerState === 'unlocked') && !isSessionActiveRef.current) {
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
      const timer = setTimeout(async () => {
        if (!isSessionActiveRef.current) return;
        const snapshot = await endSession(stepCountRef.current);
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
    const firstSteps = data[data.length - 1].steps ?? 0;
    const lastSteps = data[0].steps ?? 0;
    const stepDelta = Math.max(0, lastSteps - firstSteps);
    router.push({
      pathname: '/walk-summary',
      params: {
        startedAt: new Date(data[data.length - 1].date).getTime().toString(),
        endedAt: (new Date(data[0].date).getTime() + data[0].duration * 1000).toString(),
        steps: stepDelta.toString(),
        recordingIds: data.map(r => r.id).join(','),
      },
    });
  }

  const aiStatus = modelError
    ? `AI error: ${modelError}`
    : !isModelReady && modelDownloadProgress === 0
    ? 'Loading AI model...'
    : !isModelReady && modelDownloadProgress > 0
    ? `Preparing AI... ${Math.round(modelDownloadProgress * 100)}%`
    : processingType === 'transcribe'
    ? 'Transcribing...'
    : processingType === 'tag'
    ? 'Tagging...'
    : null;

  if (pedometerState === 'checking') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>Checking motion sensor...</Text>
        {aiStatus && <Text style={{ marginTop: 16, color: '#888' }}>{aiStatus}</Text>}
      </View>
    );
  }

  if (pedometerState === 'unavailable') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>Step counter not available on this device.</Text>
        {aiStatus && <Text style={{ marginTop: 16, color: '#888' }}>{aiStatus}</Text>}
      </View>
    );
  }

  if (pedometerState === 'locked' && !testMode) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>LOCKED</Text>
        <Text>Start walking to unlock</Text>
        {aiStatus && <Text style={{ marginTop: 16, color: '#888' }}>{aiStatus}</Text>}
        {lastWalkRecordings && (
          <Pressable onPress={openLastWalk} style={{ marginTop: 24 }}>
            <Text style={{ color: '#0a7ea4', fontSize: 14 }}>View last walk →</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setTestMode(true)} style={{ marginTop: 32 }}>
          <Text style={{ color: '#aaa', fontSize: 12 }}>Test mode</Text>
        </Pressable>
      </View>
    );
  }

  if (pedometerState === 'provisional') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Button
          title={isRecording ? 'Stop Recording' : 'Record'}
          onPress={isRecording ? handleStopRecording : startRecording}
        />
        {isRecording && <Text>Keep walking to keep talking</Text>}
        {aiStatus && <Text style={{ marginTop: 16, color: '#888' }}>{aiStatus}</Text>}
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
      <Text>{testMode ? 'TEST MODE' : 'UNLOCKED'}</Text>
      <Button
        title={isRecording ? 'Stop Recording' : 'Record'}
        onPress={isRecording ? handleStopRecording : startRecording}
      />
      {isRecording && <Text>Recording...</Text>}
      {aiStatus && <Text style={{ marginTop: 16, color: '#888' }}>{aiStatus}</Text>}
      {lastWalkRecordings && (
        <Pressable onPress={openLastWalk} style={{ marginTop: 24 }}>
          <Text style={{ color: '#0a7ea4', fontSize: 14 }}>View last walk →</Text>
        </Pressable>
      )}
    </View>
  );
}
