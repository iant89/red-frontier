/** Shared, dependency-free item pictograms. Shapes, labels and quantities—not colour alone. */
import {
  COMPONENTS,
  RESOURCES,
  type ComponentId,
  type ResourceId,
} from '../sim/defs';
export type ItemId = ComponentId | ResourceId;
const shapes: Record<ItemId, string> = {
  regolith:
    '<path d="m4 23 5-10 8-5 10 8 1 9H4Z"/><path d="m9 13 7 4 11-1M16 17l-3 8M17 8l-1 9"/>',
  iron: '<path d="m4 23 3-12 10-6 10 9-2 13H9Z"/><path d="m7 11 10 5 10-2M17 5v11l8 11M17 16 9 27"/><circle cx="10" cy="19" r="2"/>',
  aluminum:
    '<path d="m4 24 2-12 11-7 11 9-3 12H4Z"/><path d="m6 12 10 5 12-3M17 5l-1 12-12 7M16 17l9 9"/><path d="m12 10 4 2m4 7 3-1"/>',
  silicon:
    '<path d="m16 3 7 8-2 15-7 3-6-8 2-14Z"/><path d="m16 3-1 14-1 12m1-12 8-6M8 21l7-4"/><path d="m23 16 5 3-1 8-6-1"/>',
  ice: '<path d="m16 3 10 6 3 12-12 8L4 22l2-13Z"/><path d="M16 3v12L6 9m10 6 13 6m-13-6 1 14M4 22l12-7"/>',
  steel:
    '<path d="m4 11 7-5 17 2v6l-5 3v5l5 1v5L4 25v-5l5-2v-4l-5 2Z"/><path d="m4 11 19 2 5-5M9 14l14 3M9 18l14 4M4 20l19 3 5 0"/>',
  motor:
    '<rect x="7" y="8" width="18" height="17" rx="4"/><path d="M3 14h4m18 2h5M10 25v3h13v-3M12 8V5h7v3m-7 4v9m5-9v9m5-9v9"/>',
  circuitBoard:
    '<rect x="5" y="5" width="23" height="23" rx="2"/><rect x="12" y="11" width="10" height="11" rx="1"/><path d="M2 10h3m-3 6h3m-3 6h3M15 5v6m5-6v6m-5 11v6m5-6v6M5 15h7m10 1h6"/>',
  pipe: '<path d="M4 6h8v12h15v8H10a6 6 0 0 1-6-6Z"/><path d="M2 6h12M2 10h12m9 6v12m4-12v12"/>',
  batteryPack:
    '<rect x="6" y="7" width="21" height="21" rx="3"/><path d="M10 7V4h4v3m7 0V4h3v3m-7 4-5 9h5l-1 5 6-9h-5Z"/>',
  cargoFrame:
    '<path d="M5 9 16 4l12 5v16l-12 5-11-5Z"/><path d="m5 9 11 5 12-5M16 14v16M5 25l11-21 12 21M5 9l11 21L28 9"/>',
  drillTeeth:
    '<path d="m3 9 6-4 6 4-3 10-3 8-3-8Zm14 0 6-4 6 4-3 10-3 8-3-8Z"/><path d="M3 9h12m2 0h12M6 19h6m8 0h6"/>',
};
export function itemIcon(id: ItemId): string {
  const info =
    id in RESOURCES
      ? RESOURCES[id as ResourceId]
      : COMPONENTS[id as ComponentId];
  return `<svg class="item-icon" role="img" aria-label="${info.label}" viewBox="0 0 32 32" style="--item-color:#${info.color.toString(16).padStart(6, '0')}" xmlns="http://www.w3.org/2000/svg"><g fill="var(--item-color)" fill-opacity=".22" stroke="var(--item-color)" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${shapes[id]}</g></svg>`;
}
