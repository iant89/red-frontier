/**
 * Logical asset id → public URL map for Leonardo da Vinci `.glb` exports.
 *
 * Ids use a `kind/name` shape (`rover/cargo`, `building/solar`, `prop/…`).
 * URLs are root-absolute under Vite’s `public/` tree (`/models/…`).
 *
 * This catalog documents the intended drop paths; files are optional. The
 * ModelRegistry falls back to procedural meshes when an id is unregistered,
 * the file is missing, or load fails.
 */
import type { BuildingKind, RoverKind } from '../sim/defs';

/** Canonical logical ids the Renderer knows how to ask for. */
export type RoverAssetId = `rover/${RoverKind}`;
export type BuildingAssetId = `building/${BuildingKind}`;
export type PropAssetId = `prop/${string}`;

export type AssetId = RoverAssetId | BuildingAssetId | PropAssetId | (string & {});

/** Default URL map. Extend via `ModelRegistry.register` for one-off overrides. */
export const DEFAULT_ASSET_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  // Rovers
  'rover/mining': '/models/rovers/mining.glb',
  'rover/utility': '/models/rovers/utility.glb',
  'rover/cargo': '/models/rovers/cargo.glb',
  // Buildings
  'building/habitat': '/models/buildings/habitat.glb',
  'building/solar': '/models/buildings/solar.glb',
  'building/battery': '/models/buildings/battery.glb',
  'building/warehouse': '/models/buildings/warehouse.glb',
  'building/workshop': '/models/buildings/workshop.glb',
  'building/extractor': '/models/buildings/extractor.glb',
  'building/oxygenator': '/models/buildings/oxygenator.glb',
  'building/greenhouse': '/models/buildings/greenhouse.glb',
  'building/garage': '/models/buildings/garage.glb',
  'building/rtg': '/models/buildings/rtg.glb',
  'building/weatherStation': '/models/buildings/weatherStation.glb',
  'building/refinery': '/models/buildings/refinery.glb',
});

export function roverAssetId(kind: RoverKind): RoverAssetId {
  return `rover/${kind}`;
}

export function buildingAssetId(kind: BuildingKind): BuildingAssetId {
  return `building/${kind}`;
}
