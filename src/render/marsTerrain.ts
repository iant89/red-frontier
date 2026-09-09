import * as THREE from 'three';

export interface MarsPbrMaps {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  metallic: THREE.Texture;
  ao: THREE.Texture;
  height: THREE.Texture;
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
 * the albedo map is used as grain so the painted crater does not tile.
 */
export function makeMarsTerrainMaterial(maps: MarsPbrMaps, anisotropy = 8): THREE.MeshStandardMaterial {
  prep(maps.albedo, true, anisotropy);
  prep(maps.normal, false, anisotropy);
  prep(maps.roughness, false, anisotropy);
  prep(maps.metallic, false, anisotropy);
  prep(maps.ao, false, anisotropy);
  prep(maps.height, false, anisotropy);

  const mat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughnessMap: maps.roughness,
    roughness: 1,
    metalnessMap: maps.metallic,
    metalness: 0.12,
    aoMap: maps.ao,
    aoMapIntensity: 0.85,
    bumpMap: maps.height,
    bumpScale: 0.28,
    vertexColors: true,
    color: 0xffffff,
  });
  mat.customProgramCacheKey = () => 'mars-pbr-sheet-v3';
  mat.onBeforeCompile = (shader) => {
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

export function makeMarsFallbackMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.03,
  });
}
