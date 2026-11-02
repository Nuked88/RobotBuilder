// three.js rendering of the document (edit pose) and of the running simulation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { P, BEAM_W, HOLE_R, BOARD, LAYER, layerY, rad, holePos, pinMembers, mountOf, anchorPos, BEAM_COLORS } from './model.js';

const ROT = (a) => -rad(a); // beam angle -> rotation about +Y

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
    const cam = (this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000));
    cam.up.set(0, 0, 1);
    this.controls = new OrbitControls(cam, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.frontView(false);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa0a8, 1.9);
    hemi.position.set(0, -1, 1.2);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
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
  frontView(animate = true) {
    const box = new THREE.Box3();
    for (const p of this.doc?.parts || []) {
      const e = holePos(p, p.holes - 1);
      box.expandByPoint(new THREE.Vector3(p.x, 0, p.z));
      box.expandByPoint(new THREE.Vector3(e.x, 0, e.z));
    }
    for (const w of [...(this.doc?.winches || []), ...(this.doc?.pulleys || [])]) box.expandByPoint(new THREE.Vector3(w.x, 0, w.z));
    let c = new THREE.Vector3(0, 0, 120), size = 260;
    if (!box.isEmpty()) {
      box.getCenter(c);
      const s = box.getSize(new THREE.Vector3());
      size = Math.max(120, s.x * 1.25, s.z * 1.4) + 40;
    }
    const dist = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const target = new THREE.Vector3(c.x, -16, c.z);
    const pos = new THREE.Vector3(c.x + dist * 0.18, -16 - dist, c.z + dist * 0.28);
    if (!animate) { this.camera.position.copy(pos); this.controls.target.copy(target); this.controls.update(); return; }
    this.camAnim = { from: this.camera.position.clone(), to: pos, tf: this.controls.target.clone(), tt: target, t: 0 };
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    for (const l of this.stringLines.values()) l.material.resolution.set(w, h);
    this.size = { w, h };
  }

  buildBoard() {
    const w = BOARD.x1 - BOARD.x0 + 2 * P, h = BOARD.z1 + P;
    this.boardMat = new THREE.MeshStandardMaterial({ color: 0xe4e7ec, roughness: 0.85 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, BEAM_W, h), this.boardMat);
    board.position.set((BOARD.x0 + BOARD.x1) / 2, 0, h / 2);
    board.receiveShadow = true;
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
    this.scene.add(holes);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.18 }));
    floor.receiveShadow = true;
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

  // ---------------------------------------------------------------- document
  rebuild(doc) {
    this.doc = doc;
    for (const o of this.objects.values()) o.group.removeFromParent();
    this.objects.clear();
    for (const p of doc.parts) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: p.color || BEAM_COLORS[(p.layer - 1) % BEAM_COLORS.length], roughness: 0.45, metalness: 0.0 });
      const mesh = new THREE.Mesh(this.beamGeometry(p.holes), mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData = { id: p.id, kind: 'part' };
      g.add(mesh);
      this.placeBeam(g, p);
      this.world.add(g);
      this.objects.set(p.id, { group: g, kind: 'part', mesh, mat, home: g });
    }
    for (const pin of doc.pins) this.objects.set(pin.id, { kind: 'pin', ...this.makePin(pin) });
    for (const pul of doc.pulleys) this.objects.set(pul.id, { kind: 'pulley', ...this.makeWheel(pul, 'pulley') });
    for (const w of doc.winches) this.objects.set(w.id, { kind: 'winch', ...this.makeWheel(w, 'winch') });
    this.syncStrings(null);
  }

  placeBeam(g, p) {
    g.position.set(p.x, layerY(p.layer), p.z);
    g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ROT(p.angle));
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

  attach(obj, carrier, worldPos) {
    if (carrier) {
      const home = this.objects.get(carrier.id).group;
      const local = new THREE.Vector3(worldPos.x - carrier.x, 0, worldPos.z - carrier.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -ROT(carrier.angle));
      local.y = worldPos.y - layerY(carrier.layer);
      obj.position.copy(local);
      home.add(obj);
    } else {
      obj.position.set(worldPos.x, worldPos.y, worldPos.z);
      this.world.add(obj);
    }
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
    const yMid = (layerY(lo) + layerY(hi)) / 2;
    const carrier = this.carrierFor({ kind: 'pinmem', pin });
    this.attach(g, carrier, { x: pin.x, y: yMid, z: pin.z });
    return { group: g, mat };
  }

  makeWheel(item, kind) {
    const g = new THREE.Group();
    const r = item.r;
    const w = BEAM_W - 0.8;
    if (kind === 'pulley') {
      const mat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.35 });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w * 0.5, 32), mat);
      const fl1 = new THREE.Mesh(new THREE.CylinderGeometry(r + 1.2, r + 1.2, w * 0.25, 32), mat);
      const fl2 = fl1.clone();
      fl1.position.y = w * 0.375; fl2.position.y = -w * 0.375;
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(HOLE_R * 0.9, HOLE_R * 0.9, w + LAYER, 16), new THREE.MeshStandardMaterial({ color: 0x6d737c }));
      axle.position.y = LAYER / 2;
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
    const carrier = this.carrierFor(item);
    this.attach(g, carrier, { x: item.x, y: layerY(item.layer), z: item.z });
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
        const mat = new LineMaterial({ linewidth: 3.2, vertexColors: false, worldUnits: false, dashed: false, dashSize: 3, gapSize: 2.5 });
        mat.resolution.set(this.size.w, this.size.h);
        line = new Line2(new LineGeometry(), mat);
        line.userData = { id: s.id, kind: 'string' };
        line.renderOrder = 2;
        this.overlay.add(line);
        this.stringLines.set(s.id, line);
      }
      const flat = pts.flat();
      if (line.geometry.attributes.instanceStart?.count !== pts.length - 1) {
        line.geometry.dispose();
        line.geometry = new LineGeometry();
      }
      line.geometry.setPositions(flat);
      line.computeLineDistances();
      const T = tensions[s.id];
      const style = stringStyle(s, T, sim, this.dark);
      line.material.color.set(style.color);
      if (line.material.dashed !== style.dashed) { line.material.dashed = style.dashed; line.material.needsUpdate = true; }
      line.material.linewidth = this.selectedId === s.id ? 5 : style.width;
      line.userData.pts = pts;
    }
    for (const [id, l] of this.stringLines) if (!seen.has(id)) { l.removeFromParent(); l.geometry.dispose(); this.stringLines.delete(id); }
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
    for (const p of this.doc.parts) { const o = this.objects.get(p.id); if (o) this.placeBeam(o.group, p); }
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
    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + 0.06);
      const e = 1 - Math.pow(1 - a.t, 3);
      this.camera.position.lerpVectors(a.from, a.to, e);
      this.controls.target.lerpVectors(a.tf, a.tt, e);
      if (a.t >= 1) this.camAnim = null;
    }
    this.controls.update();
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
    const rc = this.ray(sx, sy);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -Y);
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, out) ? out : null;
  }

  pickObject(sx, sy) {
    const rc = this.ray(sx, sy);
    const hits = rc.intersectObjects([this.world], true).filter((h) => h.object.userData?.id !== undefined);
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

function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - a.x) * dx + (py - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function stringStyle(s, T, sim, dark) {
  if (T === undefined || sim === null) return { color: s.kind === 'elastic' ? '#2fae6b' : dark ? '#f4f1e8' : '#1d2127', dashed: false, width: s.kind === 'elastic' ? 4 : 3.2 };
  if (T < 0.005) return { color: '#8b919b', dashed: true, width: 2.6 };
  const ref = s.fmaxRef || 10;
  const x = Math.min(1, T / ref);
  // cool -> warm as tension grows
  const c = new THREE.Color().setHSL(0.58 - 0.58 * x, 0.85, 0.55);
  return { color: '#' + c.getHexString(), dashed: false, width: s.kind === 'elastic' ? 4 : 3.2 };
}

export { THREE };
