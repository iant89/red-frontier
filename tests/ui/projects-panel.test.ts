/**
 * @suite ui/projects-panel
 * @group unit
 * @covers src/ui/ProjectsPanel.ts
 * @desc Phase 2: the projects card states the ask, the numbers and the reward.
 * Rendered as a pure string so the copy can be pinned without a DOM — the panel
 * class is a thin shell over {@link renderProjectsHtml}.
 */

import assert from 'node:assert/strict';
import { renderProjectsHtml, formatRequirement, projectPip, autonomyChip, renderPolicyHtml } from '../../src/ui/ProjectsPanel';
import type { ObjectiveRequirementRow, ProjectsPanelModel } from '../../src/ui/ProjectsPanel';
import { group, test, finish } from '../harness';

function req(over: Partial<ObjectiveRequirementRow> = {}): ObjectiveRequirementRow {
  return {
    key: 'buildingOnline:oxygenator',
    label: 'Oxygen generator online',
    current: 0,
    target: 1,
    unit: 'count',
    met: false,
    ...over,
  };
}

const board: ProjectsPanelModel = {
  active: [
    {
      id: 'establishSurvival',
      title: 'Establish Survival',
      blurb: 'Bring oxygen, water and food under colony control.',
      why: 'The lander’s reserves are a countdown, not a plan.',
      requirements: [
        req({ key: 'buildingOnline:oxygenator', label: 'Oxygen generator online', current: 1, target: 1, met: true }),
        req({ key: 'buildingOnline:extractor', label: 'Water extractor online', current: 0, target: 1 }),
        req({ key: 'buildingOnline:battery', label: 'Battery bank online', current: 0, target: 1 }),
        req({ key: 'powerStable', label: 'Stable power (grid covers demand)', current: 9, target: 15, unit: 'percent' }),
      ],
      met: 1,
      total: 4,
      rewards: [{ id: 'stableOperations', title: 'Stable Operations', granted: false }],
    },
  ],
  completed: [],
  unlocks: [],
  solsWithoutOrder: 0,
};

group('The card states the ask');

test('it names the project, the progress and every requirement with its numbers', () => {
  const html = renderProjectsHtml(board);
  assert.match(html, /Engineering Projects/);
  assert.match(html, /Establish Survival/, 'the project is named');
  assert.match(html, /25%/, 'one of four requirements is met');
  assert.match(html, /Bring oxygen, water and food under colony control\./, 'and what it is asking for');
  assert.match(html, /Oxygen generator online/);
  assert.match(html, /1 \/ 1<\/span>/, 'a met requirement reads 1 / 1');
  assert.match(html, /Water extractor online/);
  assert.match(html, /0 \/ 1<\/span>/, 'an unmet requirement reads 0 / 1');
  assert.match(html, /9% \/ 15%/, 'percentages read as percentages');
  assert.match(html, /Reward<\/span> Stable Operations/, 'and the reward is stated up front');
  assert.match(html, /Why<\/span> The lander/, 'with the reason a player should care');
});

test('met requirements are marked, unmet ones are not', () => {
  const html = renderProjectsHtml(board);
  const metRows = html.match(/class="proj-req met"/g) ?? [];
  const openRows = html.match(/class="proj-req"/g) ?? [];
  assert.equal(metRows.length, 1, 'exactly one requirement is ticked');
  assert.equal(openRows.length, 3, 'and three are still open');
  assert.match(html, /✓/, 'a met row carries a check');
});

group('Numbers are read in the unit the sim measured them in');

test('each unit formats the way a player reads it', () => {
  const cases: Array<[ObjectiveRequirementRow, string]> = [
    [req({ unit: 'count', current: 2, target: 3 }), '2 / 3'],
    [req({ unit: 'kg', current: 312.4, target: 300 }), '312 / 300 kg'],
    [req({ unit: 'kWh', current: 290, target: 400 }), '290 / 400 kWh'],
    [req({ unit: 'sols', current: 6.25, target: 10 }), '6.3 / 10 sols'],
    [req({ unit: 'percent', current: 19, target: 15 }), '19% / 15%'],
  ];
  for (const [row, expected] of cases) {
    assert.equal(formatRequirement(row), expected, `${row.unit} reads as ${expected}`);
  }
});

group('An empty board, a finished board');

test('a colony with nothing on the board says so rather than rendering a blank card', () => {
  const html = renderProjectsHtml({ active: [], completed: [], unlocks: [], solsWithoutOrder: 4 });
  assert.match(html, /No open project/);
  assert.equal(/proj-card/.test(html), false, 'and draws no project card');
});

test('earned unlocks and completed projects are listed with their sols', () => {
  const html = renderProjectsHtml({
    active: [],
    completed: [{ id: 'establishSurvival', title: 'Establish Survival', sol: 4 }],
    unlocks: [{ id: 'stableOperations', title: 'Stable Operations', sol: 4 }],
    solsWithoutOrder: 4,
  });
  assert.match(html, /Earned/);
  assert.match(html, /Stable Operations/);
  assert.match(html, /Completed/);
  assert.match(html, /sol 4/, 'stamped with the sol it happened on');
});

test('player-visible text is escaped, because all of it is data', () => {
  const html = renderProjectsHtml({
    active: [
      {
        ...board.active[0]!,
        title: '<script>alert(1)</script>',
        blurb: 'a & b',
        rewards: [],
      },
    ],
    completed: [],
    unlocks: [],
    solsWithoutOrder: 0,
  });
  assert.equal(/<script>/.test(html), false, 'no raw markup survives into the panel');
  assert.match(html, /&lt;script&gt;/, 'it is escaped instead');
  assert.match(html, /a &amp; b/);
});

group('The HUD pip states the situation in a glance');

test('it names the lead project with its count and the next ask', () => {
  const pip = projectPip(board)!;
  assert.ok(pip);
  assert.equal(pip.text, 'Establish Survival 1/4');
  assert.equal(pip.tone, 'progress');
  assert.match(pip.title, /next: Water extractor online \(0 \/ 1\)/);
});

test('the tone follows the situation, not a timer', () => {
  const p = board.active[0];
  const idle = projectPip({ ...board, active: [{ ...p, met: 0, requirements: p.requirements.map((r) => ({ ...r, met: false })) }] })!;
  assert.equal(idle.tone, 'idle', 'nothing done yet');
  const near = projectPip({ ...board, active: [{ ...p, met: 3 }] })!;
  assert.equal(near.tone, 'near', 'one requirement left');
  assert.equal(near.text, 'Establish Survival 3/4');
  const done = projectPip({ ...board, active: [], completed: [{ id: 'x', title: 'X', sol: 3 }] })!;
  assert.equal(done.tone, 'done');
  assert.match(done.text, /all complete/);
  assert.equal(projectPip({ ...board, active: [], completed: [] }), null, 'nothing to say on an empty board');
});

test('with two projects on the board the pip leads with the closer one and counts the rest', () => {
  const p = board.active[0];
  const other = { ...p, id: 'industrialize', title: 'Industrialize', met: 3, total: 4 };
  const pip = projectPip({ ...board, active: [p, other] })!;
  assert.equal(pip.text, 'Industrialize 3/4 +1');
  assert.equal(pip.tone, 'near');
});

group('The autonomy headline (Phase 3)');

test('it reads the streak and the identity, and its tooltip teaches the last break', () => {
  const chip = autonomyChip({
    current: 6.8,
    best: 11.2,
    rung: 'redundant',
    identity: 'engineer',
    coverage: 0.82,
    singlePoints: [],
    lastBreak: { reason: 'intervention', streak: 6.8, detail: 'ordered a rover to mine' },
  });
  assert.equal(chip.text, 'Autonomy 6.8 sols · ENGINEER');
  assert.equal(chip.identity, 'engineer');
  assert.match(chip.title, /REDUNDANT · coverage 82% · best 11\.2 sols/);
  assert.match(chip.title, /No single machine can end this colony/);
  assert.match(chip.title, /Last break: ordered a rover to mine at 6\.8 sols/);

  const broke = autonomyChip({
    current: 0.2, best: 3, rung: 'assisted', identity: 'operator', coverage: 0.4,
    singlePoints: ['water', 'oxygen'],
    lastBreak: { reason: 'life-support-critical', streak: 3, detail: 'Oxygen reserve critical' },
  });
  assert.match(broke.title, /Single points of failure: water, oxygen/);
  assert.match(broke.title, /Last break: Oxygen reserve critical after 3\.0 sols/);
});

group('The Standing Orders card (Phase 3, slice 2)');

const POLICIES = {
  unlocked: true,
  stockpile: { on: true, resource: 'iron', minKg: 400, currentKg: 252.3 },
  nightPower: { on: true, minBatteryPct: 40, shedding: 2 },
  stormShelter: { on: false },
  autoMaintain: { on: false, maxWearPct: 30, worstWearPct: 51 },
  actions: 7,
};

test('it lists the four policies with a toggle, one number each, and what each is holding', () => {
  const html = renderPolicyHtml(POLICIES);
  assert.match(html, /Standing Orders/);
  assert.match(html, /7 actions/);
  for (const id of ['stockpile', 'nightPower', 'stormShelter', 'autoMaintain']) {
    assert.match(html, new RegExp(`data-policy="${id}"`), id);
    assert.match(html, new RegExp(`data-pol-on="${id}"`), `${id} toggle`);
  }
  assert.match(html, /252 \/ 400 kg/, 'stockpile states the floor against the silo');
  assert.match(html, /<option value="iron" selected>/);
  assert.match(html, /data-pol-num="minKg"[^>]*value="400"/);
  assert.match(html, /2 shed until morning/);
  assert.match(html, /worst wear 51 %/);
  assert.match(html, /none of these end your autonomy streak/);
  assert.doesNotMatch(html, /disabled/);
});

test('locked, every control is disabled and the card says what unlocks it', () => {
  const html = renderPolicyHtml({ ...POLICIES, unlocked: false });
  assert.match(html, /pol-card locked/);
  assert.match(html, /unlock with <b>Industrialize<\/b>/);
  assert.match(html, /locked</);
  assert.equal((html.match(/ disabled/g) ?? []).length, 8, 'four toggles + four inputs');
});

await finish('ui/projects-panel');
