/**
 * Design tokens. Contrast pairs meet WCAG 2.2 AA (>= 4.5:1 for body text).
 * The web app maps these to CSS custom properties; mobile consumes them
 * directly in StyleSheet values.
 */
export const colors = {
  // brand: deep teal — trustworthy, athletic, calm
  primary: "#0f766e",
  primaryHover: "#115e59",
  primaryContrast: "#ffffff",
  accent: "#f59e0b",
  accentContrast: "#1c1917",

  bg: "#ffffff",
  bgSubtle: "#f5f5f4",
  surface: "#ffffff",
  border: "#d6d3d1",

  text: "#1c1917",
  textMuted: "#57534e",
  textInverse: "#fafaf9",

  success: "#15803d",
  warning: "#b45309",
  danger: "#b91c1c",
  info: "#1d4ed8",

  focusRing: "#0f766e",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 9999,
} as const;

export const fontSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  display: 36,
} as const;

/** Minimum touch target per WCAG 2.5.8 / platform guidance. */
export const MIN_TOUCH_TARGET = 44;
