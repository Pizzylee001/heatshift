"use client";

import { useEffect } from "react";
import { MapContainer, Marker, Polygon, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapSite = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

export type MapHeatBand = "Low" | "Moderate" | "High" | "Extreme";

export type MapHeatTile = {
  id: string;
  siteName: string;
  hour: number;
  temperature: number;
  band: MapHeatBand;
  positions: [number, number][];
};

type HeatMapProps = {
  sites: MapSite[];
  heatTiles: MapHeatTile[];
  showHeatLayer: boolean;
  onAdd: (lat: number, lng: number) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
};

const BAND_COLORS: Record<MapHeatBand, string> = {
  Low: "#38bdf8",
  Moderate: "#facc15",
  High: "#fb923c",
  Extreme: "#ef4444",
};

function MapClickHandler({ onAdd, disabled }: Pick<HeatMapProps, "onAdd" | "disabled">) {
  useMapEvents({
    click(event) {
      if (!disabled) onAdd(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function namedPin(name: string): L.DivIcon {
  return L.divIcon({
    className: "heatshift-pin",
    html: `<span class="pin-wrap"><span class="pin-dot"></span><span class="pin-name">${name}</span></span>`,
    iconSize: [0, 0],
    iconAnchor: [7, 7],
  });
}

export default function HeatMap({
  sites,
  heatTiles,
  showHeatLayer,
  onAdd,
  onRemove,
  disabled,
}: HeatMapProps) {
  useEffect(() => {
    delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  return (
    <MapContainer center={[33.4484, -112.074]} zoom={11} scrollWheelZoom className="heatmap-canvas">
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickHandler onAdd={onAdd} disabled={disabled} />
      {showHeatLayer && heatTiles.map((tile) => {
        const color = BAND_COLORS[tile.band];
        return (
          <Polygon
            key={tile.id}
            positions={tile.positions}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.5, opacity: 0.82, weight: 1.1 }}
          >
            <Tooltip sticky opacity={0.96}>
              <strong>{tile.siteName}</strong><br />
              {String(tile.hour).padStart(2, "0")}:00 · {tile.temperature.toFixed(1)}°C
            </Tooltip>
          </Polygon>
        );
      })}
      {sites.map((site) => (
        <Marker
          key={site.id}
          position={[site.lat, site.lng]}
          icon={namedPin(site.name)}
          eventHandlers={{ click: () => onRemove(site.id) }}
        />
      ))}
    </MapContainer>
  );
}
