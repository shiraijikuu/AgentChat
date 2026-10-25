import fs from 'node:fs';
import path from 'node:path';

const CLOSE_ACTIONS = new Set(['ask', 'tray', 'quit']);
const MODES = new Set(['system', 'light', 'dark', 'custom']);
const FONTS = new Set(['system', 'segoe-ui', 'microsoft-yahei']);
const HEX = /^#[0-9A-F]{6}$/;

export const DEFAULT_APP_SETTINGS = Object.freeze({
  closeAction: 'ask',
  appearance: Object.freeze({
    mode: 'system',
    accent: '#2563EB',
    background: '#0D0F13',
    foreground: '#E6E8EB',
    font: 'system',
  }),
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const color = (value) => {
  const normalized = String(value || '').toUpperCase();
  return HEX.test(normalized) ? normalized : null;
};

function luminance(hex) {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(background, foreground) {
  const bg = color(background);
  const fg = color(foreground);
  if (!bg || !fg) throw new Error('颜色必须是 #RRGGBB');
  const [light, dark] = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function normalizeAppSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const appearance = source.appearance && typeof source.appearance === 'object' ? source.appearance : {};
  const out = {
    closeAction: CLOSE_ACTIONS.has(source.closeAction) ? source.closeAction : DEFAULT_APP_SETTINGS.closeAction,
    appearance: {
      mode: MODES.has(appearance.mode) ? appearance.mode : DEFAULT_APP_SETTINGS.appearance.mode,
      accent: color(appearance.accent) || DEFAULT_APP_SETTINGS.appearance.accent,
      background: color(appearance.background) || DEFAULT_APP_SETTINGS.appearance.background,
      foreground: color(appearance.foreground) || DEFAULT_APP_SETTINGS.appearance.foreground,
      font: FONTS.has(appearance.font) ? appearance.font : DEFAULT_APP_SETTINGS.appearance.font,
    },
  };
  if (out.appearance.mode === 'custom'
      && contrastRatio(out.appearance.background, out.appearance.foreground) < 4.5) {
    out.appearance.mode = 'system';
  }
  return out;
}

function validateAppearance(value) {
  if (!value || typeof value !== 'object') throw new Error('appearance 必须是对象');
  if (!MODES.has(value.mode)) throw new Error('外观模式无效');
  const accent = color(value.accent);
  const background = color(value.background);
  const foreground = color(value.foreground);
  if (!accent || !background || !foreground) throw new Error('颜色必须是 #RRGGBB');
  if (!FONTS.has(value.font)) throw new Error('字体无效');
  if (value.mode === 'custom' && contrastRatio(background, foreground) < 4.5) {
    throw new Error('背景与文字对比度必须至少为 4.5:1');
  }
  return { mode: value.mode, accent, background, foreground, font: value.font };
}

export function createAppSettings({ dir, onLog = () => {} }) {
  if (!dir) throw new Error('设置目录不能为空');
  const file = path.join(dir, 'app-settings.json');
  let state = clone(DEFAULT_APP_SETTINGS);
  try {
    if (fs.existsSync(file)) state = normalizeAppSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    onLog(`读取设置失败，使用默认值：${e.message}`);
  }

  const snapshot = () => clone(state);
  const update = (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('设置内容必须是对象');
    const next = snapshot();
    if (Object.hasOwn(patch, 'closeAction')) {
      if (!CLOSE_ACTIONS.has(patch.closeAction)) throw new Error('关闭行为无效');
      next.closeAction = patch.closeAction;
    }
    if (Object.hasOwn(patch, 'appearance')) next.appearance = validateAppearance(patch.appearance);

    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
    state = next;
    return snapshot();
  };

  return { file, snapshot, update };
}
