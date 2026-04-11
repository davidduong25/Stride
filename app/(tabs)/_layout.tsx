import { Tabs } from 'expo-router';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { C } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor:   C.tabIconSelected,
        tabBarInactiveTintColor: C.tabIconDefault,
        tabBarStyle: {
          backgroundColor: C.tabBar,
          borderTopColor:  C.border,
          borderTopWidth:  0.5,
        },
        tabBarLabelStyle: {
          fontSize:      11,
          fontWeight:    '500',
          letterSpacing: 0.3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'home',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="house.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="walks"
        options={{
          title: 'walks',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="figure.walk" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="logs"
        options={{
          title: 'logs',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="list.bullet.rectangle.portrait" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
