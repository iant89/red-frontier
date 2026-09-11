/**
 * The dispatch table: `SimCommand` → the simulation's own methods.
 *
 * This module is the **sim side** of the protocol, and that placement is the
 * whole point. It is DOM-free, three.js-free and renderer-free, so when the
 * worker exists it imports this file and calls `applyCommand(sim, cmd)` with no
 * changes — the message loop around it is the only new code. `LocalSimHost` is
 * simply the case where "the other side" happens to be the same thread.
 *
 * Two conventions:
 *
 *  - **The sim owns every decision.** A command never says "set battery to
 *    41.7 kWh because I clamped it"; it says what was asked, and the sim's
 *    method does the arithmetic. That is what keeps a worker's copy of the
 *    world authoritative instead of advisory.
 *  - **A refusal is data, not an exception.** Anything the sim will not do
 *    comes back as `SimAck.error` for the log — a message crossing a thread
 *    boundary cannot throw at its caller anyway.
 */

import type { Simulation } from '../Simulation';
import type { SimAck, SimCommand } from './protocol';
/** The ack a command that simply succeeded returns. */
const ACK: SimAck = { ok: true };

/**
 * Apply one already-validated command. Returns the ack the caller (if any) is
 * waiting for; commands with nothing to report return `{ ok: true }`.
 */
export function applyCommand(sim: Simulation, cmd: SimCommand): SimAck {
  switch (cmd.type) {
    // ------------------------------------------------------- rover orders ----
    case 'rover/move':
      sim.issueMove(cmd.roverId, cmd.x, cmd.z, cmd.queue);
      return ACK;
    case 'rover/mine':
      sim.issueMine(cmd.roverId, cmd.depositId, cmd.queue);
      return ACK;
    case 'rover/unload':
      sim.issueUnload(cmd.roverId, cmd.queue);
      return ACK;
    case 'rover/wait':
      sim.issueWait(cmd.roverId, cmd.seconds, cmd.queue);
      return ACK;
    case 'rover/construct':
      sim.issueConstruct(cmd.roverId, cmd.buildingId, cmd.queue);
      return ACK;
    // The service orders answer with a boolean ("was there anything to do?") and
    // log the reason themselves. That verdict is the colony's business, not the
    // protocol's: the command was accepted either way, so it acks `ok` and the
    // log line carries the nuance.
    case 'rover/clean':
      sim.issueClean(cmd.roverId, cmd.buildingId, cmd.queue);
      return ACK;
    case 'rover/repair':
      sim.issueRepair(cmd.roverId, cmd.buildingId, cmd.queue);
      return ACK;
    case 'rover/recover':
      sim.issueRecover(cmd.roverId, cmd.strandedId, cmd.queue);
      return ACK;
    // Salvage answers with a boolean too ("was there anything out there?"), and
    // logs its own reason — an undiscovered site, a buried container, a wreck
    // already stripped. The command was accepted either way.
    case 'rover/salvage':
      return { ok: sim.issueSalvage(cmd.roverId, cmd.poiId, cmd.queue) };
    case 'rover/stop':
      sim.stopRover(cmd.roverId);
      return ACK;
    case 'rover/repeatRoute':
      sim.setRepeatRoute(cmd.roverId, cmd.on);
      return ACK;
    case 'rover/rule':
      sim.setRoverRule(cmd.roverId, cmd.rule, cmd.on);
      return ACK;
    case 'rover/chargeFloor':
      sim.setChargeFloor(cmd.roverId, cmd.pct);
      return ACK;
    case 'rover/lights':
      sim.setRoverLights(cmd.roverId, cmd.on);
      return ACK;

    // ------------------------------------------------------- structures ----
    case 'building/place': {
      // Siting is checked here rather than by the caller so that the answer a
      // player gets for a ghost preview and the answer that gates the actual
      // placement are the same call, on the same authority.
      const err = sim.canPlace(cmd.kind, cmd.x, cmd.z);
      if (err) return { ok: false, error: err };
      const b = sim.placeBuilding(cmd.kind, cmd.x, cmd.z);
      return b ? { ok: true, entityId: b.id } : { ok: false, error: 'that spot refused the site' };
    }
    case 'building/toggle':
      sim.setBuildingEnabled(cmd.buildingId, cmd.enabled);
      return ACK;
    case 'building/demolish':
      sim.demolish(cmd.buildingId);
      return ACK;
    case 'building/maintain':
      sim.dispatchMaintenance(cmd.buildingId);
      return ACK;
    case 'building/assemble':
      // The one boolean worth forwarding: the palette's Assemble button greys
      // itself out from the view, so a refusal here is a state the UI reads back.
      return { ok: sim.assembleRover(cmd.buildingId, cmd.kind) };

    // ---------------------------------------------------------- the human ----
    case 'colonist/order':
      sim.orderColonist(cmd.order);
      return ACK;

    // ------------------------------------------------------ dev backdoors ----
    case 'dev/time':
      sim.devSetTime(cmd.sol, cmd.frac);
      return ACK;
    case 'dev/storm/force':
      sim.devForceStorm(cmd.kind);
      return ACK;
    case 'dev/storm/clear':
      sim.devClearStorms();
      return ACK;
    case 'dev/storm/scheduler':
      sim.devSetStormScheduler(cmd.on);
      return ACK;
    case 'dev/dust':
      sim.devSetDust(cmd.frac);
      return ACK;
    case 'dev/spawn/rover':
      return { ok: true, entityId: sim.devSpawnRover(cmd.kind, cmd.x, cmd.z).id };
    case 'dev/spawn/building': {
      const b = sim.devSpawnBuilding(cmd.kind, cmd.x, cmd.z);
      return b ? { ok: true, entityId: b.id } : { ok: false, error: 'illegal site' };
    }
    case 'dev/spawn/deposit':
      return { ok: true, entityId: sim.devSpawnDeposit(cmd.resource, cmd.x, cmd.z, cmd.kg).id };
    case 'dev/building/complete':
      return { ok: sim.devCompleteBuilding(cmd.buildingId) };
    case 'dev/building/level':
      return { ok: true, value: sim.devSetBuildingLevel(cmd.buildingId, cmd.level) };
    case 'dev/building/health':
      return { ok: sim.devSetBuildingHealth(cmd.buildingId, cmd.pct) };
    case 'dev/building/damaged':
      return { ok: sim.devSetBuildingDamaged(cmd.buildingId, cmd.on) };
    case 'dev/building/cleanliness':
      return { ok: sim.devSetBuildingCleanliness(cmd.buildingId, cmd.frac) };
    case 'dev/rover/battery':
      return { ok: sim.devSetRoverBatteryFrac(cmd.roverId, cmd.frac) };
    case 'dev/rover/cargo':
      return { ok: true, value: sim.devSetRoverCargo(cmd.roverId, cmd.resource, cmd.kg) };
    case 'dev/rover/cargoClear':
      return { ok: sim.devClearRoverCargo(cmd.roverId) };
    case 'dev/rover/condition':
      return { ok: sim.devSetRoverCondition(cmd.roverId, cmd.pct) };
    case 'dev/colonist/health':
      return { ok: sim.devSetColonistHealth(cmd.pct) };
    case 'dev/colonist/suit':
      sim.devRefillSuit();
      return ACK;
  }
}
