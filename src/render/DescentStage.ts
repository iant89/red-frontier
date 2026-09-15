/**
 * The descent stage that put the colony on the ground.
 *
 * The sim has always known it is there — the landing pod is a shelter, a
 * charger, a 14 kW RTG and an obstacle rovers crawl around (`POD_RADIUS` in
 * `sim/config.ts`) — but nothing ever drew it. This module is that missing
 * body: a tall propulsive-landing stage standing on three splayed legs in the
 * middle of the pad, its windward flank still carrying the reentry burn.
 *
 * It is **presentation only**. It never writes sim state, is not pickable
 * (clicks fall through to the terrain, exactly as they did before), and adds
 * nothing to a save. Everything that has to stay in step with the simulation —
 * the exclusion radius, the pod's stores, the RTG — keeps living in the sim.
 *
 * Scale note: the hull is deliberately slimmer than the sim's 8 m pod radius.
 * The legs need room to splay inside the buildable ring without standing where
 * a habitat is legally allowed to go (`rules.ts`: centre ≥ def.radius +
 * POD_RADIUS + 1.5), so the visual footprint stops at ~10 m while the sim's
 * footprint stays at 8 m.
 */
import * as THREE from 'three';

// ------------------------------------------------------------------ scale ----

/** Stage dimensions, metres. Everything else is derived from these. */
export const STAGE = {
  /** Tank diameter. Slimmer than POD_RADIUS on purpose — see the header. */
  hullRadius: 6.6,
  /** Straight tank section, from the engine deck up to the forward dome. */
  hullHeight: 37,
  /** Engine deck clearance: how high the tank bottom sits over the pad. */
  deckHeight: 11.5,
  /** Ogive above the tank. */
  noseHeight: 5,
  /** Aperture the nose closes down to. */
  noseTopRadius: 2.0,
  /** Flared skirt below the tank carrying the engines. */
  skirtHeight: 2.5,
  /** Landing-leg hinge height and how far the feet stand off the centreline. */
  hipHeight: 13.5,
  legReach: 9.2,
  /** Azimuths of the three legs, degrees, measured from +Z toward +X. Chosen
   * so no foot lands on a starting rover: Simulation.ts parks them at (9, 0)
   * and (−9, 4), i.e. 90° and 294°, and 0/120/240 keeps ≥4.7 m off both. */
  legAzimuthsDeg: [0, 120, 240],
} as const;

/** Overall standing height of the stage, ground to nav beacon. */
export const STAGE_HEIGHT =
  STAGE.deckHeight + STAGE.hullHeight + STAGE.noseHeight + STAGE.hullRadius * 0.24 + 0.8;

/**
 * Where the reentry burn lives on the hull, in normalised height (0 = the
 * engine deck, 1 = the top of the tank section). These numbers are the single
 * source of truth: `burnProfile` below and the GLSL in `BURN_MATH` are both
 * generated from them, so the tested curve and the painted one cannot drift.
 */
export const BURN = {
  /** Soot climbs to here; above it the tank is still bright metal. */
  sootTop: 0.78,
  /** Soot opacity at the deck. Full char at the bottom, feathered upward. */
  sootPeak: 0.95,
  /** Char falloff exponent — lower reads as a longer plume scrub. */
  sootExp: 1.15,
  /** Residual heat only reaches this far up. */
  glowTop: 0.5,
  /** Heat falloff exponent. */
  glowExp: 1.7,
  /** Emission gain: residual heat has to read against a black sky. */
  glowGain: 2.6,
  /** Streak floor and gain: how much char lives between the hot lanes. */
  streakFloor: 0.45,
  streakGain: 0.95,
  /** Leeward flank still catches a third of the scrub. */
  sideMin: 0.34,
  /** How sharply the streaks are pulled into the windward band. */
  windFocus: 2.1,
  /** Centres of the two hottest sectors, degrees of hull azimuth. */
  hotSectorsDeg: [305, 22],
  /** Angular half-width of each hot sector, degrees. */
  hotWidthDeg: 38,
} as const;

// --------------------------------------------------------------- pure math ----

const D2R = Math.PI / 180;
/** Clamp that also swallows NaN — every one of these feeds a shader uniform. */
const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** Foot position of one leg: `splayDeg` off vertical, `reach` off the axis. */
export function legFoot(azimuthDeg: number, reach: number): { x: number; z: number } {
  const a = azimuthDeg * D2R;
  return { x: Math.sin(a) * reach, z: Math.cos(a) * reach };
}

/**
 * A strut hangs off vertical by `asin(reach / length)` — the whole tripod
 * stance in one number. Returns π/2 for a degenerate (zero-length) strut
 * rather than NaN, so a caller can never propagate a broken rotation.
 */
export function legSplayRad(reach: number, drop: number): number {
  const len = Math.hypot(reach, drop);
  if (!(len > 1e-6)) return Math.PI / 2;
  return Math.asin(Math.min(1, reach / len));
}

/**
 * Vertical profile of the burn at a normalised hull height.
 *
 * Two terms share one curve: `soot` is the char (opaque, dark, permanent —
 * this is what the hull looks like in daylight) and `glow` is the heat still
 * in the metal (shorter-ranged, and the only part that flickers). The soot
 * deliberately out-runs the glow: a cooled stage stays blackened long after it
 * stops shining.
 */
export function burnProfile(hNorm: number): { soot: number; glow: number } {
  const h = clamp01(hNorm);
  const soot = BURN.sootPeak * Math.pow(1 - h / BURN.sootTop, BURN.sootExp);
  const glow = Math.pow(1 - h / BURN.glowTop, BURN.glowExp);
  return {
    soot: h >= BURN.sootTop ? 0 : soot,
    glow: h >= BURN.glowTop ? 0 : glow,
  };
}

/**
 * Residual-heat flicker. Two incommensurate sines plus a third at their sum
 * frequency, so the beat never quite repeats — a cooling slab of metal does
 * not pulse like a lamp. Bounded 0..1 by construction.
 */
export function emberFlicker(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const s =
    0.5 +
    0.28 * Math.sin(t * 0.9) +
    0.15 * Math.sin(t * 2.37 + 1.1) +
    0.07 * Math.sin(t * 4.13 + 2.7);
  return Math.min(1, Math.max(0, s));
}

/**
 * How hard the ember lights under the hull read at a given moment. `daylight`
 * is the renderer's 0..1 sun term: in full sun the residual heat is a colour,
 * not a light source, so it barely lifts the scene at all.
 */
export function emberLightIntensity(ember: number, daylight: number): number {
  return 4.2 * clamp01(ember) * (0.12 + 0.88 * (1 - clamp01(daylight)));
}

// ------------------------------------------------------------- reentry burn ----

const BURN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The burn pattern itself, shared by both passes so the char and the heat can
 * never disagree about where the plasma went. `uv.y` is height along the hull
 * and `uv.x` runs around it, so the streaks are vertical by construction —
 * which is what a hypersonic boundary layer leaves behind.
 */
const BURN_MATH = /* glsl */ `
uniform float uEmber;
uniform float uDay;
uniform float uSootPeak;
uniform float uSootTop;
uniform float uGlowTop;
uniform float uWindFocus;
uniform vec2 uHot;
uniform float uHotWidth;
varying vec2 vUv;

float hash1(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

/** soot = the permanent char, glow = the heat still in the metal. */
vec2 burnAmounts() {
  float h = vUv.y;
  float a = vUv.x * 6.28318530718;

  // Char: deepest at the deck, feathering out before the tank ends.
  float soot = uSootPeak * pow(max(0.0, 1.0 - h / uSootTop), ${BURN.sootExp.toFixed(2)});

  // Streaks dragged up the flank at three wavelengths so they do not read as
  // a regular comb, each lane offset by its own hash so they break up sideways.
  float lane = floor(vUv.x * 18.0);
  float drag = hash1(lane) * 6.2831;
  float streak =
      0.50 * pow(0.5 + 0.5 * sin(a * 7.0 + drag), 6.0)
    + 0.30 * pow(0.5 + 0.5 * sin(a * 13.0 - drag * 1.7 + 0.9), 5.0)
    + 0.20 * pow(0.5 + 0.5 * sin(a * 23.0 + drag * 0.6 + 2.1), 4.0);

  // Plume scrub: the windward flank took the heating, the leeward side is
  // merely dirty. Two hot sectors, wrapped and clamped to stay inside 0..1.
  float wind = 0.5 + 0.5 * cos(a - uHot.x);
  float wind2 = 0.5 + 0.5 * cos(a - uHot.y);
  float sector = max(smoothstep(uHotWidth, 1.0, wind), smoothstep(uHotWidth, 1.0, wind2));
  float side = mix(${BURN.sideMin.toFixed(2)}, 1.0, pow(sector, uWindFocus));

  float sootAmt = clamp(soot * (${BURN.streakFloor.toFixed(2)} + ${BURN.streakGain.toFixed(2)} * streak) * side, 0.0, 1.0);
  // Residual heat is a night feature: in full sun the same metal reads as
  // char, not fire, so the emission yields to the daylight term.
  float glowAmt = ${BURN.glowGain.toFixed(2)} * pow(max(0.0, 1.0 - h / uGlowTop), ${BURN.glowExp.toFixed(2)})
      * side * (0.34 + 0.78 * streak) * uEmber
      * (0.1 + 0.9 * (1.0 - uDay));
  return vec2(sootAmt, glowAmt);
}
`;

/**
 * Pass 1 — the char. Normal alpha blending: a veil of soot over the bright
 * tank, which is the only way an overlay can *darken* what is behind it. An
 * additive pass could never do this, which is exactly why the burn needs two.
 */
const CHAR_FRAG = /* glsl */ `
${BURN_MATH}
void main() {
  float sootAmt = burnAmounts().x;
  if (sootAmt < 0.004) discard;
  gl_FragColor = vec4(vec3(0.055, 0.038, 0.031), sootAmt);
}
`;

/**
 * Pass 2 — the residual heat. Additive emission on top of the char: deep red
 * where the metal has cooled toward black, orange in the streaks that are
 * still letting go of the reentry.
 *
 * Additive blending in three multiplies the source rgb **by the source alpha**
 * (SrcAlpha, One), so the intensity has to ride in alpha and the colour in rgb
 * — an rgb-only payload with alpha 0 adds precisely nothing, which is the
 * quietest way a shader can fail.
 */
const GLOW_FRAG = /* glsl */ `
${BURN_MATH}
void main() {
  float glowAmt = burnAmounts().y;
  if (glowAmt < 0.004) discard;
  vec3 cool = vec3(0.55, 0.08, 0.02);
  vec3 hot = vec3(1.0, 0.42, 0.1);
  vec3 heatColor = mix(cool, hot, clamp(glowAmt * 1.5, 0.0, 1.0));
  gl_FragColor = vec4(heatColor, glowAmt);
}
`;

// ------------------------------------------------------------------ build ----

/**
 * The landed descent stage: hull, ogive, engine deck, three deployed legs and
 * the burn still standing on its flank. Add it to the scene at the pad, then
 * call `sync()` once a frame with sim time.
 */
export class DescentStage {
  /** Root node — position this at (SPAWN_X, ground, SPAWN_Z). */
  readonly group = new THREE.Group();

  private readonly burnUniforms: Record<string, THREE.IUniform>;
  private readonly burnMat: THREE.ShaderMaterial;
  private readonly charMat: THREE.ShaderMaterial;
  private readonly padHeatMat: THREE.MeshBasicMaterial;
  private readonly emberLight: THREE.PointLight;
  private readonly beacon: THREE.Mesh;
  private readonly beaconMat: THREE.MeshStandardMaterial;
  private readonly heatShieldMat: THREE.MeshStandardMaterial;
  /** The two burn veils — excluded from shadow casting (see the traverse). */
  private readonly burnMeshes: THREE.Mesh[] = [];
  private lastEmber = -1;
  private lastBeacon = -1;

  /** Ground height the legs were built against; `sync` re-seats if it moves. */
  private groundY: number;

  constructor(groundY = 0) {
    this.groundY = groundY;
    this.group.position.set(0, groundY, 0);
    this.group.name = 'descent-stage';

    // Metalness is kept low on purpose: the scene has no environment map, so a
    // mirror-metal tank reflects nothing and reads black. Painted alloy, then.
    const steel = (color: number, rough = 0.5, metal = 0.34) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

    // ---- tank --------------------------------------------------------------
    // The bright side of the vehicle: unburnt metal above the soot line.
    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(
        STAGE.hullRadius,
        STAGE.hullRadius,
        STAGE.hullHeight,
        56,
        1,
        true,
      ),
      steel(0xc9cdd2, 0.46, 0.3),
    );
    hull.position.y = STAGE.deckHeight + STAGE.hullHeight / 2;
    hull.material.side = THREE.DoubleSide;
    this.group.add(hull);

    // Paneled seams: vertical stiffeners and girth weld rings. Cheap geometry
    // that gives the burn streaks something to break against.
    const seamMat = steel(0x9aa0a8, 0.55, 0.3);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(0.17, STAGE.hullHeight - 0.6, 0.3),
        seamMat,
      );
      seam.position.set(
        Math.sin(a) * (STAGE.hullRadius - 0.12),
        STAGE.deckHeight + STAGE.hullHeight / 2,
        Math.cos(a) * (STAGE.hullRadius - 0.12),
      );
      seam.rotation.y = a;
      this.group.add(seam);
    }
    const ringGeo = new THREE.TorusGeometry(STAGE.hullRadius + 0.03, 0.14, 5, 56);
    for (let i = 1; i <= 6; i++) {
      const ring = new THREE.Mesh(ringGeo, seamMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = STAGE.deckHeight + (STAGE.hullHeight * i) / 7;
      this.group.add(ring);
    }

    // ---- forward dome + ogive ----------------------------------------------
    const domeY = STAGE.deckHeight + STAGE.hullHeight;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(
        STAGE.hullRadius,
        40,
        14,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.34,
      ),
      steel(0xb9bfc6, 0.42, 0.3),
    );
    dome.position.y = domeY - STAGE.hullRadius * 0.1;
    this.group.add(dome);

    const nose = new THREE.Mesh(
      new THREE.CylinderGeometry(
        STAGE.noseTopRadius,
        STAGE.hullRadius * 0.9,
        STAGE.noseHeight,
        40,
        1,
        true,
      ),
      steel(0xd3d7dc, 0.4, 0.28),
    );
    nose.material.side = THREE.DoubleSide;
    nose.position.y = domeY + STAGE.hullRadius * 0.14 + STAGE.noseHeight / 2;
    this.group.add(nose);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(STAGE.noseTopRadius, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      steel(0xaeb4bb, 0.44, 0.3),
    );
    cap.position.y = nose.position.y + STAGE.noseHeight / 2;
    this.group.add(cap);

    // Nav beacon: the one moving part that is not heat. Two-second blink, the
    // same cadence a pad light uses, so the stage is findable after dark.
    this.beaconMat = new THREE.MeshStandardMaterial({
      color: 0xff5a3a,
      emissive: 0xff3a1a,
      emissiveIntensity: 0,
      roughness: 0.4,
    });
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), this.beaconMat);
    this.beacon.position.y = cap.position.y + 0.55;
    this.group.add(this.beacon);

    // ---- engine deck -------------------------------------------------------
    // The skirt lives inside the engine plume and the bow shock's runoff, so it
    // starts life already scorched — a shade of its own, darker than the tank.
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(
        STAGE.hullRadius,
        STAGE.hullRadius * 1.14,
        STAGE.skirtHeight,
        48,
        1,
        true,
      ),
      steel(0x4e5257, 0.72, 0.18),
    );
    skirt.material.side = THREE.DoubleSide;
    skirt.position.y = STAGE.deckHeight - STAGE.skirtHeight / 2;
    this.group.add(skirt);

    // The shield itself — the face that took the plasma, so it starts charred
    // and glows from underneath while the ember term is up.
    this.heatShieldMat = new THREE.MeshStandardMaterial({
      color: 0x22191a,
      roughness: 0.95,
      metalness: 0.12,
      emissive: new THREE.Color(0xff4a12),
      emissiveIntensity: 0.18,
    });
    const shield = new THREE.Mesh(
      new THREE.CircleGeometry(STAGE.hullRadius * 1.14, 48),
      this.heatShieldMat,
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.y = STAGE.deckHeight - STAGE.skirtHeight;
    this.group.add(shield);

    // Tile field on the shield: concentric courses that read as hex tiles at a
    // glance without paying for a texture.
    const tileMat = new THREE.MeshStandardMaterial({
      color: 0x14100f,
      roughness: 1,
      metalness: 0.05,
    });
    for (const [r, tube] of [
      [2.0, 0.09],
      [3.6, 0.09],
      [5.1, 0.09],
      [6.4, 0.09],
    ] as const) {
      const course = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 4, 44), tileMat);
      course.rotation.x = Math.PI / 2;
      course.position.y = STAGE.deckHeight - STAGE.skirtHeight + 0.03;
      this.group.add(course);
    }

    // One central bell and three outer ones — a landing engine cluster, not a
    // launch stack, so the bells are short and wide.
    const bellProfile = [
      new THREE.Vector2(0.34, 1.35),
      new THREE.Vector2(0.4, 1.0),
      new THREE.Vector2(0.55, 0.6),
      new THREE.Vector2(0.82, 0.26),
      new THREE.Vector2(1.06, 0.0),
    ];
    const bellGeo = new THREE.LatheGeometry(bellProfile, 26);
    const bellMat = new THREE.MeshStandardMaterial({
      color: 0x2b2622,
      roughness: 0.62,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });
    const bellTop = STAGE.deckHeight - STAGE.skirtHeight + 0.1;
    const bells: Array<[number, number, number]> = [
      [0, 0, 1.0],
      [3.0, 0, 0.86],
      [-1.5, 2.6, 0.86],
      [-1.5, -2.6, 0.86],
    ];
    for (const [bx, bz, s] of bells) {
      const bell = new THREE.Mesh(bellGeo, bellMat);
      bell.position.set(bx, bellTop, bz);
      bell.scale.setScalar(s);
      this.group.add(bell);
    }

    // ---- legs --------------------------------------------------------------
    for (const az of STAGE.legAzimuthsDeg) this.group.add(this.buildLeg(az, steel));

    // ---- ground scorch -----------------------------------------------------
    // What the landing burn did to the pad: a darkened disc under the bells
    // with a faint heat bloom that shares the ember term.
    // A radial gradient as alphaMap keeps the mark from ending in a hard rim.
    const fade = radialFadeTexture();
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(STAGE.legReach + 2.2, 44),
      new THREE.MeshBasicMaterial({
        color: 0x241a13,
        transparent: true,
        alphaMap: fade,
        opacity: 0.8,
        depthWrite: false,
      }),
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.06;
    this.group.add(scorch);

    // And the heat the landing burn left in the pad: additive, faint in
    // daylight, the first thing you see under the hull after dark.
    this.padHeatMat = new THREE.MeshBasicMaterial({
      color: 0xff5a1a,
      transparent: true,
      alphaMap: fade,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const padHeat = new THREE.Mesh(new THREE.CircleGeometry(STAGE.hullRadius * 1.5, 40), this.padHeatMat);
    padHeat.rotation.x = -Math.PI / 2;
    padHeat.position.y = 0.09;
    padHeat.renderOrder = 3;
    this.group.add(padHeat);

    // ---- reentry burn shell ------------------------------------------------
    this.burnUniforms = {
      uTime: { value: 0 },
      uEmber: { value: 0 },
      uDay: { value: 1 },
      uSootPeak: { value: BURN.sootPeak },
      uSootTop: { value: BURN.sootTop },
      uGlowTop: { value: BURN.glowTop },
      uWindFocus: { value: BURN.windFocus },
      uHot: {
        value: new THREE.Vector2(BURN.hotSectorsDeg[0] * D2R, BURN.hotSectorsDeg[1] * D2R),
      },
      uHotWidth: { value: Math.cos(BURN.hotWidthDeg * D2R) },
    };
    const shellGeo = new THREE.CylinderGeometry(
      STAGE.hullRadius + 0.045,
      STAGE.hullRadius + 0.045,
      STAGE.hullHeight + 0.5,
      72,
      1,
      true,
    );
    // Front faces only: a DoubleSide veil would darken (and glow) twice where
    // the far wall shows through the near one.
    const makeBurnPass = (frag: string, order: number, blending: THREE.Blending) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: this.burnUniforms,
        vertexShader: BURN_VERT,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(shellGeo, mat);
      mesh.position.y = STAGE.deckHeight + STAGE.hullHeight / 2;
      mesh.renderOrder = order;
      this.burnMeshes.push(mesh);
      this.group.add(mesh);
      return mat;
    };
    this.charMat = makeBurnPass(CHAR_FRAG, 1, THREE.NormalBlending);
    this.burnMat = makeBurnPass(GLOW_FRAG, 2, THREE.AdditiveBlending);

    // Residual heat under the hull. Small and warm, never a shadow caster.
    this.emberLight = new THREE.PointLight(0xff6a24, 0, 70, 2);
    this.emberLight.position.y = STAGE.deckHeight - STAGE.skirtHeight + 1.2;
    this.group.add(this.emberLight);

    // Shadows: the stage is the tallest thing in the colony, so its shadow is
    // the base's sundial. Legs cast, the additive shell must not.
    const noShadow = new Set<THREE.Object3D>([...this.burnMeshes, scorch, padHeat]);
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (noShadow.has(o)) return; // veils and decals must not cast or catch
      o.castShadow = true;
      o.receiveShadow = true;
    });
  }

  /**
   * One landing leg, pre-built in its own frame: origin at the hip on the
   * hull, local +Y running down the strut to the foot at the origin of the
   * pad sub-frame. Yaw then tilt is all the placement needs.
   */
  private buildLeg(
    azimuthDeg: number,
    steel: (color: number, rough?: number, metal?: number) => THREE.MeshStandardMaterial,
  ): THREE.Group {
    const leg = new THREE.Group();
    const a = azimuthDeg * D2R;
    const splay = legSplayRad(STAGE.legReach, STAGE.hipHeight);
    const strutLen = STAGE.hipHeight / Math.cos(splay);

    leg.position.set(Math.sin(a) * STAGE.hullRadius, STAGE.hipHeight, Math.cos(a) * STAGE.hullRadius);
    leg.rotation.order = 'YXZ';
    leg.rotation.y = a;
    // Negative: local −Y (the strut, hip→foot) must fall *outward* as it drops,
    // which is the whole point of a splayed leg. The opposite sign collapses
    // the tripod into a stool under the engine deck.
    leg.rotation.x = -splay;

    // Primary strut: fat at the hinge, slim at the ankle.
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.58, 0.3, strutLen, 14),
      steel(0x9ea4ab, 0.5, 0.32),
    );
    strut.position.y = -strutLen / 2;
    leg.add(strut);

    // The telescoped inner stage, still showing where the leg extended.
    const piston = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, strutLen * 0.5, 14),
      steel(0x6f757c, 0.38, 0.5),
    );
    piston.position.y = -strutLen * 0.66;
    leg.add(piston);

    // Hinge block + deploy actuator at the top of the strut.
    const hinge = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.3), steel(0x5d636a, 0.55, 0.3));
    hinge.position.y = -0.2;
    leg.add(hinge);
    const actuator = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.19, strutLen * 0.34, 10),
      steel(0xc9a24a, 0.42, 0.45),
    );
    actuator.position.set(0.62, -strutLen * 0.2, 0);
    actuator.rotation.z = -0.1;
    leg.add(actuator);

    // Secondary (drag) strut, from higher on the hull down to the ankle — the
    // A-frame that makes it a tripod rather than a pole. World-up in the leg's
    // own frame is cos(splay)·Y + sin(splay)·Z, so this climbs the tank wall
    // instead of floating beside it.
    const climb = 4.8;
    const top = new THREE.Vector3(0, Math.cos(splay) * climb, Math.sin(splay) * climb);
    const ankle = new THREE.Vector3(0, -strutLen * 0.6, 0);
    const braceDir = new THREE.Vector3().subVectors(ankle, top);
    const brace = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.21, 1, 10),
      steel(0x8b9198, 0.5, 0.32),
    );
    brace.position.copy(top).addScaledVector(braceDir, 0.5);
    brace.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      braceDir.clone().normalize(),
    );
    brace.scale.y = braceDir.length();
    leg.add(brace);

    // Ladder rungs down the strut: the only way up a landed stage.
    const rungMat = steel(0x7d838a, 0.6, 0.3);
    for (let i = 1; i <= 5; i++) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.11, 0.11), rungMat);
      rung.position.set(0, -strutLen * (0.14 + i * 0.14), 0.46);
      leg.add(rung);
    }

    // Foot: a disc held perpendicular to gravity (so it counter-rotates the
    // strut's tilt) with a rim, sitting just clear of the pad datum.
    const foot = new THREE.Group();
    foot.position.y = -strutLen;
    foot.rotation.x = splay; // cancel the strut's tilt: pads sit flat on the pad
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.72, 0.46, 20),
      steel(0x6b7178, 0.66, 0.28),
    );
    pad.position.y = 0.34;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.13, 5, 26), steel(0x4a4f55, 0.64, 0.3));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.14;
    foot.add(pad, rim);
    leg.add(foot);

    // Plume wash: the ankle end of a leg took far more heat than the hinge, so
    // the strut darkens toward the foot. Each `steel()` call is its own
    // material, so this never leaks into the tank's bright metal.
    leg.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      const wash =
        o === pad || o === rim
          ? 0.85 // the foot sat in the landing plume
          : Math.max(0, Math.min(1, -o.position.y / strutLen));
      m.color.multiplyScalar(1 - 0.42 * Math.pow(wash, 1.4));
    });

    return leg;
  }

  /**
   * Re-seat the stage on the ground (the pad is graded flat, so this is a
   * no-op in practice — but a dev-pinned camera or a re-generated world should
   * never leave the legs hanging in the air).
   */
  setGround(y: number): void {
    if (Math.abs(y - this.groundY) < 1e-4) return;
    this.groundY = y;
    this.group.position.y = y;
  }

  /**
   * Advance the burn. `simTime` freezes the flicker with a paused colony;
   * `daylight` is the renderer's 0..1 sun term, which decides whether the
   * residual heat is a light source or just a colour.
   */
  sync(simTime: number, daylight: number): void {
    const t = Number.isFinite(simTime) ? simTime : 0;
    const ember = emberFlicker(t);
    this.burnUniforms.uTime.value = t;
    this.burnUniforms.uDay.value = daylight;
    if (Math.abs(ember - this.lastEmber) > 1e-3) {
      this.lastEmber = ember;
      this.burnUniforms.uEmber.value = ember;
      this.emberLight.intensity = emberLightIntensity(ember, daylight);
      this.heatShieldMat.emissiveIntensity = 0.1 + 0.5 * ember;
      this.padHeatMat.opacity = 0.16 * ember * (0.35 + 0.65 * (1 - daylight));
    }
    const beacon = beaconBlink(t);
    if (Math.abs(beacon - this.lastBeacon) > 1e-3) {
      this.lastBeacon = beacon;
      this.beaconMat.emissiveIntensity = beacon * 2.4;
    }
  }

  dispose(): void {
    const seen = new Set<THREE.Texture>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      const mats = o.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        const alpha = (m as THREE.MeshBasicMaterial).alphaMap;
        if (alpha && !seen.has(alpha)) {
          seen.add(alpha);
          alpha.dispose();
        }
        m.dispose();
      }
    });
    this.burnMat.dispose();
    this.charMat.dispose();
    this.padHeatMat.dispose();
  }
}

/**
 * A soft radial falloff (white centre → black rim) for alphaMap use. Built in
 * a canvas so the scorch and pad-heat decals fade out instead of ending in a
 * hard circle; 64 px is plenty for something the camera never reads closely.
 */
function radialFadeTexture(): THREE.Texture {
  const size = 64;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) return new THREE.Texture();
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * The nav beacon's blink: a 2.2 s cycle with a 0.4 s lit window and soft
 * edges, so it reads as a strobe from a distance and not as a slow fade.
 */
export function beaconBlink(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const phase = ((t % 2.2) + 2.2) % 2.2;
  if (phase > 0.55) return 0;
  return Math.sin((phase / 0.55) * Math.PI);
}
