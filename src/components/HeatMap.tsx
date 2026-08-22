"use client";

import { useEffect } from "react";
import { MapContainer, Marker, TileLayer, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapSite = {
  id: string;
  label: string;
  lat: number;
  lng: number;
};

type HeatMapProps = {
  sites: MapSite[];
  onAdd: (lat: number, lng: number) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
};

function MapClickHandler({ onAdd, disabled }: Pick<HeatMapProps, "onAdd" | "disabled">) {
  useMapEvents({
    click(event) {
      if (!disabled) onAdd(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function MarkerIcon({ label }: { label: string }): L.DivIcon {
  return L.divIcon({
    className: "heatshift-marker",
    html: `<span>${label}</span>`, 
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export default function HeatMap({ sites, onAdd, onRemove, disabled }: HeatMapProps) {
  useEffect(() => {
    delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  return (
    <MapContainer
      center={[33.4484, -112.074]}
      zoom={12}
      scrollWheelZoom
      className="heatmap-canvas"
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickHandler onAdd={onAdd} disabled={disabled} />
      {sites.map((site) => (
        <Marker
          key={site.id}
          position={[site.lat, site.lng]}
          icon={MarkerIcon({ label: site.label })}
          eventHandlers={{ click: () => onRemove(site.id) }}
        />
      ))}
    </MapContainer>
  );
}
