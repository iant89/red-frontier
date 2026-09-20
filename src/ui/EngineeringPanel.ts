/** Engineering dialog: owned host data in, player intents out. No sim writes. */
import type { SimView, RoverView, BuildingView, SimCommand } from '../sim/host';
import {
  BUILDINGS,
  ROVERS,
  RESOURCES,
  COMPONENTS,
  ALL_RESOURCES,
  ALL_COMPONENTS,
  recipesFor,
  type RoverKind,
} from '../sim/defs';
import {
  UPGRADES,
  PAINTS,
  levelOf,
  roverUpgrades,
  buildingUpgrades,
  upgradePrice,
  effectiveRoverDef,
  effectiveBuildingDef,
  upgradeMul,
  type EntityTarget,
  type UpgradeId,
} from '../sim/engineering/upgrades';
import { itemIcon } from './ItemIcons';
import { updateWaterPanel } from './WaterPanel';
export interface EngineeringCallbacks {
  close(): void;
  command(command: SimCommand): void;
  action(action: string, arg?: string): void;
  previewPaint(color: string | null): void;
  garage(): void;
}
const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export class EngineeringPanel {
  readonly root = document.createElement('div');
  readonly preview: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private signature = '';
  private tab = 'upgrades';
  private sim!: SimView;
  private draft: string | undefined;
  private previousFocus = document.activeElement as HTMLElement | null;
  constructor(
    readonly target: EntityTarget,
    private cb: EngineeringCallbacks,
  ) {
    this.root.className = 'engineering-overlay';
    this.root.innerHTML = `<section class="engineering-dialog" role="dialog" aria-modal="true" aria-labelledby="engineering-title">
      <header class="engineering-header"><div><span class="engineering-kicker">COLONY ENGINEERING / REFIT & CUSTOMIZATION</span><h2 id="engineering-title">Engineering</h2></div><button class="engineering-close" aria-label="Close engineering">×</button></header>
      <div class="engineering-layout"><div class="engineering-display"><div class="engineering-model"></div><div class="engineering-model-caption"><span>LIVE ASSET PREVIEW</span><span>360° TURNTABLE</span></div><div class="engineering-specs"></div></div>
      <div class="engineering-controls"><nav aria-label="Engineering sections">${['overview', 'upgrades', 'appearance', 'actions'].map((tab) => `<button data-tab="${tab}" aria-pressed="${tab === this.tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</nav><div class="engineering-content"></div></div></div>
      <footer><span>Ⅱ Colony paused · close to restore previous speed</span><button class="btn engineering-return">Return to colony</button></footer></section>`;
    this.preview = this.root.querySelector('.engineering-model')!;
    this.body = this.root.querySelector('.engineering-content')!;
    this.title = this.root.querySelector('h2')!;
    this.root
      .querySelector('.engineering-close')!
      .addEventListener('click', () => cb.close());
    this.root
      .querySelector('.engineering-return')!
      .addEventListener('click', () => cb.close());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) cb.close();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab!;
        this.signature = '';
        this.update(this.sim);
        this.root
          .querySelectorAll('[data-tab]')
          .forEach((t) =>
            t.setAttribute(
              'aria-pressed',
              String((t as HTMLElement).dataset.tab === this.tab),
            ),
          );
      }),
    );
    document.addEventListener('keydown', this.keydown, true);
  }
  mount(): void {
    document.body.append(this.root);
    (
      this.root.querySelector('.engineering-close') as HTMLButtonElement
    ).focus();
  }
  dispose(): void {
    document.removeEventListener('keydown', this.keydown, true);
    this.root.remove();
    this.previousFocus?.focus();
  }
  private keydown = (e: KeyboardEvent): void => {
    e.stopImmediatePropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')
      e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cb.close();
      return;
    }
    if (e.key === 'Tab') {
      const nodes = [
        ...this.root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),select,input,[tabindex="0"]',
        ),
      ].filter((n) => !n.hidden);
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (
        (e.shiftKey && index <= 0) ||
        (!e.shiftKey && index === nodes.length - 1)
      ) {
        e.preventDefault();
        nodes[e.shiftKey ? nodes.length - 1 : 0]?.focus();
      }
    }
  };
  update(sim: SimView): void {
    this.sim = sim;
    const entity =
      this.target.entity === 'rover'
        ? sim.roverById(this.target.id)
        : sim.buildingById(this.target.id);
    if (!entity) {
      this.cb.close();
      return;
    }
    const signature = JSON.stringify([
      entity,
      sim.storage,
      sim.components,
      sim.waterNetwork,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const rover = this.target.entity === 'rover';
    const name = rover
      ? ROVERS[(entity as RoverView).kind].label
      : BUILDINGS[(entity as BuildingView).kind].label;
    this.title.textContent = `${name} · #${entity.id}`;
    this.root.querySelector('.engineering-specs')!.innerHTML =
      this.stats(entity);
    if (this.tab === 'appearance') this.appearance(entity);
    else if (this.tab === 'upgrades') this.upgrades(entity);
    else if (this.tab === 'actions') this.actions(entity);
    else
      this.body.innerHTML = `<h3>${esc(name)}</h3><p>${esc(rover ? ROVERS[(entity as RoverView).kind].role : BUILDINGS[(entity as BuildingView).kind].description)}</p><div class="engineering-note">Permanent upgrades are separate from wear, repairs and developer levels. Each system supports three upgrade tiers. Parts are manufactured at the Workshop.</div><h3>Installation</h3><p>${rover ? 'Park and stop beside an enabled Garage. Its powered bay fits one rover at a time; assembly and refits share the bay.' : 'A construction rover travels to this structure and performs the refit on site. Keep the structure enabled and powered if it needs electricity.'}</p><p>Materials are paid when you queue a refit. Departures and power loss pause installation. Cancel to recover materials up to available storage capacity.</p>`;
  }
  private stats(e: RoverView | BuildingView): string {
    const rows: Array<[string, string]> =
      this.target.entity === 'rover'
        ? (() => {
            const r = e as RoverView,
              d = effectiveRoverDef(r);
            return [
              ['Speed', `${d.cruiseSpeed.toFixed(1)} m/s`],
              [
                'Battery',
                `${r.battery.toFixed(1)} / ${d.maxBatteryKWh.toFixed(0)} kWh`,
              ],
              [
                'Cargo',
                `${Object.values(r.cargo)
                  .reduce((a, b) => a + b, 0)
                  .toFixed(0)} / ${d.capacityKg.toFixed(0)} kg`,
              ],
              ['Condition', `${r.condition.toFixed(0)}%`],
            ] as Array<[string, string]>;
          })()
        : (() => {
            const b = e as BuildingView,
              d = effectiveBuildingDef(b);
            return [
              ['Structure', `${b.health.toFixed(0)}%`],
              [
                'Status',
                b.state === 'online'
                  ? b.enabled
                    ? 'Online'
                    : 'Switched off'
                  : 'Under construction',
              ],
              ['Power', `${b.loadKw.toFixed(1)} kW`],
              ['Rated output', `${d.powerProduceKw.toFixed(1)} kW`],
            ] as Array<[string, string]>;
          })();
    return rows
      .map(
        ([label, value]) =>
          `<div><span>${label}</span><strong>${value}</strong></div>`,
      )
      .join('');
  }
  private costs(
    solids: Partial<Record<keyof SimView['storage'], number>>,
    parts: Partial<Record<keyof SimView['components'], number>>,
  ): string {
    return `<div class="engineering-costs">${ALL_RESOURCES.filter(
      (k) => (solids[k] ?? 0) > 0,
    )
      .map(
        (k) =>
          `<div class="engineering-cost ${(solids[k] ?? 0) > this.sim.storage[k] ? 'shortage' : ''}">${itemIcon(k)}<span><strong>${solids[k]} kg</strong><small>${RESOURCES[k].label}</small><small>${this.sim.storage[k].toFixed(0)} available</small></span></div>`,
      )
      .join('')}${ALL_COMPONENTS.filter((k) => (parts[k] ?? 0) > 0)
      .map(
        (k) =>
          `<div class="engineering-cost ${(parts[k] ?? 0) > this.sim.components[k] ? 'shortage' : ''}">${itemIcon(k)}<span><strong>${parts[k]} ×</strong><small>${COMPONENTS[k].label}</small><small>${this.sim.components[k]} available</small></span></div>`,
      )
      .join('')}</div>`;
  }
  private metric(e: RoverView | BuildingView, id: UpgradeId): string {
    if (this.target.entity === 'rover') {
      const d = effectiveRoverDef(e as RoverView);
      return id === 'drivetrain'
        ? `${d.cruiseSpeed.toFixed(1)} m/s`
        : id === 'battery'
          ? `${d.maxBatteryKWh.toFixed(0)} kWh`
          : id === 'cargo'
            ? `${d.capacityKg.toFixed(0)} kg`
            : `${d.mineSpeedMul.toFixed(2)}× mining`;
    }
    const b = e as BuildingView,
      d = effectiveBuildingDef(b);
    if (id === 'generation') return `${d.powerProduceKw.toFixed(1)} kW`;
    if (id === 'efficiency') return `${d.powerDrawKw.toFixed(1)} kW`;
    if (id === 'pump') return `${(6 * upgradeMul(b, 'pump')).toFixed(1)} kg/h`;
    if (id === 'radar') return `${d.weatherRadarRangeKm?.toFixed(0)} km`;
    if (id === 'storage')
      return d.batteryKWh
        ? `${d.batteryKWh.toFixed(0)} kWh`
        : d.storagePerResourceKg
          ? `${d.storagePerResourceKg.toFixed(0)} kg / resource`
          : d.componentSlots
            ? `${Math.floor(d.componentSlots)} slots / part`
            : `${Object.values(d.fluidCapacity ?? {})
                .reduce((a, b) => a + b, 0)
                .toFixed(0)} kg tanks`;
    return `${upgradeMul(b, id).toFixed(2)}× ${id === 'service' ? 'service' : 'production'}`;
  }
  private upgrades(e: RoverView | BuildingView): void {
    const rover = this.target.entity === 'rover',
      choices = rover
        ? roverUpgrades((e as RoverView).kind)
        : buildingUpgrades((e as BuildingView).kind);
    const job = e.upgradeJob;
    const r = e as RoverView;
    const garage = rover
      ? this.sim.buildings.find(
          (b) =>
            b.kind === 'garage' &&
            b.state === 'online' &&
            b.enabled &&
            !b.damaged &&
            Math.hypot(b.x - r.x, b.z - r.z) <= BUILDINGS.garage.radius + 5,
        )
      : null;
    const ready = rover
      ? !!garage &&
        ['idle', 'wait'].includes(r.command.type) &&
        !r.pending.length &&
        r.phase !== 'disabled' &&
        !garage.assembly &&
        !this.sim.rovers.some(
          (other) => other.upgradeJob?.facilityId === garage.id,
        )
      : (e as BuildingView).state === 'online' && !(e as BuildingView).damaged;
    const status = job
      ? `${UPGRADES[job.upgrade].label} tier ${job.tier} · ${(job.progress * 100).toFixed(0)}% installed. ${rover ? 'Resume beside the reserved, powered Garage.' : 'Resume to dispatch an on-site construction rover.'}`
      : ready
        ? 'Installation ready. Materials are spent once when queued.'
        : rover
          ? 'Park and stop beside a free Garage. Assembly and refits share its bay.'
          : 'Complete and repair the structure first.';
    this.body.innerHTML =
      `<div class="engineering-note ${ready ? '' : 'attention'}">${status}${job ? '<button class="btn" data-cancel>Cancel refit & recover materials</button>' : rover && !ready ? '<button class="btn" data-garage>Drive to nearest Garage</button>' : ''}</div>` +
      choices
        .map((id) => {
          const def = UPGRADES[id],
            level = levelOf(e, id),
            tier = level + 1,
            max = level >= 3,
            cost = upgradePrice(id, Math.min(tier, 3));
          const enough =
            ALL_RESOURCES.every((k) => this.sim.storage[k] >= cost.solids[k]) &&
            ALL_COMPONENTS.every(
              (k) => this.sim.components[k] >= cost.parts[k],
            );
          const next = { ...e, upgrades: { ...e.upgrades, [id]: tier } };
          return `<article class="engineering-upgrade" data-upgrade-card="${id}"><div class="engineering-upgrade-title"><h3>${def.label}</h3><span>${max ? 'MAXIMUM' : `TIER ${level} → ${tier}`}</span></div><div class="engineering-improvement">${this.metric(e, id)}${max ? '' : ` <span>→</span> <strong>${this.metric(next, id)}</strong>`}</div><p>${def.description}</p>${max ? '' : this.costs(cost.solids, cost.parts)}<div class="engineering-upgrade-footer"><span>${max ? 'Fully upgraded' : `${cost.seconds} s at full work rate`}</span><button class="btn" data-upgrade="${id}" ${max || !ready || !!job || !enough ? 'disabled' : ''}>${max ? 'Fully upgraded' : !enough ? 'Missing materials' : 'Queue installation'}</button></div></article>`;
        })
        .join('');
    this.body
      .querySelectorAll<HTMLButtonElement>('[data-upgrade]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          this.cb.command({
            type: 'engineering/upgrade',
            ...this.target,
            upgrade: b.dataset.upgrade as UpgradeId,
          });
        }),
      );
    this.body
      .querySelector('[data-cancel]')
      ?.addEventListener('click', () =>
        this.cb.command({ type: 'engineering/cancel', ...this.target }),
      );
    this.body
      .querySelector('[data-garage]')
      ?.addEventListener('click', () => this.cb.garage());
  }
  private appearance(e: RoverView | BuildingView): void {
    const chosen = this.draft ?? e.paint ?? '';
    this.body.innerHTML = `<h3>Exterior finish</h3><p>Preview a finish on the model. Paint is cosmetic and free; it does not restore damaged parts.</p><div class="engineering-swatches">${['', ...PAINTS].map((c, i) => `<button data-paint="${c}" class="${c === chosen ? 'selected' : ''}" aria-label="${i ? 'Paint ' + c : 'Factory finish'}" aria-pressed="${c === chosen}" style="--paint:${c || '#aaa'}">${i ? '' : '↺'}</button>`).join('')}</div><button class="btn engineering-apply" ${chosen === (e.paint ?? '') ? 'disabled' : ''}>${chosen === (e.paint ?? '') ? 'Current finish' : 'Apply finish'}</button><p class="engineering-note">Your finish appears on the colony model and persists in saves. Mechanical details and glass retain their original materials.</p>`;
    this.body.querySelectorAll<HTMLButtonElement>('[data-paint]').forEach((b) =>
      b.addEventListener('click', () => {
        this.draft = b.dataset.paint!;
        this.cb.previewPaint(this.draft || null);
        this.appearance(e);
      }),
    );
    this.body
      .querySelector('.engineering-apply')!
      .addEventListener('click', () =>
        this.cb.command({
          type: 'engineering/paint',
          ...this.target,
          paint: this.draft ?? e.paint ?? '',
        }),
      );
  }
  private actions(e: RoverView | BuildingView): void {
    const rover = this.target.entity === 'rover';
    this.body.innerHTML = `<h3>Operations</h3><div class="engineering-action-grid">${(rover
      ? [
          ['stop', '■ Stop'],
          ['unload', '⇩ Unload cargo'],
          ['wait', '◷ Wait 1 minute'],
        ]
      : [
          [
            'toggle',
            (e as BuildingView).enabled ? '⏻ Switch off' : '⏻ Switch on',
          ],
          ['service', '⚒ Dispatch maintenance'],
          ['demolish', '× Dismantle'],
        ]
    )
      .map(
        ([a, label]) =>
          `<button class="btn" data-operation="${a}">${label}</button>`,
      )
      .join(
        '',
      )}</div><div class="engineering-recipes"></div><div class="engineering-water"></div>`;
    this.body
      .querySelectorAll<HTMLButtonElement>('[data-operation]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const action = b.dataset.operation!;
          if (
            action === 'demolish' &&
            !window.confirm(
              'Dismantle this building? Stored local water and unfinished refits will be lost.',
            )
          )
            return;
          this.cb.action(action, action === 'wait' ? '60' : undefined);
        }),
      );
    if (rover) return;
    const b = e as BuildingView,
      recipes = recipesFor(b.kind),
      wrap = this.body.querySelector('.engineering-recipes')!;
    if (recipes.length) {
      wrap.innerHTML =
        '<h3>Manufacturing / production line</h3>' +
        recipes
          .map(
            (recipe, i) =>
              `<button class="engineering-recipe ${b.recipe === i ? 'selected' : ''}" data-recipe="${i}"><strong>${recipe.label}</strong><span>${recipe.process.summary}</span>${Object.keys(
                recipe.process.solidIn ?? {},
              )
                .map((k) => itemIcon(k as keyof SimView['storage']))
                .join('')}${Object.keys(recipe.process.componentOut ?? {})
                .map((k) => itemIcon(k as keyof SimView['components']))
                .join('')}</button>`,
          )
          .join('');
      wrap
        .querySelectorAll<HTMLButtonElement>('[data-recipe]')
        .forEach((btn) =>
          btn.addEventListener('click', () =>
            this.cb.command({
              type: 'building/recipe',
              buildingId: b.id,
              recipe: Number(btn.dataset.recipe),
            }),
          ),
        );
    }
    if (b.kind === 'garage') {
      wrap.innerHTML =
        '<h3>Rover assembly</h3>' +
        (Object.keys(ROVERS) as RoverKind[])
          .map(
            (k) =>
              `<article class="engineering-upgrade"><h3>${ROVERS[k].label}</h3>${this.costs(ROVERS[k].cost, ROVERS[k].componentCost)}<button class="btn" data-assemble="${k}" ${b.assembly || b.state !== 'online' || !b.enabled || b.damaged || this.sim.rovers.some((r) => r.upgradeJob?.facilityId === b.id) || !ALL_RESOURCES.every((res) => this.sim.storage[res] >= ROVERS[k].cost[res]) || !ALL_COMPONENTS.every((c) => this.sim.components[c] >= ROVERS[k].componentCost[c]) ? 'disabled' : ''}>Assemble · ${ROVERS[k].buildTime} s</button></article>`,
          )
          .join('');
      wrap
        .querySelectorAll<HTMLButtonElement>('[data-assemble]')
        .forEach((btn) =>
          btn.addEventListener('click', () =>
            this.cb.command({
              type: 'building/assemble',
              buildingId: b.id,
              kind: btn.dataset.assemble as RoverKind,
            }),
          ),
        );
    }
    updateWaterPanel(
      this.body.querySelector('.engineering-water')!,
      b.id,
      this.sim,
      (a, arg) => this.cb.action(a, arg),
    );
  }
}
