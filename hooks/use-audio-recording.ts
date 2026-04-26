import { useEffect, useRef, useState } from 'react';
import {
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  IOSOutputFormat,
  AudioQuality,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { documentDirectory, moveAsync } from 'expo-file-system/legacy';

// 16 kHz mono LinearPCM WAV — matches Whisper's expected input format.
// isMeteringEnabled must live here; passing it to prepareToRecordAsync would
// wipe the other fields (createRecordingOptions reads all fields, treating
// undefined as "no value" and letting the native side fall back to defaults).
// Android MediaRecorder has no native WAV encoder; m4a (AAC) is used there
// so that both the player and the transcription pipeline can handle the file.
const WHISPER_RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: true,
  extension: '.wav',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  web: {
    mimeType: 'audio/wav',
    bitsPerSecond: 256000,
  },
};

export type RecordingResult = {
  uri: string;
  filename: string;
  duration: number;   // seconds
  waveform: string;   // JSON array of dB samples
  steps: number;      // pedometer snapshot at stop time
};

// 5 Hz — good detail-to-storage ratio; 1 min recording ≈ 300 samples
const METERING_INTERVAL_MS = 200;
// How many metering samples to keep for the live waveform display (~6 seconds)
const LIVE_WINDOW = 30;

export function useAudioRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [liveWaveform, setLiveWaveform] = useState<number[]>([]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorder = useAudioRecorder(WHISPER_RECORDING_OPTIONS);
  const meteringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveformSamplesRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      if (meteringTimerRef.current) {
        clearInterval(meteringTimerRef.current);
        meteringTimerRef.current = null;
      }
    };
  }, []);

  async function startRecording() {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return;

    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, staysActiveInBackground: true });

    let prepared = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await recorder.prepareToRecordAsync();
        prepared = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    if (!prepared) return;
    recorder.record();
    waveformSamplesRef.current = [];

    meteringTimerRef.current = setInterval(() => {
      try {
        const status = recorder.getStatus();
        if (status.metering != null) {
          waveformSamplesRef.current.push(status.metering);
          setLiveWaveform(prev => {
            const next = [...prev, status.metering!];
            return next.length > LIVE_WINDOW ? next.slice(-LIVE_WINDOW) : next;
          });
        }
        setRecordingSeconds(Math.round(recorder.currentTime));
      } catch { /* recorder may have stopped */ }
    }, METERING_INTERVAL_MS);

    setIsRecording(true);
  }

  async function stopRecording(stepCount = 0): Promise<RecordingResult | null> {
    if (!recorder.isRecording) return null;

    if (meteringTimerRef.current) {
      clearInterval(meteringTimerRef.current);
      meteringTimerRef.current = null;
    }

    const durationMs = recorder.currentTime * 1000;
    const waveformSamples = [...waveformSamplesRef.current];
    waveformSamplesRef.current = [];

    // Capture the URI before stop() — this is set at prepareToRecordAsync time
    // and points to the file iOS is actively writing to.
    const fileUri = recorder.uri;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { sub.remove(); resolve(); }, 5000);
      const sub = recorder.addListener('recordingStatusUpdate', (status) => {
        if (status.isFinished || status.hasError) {
          clearTimeout(timeout);
          sub.remove();
          resolve();
        }
      });
      recorder.stop();
    });

    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch { /* ignore — audio session flip is best-effort */ }

    setLiveWaveform([]);
    setRecordingSeconds(0);
    setIsRecording(false);
    if (!fileUri) return null;

    // Poll until the recorder has flushed audio data to disk (beyond the empty file header).
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const file = new File(fileUri);
      if (file.exists && file.size > 4096) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) return null;

    // Move from cache/tmp (iOS can delete these) to the documents directory (persistent).
    const filename = fileUri.split('/').pop() ?? `recording_${Date.now()}.wav`;
    const persistentUri = (documentDirectory ?? '') + filename;
    try {
      await moveAsync({ from: fileUri, to: persistentUri });
    } catch {
      // Move failed (OS may have purged the cache file under memory pressure).
      // Fall back to the original URI so the recording isn't completely lost.
      return {
        uri: fileUri,
        filename,
        duration: Math.round(durationMs / 1000),
        waveform: JSON.stringify(waveformSamples),
        steps: stepCount,
      };
    }

    if (!new File(persistentUri).exists) return null;

    return {
      uri: persistentUri,
      filename,
      duration: Math.round(durationMs / 1000),
      waveform: JSON.stringify(waveformSamples),
      steps: stepCount,
    };
  }

  return { isRecording, liveWaveform, recordingSeconds, startRecording, stopRecording };
}
