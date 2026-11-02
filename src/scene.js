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
    const target = new THREE.Vector3(c.x, -16, c.z);
    this.animateView(new THREE.Vector3(0, -1, 0), { target, size, animate });
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
        const mat = new LineMaterial({ linewidth: 3.2, worldUnits: false, dashed: false, dashSize: 3, gapSize: 2.5 });
        mat.resolution.set(this.size.w, this.size.h);
        line = new Line2(new LineGeometry(), mat);
        line.userData = { id: s.id, kind: 'string' };
        line.renderOrder = 3;
        // the same string drawn faintly through beams and pulleys, so its whole route stays readable
        const xmat = new LineMaterial({ linewidth: 2, worldUnits: false, dashed: false, dashSize: 3, gapSize: 2.5, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false });
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
      const style = stringStyle(s, T, sim, this.dark);
      for (const l of [line, xray]) {
        l.material.color.set(style.color);
        if (l.material.dashed !== style.dashed) { l.material.dashed = style.dashed; l.material.needsUpdate = true; }
      }
      line.material.linewidth = this.selectedId === s.id ? 5 : style.width;
      xray.material.linewidth = Math.max(1.5, style.width * 0.6);
      line.userData.pts = pts;
      this.updateMarks(s, line, pts, style.color, T, sim);
    }
    for (const [id, l] of this.stringLines) if (!seen.has(id)) { l.removeFromParent(); l.userData.xray.removeFromParent(); l.userData.marks?.removeFromParent(); l.userData.arrow?.removeFromParent(); l.geometry.dispose(); this.stringLines.delete(id); }
  }

  // Direction marks: small arrowheads fixed on the string material, every few millimetres from the end
  // tied to the mechanism, pointing towards the winch. When the winch reels in they ride along the
  // string towards it and disappear into the drum, so you see which way the string slides.
  // In the simulation an arrow on the tied end shows the pull on that part.
  updateMarks(s, line, pts, color, T, sim) {
    const winchAtStart = s.anchors[0]?.t === 'winch';
    const winchAtEnd = s.anchors[s.anchors.length - 1]?.t === 'winch';
    let marks = line.userData.marks;
    if (!winchAtStart && !winchAtEnd) { if (marks) marks.visible = false; if (line.userData.arrow) line.userData.arrow.visible = false; return; }
    const path = winchAtStart ? pts : [...pts].reverse(); // from the winch to the tied end
    if (!marks) {
      const geo = new THREE.ConeGeometry(1.5, 3.6, 10);
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
