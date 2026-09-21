/**
 * @suite ui/advisor
 * @group unit
 * @covers src/ui/AdvisorPanel.ts src/ui/strings.ts
 * @desc Phase 5: the roadmap's "WATER BOTTLENECK" mock rendered from the
 * mirror — rates, the projected shortage, contributing factors, possible
 * solutions — plus the badge and the two constraints the phase enforces:
 * entity rows only ever *focus* a machine, and a clear colony renders the
 * empty state, not noise. Pure functions, pinned without a DOM.
 */

import assert from 'node:assert/strict';
import {
  advisorModelFromView,
  advisorBadge,
  renderAdvisorHtml,
  formatRate,
  formatShortage,
} from '../../src/ui/AdvisorPanel';
import type { AdvisorViewSource } from '../../src/ui/AdvisorPanel';
import type { BottleneckView } from '../../src/sim/host/viewModels';
import { STRINGS } from '../../src/ui/strings';
import { group, test, finish } from '../harness';

function waterCard(over: Partial<BottleneckView> = {}): BottleneckView {
  return {
    kind: 'water',
    title: 'WATER BOTTLENECK',
    severity: 'warning',
    productionPerSol: 8.4,
    consumptionPerSol: 9.7,
    unit: 'kg',
    projectedShortageSols: 3.2,
    factors: [
      { key: 'damaged/1004', label: 'Water Extractor #1004 damaged — tripped offline', entityId: 1004 },
      { key: 'feed/far', label: 'Nearest water ice is 2.4 km away — a long haul per fill', entityId: null },
    ],
    solutions: [
      { key: 'repair/1004', label: 'Repair Water Extractor #1004', entityId: 1004 },
      { key: 'haul-ice', label: 'Increase mining — haul more ice; the tap starts at the seam', entityId: null },
    ],
    ...over,
  };
}

function view(cards: BottleneckView[]): AdvisorViewSource {
  return { bottlenecks: { bottlenecks: cards, next: cards[0] ?? null } };
}

// ------------------------------------------------------------------ model ----

group('advisorModelFromView — the mock, from the mirror');

test('one card carries the mock\'s numbers, formatted', () => {
  const m = advisorModelFromView(view([waterCard()]));
  assert.equal(m.count, 1);
  assert.equal(m.worst, 'warning');
  const c = m.cards[0];
  assert.equal(c.title, 'WATER BOTTLENECK');
  assert.equal(c.severityLabel, 'Warning');
  assert.equal(c.production, '8.4 kg/sol');
  assert.equal(c.consumption, '9.7 kg/sol');
  assert.equal(c.shortage, '3.2 sols');
  assert.equal(c.shortageBreach, false, '3.2 sols is a warning, not yet a breach');
  assert.equal(c.factors[0].focus, 1004, 'the damaged machine row can focus it');
  assert.equal(c.factors[1].focus, null, 'the distance row has nothing to point at');
});

test('power formats in kWh/sol, and a sub-sol shortage flags the breach', () => {
  const power = waterCard({
    kind: 'power',
    title: 'POWER BOTTLENECK',
    unit: 'kWh',
    productionPerSol: 305.7,
    consumptionPerSol: 84.2,
    projectedShortageSols: 0.4,
  });
  const m = advisorModelFromView(view([power]));
  assert.equal(m.cards[0].production, '306 kWh/sol');
  assert.equal(m.cards[0].consumption, '84.2 kWh/sol');
  assert.equal(m.cards[0].shortageBreach, true);
});

test('a null projection is the honest "not draining" line', () => {
  assert.equal(formatShortage(null).text, STRINGS['bottleneck.shortageNone']);
  assert.deepEqual(formatRate(9.75, 'kg'), '9.8 kg/sol');
});

test('the badge is silent when clear, counted and toned when not', () => {
  assert.equal(advisorBadge(advisorModelFromView(view([]))), null, 'no noise for a healthy colony');
  const badge = advisorBadge(advisorModelFromView(view([waterCard({ severity: 'critical' }), waterCard({ kind: 'oxygen', severity: 'watch' })])));
  assert.ok(badge);
  assert.equal(badge.text, '2');
  assert.equal(badge.tone, 'critical', 'the badge wears the worst severity');
  assert.match(badge.title, /WATER BOTTLENECK/);
});

// ----------------------------------------------------------------- render ----

group('renderAdvisorHtml — the mock, as markup');

test('a card renders the mock\'s sections, in its order', () => {
  const html = renderAdvisorHtml(advisorModelFromView(view([waterCard()])));
  assert.match(html, /! WATER BOTTLENECK/, 'the roadmap\'s headline');
  const order = [STRINGS['bottleneck.production'], STRINGS['bottleneck.consumption'], STRINGS['bottleneck.projectedShortage'], STRINGS['bottleneck.contributing'], STRINGS['bottleneck.solutions']];
  let at = -1;
  for (const part of order) {
    const found = html.indexOf(part);
    assert.ok(found > at, `${part} appears after the previous section`);
    at = found;
  }
  assert.match(html, /Projected shortage<\/dt><dd>3\.2 sols/, 'the shortage is the number');
  assert.match(html, /<span class="adv-marker">-<\/span><span>Water Extractor #1004 damaged/, 'factors list with dashes');
  assert.match(html, /<span class="adv-marker">><\/span><span>Repair Water Extractor #1004/, 'solutions list with carets');
  assert.match(html, /data-focus="1004"/, 'entity rows focus, alert-style');
  assert.ok(html.includes(STRINGS['bottleneck.oath']), 'the oath renders — advice, not autopilot');
});

test('severe cards wear their tone; labels are escaped', () => {
  const evil = waterCard({
    severity: 'critical',
    factors: [{ key: 'x', label: 'Shelter <b>now</b> & "later"', entityId: null }],
  });
  const html = renderAdvisorHtml(advisorModelFromView(view([evil])));
  assert.match(html, /tone-critical/);
  assert.ok(!html.includes('<b>now</b>'), 'factor copy is text, never markup');
  assert.match(html, /&lt;b&gt;now&lt;\/b&gt;/);
});

test('a clear board renders the empty state, not a blank panel', () => {
  const html = renderAdvisorHtml(advisorModelFromView(view([])));
  assert.match(html, /No bottlenecks\./);
  assert.match(html, /never fixes it for you/);
  assert.ok(!html.includes('adv-card'), 'nothing short, nothing said');
});

finish();
