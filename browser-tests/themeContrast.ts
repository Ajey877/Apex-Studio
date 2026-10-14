import type { Locator } from '@playwright/test';

export interface TextContrastMeasurement {
  foreground: string;
  /** Effective opaque background after compositing every translucent ancestor. */
  background: string;
  ratio: number;
  /** Computed background layers, ordered from the text element outward. */
  backgroundLayers: string[];
}

/**
 * Measures rendered text contrast from computed styles. Alpha backgrounds are
 * composited over each ancestor surface before WCAG relative luminance is
 * calculated; this is important for the status badges and washes in the UI.
 */
export const measureTextContrast = (locator: Locator): Promise<TextContrastMeasurement> =>
  locator.evaluate((element) => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color | null => {
      const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/i.exec(value);
      if (srgb) {
        return [
          Number(srgb[1]) * 255,
          Number(srgb[2]) * 255,
          Number(srgb[3]) * 255,
          srgb[4] === undefined ? 1 : Number(srgb[4]),
        ];
      }
      const rgb = /rgba?\(([^)]+)\)/i.exec(value);
      if (!rgb) return null;
      const channels = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (channels.length < 3) return null;
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const composite = (foreground: Color, background: Color): Color => {
      const alpha = foreground[3];
      return [
        foreground[0] * alpha + background[0] * (1 - alpha),
        foreground[1] * alpha + background[1] * (1 - alpha),
        foreground[2] * alpha + background[2] * (1 - alpha),
        1,
      ];
    };
    const luminance = (color: Color): number => {
      const linear = color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };

    const backgroundLayers: string[] = [];
    const parsedLayers: Color[] = [];
    let current: HTMLElement | null = element as HTMLElement;
    while (current) {
      const value = getComputedStyle(current).backgroundColor;
      const layer = parse(value);
      if (layer && layer[3] > 0) {
        backgroundLayers.push(value);
        parsedLayers.push(layer);
        if (layer[3] >= 1) break;
      }
      current = current.parentElement;
    }
    if (parsedLayers.length === 0 || parsedLayers[parsedLayers.length - 1][3] < 1) {
      throw new Error(`No opaque ancestor surface found for ${element.textContent?.trim() || element.tagName}`);
    }

    let background = parsedLayers[parsedLayers.length - 1];
    for (let index = parsedLayers.length - 2; index >= 0; index -= 1) {
      background = composite(parsedLayers[index], background);
    }
    const foregroundValue = getComputedStyle(element).color;
    const foreground = parse(foregroundValue);
    if (!foreground) throw new Error(`Cannot parse rendered foreground: ${foregroundValue}`);
    const effectiveForeground = foreground[3] < 1 ? composite(foreground, background) : foreground;
    const foregroundLuminance = luminance(effectiveForeground);
    const backgroundLuminance = luminance(background);
    const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    const format = (color: Color) =>
      `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`;

    return {
      foreground: foregroundValue,
      background: format(background),
      ratio,
      backgroundLayers,
    };
  });

/** A computed rgba()/color(srgb … / alpha) layer is genuinely translucent. */
export const hasTranslucentBackgroundLayer = (layers: string[]): boolean =>
  layers.some((value) => {
    const srgb = /color\(srgb\s+[\d.eE+-]+\s+[\d.eE+-]+\s+[\d.eE+-]+\s*\/\s*([\d.eE+-]+)\s*\)/i.exec(value);
    if (srgb) return Number(srgb[1]) < 1;
    const rgba = /rgba\(([^)]+)\)/i.exec(value);
    if (!rgba) return false;
    const channels = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return channels.length >= 4 && channels[3] < 1;
  });
