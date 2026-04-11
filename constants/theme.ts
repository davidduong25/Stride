import { Platform } from 'react-native';

// Stride is always dark — no light mode variant.
export const Colors = {
  dark: {
    // ── Backgrounds ──────────────────────────────────────────────────────────
    background:   '#000000',  // pure black — main screen bg
    surface:      '#111111',  // cards, stat tiles
    surfaceHigh:  '#1C1C1E',  // elevated / pressed surfaces

    // ── Text ─────────────────────────────────────────────────────────────────
    text:          '#FFFFFF',  // primary
    textSecondary: '#8E8E93',  // labels, subtitles
    textTertiary:  '#48484A',  // disabled, placeholders

    // ── Accent ───────────────────────────────────────────────────────────────
    tint:   '#2D6EF5',  // primary blue (active tabs, buttons, ring fill)
    green:  '#34D058',  // moving / recording state
    yellow: '#FFD60A',  // grace-period / warning state
    red:    '#FF453A',  // error / stop

    // ── Chrome ───────────────────────────────────────────────────────────────
    border:          '#2C2C2E',  // dividers, card borders
    tabBar:          '#050505',  // tab bar background
    tabIconDefault:  '#48484A',  // inactive tab icon
    tabIconSelected: '#FFFFFF',  // active tab icon
    icon:            '#8E8E93',  // general icons

    // Alias used by React Navigation ThemeProvider
    tintColor: '#2D6EF5',
  },
};

// Convenience: every screen imports this instead of Colors.dark
export const C = Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans:    'system-ui',
    serif:   'ui-serif',
    rounded: 'ui-rounded',
    mono:    'ui-monospace',
  },
  default: {
    sans:    'normal',
    serif:   'serif',
    rounded: 'normal',
    mono:    'monospace',
  },
  web: {
    sans:    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif:   "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono:    "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
