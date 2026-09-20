/**
 * @suite full
 * @group link
 * @desc The serial full test: links every suite into one process and prints the
 * roll-up. `npm run test:serial` uses it; `npm test` runs suites in parallel.
 *
 * Nothing is implemented here but the import list, and that list is checked
 * against the files on disk by `npm run test:check` — a suite that exists but
 * is not linked here fails the check instead of quietly never running. Suites
 * are imported in the order they should run: cheap units first, the long soak
 * and save rounds after them, the DOM suites last.
 */

import { report } from './harness';

import './audio/system.test';
import './sim/power.test';
import './sim/world.test';
import './sim/setup.test';
import './sim/clock.test';
import './sim/clock-system.test';
import './sim/invariants.test';
import './sim/state-hash.test';
import './sim/profiler.test';
import './sim/save-validation.test';
import './sim/transcript.test';
import './sim/life-support.test';
import './sim/life-support-system.test';
import './sim/logistics-system.test';
import './sim/colony.test';
import './sim/soak.test';
import './sim/build.test';
import './sim/grid.test';
import './sim/power-system.test';
import './sim/production-system.test';
import './sim/construction-system.test';
import './sim/refining.test';
import './sim/components.test';
import './sim/maintenance.test';
import './sim/water.test';
import './sim/engineering.test';
import './sim/alerts.test';
import './sim/weather.test';
import './sim/weather-system.test';
import './sim/storms.test';
import './sim/rovers.test';
import './sim/rover-system.test';
import './sim/rover-state.test';
import './sim/proximity.test';
import './sim/fleet.test';
import './sim/fleet-automation.test';
import './sim/garage.test';
import './sim/lights.test';
import './sim/determinism.test';
import './sim/exploration-system.test';
import './sim/failure-system.test';
import './sim/alert-system.test';
import './sim/domain-events.test';
import './sim/navigation.test';
import './sim/history-system.test';
import './sim/simulation-orchestrator.test';
import './sim/pois.test';
import './sim/persistence.test';
import './sim/devtools.test';
import './sim/host.test';
import './sim/worker.test';
import './sim/worker-performance.test';
import './sim/property-testing.test';
import './sim/performance-regression.test';
import './sim/large-colony-stress.test';
import './sim/network-boundary.test';
import './render/particles.test';
import './render/water-overlay.test';
import './hud/water.test';
import './hud/engineering.test';
import './render/entity-preview.test';
import './render/selection.test';
import './render/solar.test';
import './render/descent-stage.test';
import './render/weather-station.test';
import './render/glb-assets.test';
import './app/update-check.test';
import './app/game-controllers.test';
import './app/pause-save.test';
import './ui/build-status.test';
import './ui/gestures.test';
import './hud/chrome.test';
import './hud/panels.test';
import './hud/weather.test';
import './hud/inspectors.test';
import './hud/fleet.test';
import './hud/garage.test';
import './hud/workshop.test';
import './hud/maintenance.test';
import './hud/controls.test';
import './hud/alerts.test';
import './hud/mobile.test';
import './hud/dossier.test';
import './hud/markers.test';
import './hud/devpanel.test';
import './hud/worldmap.test';
import './hud/pause-menu.test';

// Each suite prints one line as it runs; `report` prints the total, every
// failure, and exits non-zero if anything broke.
report(76);
