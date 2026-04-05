import { useRef, useState } from 'react';
import {
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  IOSOutputFormat,
  AudioQuality,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';

// 16 kHz mono LinearPCM WAV — matches Whisper's expected input format.
// Android MediaRecorder has no native WAV encoder; 'default'/'default' records
// in whatever the device default is (typically AMR). PCM decode will still
// attempt WAV parsing; correct WAV output is guaranteed only on iOS.
const WHISPER_RECORDING_OPTIONS: RecordingOptions = {
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
    outputFormat: 'default',
    audioEncoder: 'default',
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

export function useAudioRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const recorder = useAudioRecorder(WHISPER_RECORDING_OPTIONS);
  const meteringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveformSamplesRef = useRef<number[]>([]);

  async function startRecording() {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return;

    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

    await recorder.prepareToRecordAsync({ isMeteringEnabled: true });
    recorder.record();
    waveformSamplesRef.current = [];

    meteringTimerRef.current = setInterval(() => {
      try {
        const status = recorder.getStatus();
        if (status.metering != null) {
          waveformSamplesRef.current.push(status.metering);
        }
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
      const sub = recorder.addListener('recordingStatusUpdate', (status) => {
        if (status.isFinished || status.hasError) {
          sub.remove();
          resolve();
        }
      });
      recorder.stop();
    });

    setIsRecording(false);
    if (!fileUri) return null;

    // Poll until iOS flushes audio data beyond the 4096-byte CAF skeleton.
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const file = new File(fileUri);
      if (file.exists && file.size > 4096) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) return null;

    return {
      uri: fileUri,
      filename: fileUri.split('/').pop() ?? `recording_${Date.now()}.caf`,
      duration: Math.round(durationMs / 1000),
      waveform: JSON.stringify(waveformSamples),
      steps: stepCount,
    };
  }

  return { isRecording, startRecording, stopRecording };
}
