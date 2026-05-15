import { useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
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
import { VALID_WALK_TYPES, WALK_TYPE_LABELS, WALK_TYPE_DESCRIPTIONS, WalkType } from '@/context/ai-queue-context';

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

const TOTAL_PAGES = SLIDES.length + 1; // +1 for walk types page

const WALK_TYPE_EXAMPLES: Record<WalkType, { title: string; keyPoints: string[]; duration: string }> = {
  vent: {
    title:     'The meeting that drained me',
    keyPoints: [
      "I feel dismissed when my input isn't acknowledged in group settings",
      'The frustration is about respect, not the actual topic',
    ],
    duration: '22m',
  },
  brainstorm: {
    title:     'App ideas from this walk',
    keyPoints: [
      'A habit tracker that unlocks features based on usage streaks could hook power users',
      'Integrating with health data to surface prompts automatically is worth exploring',
    ],
    duration: '31m',
  },
  plan: {
    title:     'Launch prep this week',
    keyPoints: [
      'Send beta invites by Thursday before the weekend window closes',
      'Write the App Store description tonight while the framing is fresh',
    ],
    duration: '18m',
  },
  reflect: {
    title:     'A year since I left that job',
    keyPoints: [
      "Leaving wasn't running away — it was making room for something better",
      "I've stopped measuring growth by title and started measuring by energy",
    ],
    duration: '27m',
  },
  appreciate: {
    title:     "What's actually going well",
    keyPoints: [
      'The morning light through the trees on this route made me genuinely slow down',
      'Three people showed up for me this week without being asked',
    ],
    duration: '15m',
  },
  untangle: {
    title:     'Stay or go — thinking it through',
    keyPoints: [
      "The real question isn't the role, it's whether I trust the direction",
      "My hesitation isn't fear of change — it's a signal worth respecting",
    ],
    duration: '34m',
  },
};

function WalkTypesPage() {
  const [selectedType, setSelectedType] = useState<WalkType | null>(null);

  return (
    <View style={[styles.slide, typePageStyles.slide]}>
      <Text style={styles.title}>walk types</Text>
      <Text style={styles.body}>Choose a mode — AI shapes your summary to match.</Text>
      <Text style={typePageStyles.hint}>tap any to see an example</Text>
      <View style={typePageStyles.grid}>
        {VALID_WALK_TYPES.map(type => (
          <Pressable
            key={type}
            style={({ pressed }) => [typePageStyles.card, pressed && { opacity: 0.7 }]}
            onPress={() => setSelectedType(type)}
          >
            <Text style={typePageStyles.cardLabel}>{WALK_TYPE_LABELS[type]}</Text>
            <Text style={typePageStyles.cardDesc}>{WALK_TYPE_DESCRIPTIONS[type]}</Text>
          </Pressable>
        ))}
      </View>
      <WalkTypePreviewSheet type={selectedType} onClose={() => setSelectedType(null)} />
    </View>
  );
}

function WalkTypePreviewSheet({ type, onClose }: { type: WalkType | null; onClose: () => void }) {
  const ex = type ? WALK_TYPE_EXAMPLES[type] : null;

  return (
    <Modal
      visible={!!type}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose}>
        <Pressable style={sheetStyles.sheet} onPress={() => {}}>
          <View style={sheetStyles.handle} />
          {type && ex && (
            <>
              <Text style={sheetStyles.eyebrow}>example output</Text>
              <View style={sheetStyles.card}>
                <View style={sheetStyles.topRow}>
                  <Text style={sheetStyles.cardTitle} numberOfLines={1}>{ex.title}</Text>
                  <Text style={sheetStyles.cardDuration}>{ex.duration}</Text>
                </View>
                <Text style={sheetStyles.cardDate}>Today · {WALK_TYPE_LABELS[type]}</Text>
                {ex.keyPoints.map((kp, i) => (
                  <View key={i} style={sheetStyles.bullet}>
                    <Text style={sheetStyles.bulletDot}>·</Text>
                    <Text style={sheetStyles.bulletText}>{kp}</Text>
                  </View>
                ))}
                <View style={sheetStyles.badge}>
                  <Text style={sheetStyles.badgeText}>{WALK_TYPE_LABELS[type]}</Text>
                </View>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const typePageStyles = StyleSheet.create({
  slide: {
    justifyContent: 'center',
    gap:            20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            10,
    width:         '100%',
  },
  card: {
    width:           (W - 96) / 2,
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         14,
    gap:              4,
    borderWidth:     1,
    borderColor:     C.border,
  },
  cardLabel: {
    fontSize:   14,
    fontWeight: '600',
    color:      C.text,
  },
  cardDesc: {
    fontSize:   12,
    color:      C.textSecondary,
    lineHeight: 17,
  },
  hint: {
    fontSize:  13,
    color:     C.textTertiary,
    textAlign: 'center',
    marginTop: -8,
  },
});

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent:  'flex-end',
  },
  sheet: {
    backgroundColor:      C.surface,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    padding:              24,
    paddingBottom:        48,
    gap:                  14,
  },
  handle: {
    width:           36,
    height:          4,
    borderRadius:    2,
    backgroundColor: C.textTertiary,
    alignSelf:       'center',
    marginBottom:    4,
  },
  eyebrow: {
    fontSize:      11,
    fontWeight:    '600',
    letterSpacing: 1.2,
    color:         C.textTertiary,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: C.surfaceHigh,
    borderRadius:    14,
    padding:         16,
    gap:              8,
  },
  topRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  cardTitle: {
    flex:       1,
    fontSize:   16,
    fontWeight: '600',
    color:      C.text,
  },
  cardDuration: {
    fontSize:   13,
    color:      C.textSecondary,
    marginLeft: 8,
  },
  cardDate: {
    fontSize:  13,
    color:     C.textSecondary,
    marginTop: -4,
  },
  bullet: {
    flexDirection: 'row',
    gap:            8,
    alignItems:    'flex-start',
  },
  bulletDot: {
    color:      C.tint,
    fontSize:   16,
    lineHeight: 20,
    marginTop:  1,
  },
  bulletText: {
    flex:       1,
    fontSize:   14,
    color:      C.textSecondary,
    lineHeight: 20,
  },
  badge: {
    alignSelf:         'flex-start',
    backgroundColor:   C.surface,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:    4,
    marginTop:          4,
  },
  badgeText: {
    fontSize:   12,
    fontWeight: '500',
    color:      C.textSecondary,
  },
});

export default function OnboardingScreen() {
  const router  = useRouter();
  const { replay } = useLocalSearchParams<{ replay?: string }>();
  const isReplay   = replay === 'true';

  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const slide  = index < SLIDES.length ? SLIDES[index] : null;
  const isLast = index === TOTAL_PAGES - 1;

  function advance() {
    if (isLast) { finish(); return; }
    const next = index + 1;
    scrollRef.current?.scrollTo({ x: next * W, animated: true });
    setIndex(next);
  }

  const dotColor = slide?.color ?? C.tint;

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
        <WalkTypesPage />
      </ScrollView>

      {/* Dot indicators */}
      <View style={styles.dots}>
        {Array.from({ length: TOTAL_PAGES }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === index && { width: 22, backgroundColor: dotColor },
            ]}
          />
        ))}
      </View>

      {/* CTA */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.btn, { backgroundColor: dotColor }]}
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
