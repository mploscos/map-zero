import { clampNumber } from './math.js';

export function colorWithOpacity(color, alpha) {
  if (color.startsWith('rgba(') || color.startsWith('hsla(')) return color;
  const rgb = parseHexColor(color);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : color;
}

export function parseHexColor(color) {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].split('').map((char) => char + char).join('') : match[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

export function opacity(value, fallback) {
  return clampNumber(value ?? fallback, 0, 1);
}
