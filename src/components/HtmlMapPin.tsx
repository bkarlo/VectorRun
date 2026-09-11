"use client";

import { pinSvg } from "@/lib/mapPins";

/** HTML overlay pin. When `tipAnchor` is true, the tip sits on the parent's origin. */
export default function HtmlMapPin({
  color,
  label,
  className = "",
  tipAnchor = true,
}: {
  color: string;
  label?: string;
  className?: string;
  tipAnchor?: boolean;
}) {
  return (
    <div
      className={className}
      style={{
        width: 24,
        height: 36,
        transform: tipAnchor ? "translate(-50%, -100%)" : undefined,
        filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))",
      }}
      dangerouslySetInnerHTML={{ __html: pinSvg(color, label) }}
    />
  );
}
