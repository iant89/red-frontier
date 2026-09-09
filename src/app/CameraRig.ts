import * as THREE from 'three';
import { WORLD_HALF } from '../sim/config';

/** Simple orbit camera: a target point + spherical offset. Pointer gestures drive it. */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 4, 0);
  theta = 0.85; // azimuth (radians)
  phi = 0.8; // polar angle from +Y
  radius = 170;

  private readonly minPhi = 0.12;
  private readonly maxPhi = 1.42;
  private readonly minRadius = 16;
  private readonly maxRadius = 1600;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.update();
  }

  update(): void {
    const dir = new THREE.Vector3(
      Math.sin(this.phi) * Math.sin(this.theta),
      Math.cos(this.phi),
      Math.sin(this.phi) * Math.cos(this.theta),
    );
    this.camera.position.copy(this.target).addScaledVector(dir, this.radius);
    if (this.camera.position.y < 10) this.camera.position.y = 10;
    this.camera.lookAt(this.target);
  }

  /** dTheta/dPhi in radians (drag camera around the target). */
  rotate(dTheta: number, dPhi: number): void {
    this.theta -= dTheta;
    this.phi = Math.min(this.maxPhi, Math.max(this.minPhi, this.phi - dPhi));
  }

  dolly(factor: number): void {
    this.radius = Math.min(
      this.maxRadius,
      Math.max(this.minRadius, this.radius * factor),
    );
  }

  /** Translate the camera target so the world under the cursor follows the drag. */
  panByPixels(dxPx: number, dyPx: number, viewH: number): void {
    const scale =
      (2 * this.radius * Math.tan((this.camera.fov * Math.PI) / 360)) / viewH;

    // world axes aligned to the current view
    const right = new THREE.Vector3();
    this.camera.getWorldDirection(right);
    right.cross(this.camera.up).normalize();
    right.y = 0;
    right.normalize();

    // horizontal "away" direction (camera -> target projected on ground)
    const away = new THREE.Vector3()
      .subVectors(this.target, this.camera.position);
    away.y = 0;
    away.normalize();

    // dragging right/down pulls content right/down => target moves opposite on X axis
    // and toward the viewer (negative away) when dragging down.
    const offset = new THREE.Vector3()
      .addScaledVector(right, -dxPx * scale)
      .addScaledVector(away, dyPx * scale);
    this.target.add(offset);
    this.target.y = 4;
    const lim = WORLD_HALF - 24;
    this.target.x = Math.max(-lim, Math.min(lim, this.target.x));
    this.target.z = Math.max(-lim, Math.min(lim, this.target.z));
  }

  /** Pixel drag (single pointer) rotates the camera. */
  rotateByPixels(dxPx: number, dyPx: number, viewW: number, viewH: number): void {
    this.rotate((dxPx / viewW) * 2.6, (dyPx / viewH) * 1.9);
  }
}
