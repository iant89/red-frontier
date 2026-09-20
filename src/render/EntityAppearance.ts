/** Paint only designated/body surfaces. Never touch shared template materials. */
import * as THREE from 'three';
import { rebindLightTargets } from './ModelRegistry';
export function applyEntityPaint(
  root: THREE.Object3D,
  paint: string | null | undefined,
): void {
  const value = paint ?? '';
  if (root.userData.appliedPaint === value) return;
  root.userData.appliedPaint = value;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o.material;
    if (Array.isArray(m) || !(m instanceof THREE.MeshStandardMaterial)) return;
    if (o.userData.paintable === undefined) {
      const hsl = { h: 0, s: 0, l: 0 };
      m.color.getHSL(hsl);
      o.userData.paintable =
        !m.transparent &&
        m.emissive.getHex() === 0 &&
        hsl.s < 0.4 &&
        hsl.l > 0.25 &&
        !/lamp|strobe|marker|sensor|solarPanel/i.test(o.name);
    }
    if (!o.userData.paintable) return;
    if (o.userData.factoryColor === undefined) {
      const base = o.userData.baseColor;
      o.userData.factoryColor =
        base instanceof THREE.Color ? base.getHex() : m.color.getHex();
      o.material = m.clone();
    }
    const mat = o.material as THREE.MeshStandardMaterial;
    const color = new THREE.Color(value || o.userData.factoryColor);
    mat.color.copy(color);
    o.userData.baseColor = color.clone();
    o.userData.brightness = undefined;
  });
}
/** An independently disposable preview clone. Textures stay borrowed; geometry
 * and materials are owned. Reset world transforms and dynamic dimming. */
export function clonePreviewModel(source: THREE.Object3D): THREE.Object3D {
  const model = source.clone(true);
  rebindLightTargets(source, model);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(1);
  model.visible = true;
  model.traverse((o) => {
    if (o instanceof THREE.Light) o.visible = false;
    if (
      !(
        o instanceof THREE.Mesh ||
        o instanceof THREE.Line ||
        o instanceof THREE.Points
      )
    )
      return;
    o.geometry = o.geometry.clone();
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => m.clone())
      : o.material.clone();
    const m = o.material as THREE.MeshStandardMaterial;
    if (m.color && o.userData.factoryColor !== undefined)
      m.color.setHex(o.userData.factoryColor);
    delete o.userData.baseColor;
    delete o.userData.brightness;
  });
  delete model.userData.appliedPaint;
  return model;
}

/** Dispose only resources owned by clonePreviewModel (or the preview scene).
 * Textures remain borrowed from the live model and must never be disposed here. */
export function disposePreviewResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    if (
      !(
        o instanceof THREE.Mesh ||
        o instanceof THREE.Line ||
        o instanceof THREE.Points
      )
    )
      return;
    geometries.add(o.geometry);
    for (const material of Array.isArray(o.material)
      ? o.material
      : [o.material])
      materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
