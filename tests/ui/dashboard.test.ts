/**
 * @suite ui/dashboard
 * @group unit
 * @covers src/ui/DashboardPanel.ts
 * @desc Phase 4: the operations dashboard states what the colony is doing —
 * six status rows, the single-points-of-failure row, the roadmap's nine
 * historical graphs. Rendered as pure functions so the numbers, the copy and
 * the tone rules can be pinned without a DOM; the panel class is a shell over
 * {@link renderDashboardHtml}. "NEXT BOTTLENECK" stays missing on purpose —
 * advice is P5, this panel is description.
 */

import assert from 'node:assert/strict';
import {
  dashboardModelFromView,
  renderDashboardHtml,
  renderGraphControlsHtml,
  GRAPH_DEFS,
} from '../../src/ui/DashboardPanel';
import type { OpsViewSource } from '../../src/ui/DashboardPanel';
import { STRINGS } from '../../src/ui/strings';
import { group, test, finish } from '../harness';

interface ViewOptions {
  reserveSols?: number;
  netRate?: number;
  storedFrac?: number;
  brownout?: boolean;
  firstShedTier?: number | null;
  roverPhases?: string[];
  singlePoints?: string[];
  autonomyCurrent?: number;
  fluid?: 'water' | 'oxygen' | 'food';
}

function view(over: ViewOptions = {}): OpsViewSource {
  const reserve = over.reserveSols ?? 10;
  const rate = over.netRate ?? 1.2;
  const capKWh = 40;
  const stored = (over.storedFrac ?? 0.84) * capKWh;
  const phases = over.roverPhases ?? ['idle', 'moving', 'working', 'disabled', 'idle'];
  return {
    pools: {
      amounts: { water: 71, oxygen: 96, food: 82 },
      capacity: { water: 100, oxygen: 100, food: 100 },
    },
    power: {
      generationKw: 12.4,
      demandKw: 9.1,
      servedKw: 9.1,
      storedKWh: stored,
      capacityKWh: capKWh,
      brownout: over.brownout ?? false,
      firstShedTier: over.firstShedTier ?? null,
    },
    storedKWh: stored,
    rovers: phases.map((phase) => ({ phase })),
    autonomy: {
      current: over.autonomyCurrent ?? 6.8,
      best: 8.2,
      identity: 'engineer',
      singlePoints: over.singlePoints ?? [],
    },
    reserveSols: () => reserve,
    netRatePerSol: () => rate,
  };
}

// ---------------------------------------------------------------- rows ----

group('dashboardModelFromView — the roadmap mock rows');

test('the six rows mirror the roadmap mock, in order', () => {
  const m = dashboardModelFromView(view());
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['power', 'water', 'oxygen', 'food', 'rovers', 'autonomy'],
  );
  assert.equal(m.rows[0].value, '84%', 'POWER 84%');
  assert.equal(m.rows[1].value, '71%', 'WATER 71%');
  assert.equal(m.rows[2].value, '96%', 'OXYGEN 96%');
  assert.equal(m.rows[3].value, '82%', 'FOOD 82%');
  assert.equal(m.rows[4].value, '4/5', 'ROVERS 4/5 — one disabled in the fixture');
  assert.equal(m.rows[5].value, '6.8 sols', 'AUTONOMY 6.8 sols');
});

test('a healthy colony reads STABLE/ok everywhere except partial fleets', () => {
  const allWorking = view({ roverPhases: ['moving', 'working'] });
  const m = dashboardModelFromView(allWorking);
  for (const r of m.rows) {
    assert.equal(r.tone, 'ok', `${r.id} ok`);
    assert.equal(r.status, r.id === 'rovers' ? STRINGS['dashboard.operational'] : r.id === 'autonomy' ? 'ENGINEER' : STRINGS['dashboard.stable']);
  }
});

test('fluid tiers: <1.0 sol critical, <2.5 warning, else stable', () => {
  assert.equal(dashboardModelFromView(view({ reserveSols: 0.5 })).rows[1].tone, 'crit');
  assert.equal(dashboardModelFromView(view({ reserveSols: 2.0 })).rows[1].tone, 'warn');
  assert.equal(dashboardModelFromView(view({ reserveSols: Infinity })).rows[1].tone, 'ok');
  assert.equal(
    dashboardModelFromView(view({ reserveSols: 0.5 })).rows[1].status,
    STRINGS['dashboard.critical'],
  );
});

test('power tiers: life-support shed or flat battery critical; brownout or low battery warning', () => {
  assert.equal(dashboardModelFromView(view({ firstShedTier: 0, brownout: true })).rows[0].tone, 'crit');
  assert.equal(dashboardModelFromView(view({ storedFrac: 0.03 })).rows[0].tone, 'crit');
  assert.equal(dashboardModelFromView(view({ brownout: true })).rows[0].tone, 'warn');
  assert.equal(dashboardModelFromView(view({ storedFrac: 0.2 })).rows[0].tone, 'warn');
  assert.equal(dashboardModelFromView(view({ storedFrac: 0.6 })).rows[0].tone, 'ok');
});

test('fleet: all disabled is critical, some disabled warns', () => {
  assert.equal(dashboardModelFromView(view({ roverPhases: ['disabled', 'disabled'] })).rows[4].tone, 'crit');
  assert.equal(dashboardModelFromView(view({ roverPhases: ['idle', 'disabled'] })).rows[4].tone, 'warn');
});

test('autonomy row carries the identity and the best streak; singlePoints pass through', () => {
  const m = dashboardModelFromView(view({ singlePoints: ['water production', 'recovery garage'] }));
  assert.equal(m.rows[5].sub, `ENGINEER · ${STRINGS['dashboard.bestAutonomy'](8.2)}`);
  assert.deepEqual(m.singlePoints, ['water production', 'recovery garage']);
});

// --------------------------------------------------------------- markup ----

group('renderDashboardHtml — statuses and the single-points row');

test('markup carries tone classes, statuses and every tooltip', () => {
  const html = renderDashboardHtml(dashboardModelFromView(view({ reserveSols: 0.5 })));
  assert.ok(html.includes('data-ops="power"'));
  assert.ok(html.includes('data-ops="autonomy"'));
  assert.ok(html.includes('tone-crit'), 'depleting water paints the critical row');
  assert.ok(html.includes(STRINGS['dashboard.critical']));
  assert.ok(html.includes('title="Runs dry inside one sol'), 'the number explains itself');
});

test('single points of failure render as a marker row; none read as redundancy taught', () => {
  const none = renderDashboardHtml(dashboardModelFromView(view()));
  assert.ok(none.includes(STRINGS['dashboard.noSinglePoints']));
  assert.ok(none.includes('dash-spof ok'));

  const some = renderDashboardHtml(dashboardModelFromView(view({ singlePoints: ['oxygen production'] })));
  assert.ok(some.includes('dash-spof warn'));
  assert.ok(some.includes('oxygen production'), 'the chain with one producer is named');
});

test('hostile copy never reaches the markup raw', () => {
  const m = dashboardModelFromView(view({ singlePoints: ['<b>water</b>'] }));
  const html = renderDashboardHtml(m);
  assert.ok(!html.includes('<b>water</b>'));
  assert.ok(html.includes('&lt;b&gt;water&lt;/b&gt;'));
});

// --------------------------------------------------------------- graphs ----

group('graphs — the roadmap checklist');

test('all nine graphs exist, in the roadmap order', () => {
  assert.deepEqual(
    GRAPH_DEFS.map((g) => g.id),
    ['power', 'water', 'oxygen', 'food', 'ore', 'utilization', 'battery', 'production', 'consumption'],
    'Power, Water, Oxygen, Food, Ore, Rover utilization, Battery reserves, Production, Consumption',
  );
});

test('every graph reads both the live ring and the sol rows', () => {
  const sample: Parameters<(typeof GRAPH_DEFS)[number]['series'][number]['pick']>[0] = {
    t: 0, genKw: 5, loadKw: 4, storedFrac: 0.5, water: 1, oxygen: 2, food: 3,
    ore: 6, steel: 1, components: 2, roverUtil: 0.25,
    prod: { water: 7, oxygen: 8, food: 9 },
    cons: { water: 1, oxygen: 2, food: 3 },
  };
  const row: Parameters<(typeof GRAPH_DEFS)[number]['series'][number]['pickSol']>[0] = {
    sol: 1, genKwAvg: 6, loadKwAvg: 5, storedFracMin: 0.4, roverUtilAvg: 0.5,
    water: 11, oxygen: 12, food: 13, ore: 14, steel: 15, components: 16,
    prod: { water: 70, oxygen: 80, food: 90 },
    cons: { water: 10, oxygen: 20, food: 30 },
  };
  for (const def of GRAPH_DEFS) {
    for (const ser of def.series) {
      assert.ok(Number.isFinite(ser.pick(sample)), `${def.id} live`);
      assert.ok(Number.isFinite(ser.pickSol(row)), `${def.id} sols`);
    }
  }
  const prod = GRAPH_DEFS.find((g) => g.id === 'production')!;
  assert.equal(prod.series.find((s) => s.label === 'water')!.pick(sample), 7, 'production reads produced rates');
  const cons = GRAPH_DEFS.find((g) => g.id === 'consumption')!;
  assert.equal(cons.series.find((s) => s.label === 'water')!.pickSol(row), 10, 'consumption reads consumed rates');
});

test('ratio charts are flagged so utilization and battery pin to [0,1]', () => {
  const ratio = GRAPH_DEFS.filter((g) => g.ratio).map((g) => g.id);
  assert.deepEqual(ratio, ['utilization', 'battery']);
});

test('the controls markup renders nine checkboxes and the live/sols toggle', () => {
  const html = renderGraphControlsHtml(['power', 'water'], 'live');
  assert.equal((html.match(/data-graph="/g) ?? []).length, 9);
  assert.ok(html.includes('data-graph="utilization"'));
  assert.ok((html.match(/checked/g) ?? []).length === 2, 'only the active boxes are checked');
  assert.ok(html.includes('data-scope="live"'));
  assert.ok(html.includes('data-scope="sols"'));
  assert.ok(html.includes('dash-scope on" data-scope="live"'), 'live is the selected scope');
});

// ---------------------------------------------------- no bottleneck here ----

group('description, not advice');

test('the dashboard never renders the P5 bottleneck panel', () => {
  const html =
    renderDashboardHtml(dashboardModelFromView(view({ singlePoints: ['water production'] }))) +
    renderGraphControlsHtml(GRAPH_DEFS.map((g) => g.id), 'sols');
  assert.ok(!html.includes(STRINGS['dashboard.nextBottleneck']));
  assert.ok(!/bottleneck/i.test(html), 'advice is another panel (P5) — kept apart so nothing auto-solves');
});

finish();
