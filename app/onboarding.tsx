import { useRef, useState } from 'react';
import {
  Dimensions,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { C } from '@/constants/theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

const { width: W } = Dimensions.get('window');

const SLIDES = [
  {
    icon:  'figure.walk',
    color: C.tint,
    title: 'stride',
    body:  'A voice journal that lives inside your walks. Move to unlock. Think out loud. Come back to a summary.',
  },
  {
    icon:  'bolt.fill',
    color: C.green,
    title: 'move to unlock',
    body:  'Recording activates when you start walking and pauses when you stop. The motion is the key.',
  },
  {
    icon:  'mic.fill',
    color: C.tint,
    title: 'capture thoughts',
    body:  'One tap to record, one tap to stop. Every clip is transcribed on-device — nothing leaves your phone.',
  },
  {
    icon:  'sparkles',
    color: C.yellow,
    title: 'walks become logs',
    body:  'When your walk ends, AI distills your thoughts into a title, key insights, and action items.',
  },
] as const;

export default function OnboardingScreen() {
  const router  = useRouter();
  const { replay } = useLocalSearchParams<{ replay?: string }>();
  const isReplay   = replay === 'true';

  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const slide  = SLIDES[index];
  const isLast = index === SLIDES.length - 1;

  function advance() {
    if (isLast) { finish(); return; }
    const next = index + 1;
    scrollRef.current?.scrollTo({ x: next * W, animated: true });
    setIndex(next);
  }

  async function finish() {
    if (isReplay) {
      router.back();
      return;
    }
    await AsyncStorage.setItem('momentum.hasOnboarded', 'true');
    router.replace('/(tabs)');
  }

  function onScroll(e: { nativeEvent: { contentOffset: { x: number } } }) {
    const i = Math.round(e.nativeEvent.contentOffset.x / W);
    if (i !== index) setIndex(i);
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Slides */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        scrollEventThrottle={16}
        style={styles.scroll}
      >
        {SLIDES.map((s, i) => (
          <View key={i} style={styles.slide}>
            {/* Layered glow */}
            <View style={styles.glowWrap}>
              <View style={[styles.glowOuter,  { backgroundColor: s.color + '12' }]} />
              <View style={[styles.glowMiddle, { backgroundColor: s.color + '22' }]} />
              <View style={[styles.glowInner,  { backgroundColor: s.color + '38' }]}>
                <IconSymbol name={s.icon as any} size={44} color={s.color} />
              </View>
            </View>

            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.body}>{s.body}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Dot indicators */}
      <View style={styles.dots}>
        {SLIDES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === index && { width: 22, backgroundColor: slide.color },
            ]}
          />
        ))}
      </View>

      {/* CTA */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.btn, { backgroundColor: slide.color }]}
          onPress={advance}
        >
          <Text style={styles.btnText}>{isLast ? 'get started' : 'next'}</Text>
        </Pressable>

        {!isLast && (
          <Pressable onPress={finish} hitSlop={12}>
            <Text style={styles.skip}>skip</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex:            1,
    backgroundColor: C.background,
  },
  scroll: {
    flex: 1,
  },

  // ── Slide ────────────────────────────────────────────────────────────────────
  slide: {
    width:             W,
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 40,
    gap:               20,
  },

  // ── Icon glow ────────────────────────────────────────────────────────────────
  glowWrap: {
    width:          200,
    height:         200,
    alignItems:     'center',
    justifyContent: 'center',
    marginBottom:   8,
  },
  glowOuter: {
    position:     'absolute',
    width:        200,
    height:       200,
    borderRadius: 100,
  },
  glowMiddle: {
    position:     'absolute',
    width:        144,
    height:       144,
    borderRadius: 72,
  },
  glowInner: {
    width:          88,
    height:         88,
    borderRadius:   44,
    alignItems:     'center',
    justifyContent: 'center',
  },

  // ── Text ─────────────────────────────────────────────────────────────────────
  title: {
    fontSize:      36,
    fontWeight:    '700',
    color:         C.text,
    letterSpacing: -0.5,
    textAlign:     'center',
  },
  body: {
    fontSize:  16,
    color:     C.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth:   300,
  },

  // ── Dots ─────────────────────────────────────────────────────────────────────
  dots: {
    flexDirection:  'row',
    justifyContent: 'center',
    alignItems:     'center',
    gap:             6,
    paddingVertical: 20,
  },
  dot: {
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: C.surfaceHigh,
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer: {
    paddingHorizontal: 24,
    paddingBottom:     36,
    alignItems:        'center',
    gap:               16,
  },
  btn: {
    width:          '100%',
    paddingVertical: 16,
    borderRadius:   14,
    alignItems:     'center',
  },
  btnText: {
    fontSize:   17,
    fontWeight: '600',
    color:      C.text,
  },
  skip: {
    fontSize: 14,
    color:    C.textTertiary,
  },
});
