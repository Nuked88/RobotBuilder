// three.js rendering of the document (edit pose) and of the running simulation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import {
  P, BEAM_W, HOLE_R, BOARD, FLOOR, LAYER, pinMembers, mountOf, anchorPos, BEAM_COLORS, GUIDE_R, GUIDE_OFF, isBeam, isBlock, isServo,
  fam, NVEC, toWorld, toFam, famQuat, partPose, docBounds, shaftMembers, servoSpec, servoLocalBox, SERVO_MODELS, SERVO_GAP, wheelWorld,
} from './model.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
const setQuat = (o, q) => o.quaternion.set(q[1], q[2], q[3], q[0]); // [w, x, y, z] -> three

export class View {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    const scene = (this.scene = new THREE.Scene());
    this.setTheme(false);
    this.persp = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.persp.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    this.orthoHalf = 150; // half height of the orthographic view (mm) at zoom 1
    this.persp.position.set(0, -500, 150);
    const cam = (this.camera = this.persp);
    this.controls = new OrbitControls(cam, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.frontView(false);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa0a8, 1.9);
    hemi.position.set(0, -1, 1.2);
    scene.add(hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 1.6));
    sun.position.set(-150, -260, 380);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 300, bottom: -100, near: 10, far: 1200 });
    sun.shadow.bias = -0.0004;
    scene.add(sun);

    this.buildBoard();
    this.world = new THREE.Group();
    scene.add(this.world);
    this.overlay = new THREE.Group();
    scene.add(this.overlay);

    this.beamGeo = new Map();
    this.objects = new Map(); // id -> {group, kind}
    this.stringLines = new Map();
    this.labelObjs = [];
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  setTheme(dark) {
    this.dark = dark;
    this.scene.background = new THREE.Color(dark ? 0x1b1e23 : 0xe9ecef);
    if (this.boardMat) {
      this.boardMat.color.set(dark ? 0x4a515b : 0xe4e7ec);
      this.holeMat.color.set(dark ? 0x30353c : 0xb4bac3);
    }
  }

  // Look at the board from the front, framing what has been built (or the middle of the board).
  frontView(animate = true) { this.frame(new THREE.Vector3(0, -1, 0), animate); }
  // Three-quarter view from above: the natural one for building with blocks.
  isoView(animate = true) { this.frame(new THREE.Vector3(-0.6, -1, 0.72), animate); }

  frame(dir, animate = true) {
    const b = this.doc ? docBounds(this.doc) : null;
    dir = dir.clone().normalize();
    const front = Math.abs(dir.y) > 0.99;
    const c = new THREE.Vector3(0, front ? -16 : -64, front ? 120 : 24);
    let size = front ? 260 : 190;
    if (b) {
      c.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
      size = front ? Math.max(120, sx * 1.25, sz * 1.4) + 40 : Math.max(140, Math.hypot(sx, sy, sz) * 1.25) + 40;
    }
    this.animateView(dir, { target: c, size, animate });
  }

  // Distance that frames `size` mm in the perspective camera.
  distFor(size) { return size / (2 * Math.tan((this.persp.fov * Math.PI) / 360)); }

  // Swing the camera round to look along -dir (dir points from the target to the camera).
  // Keeps the current distance unless a size to frame is given.
  animateView(dir, { target = this.controls.target.clone(), size = null, animate = true } = {}) {
    dir = dir.clone().normalize();
    if (Math.abs(dir.z) > 0.999) dir.set(0, dir.z > 0 ? -1e-3 : 1e-3, Math.sign(dir.z)).normalize(); // exact top/bottom
    const cur = this.camera.position.clone().sub(this.controls.target);
    const fromDist = cur.length();
    const toDist = size ? this.distFor(size) : fromDist;
    if (size && this.camera === this.ortho) { this.orthoHalf = size / 2; this.ortho.zoom = 1; this.updateOrtho(); }
    const a = {
      q: new THREE.Quaternion().setFromUnitVectors(cur.clone().normalize(), dir),
      from: cur.clone().normalize(), fromDist, toDist,
      tf: this.controls.target.clone(), tt: target.clone(), t0: performance.now(), dur: animate ? 450 : 0,
    };
    this.camAnim = a;
    if (!animate) this.stepCamAnim();
  }

  stepCamAnim() {
    const a = this.camAnim;
    if (!a) return;
    const t = a.dur ? Math.min(1, (performance.now() - a.t0) / a.dur) : 1;
    const e = 1 - Math.pow(1 - t, 3);
    const q = new THREE.Quaternion().slerp(a.q, e);
    const dir = a.from.clone().applyQuaternion(q);
    const target = a.tf.clone().lerp(a.tt, e);
    const dist = a.fromDist + (a.toDist - a.fromDist) * e;
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    if (t >= 1) { this.camAnim = null; this.controls.update(); }
  }

  setOrthographic(on) {
    if (on === (this.camera === this.ortho)) return;
    const target = this.controls.target;
    const off = this.camera.position.clone().sub(target);
    if (on) {
      this.orthoHalf = off.length() * Math.tan((this.persp.fov * Math.PI) / 360);
      this.ortho.zoom = 1;
      this.ortho.position.copy(this.persp.position);
      this.camera = this.ortho;
      this.updateOrtho();
    } else {
      const half = this.orthoHalf / this.ortho.zoom;
      const dist = half / Math.tan((this.persp.fov * Math.PI) / 360);
      this.persp.position.copy(target).addScaledVector(off.normalize(), dist);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.camera.lookAt(target);
    this.controls.update();
  }

  updateOrtho() {
    const asp = this.size ? this.size.w / Math.max(1, this.size.h) : 1;
    const h = this.orthoHalf;
    Object.assign(this.ortho, { left: -h * asp, right: h * asp, top: h, bottom: -h });
    this.ortho.updateProjectionMatrix();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.size = { w, h };
    this.persp.aspect = w / Math.max(1, h);
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    for (const l of this.stringLines.values()) { l.material.resolution.set(w, h); l.userData.xray.material.resolution.set(w, h); }
  }

  buildBoard() {
    const w = BOARD.x1 - BOARD.x0 + 2 * P, h = BOARD.z1 + P - FLOOR.z;
    this.boardMat = new THREE.MeshStandardMaterial({ color: 0xe4e7ec, roughness: 0.85 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, BEAM_W, h), this.boardMat);
    board.position.set((BOARD.x0 + BOARD.x1) / 2, 0, FLOOR.z + h / 2);
    board.receiveShadow = true;
    board.userData.surface = 'board';
    this.scene.add(board);
    this.holeMat = new THREE.MeshBasicMaterial({ color: 0xb4bac3 });
    const disc = new THREE.CircleGeometry(HOLE_R * 0.6, 16);
    disc.rotateX(Math.PI / 2);
    const nx = Math.round((BOARD.x1 - BOARD.x0) / P) + 1, nz = Math.round((BOARD.z1 - BOARD.z0) / P) + 1;
    const holes = new THREE.InstancedMesh(disc, this.holeMat, nx * nz);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      m.makeTranslation(BOARD.x0 + i * P, -BEAM_W / 2 - 0.05, BOARD.z0 + j * P);
      holes.setMatrixAt(k++, m);
    }
    holes.raycast = () => {};
    this.scene.add(holes);
    // baseplate in front of the wall: the ground to build up from
    const depth = BEAM_W / 2 - (FLOOR.y0 - P);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, depth, P), this.boardMat);
    plate.position.set((FLOOR.x0 + FLOOR.x1) / 2, BEAM_W / 2 - depth / 2, FLOOR.z - P / 2);
    plate.receiveShadow = true;
    plate.userData.surface = 'floor';
    this.scene.add(plate);
    const ny = Math.round((FLOOR.y1 - FLOOR.y0) / P) + 1;
    const fholes = new THREE.InstancedMesh(new THREE.CircleGeometry(HOLE_R * 0.6, 16), this.holeMat, nx * ny);
    k = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      m.makeTranslation(FLOOR.x0 + i * P, FLOOR.y0 + j * P, FLOOR.z + 0.05);
      fholes.setMatrixAt(k++, m);
    }
    fholes.raycast = () => {};
    this.scene.add(fholes);
    this.surfaces = [board, plate];
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.18 }));
    floor.position.z = FLOOR.z - P;
    floor.receiveShadow = true;
    floor.raycast = () => {};
    this.scene.add(floor);
  }

  beamGeometry(n) {
    if (this.beamGeo.has(n)) return this.beamGeo.get(n);
    const len = (n - 1) * P, r = BEAM_W / 2;
    const s = new THREE.Shape();
    s.moveTo(0, -r);
    s.lineTo(len, -r);
    s.absarc(len, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(0, r);
    s.absarc(0, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
    for (let i = 0; i < n; i++) {
      const h = new THREE.Path();
      h.absarc(i * P, 0, HOLE_R, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: BEAM_W - 0.6, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 2, curveSegments: 18 });
    g.rotateX(Math.PI / 2);
    g.translate(0, (BEAM_W - 0.6) / 2, 0);
    this.beamGeo.set(n, g);
    return g;
  }

  // Cable guides: a small eyelet on each side of the beam next to every hole, ring axis along the
  // beam, so a string can run along the beam and be kept in place.
  guideGeometry(n) {
    this.guideGeo ||= new Map();
    if (this.guideGeo.has(n)) return this.guideGeo.get(n);
    const parts = [];
    for (let i = 0; i < n; i++) for (const side of [1, -1]) {
      const t = new THREE.TorusGeometry(GUIDE_R, 0.42, 8, 16);
      t.rotateY(Math.PI / 2);
      t.translate(i * P, 0, side * GUIDE_OFF);
      parts.push(t);
    }
    const g = mergeGeometries(parts);
    parts.forEach((t) => t.dispose());
    this.guideGeo.set(n, g);
    return g;
  }

  // A block: one box, each cell face drawn with its hole.
  blockGeometry(s) {
    this.blockGeo ||= new Map();
    const key = s.join('x');
    if (this.blockGeo.has(key)) return this.blockGeo.get(key);
    const g = new THREE.BoxGeometry(s[0] * P - 0.3, s[1] * P - 0.3, s[2] * P - 0.3);
    g.translate(((s[0] - 1) * P) / 2, ((s[1] - 1) * P) / 2, ((s[2] - 1) * P) / 2);
    // faces come as +x -x +y -y +z -z: repeat the one-cell picture once per cell
    const uv = g.attributes.uv, reps = [[s[2], s[1]], [s[2], s[1]], [s[0], s[2]], [s[0], s[2]], [s[0], s[1]], [s[0], s[1]]];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) uv.setXY(f * 4 + v, uv.getX(f * 4 + v) * reps[f][0], uv.getY(f * 4 + v) * reps[f][1]);
    g.userData.edges = new THREE.EdgesGeometry(g);
    this.blockGeo.set(key, g);
    return g;
  }

  blockTexture() {
    if (this.blockTex) return this.blockTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 128, 128);
    x.strokeStyle = 'rgba(0,0,0,.16)'; x.lineWidth = 3; x.strokeRect(0, 0, 128, 128);
    x.fillStyle = 'rgba(0,0,0,.42)'; x.beginPath(); x.arc(64, 64, 128 * (HOLE_R / P) * 0.92, 0, 7); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 3; x.beginPath(); x.arc(64, 64, 128 * (HOLE_R / P) + 2, 0, 7); x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return (this.blockTex = t);
  }

  labelTexture(text) {
    this.labelTex ||= new Map();
    if (this.labelTex.has(text)) return this.labelTex.get(text);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 80;
    const x = c.getContext('2d');
    x.fillStyle = '#f4f5f7'; x.beginPath(); x.roundRect(2, 2, 252, 76, 12); x.fill();
    x.fillStyle = '#16181c'; x.font = '700 46px Archivo, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 128, 43);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.labelTex.set(text, t);
    return t;
  }

  // The look of a servo in its own frame (shaft at the origin pointing along -y, case behind it).
  // Returns the case and, apart, what turns with the shaft.
  servoMeshes(part) {
    const sp = servoSpec(part) || SERVO_MODELS.SG90, b = servoLocalBox(part);
    const body = new THREE.Group(), horn = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.5 });
    const topMat = new THREE.MeshStandardMaterial({ color: sp.top, roughness: 0.5 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2), mat);
    box.position.set(...b.c);
    const tabs = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2 + sp.body[1] * 0.85, 2.4, b.h[2] * 2), mat);
    tabs.position.set(b.c[0], b.c[1] - b.h[1] + 5.5, 0);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(b.h[2] * 0.92, b.h[2] * 0.92, SERVO_GAP + 1.2, 28), topMat);
    boss.position.set(0, b.c[1] - b.h[1] - (SERVO_GAP + 1.2) / 2 + 1.2, 0);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, 1.2, b.h[2] * 2), topMat);
    cap.position.set(b.c[0], b.c[1] - b.h[1] + 0.6, 0);
    body.add(box, tabs, cap, boss);
    for (const side of [1, -1]) {
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(b.h[0] * 1.5, 26), Math.min(b.h[0] * 1.5, 26) * 0.3125), new THREE.MeshBasicMaterial({ map: this.labelTexture(sp.name) }));
      lab.position.set(b.c[0], b.c[1] + b.h[1] * 0.25, side * (b.h[2] + 0.06));
      lab.rotation.set(0, side === 1 ? 0 : Math.PI, Math.PI);
      lab.userData.flat = true;
      body.add(lab);
    }
    const metal = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.35, metalness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.5 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_R * 0.88, HOLE_R * 0.88, LAYER + 2.4, 12), metal);
    shaft.position.y = -0.2;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 1.1, 28), white);
    disc.position.y = LAYER / 2 + 0.55;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(15, 1.1, 5), white);
    arm.position.set(3, LAYER / 2 + 0.55, 0);
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4 }));
    screw.position.y = -LAYER / 2 - 1.5;
    horn.add(shaft, disc, arm, screw);
    return { body, horn, mat };
  }

  // ---------------------------------------------------------------- document
  rebuild(doc) {
    this.doc = doc;
    for (const o of this.objects.values()) o.group.removeFromParent();
    this.objects.clear();
    const horns = [];
    for (const p of doc.parts) {
      const g = new THREE.Group();
      let mat;
      if (isBlock(p)) {
        mat = new THREE.MeshStandardMaterial({ color: p.color || BEAM_COLORS[1], roughness: 0.55, map: this.blockTexture() });
        const geo = this.blockGeometry(p.s);
        g.add(new THREE.Mesh(geo, mat));
        const edges = new THREE.LineSegments(geo.userData.edges, this.edgeMat ||= new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
        edges.raycast = () => {};
        g.add(edges);
      } else if (isServo(p)) {
        const sm = this.servoMeshes(p);
        mat = sm.mat;
        g.add(sm.body);
        horns.push([p, sm.horn]);
      } else {
        mat = new THREE.MeshStandardMaterial({ color: p.color || BEAM_COLORS[(p.layer - 1) % BEAM_COLORS.length], roughness: 0.45, metalness: 0.0 });
        g.add(new THREE.Mesh(this.beamGeometry(p.holes), mat), new THREE.Mesh(this.guideGeometry(p.holes), mat));
      }
      g.traverse((m) => { if (m.isMesh) { m.castShadow = !m.userData.flat; m.receiveShadow = true; m.userData.id = p.id; m.userData.kind = 'part'; } });
      this.placePart(g, p);
      this.world.add(g);
      this.objects.set(p.id, { group: g, kind: 'part', mat, home: g });
    }
    // what turns with a servo shaft rides on the first piece it drives
    for (const [p, horn] of horns) {
      horn.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.userData.id = p.id; m.userData.kind = 'part'; } });
      const pose = partPose(p);
      horn.position.set(...pose.pos);
      setQuat(horn, pose.quat);
      const drives = shaftMembers(doc, p)[0];
      (drives ? this.objects.get(drives.id).group : this.objects.get(p.id).group).attach(horn);
    }
    for (const pin of doc.pins) this.objects.set(pin.id, { kind: 'pin', ...this.makePin(pin) });
    for (const pul of doc.pulleys) this.objects.set(pul.id, { kind: 'pulley', ...this.makeWheel(pul, 'pulley') });
    for (const w of doc.winches) this.objects.set(w.id, { kind: 'winch', ...this.makeWheel(w, 'winch') });
    this.applySchema();
    if (this.hidden) this.setHidden(this.hidden);
    this.syncStrings(null);
  }

  // Hide pieces from view (and from the mouse) without touching the design.
  setHidden(ids) {
    this.hidden = ids;
    for (const [id, o] of this.objects) o.group.visible = !ids.has(id);
  }

  // Schematic view: parts become ghosts, pulleys just their rim, strings thick and on top of everything,
  // each in its own colour, so what is connected to what reads at a glance.
  setSchema(on) {
    this.schema = on;
    this.sun.castShadow = !on;
    this.applySchema();
    for (const l of this.stringLines.values()) { l.material.depthTest = !on; l.material.needsUpdate = true; l.userData.xray.visible = !on; }
  }

  applySchema() {
    const on = !!this.schema;
    for (const o of this.objects.values()) {
      o.group.traverse((m) => {
        if (!m.isMesh) return;
        const mat = m.material;
        if (m.userData.base === undefined) m.userData.base = { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite, cast: m.castShadow };
        const b = m.userData.base;
        if (o.kind === 'pin') return;
        if (o.kind === 'pulley' && !m.userData.keep) { m.visible = !on; return; }
        mat.transparent = on ? true : b.transparent;
        mat.opacity = on ? (o.kind === 'part' ? 0.3 : 0.35) : b.opacity;
        mat.depthWrite = on ? false : b.depthWrite;
        m.castShadow = on ? false : b.cast;
        mat.needsUpdate = true;
      });
    }
  }

  placePart(g, p) {
    const pose = partPose(p);
    g.position.set(...pose.pos);
    setQuat(g, pose.quat);
  }

  // Pins/pulleys/winches ride on the front-most part they touch (so they follow it in the simulation).
  carrierFor(item) {
    if (item.kind === 'pinmem') {
      const mem = pinMembers(this.doc, item.pin).filter((m) => m.kind === 'part');
      return mem.length ? mem[mem.length - 1].part : null;
    }
    const mt = mountOf(this.doc, item);
    return mt.kind === 'part' ? mt.part : null;
  }

  // Put obj (already oriented for the world) at a world position, riding on carrier if there is one.
  attach(obj, carrier, worldPos) {
    obj.position.set(worldPos.x, worldPos.y, worldPos.z);
    if (carrier) this.objects.get(carrier.id).group.attach(obj);
    else this.world.add(obj);
  }

  makePin(pin) {
    const g = new THREE.Group();
    const lo = Math.min(pin.lo, pin.hi), hi = Math.max(pin.lo, pin.hi);
    const len = (hi - lo) * LAYER + BEAM_W + 1.2;
    const color = pin.type === 'weld' ? 0xb3261e : pin.type === 'servo' ? 0x1e5bd6 : 0x6d737c;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const shaft = new THREE.Mesh(pin.type === 'weld' ? new THREE.BoxGeometry(HOLE_R * 1.3, len, HOLE_R * 1.3) : new THREE.CylinderGeometry(HOLE_R * 0.92, HOLE_R * 0.92, len, 20), mat);
    if (pin.type === 'weld') shaft.rotation.y = Math.PI / 4;
    shaft.castShadow = true;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_R * 1.25, HOLE_R * 1.25, 1.0, 24), mat);
    head.position.y = -len / 2;
    g.add(shaft, head);
    if (pin.type === 'servo') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 10), new THREE.MeshStandardMaterial({ color: 0x1e5bd6, roughness: 0.6 }));
      body.position.set(0, -len / 2 - 3.5, 0);
      body.castShadow = true;
      g.add(body);
    }
    g.traverse((o) => { if (o.isMesh) o.userData = { id: pin.id, kind: 'pin' }; });
    setQuat(g, famQuat(fam(pin)));
    const carrier = this.carrierFor({ kind: 'pinmem', pin });
    this.attach(g, carrier, toWorld(fam(pin), pin.x, pin.z, (lo + hi) / 2));
    return { group: g, mat };
  }

  makeWheel(item, kind) {
    const g = new THREE.Group();
    const r = item.r;
    const w = BEAM_W - 0.8;
    if (kind === 'pulley') {
      // see-through, so the strings wrapped round it stay visible; a solid rim keeps its shape readable
      const mat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.35, transparent: true, opacity: 0.5, depthWrite: false });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w * 0.5, 32), mat);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(r + 1.2, 0.45, 8, 40), new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: 0.5 }));
      rim.rotation.x = Math.PI / 2;
      rim.userData.keep = true;
      g.add(rim);
      const fl1 = new THREE.Mesh(new THREE.CylinderGeometry(r + 1.2, r + 1.2, w * 0.25, 32), mat);
      const fl2 = fl1.clone();
      fl1.position.y = w * 0.375; fl2.position.y = -w * 0.375;
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_R * 0.9, HOLE_R * 0.9, w + LAYER, 16), new THREE.MeshStandardMaterial({ color: 0x6d737c }));
      axle.position.y = LAYER / 2;
      core.castShadow = false;
      g.add(core, fl1, fl2, axle);
      g.userData.mat = mat;
    } else {
      const mat = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.5 });
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 32), mat);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.4, 6), new THREE.MeshStandardMaterial({ color: 0xff9f1c, roughness: 0.4 }));
      const box = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, LAYER - 1, r * 2.6), new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.7 }));
      box.position.y = LAYER;
      g.add(drum, cap, box);
      g.userData.mat = mat;
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData = { id: item.id, kind }; } });
    setQuat(g, famQuat(fam(item), 0, item.dir || 1));
    const carrier = this.carrierFor(item);
    this.attach(g, carrier, wheelWorld(item));
    return { group: g, mat: g.userData.mat };
  }

  // ---------------------------------------------------------------- strings
  // paths: Map stringId -> array of [x,y,z] in mm (from the physics), or null to use straight anchor lines
  syncStrings(paths, tensions = {}, sim = null) {
    const doc = this.doc;
    const seen = new Set();
    for (const s of doc.strings) {
      seen.add(s.id);
      let pts = paths?.get(s.id);
      if (!pts) pts = s.anchors.map((a) => anchorPos(doc, a)).filter(Boolean).map((p) => [p.x, p.y, p.z]);
      if (pts.length < 2) continue;
      let line = this.stringLines.get(s.id);
      if (!line) {
        const mat = new LineMaterial({ linewidth: 3.2, worldUnits: false, dashed: false, dashSize: 3, gapSize: 2.5 });
        mat.resolution.set(this.size.w, this.size.h);
        line = new Line2(new LineGeometry(), mat);
        line.userData = { id: s.id, kind: 'string' };
        line.renderOrder = 3;
        // the same string drawn faintly through beams and pulleys, so its whole route stays readable
        const xmat = new LineMaterial({ linewidth: 2, worldUnits: false, dashed: false, dashSize: 3, gapSize: 2.5, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
        xmat.resolution.set(this.size.w, this.size.h);
        const xray = new Line2(line.geometry, xmat);
        xray.renderOrder = 2;
        line.userData.xray = xray;
        this.overlay.add(xray, line);
        this.stringLines.set(s.id, line);
      }
      const xray = line.userData.xray;
      const drawn = s.kind === 'elastic' ? zigzag(pts, line.userData) : pts;
      const flat = drawn.flat();
      if (line.geometry.attributes.instanceStart?.count !== drawn.length - 1) {
        line.geometry.dispose();
        line.geometry = new LineGeometry();
        xray.geometry = line.geometry;
      }
      line.geometry.setPositions(flat);
      line.computeLineDistances();
      const T = tensions[s.id];
      const style = stringStyle(s, T, sim, stringColor(doc, s), this.schema);
      for (const l of [line, xray]) {
        l.material.color.set(style.color);
        if (l.material.dashed !== style.dashed) { l.material.dashed = style.dashed; l.material.needsUpdate = true; }
      }
      line.material.linewidth = this.selectedId === s.id || this.hoverString === s.id ? style.width + 2.5 : style.width;
      line.material.depthTest = !this.schema;
      xray.visible = !this.schema;
      xray.material.linewidth = Math.max(1.5, style.width * 0.6);
      line.userData.pts = pts;
      this.updateMarks(s, line, pts, style.color, T, sim);
    }
    for (const [id, l] of this.stringLines) if (!seen.has(id)) { l.removeFromParent(); l.userData.xray.removeFromParent(); l.userData.marks?.removeFromParent(); l.userData.arrow?.removeFromParent(); l.userData.dots?.removeFromParent(); l.userData.slide?.removeFromParent(); l.geometry.dispose(); this.stringLines.delete(id); }
  }

  // Direction marks: small arrowheads fixed on the string material, every few millimetres from the end
  // tied to the mechanism, pointing towards the winch. When the winch reels in they ride along the
  // string towards it and disappear into the drum, so you see which way the string slides.
  // In the simulation an arrow on the tied end shows the pull on that part.
  updateMarks(s, line, pts, color, T, sim) {
    const winchAtStart = s.anchors[0]?.t === 'winch';
    const winchAtEnd = s.anchors[s.anchors.length - 1]?.t === 'winch';
    let marks = line.userData.marks;
    this.updateSliding(s, line, pts, sim, !winchAtStart && !winchAtEnd && s.kind !== 'elastic');
    if (!winchAtStart && !winchAtEnd) { if (marks) marks.visible = false; if (line.userData.arrow) line.userData.arrow.visible = false; return; }
    const path = winchAtStart ? pts : [...pts].reverse(); // from the winch to the tied end
    if (!marks) {
      const geo = new THREE.ConeGeometry(0.95, 2.6, 10);
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
      marks = new THREE.InstancedMesh(geo, mat, 160);
      marks.renderOrder = 5;
      marks.frustumCulled = false;
      marks.raycast = () => {};
      this.overlay.add(marks);
      line.userData.marks = marks;
    }
    marks.visible = true;
    marks.material.color.set(color);
    // arclength measured from the tied end
    const seg = [];
    let total = 0;
    for (let i = path.length - 1; i > 0; i--) {
      const a = path[i], b = path[i - 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      seg.push({ a, b, L, s0: total });
      total += L;
    }
    const spacing = 7, m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
    let n = 0, k = 0;
    for (let dist = spacing * 0.6; dist < total - 4 && n < 160; dist += spacing) {
      while (k < seg.length - 1 && dist > seg[k].s0 + seg[k].L) k++;
      const g = seg[k];
      if (!g || g.L < 1e-6) continue;
      const t = (dist - g.s0) / g.L;
      d.set(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]).normalize().multiplyScalar(s.wind === -1 ? -1 : 1); // the way the string slides as the drum turns
      q.setFromUnitVectors(up, d);
      m.compose(new THREE.Vector3(g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t, g.a[2] + (g.b[2] - g.a[2]) * t), q, new THREE.Vector3(1, 1, 1));
      marks.setMatrixAt(n++, m);
    }
    marks.count = n;
    marks.instanceMatrix.needsUpdate = true;

    // pull on the tied end
    let arrow = line.userData.arrow;
    const show = sim && T > 0.005 && path.length >= 2;
    if (!show) { if (arrow) arrow.visible = false; return; }
    if (!arrow) {
      arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 10, color, 4, 3);
      arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 6; o.raycast = () => {}; });
      this.overlay.add(arrow);
      line.userData.arrow = arrow;
    }
    arrow.visible = true;
    const end = path[path.length - 1], prev = path[path.length - 2];
    d.set(prev[0] - end[0], prev[1] - end[1], prev[2] - end[2]).normalize();
    arrow.position.set(end[0], end[1], end[2]);
    arrow.setDirection(d);
    const len = 6 + Math.min(1, T / (s.fmaxRef || 10)) * 26;
    arrow.setLength(len, 4.5, 3.2);
    arrow.setColor(color);
  }

  // Strings tied at both ends (the coupling cords) slide over their pulleys as the joints turn.
  // Dots fixed on the cord material, counted from its first end, ride along with it; in the
  // simulation a big arrow on each pulley shows which way the cord is running over it right now.
  updateSliding(s, line, pts, sim, on) {
    const ud = line.userData;
    if (!on) { if (ud.dots) ud.dots.visible = false; if (ud.slide) ud.slide.visible = false; return; }
    const color = stringColor(this.doc, s);
    const mk = (geo, max, order) => {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }), max);
      mesh.renderOrder = order; mesh.frustumCulled = false; mesh.raycast = () => {};
      this.overlay.add(mesh);
      return mesh;
    };
    if (!ud.dots) ud.dots = mk(new THREE.SphereGeometry(1.1, 10, 8), 200, 5);
    if (!ud.slide) ud.slide = mk(new THREE.ConeGeometry(2.5, 6.5, 14), 16, 7);
    ud.dots.visible = true;
    ud.dots.material.color.set(color);
    ud.slide.material.color.set(color);
    // cumulative arclength from the first end
    const acc = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      acc.push(acc[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = acc[acc.length - 1];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), at = new THREE.Vector3();
    let n = 0, k = 1;
    for (let dist = 3; dist < total - 2 && n < 200; dist += 6) {
      while (k < pts.length - 1 && acc[k] < dist) k++;
      const a = pts[k - 1], b = pts[k], L = acc[k] - acc[k - 1];
      if (L < 1e-6) continue;
      const t = (dist - acc[k - 1]) / L;
      m.compose(at.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t), q.identity(), one);
      ud.dots.setMatrixAt(n++, m);
    }
    ud.dots.count = n;
    ud.dots.instanceMatrix.needsUpdate = true;

    // sliding over each pulley: how fast the arclength from the first end to the pulley changes
    const wraps = pts.wraps || [];
    const now = sim ? sim.time : null;
    const prev = ud.slidePrev;
    const vel = (ud.slideVel ||= []);
    const seen = (ud.slideSeen ||= []); // last direction and when it was last seen moving
    const wall = performance.now();
    if (!sim) { vel.length = 0; seen.length = 0; }
    if (sim && prev && prev.n === wraps.length && now > prev.time) {
      const dt = now - prev.time;
      wraps.forEach((wi, j) => {
        const v = (acc[wi] - prev.s[j]) / dt; // mm/s, > 0: the cord runs towards its first end
        vel[j] = (vel[j] ?? 0) * 0.7 + v * 0.3;
        if (Math.abs(vel[j]) > 0.3) seen[j] = { sign: vel[j] > 0 ? -1 : 1, at: wall, speed: Math.abs(vel[j]) };
      });
    }
    if (sim && (!prev || now !== prev.time)) ud.slidePrev = { time: now, n: wraps.length, s: wraps.map((wi) => acc[wi]) };
    if (!sim) ud.slidePrev = null;
    // keep each arrow up for a moment after the cord stops, so a quick move can still be read
    let c = 0;
    wraps.forEach((wi, j) => {
      const sj = seen[j];
      if (!sj || wall - sj.at > 1500 || wi < 1 || wi >= pts.length - 1) return;
      const a = pts[wi - 1], b = pts[wi + 1], p = pts[wi];
      d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize().multiplyScalar(sj.sign);
      q.setFromUnitVectors(up, d);
      const sc = 1 + Math.min(1, sj.speed / 30) * 0.5;
      // sit just ahead of the arc middle, on the way the cord is going
      m.compose(at.set(p[0] + d.x * 2.5, p[1] + d.y * 2.5, p[2] + d.z * 2.5), q, new THREE.Vector3(sc, sc, sc));
      ud.slide.setMatrixAt(c++, m);
    });
    ud.slide.count = c;
    ud.slide.visible = c > 0;
    ud.slide.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- simulation pose
  applySimPose(sim) {
    for (const p of this.doc.parts) {
      const pose = sim.bodyPose(p.id);
      const o = this.objects.get(p.id);
      if (!pose || !o) continue;
      o.group.position.set(pose.pos[0] * 1000, pose.pos[1] * 1000, pose.pos[2] * 1000);
      o.group.quaternion.set(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
    }
  }

  resetPose() {
    for (const p of this.doc.parts) { const o = this.objects.get(p.id); if (o) this.placePart(o.group, p); }
  }

  setHighlight(id, on, color = 0xffffff) {
    const o = this.objects.get(id);
    if (!o) {
      if (this.stringLines.has(id)) this.selectedId = on ? id : this.selectedId === id ? null : this.selectedId;
      return;
    }
    o.group.traverse((m) => {
      if (m.isMesh && m.material?.emissive) { m.material.emissive.set(on ? color : 0x000000); m.material.emissiveIntensity = on ? 0.35 : 0; }
    });
  }

  // ---------------------------------------------------------------- labels
  setLabels(items) {
    for (const l of this.labelObjs) l.removeFromParent();
    this.labelObjs = [];
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'tag ' + (it.cls || '');
      el.textContent = it.text;
      const o = new CSS2DObject(el);
      o.position.set(...it.pos);
      this.scene.add(o);
      this.labelObjs.push(o);
    }
  }

  render() {
    if (this.camAnim) this.stepCamAnim();
    else this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- picking helpers
  project(p) {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.size.w, y: ((1 - v.y) / 2) * this.size.h, behind: v.z > 1 };
  }

  ray(sx, sy) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((sx / this.size.w) * 2 - 1, -(sy / this.size.h) * 2 + 1), this.camera);
    return rc;
  }

  // Intersection of the mouse ray with the plane y = Y.
  planePoint(sx, sy, Y) {
    return this.planeThrough(sx, sy, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, Y, 0));
  }

  // Intersection of the mouse ray with the plane through `point` with the given normal.
  planeThrough(sx, sy, normal, point) {
    const rc = this.ray(sx, sy);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, out) ? out : null;
  }

  // Where the mouse ray meets layer `layer` of family n, in the coordinates of that family.
  famPoint(sx, sy, n, layer) {
    const N = new THREE.Vector3(...NVEC[n]);
    const w = this.planeThrough(sx, sy, N, N.clone().multiplyScalar(layer * LAYER));
    return w ? toFam(n, w) : null;
  }

  // Unit vector from a world point towards the eye.
  toEye(p) {
    if (this.camera === this.ortho) return this.camera.getWorldDirection(new THREE.Vector3()).negate();
    return this.camera.position.clone().sub(new THREE.Vector3(p.x, p.y, p.z)).normalize();
  }
  // +1 when the eye is on the side layers of family n grow towards, seen from p; else -1.
  facing(n, p) {
    const N = NVEC[n], e = this.toEye(p);
    return e.x * N[0] + e.y * N[1] + e.z * N[2] >= 0 ? 1 : -1;
  }

  // First solid thing under the cursor (a piece, the wall or the baseplate), with the face normal.
  pickSurface(sx, sy) {
    const rc = this.ray(sx, sy);
    const hits = rc.intersectObjects([this.world, ...this.surfaces], true).filter((h) => h.object.isMesh && h.face && (h.object.userData.id !== undefined || h.object.userData.surface) && shown(h.object));
    const h = hits[0];
    if (!h) return { ray: rc.ray, distance: Infinity };
    const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    return { ray: rc.ray, distance: h.distance, point: h.point, normal, id: h.object.userData.id, kind: h.object.userData.kind, surface: h.object.userData.surface };
  }

  pickObject(sx, sy) {
    const rc = this.ray(sx, sy);
    const hits = rc.intersectObjects([this.world], true).filter((h) => h.object.userData?.id !== undefined && shown(h.object));
    // strings: screen distance to segments
    let best = null;
    for (const [id, line] of this.stringLines) {
      const pts = line.userData.pts || [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = this.project({ x: pts[i][0], y: pts[i][1], z: pts[i][2] });
        const b = this.project({ x: pts[i + 1][0], y: pts[i + 1][1], z: pts[i + 1][2] });
        const d = segDist(sx, sy, a, b);
        if (d < 7 && (!best || d < best.d)) best = { d, id };
      }
    }
    if (best) return { id: best.id, kind: 'string' };
    if (hits.length) return { id: hits[0].object.userData.id, kind: hits[0].object.userData.kind, point: hits[0].point, object: hits[0].object };
    return null;
  }
}

// Elastic drawn as a spring: each straight stretch gets a fixed number of coils, chosen the first
// time it is drawn, so the coils open up as the band stretches.
function zigzag(pts, store) {
  const segs = pts.length - 1;
  if (!store.coils || store.coils.length !== segs) {
    store.coils = [];
    for (let i = 0; i < segs; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
      store.coils.push(L > 5 ? Math.max(2, Math.round(L / 2.6)) : 0);
    }
  }
  const out = [pts[0]];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < segs; i++) {
    a.set(...pts[i]); b.set(...pts[i + 1]);
    const k = store.coils[i];
    if (k) {
      dir.subVectors(b, a);
      n.crossVectors(dir, new THREE.Vector3(0, 1, 0));
      if (n.lengthSq() < 1e-8) n.set(1, 0, 0);
      n.normalize().multiplyScalar(1.6);
      const lead = 0.12; // straight bit at each end
      for (let j = 0; j <= 2 * k; j++) {
        const t = lead + ((1 - 2 * lead) * j) / (2 * k);
        const side = j === 0 || j === 2 * k ? 0 : j % 2 ? 1 : -1;
        const p = a.clone().lerp(b, t).addScaledVector(n, side);
        out.push([p.x, p.y, p.z]);
      }
    }
    out.push(pts[i + 1]);
  }
  return out;
}

function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - a.x) * dx + (py - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export const STRING_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5c940d', '#d6336c', '#3b5bdb'];
export const stringColor = (doc, s) => STRING_COLORS[Math.max(0, doc.strings.indexOf(s)) % STRING_COLORS.length];

// Colour and width of a string: its own colour while building and in the schematic view,
// a cool-to-warm tension scale in the normal simulation view.
export function stringStyle(s, T, sim, identity, schema) {
  const base = s.kind === 'elastic' ? 3 : 3.4;
  if (T === undefined || sim === null) return { color: identity, dashed: false, width: schema ? base + 1.2 : base };
  const ref = s.fmaxRef || 10;
  const x = Math.min(1, T / ref);
  if (T < 0.005) return { color: schema ? identity : '#8b919b', dashed: true, width: 2.6 };
  if (schema) return { color: identity, dashed: false, width: base + 1 + 3 * x };
  const c = new THREE.Color().setHSL(0.58 - 0.58 * x, 0.85, 0.55);
  return { color: '#' + c.getHexString(), dashed: false, width: base };
}

export { THREE };
