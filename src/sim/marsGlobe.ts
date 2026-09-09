/**
 * A compact, geographically honest Mars.
 *
 * Elevations (km) follow MOLA's big picture: northern lowlands, southern
 * highlands, Tharsis, Hellas, Argyre, Isidis, Elysium, Valles Marineris.
 * A seed picks a landable site; the playable map is a 1280 m window of that
 * site (1 world unit = 1 metre) plus HiRISE-scale local geology.
 */

import { clamp, lerp, smoothstep, mulberry32 } from '../lib/rng';

const D2R = Math.PI / 180;
/** Mars mean radius (km). */
const RM = 3389.5;
/** Metres per degree of latitude. */
export const METERS_PER_DEG = RM * 1000 * D2R;

export type MarsBiome =
  | 'plains'
  | 'highlands'
  | 'basin'
  | 'volcanic'
  | 'canyon'
  | 'crater';

export interface GlobeSample {
  /** Areoid elevation, kilometres. */
  elevKm: number;
  biome: MarsBiome;
  /** 0 Amazonian plains … 1 Noachian highlands. */
  craterDensity: number;
  rockiness: number;
  /** Dust / sand / pale bias. */
  dust: number;
  basalt: number;
}

export interface LandingSite {
  lat: number;
  lon: number;
  name: string;
  biome: MarsBiome;
  elevKm: number;
  /** Eastward slope (m / m) over the window. */
  dEdx: number;
  /** Northward slope (m / m). */
  dEdz: number;
  craterDensity: number;
  rockiness: number;
  dust: number;
  basalt: number;
}

interface NamedRegion {
  name: string;
  lat: number;
  lon: number;
  jitterDeg: number;
  biome: MarsBiome;
}

/** Prefer landable, inhabited-looking ground — not Olympus or the canyon floor. */
const REGIONS: NamedRegion[] = [
  { name: 'Amazonis Planitia', lat: 10, lon: 200, jitterDeg: 9, biome: 'plains' },
  { name: 'Chryse Planitia', lat: 27, lon: 322, jitterDeg: 7, biome: 'plains' },
  { name: 'Acidalia Planitia', lat: 46, lon: 338, jitterDeg: 6, biome: 'plains' },
  { name: 'Utopia Planitia', lat: 40, lon: 118, jitterDeg: 9, biome: 'plains' },
  { name: 'Elysium Planitia', lat: 3, lon: 155, jitterDeg: 6, biome: 'plains' },
  { name: 'Isidis Planitia', lat: 13, lon: 88, jitterDeg: 4, biome: 'basin' },
  { name: 'Meridiani Planum', lat: -2, lon: 354, jitterDeg: 3, biome: 'plains' },
  { name: 'Arabia Terra', lat: 23, lon: 33, jitterDeg: 8, biome: 'highlands' },
  { name: 'Noachis Terra', lat: -45, lon: 10, jitterDeg: 8, biome: 'highlands' },
  { name: 'Terra Cimmeria', lat: -34, lon: 145, jitterDeg: 8, biome: 'highlands' },
  { name: 'Terra Sirenum', lat: -40, lon: 210, jitterDeg: 7, biome: 'highlands' },
  { name: 'Hellas Planitia', lat: -41, lon: 70, jitterDeg: 5, biome: 'basin' },
  { name: 'Syrtis Major', lat: 9, lon: 70, jitterDeg: 4, biome: 'volcanic' },
  { name: 'Lunae Planum', lat: 12, lon: 298, jitterDeg: 5, biome: 'plains' },
  { name: 'Gale crater', lat: -5.4, lon: 137.8, jitterDeg: 0.35, biome: 'crater' },
  { name: 'Jezero crater', lat: 18.38, lon: 77.58, jitterDeg: 0.12, biome: 'crater' },
  { name: 'Gusev crater', lat: -14.5, lon: 175.4, jitterDeg: 0.4, biome: 'crater' },
  { name: 'Oxia Planum', lat: 18.2, lon: 335.5, jitterDeg: 1.2, biome: 'plains' },
];

function wrapLon(lon: number): number {
  return ((lon % 360) + 360) % 360;
}

/** Angular distance in degrees. */
export function angDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dlat = p2 - p1;
  const dlon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / D2R;
}

function gauss(dDeg: number, sigma: number): number {
  const x = dDeg / sigma;
  return Math.exp(-0.5 * x * x);
}

function basin(lat: number, lon: number, clat: number, clon: number, radiusDeg: number, depthKm: number): number {
  const d = angDist(lat, lon, clat, clon);
  if (d > radiusDeg * 1.35) return 0;
  const n = d / radiusDeg;
  if (n < 0.72) return depthKm * (1 - n * n * 0.15);
  if (n < 1) {
    const t = (n - 0.72) / 0.28;
    const rim = -depthKm * 0.08;
    return lerp(depthKm * 0.85, rim, t * t * (3 - 2 * t));
  }
  const t = (n - 1) / 0.35;
  return -depthKm * 0.08 * (1 - t) * (1 - t);
}

function volcano(lat: number, lon: number, clat: number, clon: number, heightKm: number, sigma: number): number {
  return gauss(angDist(lat, lon, clat, clon), sigma) * heightKm;
}

function trench(
  lat: number,
  lon: number,
  clat: number,
  clon0: number,
  clon1: number,
  halfW: number,
  depthKm: number,
): number {
  lon = wrapLon(lon);
  const lo = Math.min(clon0, clon1);
  const hi = Math.max(clon0, clon1);
  let along = 0;
  if (lon >= lo && lon <= hi) along = 1;
  else {
    const dlo = Math.min(Math.abs(lon - lo), 360 - Math.abs(lon - lo));
    const dhi = Math.min(Math.abs(lon - hi), 360 - Math.abs(lon - hi));
    along = Math.max(0, 1 - Math.min(dlo, dhi) / 8);
  }
  if (along <= 0) return 0;
  const latN = Math.abs(lat - clat) / halfW;
  if (latN > 1.6) return 0;
  const wall = latN < 1 ? 1 - latN * latN : Math.max(0, 1.6 - latN) / 0.6;
  return depthKm * wall * along;
}

/**
 * MOLA-like elevation in kilometres above the areoid.
 * Cheap: a handful of Gaussians, not a raster.
 */
export function marsElevationKm(lat: number, lon: number): number {
  lon = wrapLon(lon);
  const bound = 7 + 16 * Math.sin((lon - 40) * D2R);
  const north = smoothstep(clamp((lat - (bound - 14)) / 28, 0, 1));
  let h = lerp(1.55, -4.05, north);

  h += gauss(angDist(lat, lon, 5, 250), 32) * 7.2; // Tharsis bulge
  h += volcano(lat, lon, 18.65, 226.2, 21.0, 2.4); // Olympus Mons
  h += volcano(lat, lon, 11.92, 255.47, 14.9, 1.8); // Ascraeus
  h += volcano(lat, lon, 1.48, 246.9, 14.0, 1.7); // Pavonis
  h += volcano(lat, lon, -8.35, 239.91, 11.7, 1.9); // Arsia
  h += volcano(lat, lon, 40.5, 250.4, 6.0, 4.5); // Alba Mons
  h += volcano(lat, lon, 25.02, 147.21, 12.6, 2.2); // Elysium Mons
  h += volcano(lat, lon, 9.0, 67.0, 2.2, 4.0); // Syrtis shield

  h += basin(lat, lon, -42.4, 70.5, 18, -7.1); // Hellas
  h += basin(lat, lon, -49.7, 316.0, 8.5, -3.2); // Argyre
  h += basin(lat, lon, 12.9, 87.0, 9.5, -2.8); // Isidis
  h += basin(lat, lon, 45.0, 115.0, 22, -0.9); // Utopia
  h += basin(lat, lon, -5.4, 137.8, 1.3, -1.1); // Gale
  h += basin(lat, lon, 18.38, 77.58, 0.42, -0.55); // Jezero
  h += basin(lat, lon, -14.5, 175.4, 1.4, -1.0); // Gusev

  h += trench(lat, lon, -13.5, 270, 330, 2.2, -5.5);

  return h;
}

function biomeStats(biome: MarsBiome): {
  craterDensity: number;
  rockiness: number;
  dust: number;
  basalt: number;
} {
  switch (biome) {
    case 'highlands':
      return { craterDensity: 0.88, rockiness: 0.45, dust: 0.4, basalt: 0.25 };
    case 'basin':
      return { craterDensity: 0.32, rockiness: 0.12, dust: 0.8, basalt: 0.08 };
    case 'volcanic':
      return { craterDensity: 0.22, rockiness: 0.55, dust: 0.35, basalt: 0.7 };
    case 'canyon':
      return { craterDensity: 0.2, rockiness: 0.7, dust: 0.3, basalt: 0.4 };
    case 'crater':
      return { craterDensity: 0.45, rockiness: 0.35, dust: 0.55, basalt: 0.15 };
    default:
      return { craterDensity: 0.18, rockiness: 0.12, dust: 0.75, basalt: 0.08 };
  }
}

export function sampleGlobe(lat: number, lon: number): GlobeSample {
  lon = wrapLon(lon);
  const elevKm = marsElevationKm(lat, lon);
  const bound = 7 + 16 * Math.sin((lon - 40) * D2R);
  const north = smoothstep(clamp((lat - (bound - 14)) / 28, 0, 1));

  const hellas = gauss(angDist(lat, lon, -42.4, 70.5), 16);
  const tharsis = gauss(angDist(lat, lon, 5, 250), 28);
  const canyon = Math.abs(lat + 13.5) < 4 && wrapLon(lon) > 270 && wrapLon(lon) < 335 ? 1 : 0;
  const inGale = angDist(lat, lon, -5.4, 137.8) < 1.2;
  const inJezero = angDist(lat, lon, 18.38, 77.58) < 0.4;

  let biome: MarsBiome = north > 0.55 ? 'plains' : 'highlands';
  if (hellas > 0.45) biome = 'basin';
  if (tharsis > 0.55 && elevKm > 3) biome = 'volcanic';
  if (canyon && elevKm < -1) biome = 'canyon';
  if (inGale || inJezero) biome = 'crater';

  const craterDensity =
    biome === 'highlands' ? 0.88 : biome === 'crater' ? 0.45 : biome === 'basin' ? 0.32 : biome === 'volcanic' ? 0.22 : 0.18;
  const rockiness =
    biome === 'highlands' ? 0.45 : biome === 'volcanic' ? 0.55 : biome === 'canyon' ? 0.7 : biome === 'crater' ? 0.35 : 0.12;
  const dust = biome === 'basin' || biome === 'plains' ? 0.75 : 0.4;
  const basalt = biome === 'volcanic' ? 0.7 : biome === 'highlands' ? 0.25 : 0.08;

  return { elevKm, biome, craterDensity, rockiness, dust, basalt };
}

function globeSlope(lat: number, lon: number): { dEdx: number; dEdz: number } {
  const e = 0.02; // degrees ≈ 1.2 km
  const h0 = marsElevationKm(lat, lon);
  const hn = marsElevationKm(lat + e, lon);
  const he = marsElevationKm(lat, lon + e / Math.max(0.2, Math.cos(lat * D2R)));
  const metersE = METERS_PER_DEG * e * Math.max(0.2, Math.cos(lat * D2R));
  const metersN = METERS_PER_DEG * e;
  return {
    dEdx: ((he - h0) * 1000) / metersE,
    dEdz: ((hn - h0) * 1000) / metersN,
  };
}

function siteOk(lat: number, lon: number): boolean {
  if (Math.abs(lat) > 58) return false;
  const s = sampleGlobe(lat, lon);
  if (s.biome === 'canyon') return false;
  if (s.elevKm > 8.5) return false; // Olympus flank
  const sl = globeSlope(lat, lon);
  const mag = Math.hypot(sl.dEdx, sl.dEdz);
  if (mag > 0.12) return false;
  return true;
}

/**
 * Seed → a landable 1280 m patch of real Mars. Deterministic.
 */
export function pickLandingSite(seed: number): LandingSite {
  const rng = mulberry32(seed ^ 0x4d415253);
  for (let t = 0; t < 48; t++) {
    const region = REGIONS[(rng() * REGIONS.length) | 0];
    const lat = clamp(region.lat + (rng() * 2 - 1) * region.jitterDeg, -55, 55);
    const lon = wrapLon(region.lon + (rng() * 2 - 1) * region.jitterDeg);
    if (!siteOk(lat, lon) && t < 40) continue;
    const g = sampleGlobe(lat, lon);
    const sl = globeSlope(lat, lon);
    const stats = biomeStats(region.biome);
    return {
      lat,
      lon,
      name: region.name,
      biome: region.biome,
      elevKm: g.elevKm,
      dEdx: sl.dEdx,
      dEdz: sl.dEdz,
      craterDensity: stats.craterDensity,
      rockiness: stats.rockiness,
      dust: stats.dust,
      basalt: stats.basalt,
    };
  }
  // Last-resort: Amazonis.
  const g = sampleGlobe(10, 200);
  const sl = globeSlope(10, 200);
  const stats = biomeStats('plains');
  return {
    lat: 10,
    lon: 200,
    name: 'Amazonis Planitia',
    biome: 'plains',
    elevKm: g.elevKm,
    dEdx: sl.dEdx,
    dEdz: sl.dEdz,
    ...stats,
  };
}

/** World (x east, z north) in metres → planet lat/lon at this site. */
export function worldToLatLon(site: LandingSite, x: number, z: number): { lat: number; lon: number } {
  const dLat = z / METERS_PER_DEG;
  const dLon = x / (METERS_PER_DEG * Math.max(0.2, Math.cos(site.lat * D2R)));
  return { lat: site.lat + dLat, lon: wrapLon(site.lon + dLon) };
}
