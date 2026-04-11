import { useState } from 'react';
import { Pressable } from 'react-native';
import { Svg, Rect, Line } from 'react-native-svg';

import { C } from '@/constants/theme';

function normaliseDb(db: number, maxHeight: number): number {
  const FLOOR = -60;
  const clamped = Math.max(FLOOR, Math.min(0, db));
  return Math.max(2, ((clamped - FLOOR) / -FLOOR) * maxHeight);
}

export function WaveformScrubber({
  samples,
  positionMs,
  durationMs,
  onSeek,
  disabled = false,
  height = 56,
  maxBars = 120,
  marginVertical = 6,
}: {
  samples: number[];
  positionMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
  disabled?: boolean;
  height?: number;
  maxBars?: number;
  marginVertical?: number;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const BAR_COUNT = Math.min(samples.length, maxBars);
  const step = samples.length / BAR_COUNT;
  const bars = Array.from({ length: BAR_COUNT }, (_, i) =>
    samples[Math.round(i * step)] ?? -60
  );
  const playedFraction = durationMs > 0 ? positionMs / durationMs : 0;
  const w = containerWidth || 1;

  function handlePress(e: { nativeEvent: { locationX: number } }) {
    if (disabled || durationMs === 0 || !containerWidth) return;
    const fraction = Math.max(0, Math.min(1, e.nativeEvent.locationX / containerWidth));
    onSeek(fraction * durationMs);
  }

  return (
    <Pressable
      onPress={handlePress}
      onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      style={{ height, marginVertical }}
    >
      <Svg width={w} height={height}>
        {bars.map((db, i) => {
          const barW = w / BAR_COUNT;
          const bh = normaliseDb(db, height - 8);
          const played = i / BAR_COUNT <= playedFraction;
          return (
            <Rect
              key={i}
              x={i * barW + 1}
              y={(height - bh) / 2}
              width={Math.max(1, barW - 2)}
              height={bh}
              fill={played ? C.tint : C.textSecondary}
              rx={1}
            />
          );
        })}
        <Line
          x1={playedFraction * w}
          y1={0}
          x2={playedFraction * w}
          y2={height}
          stroke={C.tint}
          strokeWidth={2}
        />
      </Svg>
    </Pressable>
  );
}
