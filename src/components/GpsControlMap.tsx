"use client";

import { useEffect } from "react";
import {
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMapEvents,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface GpsControlMarker {
  code: string;
  sequence: number;
  lat: number;
  lon: number;
}

interface Props {
  controls: GpsControlMarker[];
  onPlace: (lat: number, lon: number) => void;
  center?: [number, number];
}

function ClickHandler({ onPlace }: { onPlace: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitToControls({ controls }: { controls: GpsControlMarker[] }) {
  const map = useMap();
  useEffect(() => {
    if (controls.length === 0) return;
    if (controls.length === 1) {
      map.setView([controls[0].lat, controls[0].lon], 15);
      return;
    }
    const lats = controls.map((c) => c.lat);
    const lons = controls.map((c) => c.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [40, 40] }
    );
  }, [map, controls]);
  return null;
}

export default function GpsControlMap({
  controls,
  onPlace,
  center = [59.33, 18.065],
}: Props) {
  return (
    <MapContainer
      center={center}
      zoom={14}
      className="h-full w-full min-h-[420px] cursor-crosshair"
      zoomControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onPlace={onPlace} />
      <FitToControls controls={controls} />
      {controls.map((c) => (
        <CircleMarker
          key={`${c.sequence}-${c.code}`}
          center={[c.lat, c.lon]}
          radius={10}
          pathOptions={{
            color: "#c0392b",
            fillColor: "#fff",
            fillOpacity: 0.9,
            weight: 2,
          }}
        >
          <Tooltip permanent direction="center">
            {c.code}
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
