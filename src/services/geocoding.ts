import { JAKARTA_BOUNDS } from './osm-mapping.js';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName?: string;
}

/**
 * Geocode an address using OpenStreetMap Nominatim.
 * Restricted to DKI Jakarta viewbox and bounding bounds.
 */
export async function geocodeAddress(address: string, placeName?: string): Promise<GeocodeResult | null> {
  const queriesToTry: string[] = [];
  
  const cleanAddress = address.trim();
  const cleanName = placeName?.trim();

  if (cleanName && cleanAddress) {
    queriesToTry.push(`${cleanName}, ${cleanAddress}, Jakarta, Indonesia`);
  }
  queriesToTry.push(`${cleanAddress}, Jakarta, Indonesia`);
  if (cleanName) {
    queriesToTry.push(`${cleanName}, Jakarta, Indonesia`);
  }

  for (const query of queriesToTry) {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      url.searchParams.set('countrycodes', 'id');
      // DKI Jakarta bounding box: minLon, maxLat, maxLon, minLat
      url.searchParams.set(
        'viewbox',
        `${JAKARTA_BOUNDS.minLon},${JAKARTA_BOUNDS.maxLat},${JAKARTA_BOUNDS.maxLon},${JAKARTA_BOUNDS.minLat}`
      );
      url.searchParams.set('bounded', '1');

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'AksesIn/1.0 (Aksesin Jakarta Accessibility Project; telkom-university)',
          'Accept-Language': 'id,en',
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      if (!Array.isArray(data) || data.length === 0) continue;

      const first = data[0];
      if (!first) continue;

      const lat = Number(first.lat);
      const lon = Number(first.lon);

      if (
        !Number.isNaN(lat) &&
        !Number.isNaN(lon) &&
        lat >= JAKARTA_BOUNDS.minLat &&
        lat <= JAKARTA_BOUNDS.maxLat &&
        lon >= JAKARTA_BOUNDS.minLon &&
        lon <= JAKARTA_BOUNDS.maxLon
      ) {
        return {
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lon.toFixed(6)),
          displayName: first.display_name,
        };
      }
    } catch {
      // Continue to next query if this one timed out or errored
    }
  }

  return null;
}
