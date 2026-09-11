/** Leaflet / overlay zoom ceiling. Tiles stretch past native zoom. */
export const MAP_MAX_ZOOM = 22;
export const MAP_NATIVE_ZOOM = 19;

export const PIN_W = 24;
export const PIN_H = 36;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Teardrop pin, tip at the bottom-center of the 24×36 viewBox.
 * Use iconAnchor [12, 36] / CSS translate(-50%, -100%) so the tip is the point.
 */
export function pinSvg(color: string, label?: string): string {
  const safe = label ? escapeHtml(label) : "";
  const font = safe.length > 2 ? 8 : 10;
  const inner = safe
    ? `<text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="${font}" font-weight="700" font-family="ui-sans-serif,system-ui,sans-serif">${safe}</text>`
    : `<circle cx="12" cy="12" r="3.8" fill="#fff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_W}" height="${PIN_H}" viewBox="0 0 24 36" style="display:block;overflow:visible">
    <path d="M12 36C12 36 2.2 22.2 2.2 13.2a9.8 9.8 0 1 1 19.6 0C21.8 22.2 12 36 12 36z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    ${inner}
  </svg>`;
}

export function pinHtml(
  color: string,
  label?: string,
  extraRightHtml?: string
): string {
  const side = extraRightHtml
    ? `<div style="position:absolute;left:${PIN_W + 2}px;top:2px;white-space:nowrap;pointer-events:none">${extraRightHtml}</div>`
    : "";
  return `<div style="position:relative;width:${PIN_W}px;height:${PIN_H}px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">${pinSvg(color, label)}${side}</div>`;
}
