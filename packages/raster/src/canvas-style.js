import { colorWithOpacity, opacity } from './shared/color.js';
import { styleWidth } from './style.js';

export function canvasStyleParts(rule, kind, layerId, zoom) {
  const parts = [];
  if (rule.glow?.enabled && rule.stroke) {
    parts.push({
      stroke: colorWithOpacity(String(rule.glow.color || rule.stroke), opacity(rule.glow.opacity, 0.2)),
      width: styleWidth(rule.glow.width ?? rule.glowWidth, 4, layerId, zoom),
      lineCap: rule.lineCap,
      lineJoin: rule.lineJoin
    });
  }
  if (rule.casing?.enabled && rule.stroke && kind !== 'point') {
    parts.push({
      stroke: colorWithOpacity(String(rule.casing.color || rule.stroke), opacity(rule.casing.opacity, 0.35)),
      width: styleWidth(rule.casing.width ?? rule.casingWidth, Number(rule.strokeWidth ?? 1) + 1, layerId, zoom),
      lineCap: rule.lineCap,
      lineJoin: rule.lineJoin
    });
  }

  const base = {};
  if (rule.fill && kind !== 'line') base.fill = colorWithOpacity(String(rule.fill), opacity(rule.fillOpacity, 1));
  if (rule.stroke && kind !== 'polygon-fill-only') {
    base.stroke = colorWithOpacity(String(rule.stroke), opacity(rule.strokeOpacity, 1));
    base.width = styleWidth(rule.strokeWidth, 1, layerId, zoom);
    base.lineCap = rule.lineCap;
    base.lineJoin = rule.lineJoin;
  }
  if (kind === 'point') {
    base.radius = styleWidth(rule.radius ?? rule.circleRadius, 4, layerId, zoom);
    base.fill = colorWithOpacity(String(rule.fill || rule.stroke || '#ffffff'), opacity(rule.fillOpacity ?? rule.strokeOpacity, 1));
    if (rule.stroke) {
      base.stroke = colorWithOpacity(String(rule.stroke), opacity(rule.strokeOpacity, 1));
      base.width = styleWidth(rule.strokeWidth, 1, layerId, zoom);
    }
  }
  parts.push(base);

  if (rule.centerLine?.enabled && rule.stroke && kind !== 'point') {
    parts.push({
      stroke: colorWithOpacity(String(rule.centerLine.color || rule.stroke), opacity(rule.centerLine.opacity, 0.5)),
      width: styleWidth(rule.centerLine.width, 0.5, layerId, zoom),
      lineCap: rule.lineCap,
      lineJoin: rule.lineJoin
    });
  }
  return parts;
}
