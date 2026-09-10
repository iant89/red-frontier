/**
 * The GPU side of the particle system: a single `THREE.Points` with a custom
 * shader that reads per-particle colour, world size and envelope alpha.
 *
 * Everything here is constructed from typed arrays — the soft round sprite is
 * a procedural `DataTexture`, not a canvas or an image file — so this module
 * never touches the DOM and can be exercised headlessly (geometry + material
 * construction, buffer sync, draw range). Only actual rendering needs a GPU.
 */

import * as THREE from 'three';
import type { ParticlePool } from './ParticlePool';

/**
 * A soft dust mote: radial falloff with a slightly irregular, seeded edge so
 * a field of them doesn't read as perfect discs. Deterministic — the same
 * bytes every boot.
 */
export function makeSoftSprite(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let s = 0x2f6e2b1;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const WOBBLES = 24;
  const wob = new Float32Array(WOBBLES);
  for (let i = 0; i < WOBBLES; i++) wob[i] = 0.82 + rnd() * 0.32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / (size - 1) - 0.5) * 2;
      const dy = (y / (size - 1) - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const sector =
        Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * WOBBLES) % WOBBLES;
      const d = r / wob[sector];
      const a = Math.pow(Math.max(0, 1 - d), 1.9);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 244;
      data[o + 2] = 230;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
uniform float uScale;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = aSize * uScale / max(1.0, -mv.z);
  gl_PointSize = min(px, 256.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 tex = texture2D(uMap, gl_PointCoord);
  float a = tex.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * tex.rgb, a);
}
`;

export class ParticlePoints {
  readonly points: THREE.Points;
  readonly max: number;

  private readonly geo = new THREE.BufferGeometry();
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly uniforms: { uMap: { value: THREE.Texture }; uScale: { value: number } };
  private readonly material: THREE.ShaderMaterial;
  private lastCount = 0;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
    const n = this.max;
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    // Updated wholesale every frame — hint the driver accordingly.
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aAlpha', this.alphaAttr);
    this.geo.setDrawRange(0, 0);

    this.uniforms = { uMap: { value: makeSoftSprite() }, uScale: { value: 800 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.material);
    // The field spans the camera box and is re-centred every frame — it must
    // never be culled as a whole.
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  /**
   * Calibrate world-size → pixel projection. `viewportHeightPx` is the drawing
   * buffer height (CSS height × pixel ratio); call on resize.
   */
  setPerspective(viewportHeightPx: number, fovDeg: number): void {
    const half = ((fovDeg * Math.PI) / 180 / 2) || 0.001;
    this.uniforms.uScale.value = Math.max(1, viewportHeightPx) / (2 * Math.tan(half));
  }

  get pixelScale(): number {
    return this.uniforms.uScale.value;
  }

  /** Compact the pool into the GPU buffers; returns particles drawn. */
  sync(pool: ParticlePool): number {
    const n = pool.writeRender(
      this.posAttr.array as Float32Array,
      this.colAttr.array as Float32Array,
      this.sizeAttr.array as Float32Array,
      this.alphaAttr.array as Float32Array,
    );
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.geo.setDrawRange(0, n);
    this.lastCount = n;
    return n;
  }

  /** Particles drawn by the last `sync`. */
  get count(): number {
    return this.lastCount;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    (this.uniforms.uMap.value as THREE.DataTexture).dispose();
  }
}
