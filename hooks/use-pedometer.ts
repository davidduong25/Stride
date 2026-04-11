import { useEffect, useRef, useState } from 'react';
import { Accelerometer, Pedometer } from 'expo-sensors';

const STEP_LOCK_DELAY_MS = 60_000;   // 60-second Stoplight grace period
const PROVISIONAL_TIMEOUT_MS = 5_000;
const STEPS_PER_MILE = 2200;         // ~average adult stride; user-configurable in v1.1
export const JOLT_THRESHOLD = 1.25;

export type PedometerState =
  | 'checking'
  | 'unavailable'
  | 'locked'
  | 'provisional'
  | 'unlocked'
  | 'paused';   // intentional pause — gate suspended, audio continues

export function usePedometer() {
  const [pedometerState, setPedometerState] = useState<PedometerState>('checking');
  const [stepCount, setStepCount] = useState(0);
  const [graceSecondsLeft, setGraceSecondsLeft] = useState<number | null>(null);

  const stateRef            = useRef<PedometerState>('checking');
  const stepLockTimerRef    = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const provisionalTimerRef = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const graceIntervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepCountRef        = useRef(0);

  const distanceMiles = stepCount / STEPS_PER_MILE;

  // ---------------------------------------------------------------------------
  // State helpers — only use stable refs + stable setters so these are
  // safe to call from inside the mounted effect without stale-closure risk.
  // ---------------------------------------------------------------------------

  function transition(next: PedometerState) {
    stateRef.current = next;
    setPedometerState(next);
  }

  function clearGraceCountdown() {
    if (graceIntervalRef.current) {
      clearInterval(graceIntervalRef.current);
      graceIntervalRef.current = null;
    }
    setGraceSecondsLeft(null);
  }

  function startGraceCountdown() {
    clearGraceCountdown();
    const totalSeconds = STEP_LOCK_DELAY_MS / 1000;
    setGraceSecondsLeft(totalSeconds);
    graceIntervalRef.current = setInterval(() => {
      setGraceSecondsLeft(prev => {
        if (prev === null || prev <= 1) {
          if (graceIntervalRef.current) {
            clearInterval(graceIntervalRef.current);
            graceIntervalRef.current = null;
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Public controls — exposed to screens
  // ---------------------------------------------------------------------------

  function pauseIntentionally() {
    const cur = stateRef.current;
    if (cur !== 'unlocked' && cur !== 'provisional') return;
    if (stepLockTimerRef.current) {
      clearTimeout(stepLockTimerRef.current);
      stepLockTimerRef.current = null;
    }
    if (provisionalTimerRef.current) {
      clearTimeout(provisionalTimerRef.current);
      provisionalTimerRef.current = null;
    }
    clearGraceCountdown();
    transition('paused');
  }

  function resumeFromPause() {
    if (stateRef.current !== 'paused') return;
    // Return to unlocked and restart the grace countdown so that if the user
    // doesn't start walking again the app will still lock after 60 s.
    transition('unlocked');
    startGraceCountdown();
    stepLockTimerRef.current = setTimeout(() => {
      stepLockTimerRef.current = null;
      clearGraceCountdown();
      transition('locked');
    }, STEP_LOCK_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Sensor subscriptions
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let active = true;
    let pedometerSub: ReturnType<typeof Pedometer.watchStepCount> | null = null;
    let accelSub: ReturnType<typeof Accelerometer.addListener>    | null = null;

    function onStepsDetected(steps: number) {
      stepCountRef.current = steps;
      setStepCount(steps);

      if (provisionalTimerRef.current) {
        clearTimeout(provisionalTimerRef.current);
        provisionalTimerRef.current = null;
      }

      // Any step resumes the gate (even from intentional pause) and resets the
      // grace countdown so the 60-second clock restarts from full.
      transition('unlocked');
      startGraceCountdown();

      if (stepLockTimerRef.current) clearTimeout(stepLockTimerRef.current);
      stepLockTimerRef.current = setTimeout(() => {
        stepLockTimerRef.current = null;
        clearGraceCountdown();
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
        if (Math.sqrt(x * x + y * y + z * z) >= JOLT_THRESHOLD) onJoltDetected();
      });
    }

    start();

    return () => {
      active = false;
      pedometerSub?.remove();
      accelSub?.remove();
      if (stepLockTimerRef.current)    clearTimeout(stepLockTimerRef.current);
      if (provisionalTimerRef.current) clearTimeout(provisionalTimerRef.current);
      clearGraceCountdown();
    };
  }, []);

  return {
    pedometerState,
    stepCount,
    stepCountRef,
    distanceMiles,
    graceSecondsLeft,   // null when not in grace period, 60→1 when counting down
    pauseIntentionally,
    resumeFromPause,
  };
}
