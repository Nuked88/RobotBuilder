// Navigation cube in the corner of the stage, like the one in Fusion 360:
// click a face, an edge or a corner and the main camera swings round to look from there.
import * as THREE from 'three';

const FACES = [
  { n: [0, -1, 0], text: 'FRONTE', up: [0, 0, 1] },
  { n: [0, 1, 0], text: 'RETRO', up: [0, 0, 1] },
  { n: [0, 0, 1], text: 'SOPRA', up: [0, 1, 0] },
  { n: [0, 0, -1], text: 'SOTTO', up: [0, -1, 0] },
  { n: [-1, 0, 0], text: 'SINISTRA', up: [0, 0, 1] },
  { n: [1, 0, 0], text: 'DESTRA', up: [0, 0, 1] },
];

export class ViewCube {
  constructor(container, view) {
    this.view = view;
    const size = 112;
    this.size = size;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.setSize(size, size);
    r.domElement.className = 'viewcube';
    r.domElement.setAttribute('aria-label', 'Cubo di navigazione: clicca una faccia, uno spigolo o un angolo per girare la vista');
    container.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(-1, -2, 3);
    this.scene.add(key);

    // 26 pieces: 6 faces, 12 edges, 8 corners. Each one knows the view direction it stands for.
    this.pieces = [];
    const inner = 0.62, rim = 0.19, off = inner / 2 + rim / 2;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue;
      const kind = Math.abs(x) + Math.abs(y) + Math.abs(z); // 1 face, 2 edge, 3 corner
      const g = new THREE.BoxGeometry(x ? rim : inner, y ? rim : inner, z ? rim : inner);
      const base = kind === 1 ? 0xffffff : kind === 2 ? 0xe6e9ee : 0xd5dae1;
      const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.7 });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x * off, y * off, z * off);
      mesh.userData = { dir: new THREE.Vector3(x, y, z), base };
      this.scene.add(mesh);
      this.pieces.push(mesh);
    }
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.0, 1.0, 1.0)), new THREE.LineBasicMaterial({ color: 0x8b939e }));
    this.scene.add(outline);
    for (const f of FACES) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ map: labelTexture(f.text), transparent: true, depthWrite: false }));
      const n = new THREE.Vector3(...f.n);
      plane.position.copy(n).multiplyScalar(0.503);
      plane.up.set(...f.up);
      plane.lookAt(n.clone().multiplyScalar(2));
      plane.raycast = () => {}; // clicks go to the piece underneath
      this.scene.add(plane);
    }

    this.ray = new THREE.Raycaster();
    this.hover = null;
    const el = r.domElement;
    const pick = (e) => {
      const b = el.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), this.camera);
      return this.ray.intersectObjects(this.pieces)[0]?.object || null;
    };
    el.addEventListener('pointermove', (e) => this.setHover(pick(e)));
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('click', (e) => {
      const p = pick(e);
      if (p) this.view.animateView(p.userData.dir.clone());
    });
  }

  setHover(p) {
    if (this.hover === p) return;
    if (this.hover) this.hover.material.color.set(this.hover.userData.base);
    this.hover = p;
    if (p) p.material.color.set(0xf2b51c);
    this.renderer.domElement.style.cursor = p ? 'pointer' : 'default';
  }

  render() {
    const main = this.view.camera;
    const dir = main.position.clone().sub(this.view.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(3.9));
    this.camera.up.copy(main.up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2f36';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let px = 64;
  do { g.font = `700 ${px}px Archivo, "Helvetica Neue", Arial, sans-serif`; px -= 2; } while (g.measureText(text).width > 230 && px > 20);
  g.fillText(text, 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
