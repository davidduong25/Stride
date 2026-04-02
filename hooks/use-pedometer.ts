import { useEffect, useRef, useState } from 'react';
import { Accelerometer, Pedometer } from 'expo-sensors';

const STEP_LOCK_DELAY_MS = 15_000;
const PROVISIONAL_TIMEOUT_MS = 5_000;
export const JOLT_THRESHOLD = 1.25;

export type PedometerState = 'checking' | 'unavailable' | 'locked' | 'provisional' | 'unlocked';

export function usePedometer() {
  const [pedometerState, setPedometerState] = useState<PedometerState>('checking');
  const [stepCount, setStepCount] = useState(0);
  const [accelMagnitude, setAccelMagnitude] = useState(0);

  const stateRef = useRef<PedometerState>('checking');
  const stepLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const provisionalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref so callers can snapshot the current step count without a re-render dependency
  const stepCountRef = useRef(0);

  useEffect(() => {
    let active = true;
    let pedometerSub: ReturnType<typeof Pedometer.watchStepCount> | null = null;
    let accelSub: ReturnType<typeof Accelerometer.addListener> | null = null;

    function transition(next: PedometerState) {
      stateRef.current = next;
      setPedometerState(next);
    }

    function onStepsDetected(steps: number) {
      stepCountRef.current = steps;
      setStepCount(steps);
      if (provisionalTimerRef.current) {
        clearTimeout(provisionalTimerRef.current);
        provisionalTimerRef.current = null;
      }
      transition('unlocked');
      if (stepLockTimerRef.current) clearTimeout(stepLockTimerRef.current);
      stepLockTimerRef.current = setTimeout(() => {
        stepLockTimerRef.current = null;
        transition('locked');
      }, STEP_LOCK_DELAY_MS);
    }

    function onJoltDetected() {
      if (stateRef.current !== 'locked') return;
      transition('provisional');
      provisionalTimerRef.current = setTimeout(() => {
        provisionalTimerRef.current = null;
        if (stateRef.current === 'provisional') transition('locked');
      }, PROVISIONAL_TIMEOUT_MS);
    }

    async function start() {
      const available = await Pedometer.isAvailableAsync();
      if (!active) return;
      if (!available) { transition('unavailable'); return; }
      transition('locked');

      pedometerSub = Pedometer.watchStepCount((result) => {
        if (!active) return;
        onStepsDetected(result.steps);
      });

      Accelerometer.setUpdateInterval(100);
      accelSub = Accelerometer.addListener(({ x, y, z }) => {
        if (!active) return;
        const mag = Math.sqrt(x * x + y * y + z * z);
        setAccelMagnitude(mag);
        if (mag >= JOLT_THRESHOLD) onJoltDetected();
      });
    }

    start();

    return () => {
      active = false;
      pedometerSub?.remove();
      accelSub?.remove();
      if (stepLockTimerRef.current) clearTimeout(stepLockTimerRef.current);
      if (provisionalTimerRef.current) clearTimeout(provisionalTimerRef.current);
    };
  }, []);

  return { pedometerState, stepCount, stepCountRef, accelMagnitude };
}
