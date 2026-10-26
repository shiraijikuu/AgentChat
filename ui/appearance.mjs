const HEX = /^#[0-9A-F]{6}$/;

const LIGHT = {
  '--bg': '#F6F7F9', '--panel': '#FFFFFF', '--border': '#E3E5E9', '--soft': '#EEF0F4',
  '--text': '#1C1F24', '--muted': '#6B7280', '--bubble': '#FFFFFF',
  '--scroll': '#C9CBD0', '--scroll-hover': '#A8ABB1',
};
const DARK = {
  '--bg': '#0D0F13', '--panel': '#14171D', '--border': '#262B34', '--soft': '#1B1F27',
  '--text': '#E6E8EB', '--muted': '#8B929E', '--bubble': '#1A1E26',
  '--scroll': '#3A3F48', '--scroll-hover': '#565D69',
};
const FONTS = {
  system: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  'segoe-ui': '"Segoe UI", "Microsoft YaHei", sans-serif',
  'microsoft-yahei': '"Microsoft YaHei", "Segoe UI", sans-serif',
};

function hex(value, fallback) {
  const normalized = String(value || '').toUpperCase();
  return HEX.test(normalized) ? normalized : fallback;
}

function rgb(value) {
  return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
}

function mix(a, b, amount) {
  const left = rgb(a);
  const right = rgb(b);
  const values = left.map((v, i) => Math.round(v * (1 - amount) + right[i] * amount));
  return '#' + values.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function luminance(value) {
  const channels = rgb(value).map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(background, foreground) {
  const bg = hex(background, null);
  const fg = hex(foreground, null);
  if (!bg || !fg) return 0;
  const [light, dark] = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function appearanceToCss(appearance = {}, { systemDark = false } = {}) {
  const mode = ['system', 'light', 'dark', 'custom'].includes(appearance.mode) ? appearance.mode : 'system';
  const accent = hex(appearance.accent, '#2563EB');
  const fontFamily = FONTS[appearance.font] || FONTS.system;

  if (mode !== 'custom') {
    const theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
    return {
      theme,
      vars: { ...(theme === 'dark' ? DARK : LIGHT), '--accent': accent, '--bubble-own': accent },
      fontFamily,
    };
  }

  const background = hex(appearance.background, '#0D0F13');
  const foreground = hex(appearance.foreground, '#E6E8EB');
  const dark = luminance(background) < 0.5;
  return {
    theme: 'custom',
    vars: {
      '--bg': background,
      '--panel': mix(background, foreground, dark ? 0.05 : 0.035),
      '--border': mix(background, foreground, dark ? 0.14 : 0.12),
      '--soft': mix(background, foreground, dark ? 0.09 : 0.07),
      '--text': foreground,
      '--muted': mix(foreground, background, 0.45),
      '--accent': accent,
      '--bubble': mix(background, foreground, dark ? 0.07 : 0.045),
      '--bubble-own': accent,
      // 滚动条滑块。从背景往前景方向调一点，保证深色自定义主题下也看得见。
      '--scroll': mix(background, foreground, dark ? 0.26 : 0.2),
      '--scroll-hover': mix(background, foreground, dark ? 0.42 : 0.36),
    },
    fontFamily,
  };
}
