import React, { useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

// Fix Leaflet's default marker icon paths broken by bundlers. Import the assets
// so Vite fingerprints and serves them from our own origin — no third-party CDN.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

// Re-center map when center changes (e.g. different data loaded)
function MapCenter({ center }) {
  const map = useMap();
  useEffect(() => { if (center) map.setView(center, map.getZoom()); }, [center, map]);
  return null;
}

export function SpendingMap({ transactionNotes = {}, currencySymbol = '$' }) {
  const pins = useMemo(() => {
    return Object.values(transactionNotes)
      .filter(n => n?.location?.lat != null && n?.location?.lng != null)
      .map(n => ({ ...n.location }));
  }, [transactionNotes]);

  const center = useMemo(() => {
    if (!pins.length) return [20, 0];
    const avgLat = pins.reduce((s, p) => s + p.lat, 0) / pins.length;
    const avgLng = pins.reduce((s, p) => s + p.lng, 0) / pins.length;
    return [avgLat, avgLng];
  }, [pins]);

  if (!pins.length) {
    return (
      <div
        className="rounded-[1.25rem] p-5 sm:p-6"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}
      >
        <h3 className="text-sm font-black uppercase tracking-wide mb-3" style={{ color: 'var(--color-text)' }}>
          Spending Map
        </h3>
        <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
          <span className="text-3xl">📍</span>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-muted)' }}>No tagged locations yet</p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Enable geo-tagging in Settings, then tag expenses when adding them.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-[1.25rem] p-5 sm:p-6 space-y-3"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black uppercase tracking-wide" style={{ color: 'var(--color-text)' }}>
          Spending Map
        </h3>
        <span className="text-xs font-bold" style={{ color: 'var(--color-text-muted)' }}>
          {pins.length} location{pins.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ height: 300, border: '1px solid var(--sur-8)' }}>
        <MapContainer
          center={center}
          zoom={pins.length === 1 ? 13 : 11}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={false}
        >
          <MapCenter center={center} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {pins.map((pin, i) => (
            <Marker key={i} position={[pin.lat, pin.lng]}>
              <Popup>
                <div className="text-sm font-bold">{pin.vendor || 'Expense'}</div>
                {pin.category && <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{pin.category}</div>}
                {pin.amount != null && (
                  <div className="text-sm font-black mt-1">{currencySymbol}{Number(pin.amount).toFixed(2)}</div>
                )}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
