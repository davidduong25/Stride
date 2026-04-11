import { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { C } from '@/constants/theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

export function EllipsisMenu() {
  const router  = useRouter();
  const [open, setOpen] = useState(false);

  function go(path: string) {
    setOpen(false);
    router.push(path as any);
  }

  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={12}>
        <IconSymbol name="ellipsis" size={20} color={C.icon} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Prevent backdrop tap from propagating through the menu itself */}
          <Pressable style={styles.menu} onPress={e => e.stopPropagation()}>
            <Pressable style={styles.item} onPress={() => go('/settings')}>
              <IconSymbol name="gearshape" size={17} color={C.text} />
              <Text style={styles.itemText}>Settings</Text>
            </Pressable>

            <View style={styles.divider} />

            <Pressable style={styles.item} onPress={() => go('/onboarding?replay=true')}>
              <IconSymbol name="questionmark.circle" size={17} color={C.text} />
              <Text style={styles.itemText}>How it works</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  menu: {
    position:        'absolute',
    top:             108,
    right:           20,
    backgroundColor: C.surfaceHigh,
    borderRadius:    14,
    borderWidth:     StyleSheet.hairlineWidth,
    borderColor:     C.border,
    minWidth:        190,
    overflow:        'hidden',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 8 },
    shadowOpacity:   0.45,
    shadowRadius:    20,
    elevation:       12,
  },
  item: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            12,
    paddingHorizontal: 16,
    paddingVertical:   14,
  },
  itemText: {
    fontSize:   15,
    color:      C.text,
    fontWeight: '400',
  },
  divider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: C.border,
    marginHorizontal: 12,
  },
});
