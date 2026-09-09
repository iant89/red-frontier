/**
 * @suite full
 * @group link
 * @desc The full test: links every suite under tests/sim and tests/hud into one
 * run and prints the roll-up. This is what `npm test` executes.
 *
 * Nothing is implemented here but the import list, and that list is checked
 * against the files on disk by `npm run test:check` — a suite that exists but
 * is not linked here fails the check instead of quietly never running. Suites
 * are imported in the order they should run: cheap units first, the long soak
 * and save rounds after them, the DOM suites last.
 */

import { report } from './harness';

import './sim/power.test';
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
import './sim/determinism.test';
import './sim/persistence.test';
import './hud/chrome.test';
import './hud/weather.test';
import './hud/inspectors.test';
import './hud/fleet.test';
import './hud/garage.test';
import './hud/controls.test';
import './hud/alerts.test';
import './hud/mobile.test';
import './hud/dossier.test';
import './hud/markers.test';

// Each suite prints one line as it runs; `report` prints the total, every
// failure, and exits non-zero if anything broke.
report(25);
