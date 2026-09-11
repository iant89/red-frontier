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

import './sim/power.test';
import './sim/world.test';
import './sim/setup.test';
import './sim/clock.test';
import './sim/life-support.test';
import './sim/colony.test';
import './sim/soak.test';
import './sim/build.test';
import './sim/grid.test';
import './sim/alerts.test';
import './sim/weather.test';
import './sim/storms.test';
import './sim/rovers.test';
import './sim/fleet.test';
import './sim/garage.test';
import './sim/lights.test';
import './sim/determinism.test';
import './sim/persistence.test';
import './sim/devtools.test';
import './sim/host.test';
import './render/particles.test';
import './ui/build-status.test';
import './hud/chrome.test';
import './hud/panels.test';
import './hud/weather.test';
import './hud/inspectors.test';
import './hud/fleet.test';
import './hud/garage.test';
import './hud/controls.test';
import './hud/alerts.test';
import './hud/mobile.test';
import './hud/dossier.test';
import './hud/markers.test';
import './hud/devpanel.test';

// Each suite prints one line as it runs; `report` prints the total, every
// failure, and exits non-zero if anything broke.
report(33);
