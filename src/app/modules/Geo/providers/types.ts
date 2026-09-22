/**
 * Our own place shape. Every provider maps into this, so the frontend never
 * sees a Photon or Nominatim field and a provider can be swapped (Barikoi,
 * Google) without touching it.
 */
export type GeoPlace = {
  label: string; // "Road 27, Dhanmondi, Dhaka"
  lat: number;
  lng: number;
  area?: string; // matched to BANGLADESH_LOCATIONS names when possible
  district?: string;
  division?: string;
  city?: string;
  postcode?: string;
};

export type GeoBias = { lat: number; lng: number };

export interface GeocodingProvider {
  search(q: string, bias?: GeoBias): Promise<GeoPlace[]>;
  /** `null` when there is no Bangladesh address at that point. */
  reverse(lat: number, lng: number): Promise<GeoPlace | null>;
}
