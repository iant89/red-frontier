/**
 * @suite ui/projects-panel
 * @group unit
 * @covers src/ui/ProjectsPanel.ts
 * @desc Phase 2: the projects card states the ask, the numbers and the reward.
 * Rendered as a pure string so the copy can be pinned without a DOM — the panel
 * class is a thin shell over {@link renderProjectsHtml}.
 */

import assert from 'node:assert/strict';
import { renderProjectsHtml, formatRequirement } from '../../src/ui/ProjectsPanel';
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

await finish('ui/projects-panel');
