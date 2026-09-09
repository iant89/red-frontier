/**
 * What the wizard tells the commander about each landing zone.
 *
 * The geography is real (MOLA regions the terrain sampler understands); the
 * traits translate each biome's geology — crater density, rockiness, dust —
 * into the building, driving and power advice that actually matters on Sol 1.
 */

import type { MarsBiome } from '../sim/marsGlobe';

export interface RegionBrief {
  name: string;
  biome: MarsBiome;
  description: string;
  traits: string[];
}

export const BIOME_LABELS: Record<MarsBiome, string> = {
  plains: 'Plains',
  highlands: 'Highlands',
  basin: 'Basin Floor',
  volcanic: 'Volcanic',
  canyon: 'Canyon Rim',
  crater: 'Impact Crater',
};

/** Transparent marker tint per biome on the mission globe. */
export const BIOME_COLORS: Record<MarsBiome, string> = {
  plains: '#6fd3ff',
  highlands: '#ffc46b',
  basin: '#4ae0b0',
  volcanic: '#ff6a3d',
  canyon: '#ff9a5c',
  crater: '#c99aff',
};

const PLAINS_BUILD = 'Flat, forgiving ground — construction sites go down fast.';
const DUSTY = 'Deep dust: arrays bury quickly, so plan cleaning runs early.';
const ROCKY_DRIVE = 'Broken, rocky ground — expect longer rover detours.';
const CRATER_RICH = 'Old cratered crust with rich, varied deposits nearby.';
const BASIN_CALM = 'Sheltered basin floor with gentle slopes and easy driving.';

export const REGION_BRIEFS: RegionBrief[] = [
  {
    name: 'Amazonis Planitia',
    biome: 'plains',
    description:
      'Vast young lava plains west of Olympus Mons — some of the smoothest ground on Mars. Few craters, endless dust, and unbroken horizons in every direction.',
    traits: [PLAINS_BUILD, DUSTY, 'Sparse craters mean fewer exposed ore faces.'],
  },
  {
    name: 'Chryse Planitia',
    biome: 'plains',
    description:
      'The "Golden Plains" where ancient outflow channels spilled into the northern lowlands. Viking 1 landed here in 1976 on a rock-strewn floodplain.',
    traits: [PLAINS_BUILD, 'Flood-scoured gravels — solid building footings.', DUSTY],
  },
  {
    name: 'Acidalia Planitia',
    biome: 'plains',
    description:
      'Far-northern plains between the cratered highlands and the polar cap. Mark Watney drove across it in fiction; in reality it is flat, cold dust.',
    traits: [PLAINS_BUILD, 'High latitude — weaker winter sun for solar.', DUSTY],
  },
  {
    name: 'Utopia Planitia',
    biome: 'plains',
    description:
      'The largest recognised impact basin on Mars, buried under smooth plains. Viking 2 and the Zhurong rover both touched down in this 3,300 km bowl.',
    traits: [BASIN_CALM, 'Ancient basin fill hides abundant buried ice.', DUSTY],
  },
  {
    name: 'Elysium Planitia',
    biome: 'plains',
    description:
      'Young volcanic plains east of the Elysium rise, home of NASA\'s InSight lander. Some of the flattest, youngest lava flows on the planet.',
    traits: [PLAINS_BUILD, 'Fresh lava flows — excellent iron and silicon.', 'Low dust devils, steady winds.'],
  },
  {
    name: 'Isidis Planitia',
    biome: 'basin',
    description:
      'A 1,500 km impact basin older than Olympus Mons, ringed by mountains. Its floor is a dust sea; its rim exposes some of the oldest rock on Mars.',
    traits: [BASIN_CALM, 'Basin dust runs deep — panels need frequent care.', 'Rim outcrops repay prospecting rovers.'],
  },
  {
    name: 'Meridiani Planum',
    biome: 'plains',
    description:
      'The hematite plains where Opportunity found its "blueberries" — proof of ancient standing water. Flat, dark, and littered with iron-rich spherules.',
    traits: [PLAINS_BUILD, 'Hematite-rich ground — iron never far away.', DUSTY],
  },
  {
    name: 'Arabia Terra',
    biome: 'highlands',
    description:
      'Densely cratered Noachian highlands between the lowlands and the canyons. Four billion years of impacts have gardened every mineral to the surface.',
    traits: [CRATER_RICH, ROCKY_DRIVE, 'Rugged relief complicates large layouts.'],
  },
  {
    name: 'Noachis Terra',
    biome: 'highlands',
    description:
      'The type region of the Noachian age — the oldest, most battered crust on Mars. Crater overlaps crater here, and dust storms are born next door.',
    traits: [CRATER_RICH, 'Storms spin up fast in the southern spring.', ROCKY_DRIVE],
  },
  {
    name: 'Terra Cimmeria',
    biome: 'highlands',
    description:
      'Magnetic southern highlands with some of the strongest crustal magnetism on Mars. Rugged, ancient, and far from easy rescue.',
    traits: [CRATER_RICH, ROCKY_DRIVE, 'Remote latitude — long, dark winters.'],
  },
  {
    name: 'Terra Sirenum',
    biome: 'highlands',
    description:
      'Highland terrain south of the Tharsis bulge, grooved by ancient faults and seasonal dark streaks. Beautiful, broken, and mineral-rich.',
    traits: [CRATER_RICH, 'Fault valleys channel fierce seasonal winds.', ROCKY_DRIVE],
  },
  {
    name: 'Hellas Planitia',
    biome: 'basin',
    description:
      'The deepest hole on Mars — a 2,300 km impact basin 7 km below the datum. Air pressure here is double the global average; dust storms well up from within.',
    traits: [BASIN_CALM, 'Thicker air softens entry but feeds storms.', 'Some of the dustiest skies on Mars.'],
  },
  {
    name: 'Syrtis Major',
    biome: 'volcanic',
    description:
      'A dark basaltic shield volcano once mistaken for a Martian sea. Fresh lava flows, high ground, and the planet\'s most dramatic sunrises.',
    traits: [
      'Basalt flows — premium silicon and aluminum.',
      'Exposed high ground takes the full wind.',
      'Thin dust: arrays stay cleaner, longer.',
    ],
  },
  {
    name: 'Lunae Planum',
    biome: 'plains',
    description:
      'Ridged volcanic plains between the Tharsis volcanoes and the Chryse outflow channels. Wrinkle ridges march for hundreds of kilometres.',
    traits: [PLAINS_BUILD, 'Wrinkle ridges make natural windbreaks.', DUSTY],
  },
  {
    name: 'Gale crater',
    biome: 'crater',
    description:
      'A 154 km crater holding Mount Sharp, a 5 km mound of layered sediment. Curiosity has climbed it since 2012, reading Mars\' watery history layer by layer.',
    traits: [
      'Layered mound exposes every resource in one climb.',
      'Crater walls shelter the floor from the worst wind.',
      'Slopes steepen toward the central peak.',
    ],
  },
  {
    name: 'Jezero crater',
    biome: 'crater',
    description:
      'An ancient river delta preserved in a 45 km crater — Perseverance\'s hunting ground for signs of past life. Clays, carbonates, and shoreline gravels.',
    traits: [
      'Delta clays and carbonates — superb water ice odds.',
      'Compact floor keeps hauls short.',
      'Rocky shoreline terrain slows heavy rovers.',
    ],
  },
  {
    name: 'Gusev crater',
    biome: 'crater',
    description:
      'A 166 km crater where the Spirit rover found silica-rich soils and carbonate outcrops. Ma\'adim Vallis, one of Mars\' largest channels, drains into it.',
    traits: [
      'Channel deposits concentrate ice and regolith.',
      'Wide flat floor — easy driving, easy building.',
      'Distant rim limits the far prospecting range.',
    ],
  },
  {
    name: 'Oxia Planum',
    biome: 'plains',
    description:
      'Clay-rich plains chosen for the Rosalind Franklin rover. Among the most water-altered — and smoothest — landing ellipses ever certified.',
    traits: [PLAINS_BUILD, 'Clay minerals hint at shallow ground ice.', 'Certified smooth: the gentle landing.'],
  },
];

export function briefFor(regionName: string): RegionBrief | null {
  return REGION_BRIEFS.find((b) => b.name === regionName) ?? null;
}
