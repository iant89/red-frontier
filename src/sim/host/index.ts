/**
 * The module surface of the host layer.
 *
 * `app/`, `ui/`, `render/` and `dev/` import from here and from nowhere else in
 * `src/sim/` — the rule `tests/sim/host.test.ts` enforces by grepping the tree
 * for the `Simulation` class outside this directory. The sim's *types* (`Rover`,
 * `Building`, `Colonist`) still come from `sim/Simulation` and `sim/defs`,
 * because a shape is not an authority: knowing what a rover holds is different
 * from being able to move one.
 */

export type { SimHost, SimTransport } from './SimHost';
export type {
  SimView,
  SimFields,
  SimQuery,
  SimSnapshot,
  SimLogEvent,
  SimWritable,
  SimBootParams,
  WorldView,
  ClockView,
  WeatherView,
  AlertsView,
} from './view';
export type { SimCommand, SimCommandType, SimAck, RoverRule, DecodeResult } from './protocol';
export { COMMAND_SHAPES, COMMAND_TYPES, decodeCommand } from './protocol';
export { applyCommand } from './applyCommand';
export { LocalSimHost, createLocalHost, restoreLocalHost } from './LocalSimHost';
export { WorkerSimHost, type WorkerInit } from './WorkerSimHost';
export {
  createHost,
  restoreHost,
  planHost,
  wantsWorker,
  workerSupported,
  type HostChoice,
  type HostPlan,
} from './createHost';
export {
  runOverlays,
  BATTERY_PIN_OVERLAY,
  EMPTY_OVERLAYS,
  type OverlayState,
} from './overlays';
export { ColonyMirror, type TerrainParams } from './mirror';
export { projectView, type ViewPayload, type WeatherPayload, type PowerPayload } from './projection';
export { evaluateSite, maintenanceNeed, type SitingInput, type SitingGround } from '../rules';
export type { HostRequest, HostReply, HostPort } from './messages';
