/** 界面字号档位:通过 <html data-font-scale> 驱动 app.css 里 --mantine-font-size-* 的档位覆盖。
 *  仅存 localStorage(纯展示偏好,单机单用户);小档 = Mantine 默认字号。 */

export const FONT_SCALE_KEY = "ui-font-scale";

export const FONT_SCALES = [
  { value: "small", label: "小" },
  { value: "middle", label: "中" },
  { value: "large", label: "大" },
  { value: "max", label: "最大" },
] as const;

export type FontScale = (typeof FONT_SCALES)[number]["value"];

export function isFontScale(v: unknown): v is FontScale {
  return FONT_SCALES.some((s) => s.value === v);
}

export function applyFontScale(v: FontScale) {
  document.documentElement.dataset.fontScale = v;
}

export function loadFontScale(): FontScale {
  const raw = localStorage.getItem(FONT_SCALE_KEY);
  return isFontScale(raw) ? raw : "small";
}

export function saveFontScale(v: FontScale) {
  localStorage.setItem(FONT_SCALE_KEY, v);
  applyFontScale(v);
}

/** 在 React 渲染前调用,避免首帧闪回默认字号 */
export function initFontScale() {
  applyFontScale(loadFontScale());
}
