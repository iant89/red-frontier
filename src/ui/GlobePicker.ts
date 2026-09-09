/**
 * The mission globe: a spinnable 3D Mars studded with transparent landing-zone
 * markers. Drag to rotate, click a zone to select it.
 *
 * The surface texture is generated, not shipped — the same MOLA-like elevation
 * model the terrain sampler uses, painted once into an equirectangular canvas.
 * Marker placement uses three.js' own sphere parametrisation, so the zones
 * sit exactly on the geography they describe.
 */

import * as THREE from 'three';
import { LANDABLE_REGIONS, marsElevationKm } from '../sim/marsGlobe';
import { BIOME_COLORS } from './landingRegions';

function wrapLonSafe(lon: number): number {
  return ((lon % 360) + 360) % 360;
}

export interface GlobePickerOptions {
  regions?: string[];
  selected?: string | null;
  onSelect?: (regionName: string) => void;
  onHover?: (regionName: string | null) => void;
}

const TEX_W = 640;
const TEX_H = 320;

let cachedTexture: THREE.CanvasTexture | null = null;

function elevColor(elevKm: number, lat: number, n: number): [number, number, number] {
  // Rust ramp: deep basins → plains → highlands → shield volcanoes.
  let r: number;
  let g: number;
  let b: number;
  if (elevKm < -4) {
    r = 110; g = 58; b = 38;
  } else if (elevKm < -1) {
    r = 150; g = 80; b = 48;
  } else if (elevKm < 2.5) {
    r = 190; g = 112; b = 64;
  } else if (elevKm < 6) {
    r = 214; g = 138; b = 82;
  } else if (elevKm < 11) {
    r = 228; g = 172; b = 116;
  } else {
    r = 236; g = 196; b = 150;
  }
  // Tharsis/Syrtis basalt reads darker from orbit.
  if (elevKm > 1.5 && elevKm < 9 && Math.abs(lat) < 30) {
    const k = 0.12;
    r *= 1 - k; g *= 1 - k; b *= 1 - k * 0.5;
  }
  // Polar caps.
  const cap = Math.max(0, (Math.abs(lat) - 66) / 14);
  if (cap > 0) {
    const k = Math.min(1, cap);
    r = r + (232 - r) * k;
    g = g + (214 - g) * k;
    b = b + (198 - b) * k;
  }
  const grain = 0.94 + n * 0.12;
  return [Math.min(255, r * grain), Math.min(255, g * grain), Math.min(255, b * grain)];
}

function hash2i(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function getMarsTexture(): THREE.CanvasTexture {
  if (cachedTexture) return cachedTexture;
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(TEX_W, TEX_H);
  for (let py = 0; py < TEX_H; py++) {
    // CanvasTexture flips Y: canvas row 0 is the north pole.
    const lat = (py / TEX_H) * 180 - 90;
    for (let px = 0; px < TEX_W; px++) {
      const lon = (px / TEX_W) * 360;
      const elev = marsElevationKm(lat, lon);
      const [r, g, b] = elevColor(elev, lat, hash2i(px, py));
      const k = (py * TEX_W + px) * 4;
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cachedTexture = new THREE.CanvasTexture(canvas);
  cachedTexture.colorSpace = THREE.SRGBColorSpace;
  return cachedTexture;
}

/** Region lat/lon → unit-sphere position (matches SphereGeometry UVs). */
function latLonToVec(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (wrapLonSafe(lon) / 360) * Math.PI * 2;
  const theta = ((90 - lat) * Math.PI) / 180;
  return new THREE.Vector3(
    -Math.cos(phi) * Math.sin(theta) * radius,
    Math.cos(theta) * radius,
    Math.sin(phi) * Math.sin(theta) * radius,
  );
}

export class GlobePicker {
  private container: HTMLElement;
  private opts: GlobePickerOptions;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private globe = new THREE.Group();
  private markers = new Map<string, { group: THREE.Group; disc: THREE.Mesh; ring: THREE.Mesh }>();
  private hitMeshes: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private raf = 0;
  private lastT = 0;
  private lastInteract = 0;
  private dragging = false;
  private dragTravel = 0;
  private lastX = 0;
  private lastY = 0;
  private ro: ResizeObserver | null = null;
  private tip: HTMLElement;
  private disposed = false;
  selected: string | null;

  constructor(container: HTMLElement, opts: GlobePickerOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.selected = opts.selected ?? null;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
    this.camera.position.set(0, 0.35, 3.1);
    this.camera.lookAt(0, 0, 0);

    this.tip = document.createElement('div');
    this.tip.className = 'rf-globe-tip';
    container.appendChild(this.tip);

    try {
      this.initGl();
    } catch (err) {
      console.error('Globe renderer unavailable, falling back to a list', err);
      this.renderFallback();
      return;
    }
    this.bindPointer();
    this.observeResize();
    this.resize();
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.05, (t - this.lastT) / 1000);
      this.lastT = t;
      // Idle drift: the planet turns until the commander grabs it.
      if (!this.dragging && t - this.lastInteract > 3000) {
        this.globe.rotation.y += dt * 0.07;
      }
      this.renderer!.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setSelected(name: string | null): void {
    this.selected = name;
    for (const [key, m] of this.markers) {
      const on = key === name;
      (m.disc.material as THREE.MeshBasicMaterial).opacity = on ? 0.85 : 0.5;
      (m.ring.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.75;
      (m.ring.material as THREE.MeshBasicMaterial).color.set(on ? '#ffffff' : BIOME_COLORS[this.biomeOf(key)]);
      m.group.scale.setScalar(on ? 1.35 : 1);
    }
  }

  private biomeOf(name: string) {
    return LANDABLE_REGIONS.find((r) => r.name === name)?.biome ?? 'plains';
  }

  dispose(): void {
    this.disposed = true;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.tip.remove();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }

  // ------------------------------------------------------------------ gl ----

  private initGl(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffe2c4, 0.75));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    sun.position.set(-3, 1.2, 2.2);
    this.scene.add(sun);

    const mars = new THREE.Mesh(
      new THREE.SphereGeometry(1, 72, 48),
      new THREE.MeshStandardMaterial({ map: getMarsTexture(), roughness: 0.96, metalness: 0 }),
    );
    this.globe.add(mars);

    // Whisper of atmosphere on the limb.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.03, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0xd98a52,
        transparent: true,
        opacity: 0.14,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.globe.add(halo);
    this.globe.rotation.x = 0.18;
    this.globe.rotation.y = 2.4;
    this.scene.add(this.globe);

    const wanted = new Set(this.opts.regions ?? LANDABLE_REGIONS.map((r) => r.name));
    for (const region of LANDABLE_REGIONS) {
      if (!wanted.has(region.name)) continue;
      this.addMarker(region.name, region.lat, region.lon);
    }
    this.setSelected(this.selected);
  }

  private addMarker(name: string, lat: number, lon: number): void {
    const color = BIOME_COLORS[this.biomeOf(name)];
    const group = new THREE.Group();
    group.position.copy(latLonToVec(lat, lon, 1.004));
    group.lookAt(group.position.clone().multiplyScalar(2));

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.075, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.092, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.position.z = 0.001;
    const hit = new THREE.Mesh(
      new THREE.CircleGeometry(0.17, 12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.position.z = 0.002;
    hit.userData.region = name;
    group.add(disc, ring, hit);
    this.globe.add(group);
    this.markers.set(name, { group, disc, ring });
    this.hitMeshes.push(hit);
  }

  // ------------------------------------------------------------- input ----

  private bindPointer(): void {
    const canvas = this.renderer!.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragTravel = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.lastInteract = performance.now();
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.dragTravel += Math.abs(dx) + Math.abs(dy);
        this.globe.rotation.y += dx * 0.006;
        this.globe.rotation.x = Math.max(
          -0.7,
          Math.min(0.7, this.globe.rotation.x + dy * 0.003),
        );
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.lastInteract = performance.now();
        this.hideTip();
      } else {
        this.hover(e);
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.lastInteract = performance.now();
      if (this.dragTravel < 7) this.tap(e);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => {
      this.dragging = false;
    });
    canvas.addEventListener('pointerleave', () => this.hideTip());
  }

  private castAt(e: PointerEvent): string | null {
    const rect = this.renderer!.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false);
    // A marker on the far side of the planet must not catch clicks: the ray
    // has to reach it before it reaches the globe (radius 1, centred).
    for (const h of hits) {
      const dir = h.point.clone().sub(this.camera.position).normalize();
      const toCenter = this.camera.position.clone().negate();
      const proj = toCenter.dot(dir);
      const closestSq = toCenter.lengthSq() - proj * proj;
      if (closestSq > 1.02 * 1.02) continue; // behind the limb — unreachable
      return (h.object.userData.region as string) ?? null;
    }
    return null;
  }

  private tap(e: PointerEvent): void {
    const name = this.castAt(e);
    if (name) {
      this.setSelected(name);
      this.opts.onSelect?.(name);
    }
  }

  private hover(e: PointerEvent): void {
    const name = this.castAt(e);
    const canvas = this.renderer!.domElement;
    canvas.style.cursor = name ? 'pointer' : 'grab';
    if (name) {
      const rect = this.container.getBoundingClientRect();
      this.tip.style.display = 'block';
      this.tip.textContent = name;
      this.tip.style.left = `${e.clientX - rect.left + 14}px`;
      this.tip.style.top = `${e.clientY - rect.top - 10}px`;
    } else {
      this.hideTip();
    }
    this.opts.onHover?.(name);
  }

  private hideTip(): void {
    this.tip.style.display = 'none';
  }

  private observeResize(): void {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.max(50, this.container.clientWidth);
    const h = Math.max(50, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** No WebGL (or old GPU): the same choice as plain buttons. */
  private renderFallback(): void {
    const list = document.createElement('div');
    list.className = 'rf-globe-fallback';
    for (const region of LANDABLE_REGIONS) {
      const b = document.createElement('button');
      b.className = 'rf-pick' + (region.name === this.selected ? ' selected' : '');
      b.innerHTML = `<span class="pk-label"></span><span class="pk-tag"></span>`;
      (b.querySelector('.pk-label') as HTMLElement).textContent = region.name;
      (b.querySelector('.pk-tag') as HTMLElement).textContent = region.biome;
      b.addEventListener('click', () => {
        this.selected = region.name;
        list.querySelectorAll('.rf-pick').forEach((n) => n.classList.remove('selected'));
        b.classList.add('selected');
        this.opts.onSelect?.(region.name);
      });
      list.appendChild(b);
    }
    this.container.appendChild(list);
  }
}
