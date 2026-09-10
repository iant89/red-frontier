import * as THREE from 'three';

export interface MarsPbrMaps {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  metallic: THREE.Texture;
  ao: THREE.Texture;
  height: THREE.Texture;
}

export interface MarsTerrainOptions {
  /**
   * A world-spanning macro albedo (composed from the source imagery — never
   * tiled). When present, the colour map samples this once across the whole
   * terrain while normal/roughness/bump keep their fine tiling; the net read
   * is a landscape, not a wallpaper.
   */
  macro?: THREE.Texture;
  /** Full width of the playable square in metres (macro UV = position/size). */
  worldSize?: number;
}

function prep(tex: THREE.Texture, color: boolean, anisotropy: number): THREE.Texture {
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * PBR Martian ground. The 2×3 sheet is one landscape in six channels —
 * albedo, height, normal, roughness, metallic, AO — not six albedos.
 * Geological vertex colour owns the palette (dust / sand / bedrock / …);
 * the imagery supplies grain. With a `macro` map the albedo is stretched
 * once across the entire window (a composed, non-repeating landscape), while
 * the other channels keep their fine tiling for surface bite.
 */
export function makeMarsTerrainMaterial(
  maps: MarsPbrMaps,
  anisotropy = 8,
  opts: MarsTerrainOptions = {},
): THREE.MeshStandardMaterial {
  prep(maps.albedo, true, anisotropy);
  prep(maps.normal, false, anisotropy);
  prep(maps.roughness, false, anisotropy);
  prep(maps.metallic, false, anisotropy);
  prep(maps.ao, false, anisotropy);
  prep(maps.height, false, anisotropy);

  const macro = opts.macro ?? null;
  if (macro) {
    macro.wrapS = THREE.ClampToEdgeWrapping;
    macro.wrapT = THREE.ClampToEdgeWrapping;
    macro.colorSpace = THREE.SRGBColorSpace;
    macro.minFilter = THREE.LinearMipmapLinearFilter;
    macro.anisotropy = anisotropy;
    macro.generateMipmaps = true;
    macro.needsUpdate = true;
  }

  const mat = new THREE.MeshStandardMaterial({
    map: macro ?? maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughnessMap: maps.roughness,
    roughness: 1,
    metalnessMap: maps.metallic,
    metalness: 0.12,
    aoMap: maps.ao,
    aoMapIntensity: 0.85,
    bumpMap: maps.height,
    bumpScale: 0.22,
    vertexColors: true,
    color: 0xffffff,
  });
  mat.customProgramCacheKey = () => (macro ? 'mars-pbr-macro-v1' : 'mars-pbr-sheet-v3');
  mat.onBeforeCompile = (shader) => {
    if (macro) {
      // The macro map is addressed by world position — one non-tiling sweep
      // across the whole window — while normal/roughness/bump keep vUv tiling.
      shader.uniforms.uRfInvWorldSize = { value: 1 / Math.max(1, opts.worldSize ?? 1280) };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vRfMacroUv;
          uniform float uRfInvWorldSize;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          vRfMacroUv = clamp(position.xz * uRfInvWorldSize + 0.5, 0.0, 1.0);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vRfMacroUv;`,
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vRfMacroUv );
            diffuseColor *= sampledDiffuseColor;
          #endif`,
        );
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `// Geology tints the PBR albedo instead of multiplying it twice.
      {
        float lum = dot(diffuseColor.rgb, vec3(0.33, 0.42, 0.25));
        vec3 geo = vColor;
        diffuseColor.rgb = geo * mix(0.7, 1.25, clamp(lum, 0.0, 1.0));
      }`,
    );
  };
  return mat;
}

/**
 * Compose the world-spanning macro albedo out of the source Mars imagery:
 * the image is cut into random crops, rotated/flipped per patch, and laid
 * down on a grid with soft overlap, so adjacent ground never repeats the
 * same stamp. Deterministic per world seed. The result is stretched once
 * across the terrain — the imagery generates the landscape instead of
 * tiling it a million times.
 */
export function composeMacroAlbedo(
  source: THREE.Texture,
  worldSeed: number,
  size = 1024,
): THREE.CanvasTexture | null {
  const img = source.image as TexImageSource & { width?: number; height?: number } | undefined;
  if (!img || !img.width || !img.height) return null;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return null; // no DOM (headless) — the tiled fallback still works
  }
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;

  // Deterministic stream — same world seed, same landscape.
  let s = (worldSeed ^ 0xa1bed0) >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Base wash: the whole image, softened, so no patch can leave a hole.
  try {
    g.filter = 'blur(2px) brightness(0.98)';
  } catch {
    /* filter is a nicety */
  }
  g.drawImage(img as CanvasImageSource, 0, 0, size, size);
  try {
    g.filter = 'none';
  } catch {
    /* ignore */
  }

  const N = 7; // 7×7 patches ≈ one geological province every ~180 m
  const cell = size / N;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      // A random crop out of the source — the heart of it, never the seams.
      const sw = img.width * (0.34 + rnd() * 0.5);
      const sh = img.height * (0.34 + rnd() * 0.5);
      const sx = (img.width - sw) * (0.08 + rnd() * 0.84);
      const sy = (img.height - sh) * (0.08 + rnd() * 0.84);
      const rot = ((rnd() * 4) | 0) * (Math.PI / 2);
      const flip = rnd() < 0.5 ? -1 : 1;
      const bright = 0.9 + rnd() * 0.2;
      const d = cell * (1.08 + rnd() * 0.1);
      g.save();
      g.translate((ix + 0.5) * cell, (iy + 0.5) * cell);
      g.rotate(rot);
      g.scale(flip, 1);
      try {
        g.filter = `brightness(${bright.toFixed(3)})`;
      } catch {
        /* ignore */
      }
      g.drawImage(img as CanvasImageSource, sx, sy, sw, sh, -d / 2, -d / 2, d, d);
      g.restore();
      try {
        g.filter = 'none';
      } catch {
        /* ignore */
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function makeMarsFallbackMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.03,
  });
}
