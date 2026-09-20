/** Self-contained turntable. Uses UI time, not simulation time, and tears down
 * its RAF, observer and WebGL context on close. Never disposes borrowed textures. */
import * as THREE from 'three';
import { applyEntityPaint, disposePreviewResources } from './EntityAppearance';
export class EntityPreview {
  private renderer!: THREE.WebGLRenderer;
  private disposed = false;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private turntable = new THREE.Group();
  private frame = 0;
  private last = 0;
  private observer?: ResizeObserver;
  private distance = 8;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    .matches;
  constructor(
    private root: HTMLElement,
    private model: THREE.Object3D,
  ) {
    // Take ownership before creating a context so partial construction is safe.
    this.turntable.add(model);
    this.scene.add(this.turntable);
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      this.renderer.setClearColor(0x10171b, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.domElement.setAttribute(
        'aria-label',
        'Rotating 3D model preview',
      );
      root.append(this.renderer.domElement);
      const box = new THREE.Box3().setFromObject(model),
        size = box.getSize(new THREE.Vector3()),
        center = box.getCenter(new THREE.Vector3());
      const scale = 5 / Math.max(size.x, size.y, size.z, 0.1);
      model.position.sub(center);
      model.position.y += size.y / 2;
      this.turntable.scale.setScalar(scale);
      const ambient = new THREE.HemisphereLight(0xe6f6ff, 0x775039, 2.5);
      this.scene.add(ambient);
      const key = new THREE.DirectionalLight(0xffdec0, 4);
      key.position.set(6, 9, 5);
      this.scene.add(key);
      const fill = new THREE.DirectionalLight(0x71cfff, 2);
      fill.position.set(-6, 3, -4);
      this.scene.add(fill);
      const grid = new THREE.GridHelper(12, 16, 0xa7794d, 0x263b43);
      grid.position.y = -0.04;
      this.scene.add(grid);
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(root);
      this.resize();
      const render = (now: number) => {
        const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
        this.last = now;
        if (!this.reduced) this.turntable.rotation.y += dt * 0.18;
        this.renderer.render(this.scene, this.camera);
        this.frame = requestAnimationFrame(render);
      };
      this.frame = requestAnimationFrame(render);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  paint(value: string | null): void {
    applyEntityPaint(this.model, value);
  }
  private resize(): void {
    const w = Math.max(1, this.root.clientWidth),
      h = Math.max(1, this.root.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.distance = Math.max(10, 9 / Math.min(1, this.camera.aspect));
    this.camera.position.set(
      this.distance * 0.72,
      this.distance * 0.5,
      this.distance * 0.72,
    );
    this.camera.lookAt(0, 2, 0);
    this.camera.updateProjectionMatrix();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    disposePreviewResources(this.scene);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
  }
}
