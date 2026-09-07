"use client";

import { TileLayer } from "react-leaflet";

export type BasemapKind = "osm" | "satellite";

const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';
const SAT_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SAT_ATTR =
  "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics";

export default function BasemapTiles({
  kind = "osm",
  visible = true,
  opacity = 1,
}: {
  kind?: BasemapKind;
  visible?: boolean;
  opacity?: number;
}) {
  if (!visible) return null;
  if (kind === "satellite") {
    return (
      <TileLayer attribution={SAT_ATTR} url={SAT_URL} opacity={opacity} />
    );
  }
  return <TileLayer attribution={OSM_ATTR} url={OSM_URL} opacity={opacity} />;
}
