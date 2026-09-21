/**
 * Presentation-side sound director.
 *
 * Audio is deliberately kept out of the deterministic simulation. The sim
 * reports weather, power and log events; this class turns that read-only state
 * into a procedural soundscape on the browser's Web Audio graph. That keeps a
 * save/replay byte-for-byte deterministic while still letting wind, storms and
 * warning tones continue in real time when the player pauses the colony.
 *
 * There are no fetched sound files here. The low drones, filtered dust/wind and
 * short UI / machinery cues are synthesized in-browser, which makes the audio
 * system work from a fresh offline build and avoids a network race at boot.
 * Browsers do not permit audible playback until an input gesture, so the first
 * pointer or keyboard activation unlocks the graph; after that its ambience is
 * continuous across menus, loading surfaces and paused simulation frames.
 */

import type { SimCommandType, SimLogEvent, SimView } from '../sim/host';

export type AudioScene = 'menu' | 'game';

/** A compact, testable representation of the continuously mixed soundscape. */
export interface AudioMix {
  /** Orbital/menu drone and thin air. */
  menuAtmosphere: number;
  /** The colony's low Mars ambience. This remains audible while paused. */
  worldAtmosphere: number;
  /** Wind-driven dust hiss. */
  wind: number;
  /** Dense storm grit and gust layer. */
  storm: number;
  /** Generator / rover bed, intentionally muted when time is paused. */
  machinery: number;
}

export interface AudioMixInput {
  scene: AudioScene;
  paused: boolean;
  windSpeed: number;
  dust: number;
  stormIntensity: number;
  activeRovers: number;
  onlineBuildings: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/**
 * Convert live presentation state into mix targets. Kept pure so the important
 * promise is explicit: a pause takes machinery down but never takes the world
 * ambience, wind or storm out with it.
 */
export function audioMix(input: AudioMixInput): AudioMix {
  if (input.scene === 'menu') {
    return {
      menuAtmosphere: 1,
      worldAtmosphere: 0,
      wind: 0,
      storm: 0,
      machinery: 0,
    };
  }

  const windStrength = clamp01((input.windSpeed - 3) / 58);
  const dust = clamp01(input.dust);
  const storm = clamp01(input.stormIntensity);
  return {
    menuAtmosphere: 0,
    // A pause is a quiet observation mode, not a silent one: the frozen sky
    // still blows over the base and the player still needs to hear its mood.
    worldAtmosphere: input.paused ? 0.9 : 0.68,
    wind: clamp01(0.16 + windStrength * 0.68 + dust * 0.1 + storm * 0.12),
    storm,
    machinery: input.paused
      ? 0
      : clamp01(input.activeRovers * 0.17 + input.onlineBuildings * 0.035),
  };
}

export type AudioCue =
  | 'ui'
  | 'menu'
  | 'select'
  | 'pause'
  | 'resume'
  | 'order'
  | 'mine'
  | 'unload'
  | 'wait'
  | 'construct'
  | 'clean'
  | 'repair'
  | 'rescue'
  | 'salvage'
  | 'cancel'
  | 'toggle'
  | 'demolish'
  | 'assemble'
  | 'suit'
  | 'developer'
  | 'storm'
  | 'stormClear'
  | 'lightning'
  | 'brownout'
  | 'powerRestored'
  | 'complete'
  | 'discovery'
  | 'alert'
  | 'critical'
  | 'error'
  | 'save'
  | 'launch';

/**
 * Every command has a sound identity. The `Record` is intentionally exhaustive:
 * adding a new player action to the host protocol fails type-checking until it
 * gains audible feedback here as well.
 */
const COMMAND_CUES: Record<SimCommandType, AudioCue> = {
  'rover/move': 'order',
  'rover/mine': 'mine',
  'rover/unload': 'unload',
  'rover/wait': 'wait',
  'rover/construct': 'construct',
  'rover/clean': 'clean',
  'rover/repair': 'repair',
  'rover/recover': 'rescue',
  'rover/salvage': 'salvage',
  'rover/stop': 'cancel',
  'rover/repeatRoute': 'toggle',
  'rover/rule': 'toggle',
  'rover/chargeFloor': 'toggle',
  'rover/lights': 'toggle',
  'building/place': 'construct',
  'building/toggle': 'toggle',
  'building/demolish': 'demolish',
  'building/maintain': 'repair',
  'building/assemble': 'assemble',
  'building/recipe': 'toggle',
  'water/connect': 'toggle',
  'water/disconnect': 'toggle',
  'water/commission': 'toggle',
  'engineering/upgrade': 'toggle',
  'engineering/cancel': 'toggle',
  'engineering/paint': 'toggle',
  'colonist/order': 'suit',
  'dev/time': 'developer',
  'dev/storm/force': 'storm',
  'dev/storm/clear': 'stormClear',
  'dev/storm/scheduler': 'developer',
  'dev/dust': 'developer',
  'dev/lightning/strike': 'lightning',
  'dev/spawn/rover': 'developer',
  'dev/spawn/building': 'developer',
  'dev/spawn/deposit': 'developer',
  'dev/building/complete': 'complete',
  'dev/building/level': 'developer',
  'dev/building/health': 'developer',
  'dev/building/damaged': 'developer',
  'dev/building/cleanliness': 'clean',
  'dev/rover/battery': 'developer',
  'dev/rover/cargo': 'developer',
  'dev/rover/cargoClear': 'developer',
  'dev/rover/condition': 'developer',
  'dev/colonist/health': 'developer',
  'dev/colonist/suit': 'suit',
  'tutorial/dismiss': 'ui',
  'policy/stockpile': 'ui',
  'policy/nightPower': 'ui',
  'policy/stormShelter': 'ui',
  'policy/autoMaintain': 'ui',
};

export function cueForCommand(type: SimCommandType): AudioCue {
  return COMMAND_CUES[type];
}

interface AudioGraph {
  master: GainNode;
  menuDrone: GainNode;
  menuAir: GainNode;
  worldDrone: GainNode;
  wind: GainNode;
  storm: GainNode;
  machinery: GainNode;
  effects: GainNode;
  ui: GainNode;
  windFilter: BiquadFilterNode;
  stormFilter: BiquadFilterNode;
  loops: AudioScheduledSourceNode[];
}

type AudioContextConstructor = new () => AudioContext;

const CUE_COOLDOWNS: Partial<Record<AudioCue, number>> = {
  ui: 0.035,
  menu: 0.05,
  select: 0.05,
  order: 0.08,
  mine: 0.12,
  unload: 0.1,
  wait: 0.08,
  construct: 0.12,
  clean: 0.12,
  repair: 0.12,
  rescue: 0.2,
  salvage: 0.16,
  toggle: 0.06,
  developer: 0.08,
  storm: 1,
  stormClear: 1,
  lightning: 4,
  brownout: 4,
  powerRestored: 1,
  complete: 0.35,
  discovery: 0.35,
  alert: 0.5,
  critical: 1.2,
  error: 0.35,
  save: 0.7,
  launch: 0.35,
};

/** Find an interactive control without relying on a particular menu component. */
function interactiveTarget(target: EventTarget | null): HTMLElement | null {
  const el = target as { closest?: (selectors: string) => Element | null } | null;
  if (!el?.closest) return null;
  return el.closest(
    'button, [role="button"], input[type="checkbox"], input[type="range"], select',
  ) as HTMLElement | null;
}

/** The menu components all use `.rf-*`; keeping this check structural covers new menus too. */
function isMenuControl(control: HTMLElement): boolean {
  return Boolean(control.closest('.rf-overlay, .rf-menu-pop'));
}

/**
 * Owns the Web Audio graph and all non-deterministic sound scheduling. It has
 * no writes into the simulation — `update()` only consumes a `SimView`.
 */
export class AudioSystem {
  private scene: AudioScene = 'menu';
  private paused = false;
  private context: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private unsupported = false;
  private activated = false;
  private disposed = false;

  private mixInput: AudioMixInput = {
    scene: 'menu',
    paused: false,
    windSpeed: 8,
    dust: 0.08,
    stormIntensity: 0,
    activeRovers: 0,
    onlineBuildings: 0,
  };
  private lastCueAt = new Map<AudioCue, number>();
  private observedStorm = 'calm';
  private observedBrownout = false;
  private nextBrownoutPulseAt = 0;
  private nextLightningAt = 0;

  constructor() {
    // One capture listener makes menu, wizard, saved-game and HUD controls
    // consistent without each DOM component needing its own audio dependency.
    // It also runs early enough to satisfy Web Audio's user-gesture policy.
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.onPointerDown, true);
      document.addEventListener('keydown', this.onKeyDown, true);
    }
  }

  /** Move between the pre-flight ambience and the live colony soundscape. */
  setScene(scene: AudioScene): void {
    if (this.disposed || this.scene === scene) return;
    this.scene = scene;
    this.mixInput.scene = scene;
    if (scene === 'game') {
      // A loaded save can already be inside a storm/brownout. Resetting these
      // observations lets its state announce itself on the next update.
      this.observedStorm = 'calm';
      this.observedBrownout = false;
      this.nextBrownoutPulseAt = 0;
      this.nextLightningAt = 0;
    }
    this.applyMix();
  }

  /**
   * Time control only changes the machinery bed. The environmental layers keep
   * their current weather mix and continue using AudioContext wall time.
   */
  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    this.mixInput.paused = paused;
    this.applyMix();
    if (this.scene === 'game') this.playCue(paused ? 'pause' : 'resume');
  }

  /**
   * Call directly from a keyboard/game-canvas gesture that is not a DOM button.
   * It is safe to call repeatedly and keeps browser autoplay permission local to
   * the real input handler rather than trying to resume from a frame callback.
   */
  activateFromUserGesture(): void {
    this.unlock();
  }

  /** A tiny public hook for non-command selection and hotkey feedback. */
  select(): void {
    this.playCue('select');
  }

  /** Audible feedback for every player or developer host command. */
  command(type: SimCommandType): void {
    this.playCue(cueForCommand(type));
  }

  /** Useful for the one command with an asynchronous authoritative placement ack. */
  reject(): void {
    this.playCue('error');
  }

  /** Explicit saves are a player action; quiet autosaves intentionally do not beep. */
  saved(): void {
    this.playCue('save');
  }

  /** Transition stinger after a world is live. */
  missionStarted(): void {
    this.playCue('launch');
  }

  /**
   * Feed the latest read model each rendered frame. This is intentionally called
   * even at simulation speed zero: only the values freeze, never the ambient
   * graph or its brownout/storm reminders.
   */
  update(view: SimView, paused = this.paused): void {
    if (this.disposed) return;
    if (paused !== this.paused) this.setPaused(paused);
    this.mixInput = {
      scene: this.scene,
      paused: this.paused,
      windSpeed: view.weather.windSpeed,
      dust: view.weather.dust,
      stormIntensity: view.weather.stormIntensity,
      activeRovers: view.rovers.filter((r) => r.phase !== 'disabled' && r.command.type !== 'idle').length,
      onlineBuildings: view.buildings.filter((b) => b.state === 'online' && b.enabled).length,
    };
    this.applyMix();

    if (this.scene !== 'game') return;
    this.observeWeather(view);
    this.observePower(view);
  }

  /**
   * Log events are a second route to audible outcomes such as discoveries and
   * completed structures. State transitions still own storms and brownouts, so
   * this never relies on parsing a log line to keep a warning loop alive.
   */
  event(event: SimLogEvent): void {
    if (this.disposed || this.scene !== 'game') return;
    const text = event.text.toLowerCase();
    if (/(?:storm|dust devil).*(?:on site|forecast)|winds inbound/.test(text)) {
      this.playCue('storm');
    } else if (/storm has passed|storms dismissed/.test(text)) {
      this.playCue('stormClear');
    } else if (/found|landed|supply drop/.test(text)) {
      this.playCue('discovery');
    } else if (/online|completed|fully stocked|assembled|repressurised/.test(text)) {
      this.playCue('complete');
    } else if (/damaged|critical|mission lost|did not survive/.test(text) || event.severity === 'crit') {
      this.playCue('critical');
    } else if (event.severity === 'warn') {
      this.playCue('alert');
    }
  }

  /** Stop loops and unregister document listeners when the page/game is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this.onPointerDown, true);
      document.removeEventListener('keydown', this.onKeyDown, true);
    }
    for (const source of this.graph?.loops ?? []) {
      try {
        source.stop();
      } catch {
        /* it may already have been stopped by a browser teardown */
      }
    }
    this.graph = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  // --------------------------------------------------------- user activation ----

  private onPointerDown = (event: PointerEvent): void => {
    // A first interaction can be a right-click context order, not just a menu
    // button. It still needs to unlock the graph, though non-primary buttons do
    // not get a generic UI blip of their own.
    const nonPrimary = typeof event.button === 'number' && event.button > 0;
    this.unlock();
    if (nonPrimary) return;
    const control = interactiveTarget(event.target);
    if (!control || control.matches(':disabled')) return;
    this.playCue(isMenuControl(control) ? 'menu' : 'ui');
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    const control = interactiveTarget(event.target);
    if (!control || control.matches(':disabled')) return;
    this.unlock();
    this.playCue(isMenuControl(control) ? 'menu' : 'ui');
  };

  /** Create and resume lazily so page boot never trips autoplay warnings. */
  private unlock(): void {
    if (this.disposed) return;
    this.activated = true;
    const context = this.ensureContext();
    if (!context) return;
    // Do not await: this call is deliberately made synchronously in the input
    // handler. Safari in particular treats a deferred resume as non-gesture work.
    if (context.state !== 'running') void context.resume().catch(() => undefined);
    this.ensureGraph();
    this.applyMix();
  }

  // --------------------------------------------------------------- live mix ----

  private observeWeather(view: SimView): void {
    const storm = view.weather.storm;
    const audibleStorm = view.weather.stormIntensity > 0.08 ? storm : 'calm';
    if (audibleStorm !== this.observedStorm) {
      if (audibleStorm === 'calm') this.playCue('stormClear');
      else this.playCue('storm');
      this.observedStorm = audibleStorm;
    }

    // Mars dust storms can generate electrostatic discharges. They are scheduled
    // on wall-clock audio time rather than simulation time so a paused severe
    // storm still sounds alive without ever changing deterministic sim state.
    const electricallyActive =
      (storm === 'severe' || storm === 'planetary') && view.weather.stormIntensity >= 0.52;
    const now = this.wallTime();
    if (!electricallyActive) {
      this.nextLightningAt = now + 5;
      return;
    }
    if (now >= this.nextLightningAt) {
      this.playCue('lightning');
      this.nextLightningAt = now + 6 + Math.random() * 12;
    }
  }

  private observePower(view: SimView): void {
    const brownout = view.power.brownout;
    const now = this.wallTime();
    if (brownout !== this.observedBrownout) {
      this.playCue(brownout ? 'brownout' : 'powerRestored');
      this.observedBrownout = brownout;
      this.nextBrownoutPulseAt = now + 7;
    }
    if (brownout && now >= this.nextBrownoutPulseAt) {
      this.playCue('brownout');
      this.nextBrownoutPulseAt = now + 8;
    }
  }

  private applyMix(): void {
    if (!this.activated || this.disposed) return;
    const graph = this.ensureGraph();
    const context = this.context;
    if (!graph || !context) return;
    const mix = audioMix(this.mixInput);
    const t = context.currentTime;
    // These gains deliberately stay conservative. Ambient audio should make the
    // visual world feel inhabited, not bury alerts, voices or the player's music.
    this.ramp(graph.menuDrone.gain, 0.045 * mix.menuAtmosphere, t, 0.45);
    this.ramp(graph.menuAir.gain, 0.012 * mix.menuAtmosphere, t, 0.6);
    this.ramp(graph.worldDrone.gain, 0.033 * mix.worldAtmosphere, t, 0.35);
    this.ramp(graph.wind.gain, 0.042 * mix.wind, t, 0.25);
    this.ramp(graph.storm.gain, 0.095 * mix.storm, t, 0.3);
    this.ramp(graph.machinery.gain, 0.022 * mix.machinery, t, 0.2);
    this.ramp(graph.windFilter.frequency, 280 + mix.wind * 1500, t, 0.25);
    this.ramp(graph.stormFilter.frequency, 340 + mix.storm * 1150, t, 0.3);
  }

  // -------------------------------------------------------------- graph setup ----

  private ensureContext(): AudioContext | null {
    if (this.context || this.unsupported || this.disposed || typeof window === 'undefined') {
      return this.context;
    }
    const browser = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
    const Ctor: AudioContextConstructor | undefined = browser.AudioContext ?? browser.webkitAudioContext;
    if (!Ctor) {
      this.unsupported = true;
      return null;
    }
    try {
      this.context = new Ctor();
      return this.context;
    } catch {
      // Audio is progressive enhancement. A restricted iframe / unusual browser
      // must leave the colony entirely playable rather than throw at first click.
      this.unsupported = true;
      return null;
    }
  }

  private ensureGraph(): AudioGraph | null {
    if (this.graph) return this.graph;
    const context = this.ensureContext();
    if (!context || this.disposed) return null;
    try {
      const master = context.createGain();
      master.gain.value = 0.58;
      master.connect(context.destination);

      const menuDrone = this.gainTo(context, master);
      const menuAir = this.gainTo(context, master);
      const worldDrone = this.gainTo(context, master);
      const wind = this.gainTo(context, master);
      const storm = this.gainTo(context, master);
      const machinery = this.gainTo(context, master);
      const effects = this.gainTo(context, master);
      const ui = this.gainTo(context, master);
      effects.gain.value = 0.9;
      ui.gain.value = 0.72;

      const windFilter = context.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.Q.value = 0.45;
      windFilter.frequency.value = 700;
      const windNoise = this.noiseLoop(context, 3.7, 'white');
      windNoise.connect(windFilter).connect(wind);

      const stormFilter = context.createBiquadFilter();
      stormFilter.type = 'lowpass';
      stormFilter.Q.value = 0.55;
      stormFilter.frequency.value = 700;
      const stormHighPass = context.createBiquadFilter();
      stormHighPass.type = 'highpass';
      stormHighPass.frequency.value = 75;
      const stormNoise = this.noiseLoop(context, 5.3, 'brown');
      stormNoise.connect(stormHighPass).connect(stormFilter).connect(storm);

      const menuAirFilter = context.createBiquadFilter();
      menuAirFilter.type = 'lowpass';
      menuAirFilter.frequency.value = 540;
      const menuNoise = this.noiseLoop(context, 4.6, 'brown');
      menuNoise.connect(menuAirFilter).connect(menuAir);

      const loops: AudioScheduledSourceNode[] = [windNoise, stormNoise, menuNoise];
      loops.push(
        this.drone(context, 55, 'sine', 0.56, menuDrone),
        this.drone(context, 82.4, 'sine', 0.18, menuDrone),
        this.drone(context, 39, 'sine', 0.34, worldDrone),
        this.drone(context, 58.4, 'triangle', 0.09, worldDrone),
        this.drone(context, 46, 'sine', 0.18, machinery),
        this.drone(context, 92, 'triangle', 0.025, machinery),
      );

      this.graph = {
        master,
        menuDrone,
        menuAir,
        worldDrone,
        wind,
        storm,
        machinery,
        effects,
        ui,
        windFilter,
        stormFilter,
        loops,
      };
      return this.graph;
    } catch {
      // `createBuffer` and source setup can be disabled independently of the
      // constructor in some embedded browsers. Treat it as an unavailable audio
      // device, not a mission-ending error.
      this.unsupported = true;
      this.graph = null;
      return null;
    }
  }

  private gainTo(context: AudioContext, destination: AudioNode): GainNode {
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(destination);
    return gain;
  }

  private drone(
    context: AudioContext,
    frequency: number,
    shape: OscillatorType,
    detune: number,
    destination: AudioNode,
  ): OscillatorNode {
    const oscillator = context.createOscillator();
    oscillator.type = shape;
    oscillator.frequency.value = frequency;
    oscillator.detune.value = detune;
    oscillator.connect(destination);
    oscillator.start();
    return oscillator;
  }

  /** A small looping buffer prevents the ambient graph from depending on fetch/XHR. */
  private noiseLoop(context: AudioContext, seconds: number, color: 'white' | 'brown'): AudioBufferSourceNode {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'brown') {
        brown = (brown + 0.035 * white) / 1.035;
        data[i] = brown * 3.2;
      } else {
        data[i] = white;
      }
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start();
    return source;
  }

  // --------------------------------------------------------------- one shots ----

  private playCue(cue: AudioCue): void {
    if (!this.activated || this.disposed) return;
    const graph = this.ensureGraph();
    const context = this.context;
    if (!graph || !context) return;
    const now = this.wallTime();
    const cooldown = CUE_COOLDOWNS[cue] ?? 0;
    const last = this.lastCueAt.get(cue) ?? -Infinity;
    if (now - last < cooldown) return;
    this.lastCueAt.set(cue, now);

    const fx = graph.effects;
    const ui = graph.ui;
    switch (cue) {
      case 'ui':
        this.tone(650, 0.045, 0.035, 'sine', ui, 800);
        break;
      case 'menu':
        this.tone(420, 0.065, 0.042, 'triangle', ui, 620);
        break;
      case 'select':
        this.tone(520, 0.06, 0.035, 'sine', ui, 720);
        break;
      case 'pause':
        this.tone(420, 0.085, 0.045, 'sine', fx, 280);
        this.tone(330, 0.075, 0.032, 'sine', fx, 220, 0.09);
        break;
      case 'resume':
        this.tone(260, 0.08, 0.045, 'sine', fx, 410);
        this.tone(390, 0.07, 0.034, 'sine', fx, 570, 0.085);
        break;
      case 'order':
        this.tone(255, 0.075, 0.052, 'triangle', fx, 350);
        break;
      case 'mine':
        this.tone(190, 0.07, 0.055, 'square', fx, 130);
        this.tone(640, 0.025, 0.027, 'sine', fx, 470, 0.05);
        break;
      case 'unload':
        this.tone(310, 0.06, 0.04, 'triangle', fx, 220);
        this.tone(220, 0.08, 0.035, 'sine', fx, 150, 0.06);
        break;
      case 'wait':
        this.tone(360, 0.045, 0.028, 'sine', fx, 360);
        break;
      case 'construct':
        this.noiseBurst(0.075, 0.06, 1000, fx);
        this.tone(130, 0.1, 0.052, 'triangle', fx, 95);
        break;
      case 'clean':
        this.noiseBurst(0.1, 0.04, 1800, fx);
        this.tone(720, 0.055, 0.026, 'sine', fx, 940);
        break;
      case 'repair':
        this.tone(510, 0.045, 0.04, 'square', fx, 670);
        this.tone(720, 0.05, 0.032, 'sine', fx, 850, 0.07);
        break;
      case 'rescue':
        this.tone(310, 0.08, 0.052, 'sine', fx, 500);
        this.tone(530, 0.1, 0.047, 'sine', fx, 810, 0.1);
        break;
      case 'salvage':
        this.noiseBurst(0.11, 0.06, 780, fx);
        this.tone(250, 0.09, 0.048, 'triangle', fx, 160);
        break;
      case 'cancel':
        this.tone(380, 0.07, 0.035, 'sine', ui, 180);
        break;
      case 'toggle':
        this.tone(600, 0.045, 0.032, 'square', ui, 700);
        break;
      case 'demolish':
        this.noiseBurst(0.15, 0.07, 420, fx);
        this.tone(145, 0.15, 0.06, 'sawtooth', fx, 75);
        break;
      case 'assemble':
        this.tone(180, 0.09, 0.046, 'triangle', fx, 280);
        this.tone(300, 0.11, 0.04, 'sine', fx, 470, 0.1);
        break;
      case 'suit':
        this.tone(740, 0.055, 0.034, 'sine', fx, 980);
        break;
      case 'developer':
        this.tone(860, 0.045, 0.032, 'square', ui, 1040);
        break;
      case 'storm':
        this.noiseBurst(0.5, 0.095, 320, fx);
        this.tone(110, 0.35, 0.065, 'sawtooth', fx, 72);
        break;
      case 'stormClear':
        this.tone(330, 0.12, 0.04, 'sine', fx, 440);
        this.tone(495, 0.16, 0.035, 'sine', fx, 660, 0.12);
        break;
      case 'lightning':
        this.noiseBurst(0.07, 0.16, 2600, fx, 'highpass');
        this.noiseBurst(1.05, 0.075, 150, fx, 'lowpass');
        this.tone(92, 0.65, 0.065, 'sawtooth', fx, 43, 0.04);
        break;
      case 'brownout':
        this.tone(105, 0.25, 0.075, 'square', fx, 105);
        this.tone(880, 0.07, 0.05, 'sine', fx, 880, 0.12);
        break;
      case 'powerRestored':
        this.tone(380, 0.09, 0.04, 'sine', fx, 510);
        this.tone(510, 0.13, 0.037, 'sine', fx, 680, 0.1);
        break;
      case 'complete':
        this.tone(392, 0.11, 0.04, 'sine', fx, 524);
        this.tone(523, 0.14, 0.034, 'sine', fx, 659, 0.1);
        break;
      case 'discovery':
        this.tone(440, 0.09, 0.04, 'sine', fx, 554);
        this.tone(659, 0.17, 0.042, 'sine', fx, 880, 0.1);
        break;
      case 'alert':
        this.tone(690, 0.11, 0.05, 'triangle', fx, 690);
        break;
      case 'critical':
        this.tone(760, 0.11, 0.055, 'square', fx, 760);
        this.tone(760, 0.11, 0.055, 'square', fx, 760, 0.17);
        break;
      case 'error':
        this.tone(260, 0.12, 0.05, 'sawtooth', ui, 110);
        break;
      case 'save':
        this.tone(600, 0.06, 0.033, 'sine', ui, 760);
        this.tone(760, 0.1, 0.03, 'sine', ui, 920, 0.07);
        break;
      case 'launch':
        this.tone(220, 0.16, 0.052, 'sine', fx, 440);
        this.tone(440, 0.25, 0.043, 'sine', fx, 660, 0.12);
        break;
    }
  }

  private tone(
    frequency: number,
    duration: number,
    level: number,
    shape: OscillatorType,
    destination: AudioNode,
    endFrequency = frequency,
    delay = 0,
  ): void {
    const context = this.context;
    if (!context || this.disposed) return;
    try {
      const now = context.currentTime + delay;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = shape;
      oscillator.frequency.setValueAtTime(Math.max(1, frequency), now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + Math.min(0.018, duration * 0.28));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain).connect(destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.03);
    } catch {
      // Contexts can close asynchronously during navigation. A missed blip is
      // harmless; throwing out of a click handler is not.
    }
  }

  private noiseBurst(
    duration: number,
    level: number,
    frequency: number,
    destination: AudioNode,
    filterType: BiquadFilterType = 'bandpass',
  ): void {
    const context = this.context;
    if (!context || this.disposed) return;
    try {
      const length = Math.max(1, Math.ceil(context.sampleRate * (duration + 0.08)));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const now = context.currentTime;
      source.buffer = buffer;
      filter.type = filterType;
      filter.frequency.value = frequency;
      filter.Q.value = 0.7;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      source.connect(filter).connect(gain).connect(destination);
      source.start(now);
      source.stop(now + duration + 0.04);
    } catch {
      /* see tone() */
    }
  }

  private ramp(param: AudioParam, value: number, now: number, timeConstant: number): void {
    try {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(Math.max(0, value), now, timeConstant);
    } catch {
      /* a closed context has no usable params */
    }
  }

  private wallTime(): number {
    // Keep cooldowns on one clock. Switching from `performance.now()` while an
    // AudioContext is suspended to `currentTime` after it resumes would make a
    // just-clicked menu cue look as though it happened far in the future.
    // Wall time also keeps storm/brownout reminders alive while a browser has
    // temporarily suspended its audio device.
    return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
  }
}
