// Document model and geometry helpers.
// Editor units are millimetres. World axes follow MuJoCo: x right, z up, y into the wall board.
//
// Everything sits on a cubic lattice with an 8 mm pitch. A flat piece (beam, pin, pulley, winch,
// servo) belongs to a "family" n: the axis its holes run along.
//   n = 'y' (default): lies against the wall board, holes point at the viewer
//   n = 'z': lies flat like on a table, holes point up
//   n = 'x': stands sideways, holes point right
// Inside its family a piece is described exactly as on the wall: (x, z) in the plane, `layer`
// along the hole axis, `angle` in the plane. toWorld() turns that into world millimetres, so the
// whole planar logic (holes, pins, eyelets) is shared by the three families.
// Blocks are plain boxes of lattice cells with a hole through every cell along all three axes:
// they are what joins one family to another.

export const P = 8;            // hole pitch (mm)
export const LAYER = 8;        // layer pitch (mm)
export const BEAM_W = 7.2;     // beam width and thickness (mm)
export const HOLE_R = 2.4;     // hole radius (mm)
export const BOARD = { x0: -160, x1: 160, z0: 8, z1: 240 }; // grid of wall board holes
export const FLOOR = { z: 4, x0: -160, x1: 160, y0: -240, y1: -8 }; // baseplate: top surface height, grid of holes
export const EPS = 0.6;        // mm tolerance for "same hole"
export const GUIDE_R = 1.5;    // eyelet (cable guide) ring radius (mm)
export const GUIDE_OFF = BEAM_W / 2 + GUIDE_R - 0.2; // eyelet centre from the beam axis (mm)

export const PIN_TYPES = ['hinge', 'weld', 'servo'];
export const PIN_LABEL = { hinge: 'Perno liscio', weld: 'Perno a croce', servo: 'Perno motore' };
export const STRING_LABEL = { string: 'Filo', elastic: 'Elastico' };
export const BEAM_COLORS = ['#d8342c', '#f2b51c', '#2a6fdb', '#3c9a4a', '#ee7a1a', '#8a4fd0', '#2b2f36'];
export const BLOCK_COLORS = ['#c9ced6', ...BEAM_COLORS];

// ---------------------------------------------------------------- standard parts
// Hobby servos, with the figures printed on their datasheets. body = [length, width, height] of
// the case (mm), shaft = distance of the output shaft from the case centre along its length,
// torque in N*m (1 kg*cm = 0.0981 N*m), speed in degrees per second, mass in kg.
// `layers` is how many lattice layers the case takes under the horn.
const KGCM = 0.0980665;
export const SERVO_MODELS = {
  SG90: { name: 'SG90', kind: 'Micro, ingranaggi in plastica', body: [22.5, 12, 22.5], shaft: 5.3, layers: 3, torque: 1.8 * KGCM, kgcm: 1.8, speed: 600, range: 180, mass: 0.009, volt: '4,8 V', color: '#2f6fe0', top: '#2a5fc4' },
  MG90S: { name: 'MG90S', kind: 'Micro, ingranaggi in metallo', body: [22.8, 12.2, 22.5], shaft: 5.4, layers: 3, torque: 2.2 * KGCM, kgcm: 2.2, speed: 600, range: 180, mass: 0.0134, volt: '6 V', color: '#31343a', top: '#c9a23a' },
  MG996R: { name: 'MG996R', kind: 'Standard, ingranaggi in metallo', body: [40.7, 19.7, 38.5], shaft: 10.2, layers: 5, torque: 11 * KGCM, kgcm: 11, speed: 430, range: 180, mass: 0.055, volt: '6 V', color: '#24272c', top: '#3a3e45' },
  DS3218: { name: 'DS3218', kind: 'Standard digitale, 20 kg', body: [40, 20, 38.5], shaft: 10, layers: 5, torque: 20 * KGCM, kgcm: 20, speed: 375, range: 270, mass: 0.06, volt: '6,8 V', color: '#1d1f23', top: '#b3261e' },
  DS3235: { name: 'DS3235', kind: 'Standard digitale, 35 kg', body: [40, 20, 38.5], shaft: 10, layers: 5, torque: 35 * KGCM, kgcm: 35, speed: 460, range: 270, mass: 0.06, volt: '7,4 V', color: '#1d1f23', top: '#d98a14' },
};
export const SERVO_GAP = 1.5; // clearance between the top of the case and the horn layer (mm)
export const servoSpec = (o) => (o && o.model && SERVO_MODELS[o.model]) || null;
// Pulley sizes offered in the library (radius, mm).
export const PULLEY_SIZES = [[4, 'Ø 8'], [6, 'Ø 12'], [10, 'Ø 20'], [16, 'Ø 32']];

// Pull of a winch: its own setting, or what the chosen servo gives on the drum.
export function winchForce(w) {
  const sp = servoSpec(w);
  return sp ? sp.torque / (w.r / 1000) : (w.fmax ?? 10);
}

export const layerY = (L) => -L * LAYER;

export function emptyDoc() {
  return { app: 'RobotBuilder', version: 2, nextId: 1, parts: [], pins: [], pulleys: [], winches: [], strings: [], settings: { gravity: true } };
}

export function newId(doc) { return doc.nextId++; }

export const rad = (deg) => (deg * Math.PI) / 180;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- families
export const FAMILIES = ['y', 'z', 'x'];
export const NVEC = { y: [0, -1, 0], z: [0, 0, 1], x: [1, 0, 0] }; // direction layers grow
const UVEC = { y: [1, 0, 0], z: [1, 0, 0], x: [0, 1, 0] };          // in-plane "x"
const VVEC = { y: [0, 0, 1], z: [0, 1, 0], x: [0, 0, 1] };          // in-plane "z"
export const AXIS_INDEX = { x: 0, y: 1, z: 2 };
export const fam = (o) => (o && o.n) || 'y';
export const isBeam = (p) => !p.type || p.type === 'beam';
export const isBlock = (p) => p.type === 'block';
export const isServo = (p) => p.type === 'servo';

// Family coordinates -> world mm.
export function toWorld(n, x, z, layer) {
  const U = UVEC[n], V = VVEC[n], N = NVEC[n], w = layer * LAYER;
  return { x: U[0] * x + V[0] * z + N[0] * w, y: U[1] * x + V[1] * z + N[1] * w, z: U[2] * x + V[2] * z + N[2] * w };
}
// World mm (point or displacement) -> family coordinates; layer comes out as a real number.
export function toFam(n, p) {
  const U = UVEC[n], V = VVEC[n], N = NVEC[n];
  return { x: U[0] * p.x + U[1] * p.y + U[2] * p.z, z: V[0] * p.x + V[1] * p.y + V[2] * p.z, layer: (N[0] * p.x + N[1] * p.y + N[2] * p.z) / LAYER };
}
// In-plane direction (dx, dz) of a family as a world vector.
export function famDir(n, dx, dz) {
  const U = UVEC[n], V = VVEC[n];
  return [U[0] * dx + V[0] * dz, U[1] * dx + V[1] * dz, U[2] * dx + V[2] * dz];
}

// ---------------------------------------------------------------- small vector / quaternion kit ([w, x, y, z])
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const arr = (p) => [p.x, p.y, p.z];
export const qInv = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qRot(q, v) {
  const u = [q[1], q[2], q[3]], s = q[0];
  const t = vscale(vcross(u, v), 2);
  return vadd(vadd(v, vscale(t, s)), vcross(u, t));
}
// Quaternion of the rotation whose matrix has columns X, Y, Z.
export function quatFromBasis(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4]; }
  return q;
}

// Orientation of a flat piece: local x along its length (angle in the family plane), local -y along
// the direction its layers grow (times dir), local z to its left. On the wall this is the plain
// "rotate about y" of a beam.
export function famQuat(n, angle = 0, dir = 1) {
  const a = rad(angle);
  const d = famDir(n, Math.cos(a), Math.sin(a));
  const N = vscale(NVEC[n], dir);
  return quatFromBasis(d, vscale(N, -1), vcross(N, d));
}

// World pose of a part: {pos: [x, y, z] mm, quat}.
export function partPose(part) {
  if (isBlock(part)) return { pos: [...part.c], quat: [1, 0, 0, 0] };
  const n = fam(part);
  return { pos: arr(toWorld(n, part.x, part.z, part.layer)), quat: famQuat(n, part.angle || 0, isServo(part) ? (part.dir || 1) : 1) };
}
export function localToWorld(part, l) {
  const ps = partPose(part);
  const p = vadd(ps.pos, qRot(ps.quat, l));
  return { x: p[0], y: p[1], z: p[2] };
}
export function worldToLocal(part, p) {
  const ps = partPose(part);
  return qRot(qInv(ps.quat), vsub(arr(p), ps.pos));
}

// ---------------------------------------------------------------- beams
// Position of hole i of a beam in its family plane.
export function holePos(part, i) {
  const a = rad(part.angle);
  return { x: r6(part.x + i * P * Math.cos(a)), z: r6(part.z + i * P * Math.sin(a)) };
}
export function holeWorld(part, i) {
  const h = holePos(part, i);
  return toWorld(fam(part), h.x, h.z, part.layer);
}

// Cable guide (eyelet) beside hole i, on side +1 (left of the beam direction) or -1 (right).
export function guidePos(part, i, side) {
  const h = holePos(part, i), a = rad(part.angle);
  return { x: h.x - side * GUIDE_OFF * Math.sin(a), z: h.z + side * GUIDE_OFF * Math.cos(a) };
}
export function guideWorld(part, i, side) {
  const g = guidePos(part, i, side);
  return toWorld(fam(part), g.x, g.z, part.layer);
}

export function beamEnd(part) { return holePos(part, part.holes - 1); }

const lat = (v) => Math.abs(Math.round(v / P) * P - v) < EPS;

export function onGrid(x, z) {
  return lat(x) && lat(z) && x >= BOARD.x0 - EPS && x <= BOARD.x1 + EPS && z >= BOARD.z0 - EPS && z <= BOARD.z1 + EPS;
}
// Hole of the baseplate, in the coordinates of family 'z' (x, z = world x, y).
export function onFloor(x, y) {
  return lat(x) && lat(y) && x >= FLOOR.x0 - EPS && x <= FLOOR.x1 + EPS && y >= FLOOR.y0 - EPS && y <= FLOOR.y1 + EPS;
}

export function snapGrid(x, z) {
  return {
    x: Math.min(BOARD.x1, Math.max(BOARD.x0, Math.round(x / P) * P)),
    z: Math.min(BOARD.z1, Math.max(BOARD.z0, Math.round(z / P) * P)),
  };
}

const near = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.z - b.z) < EPS;

// Index of the hole of a beam at (x, z) of its plane, or -1.
export function holeIndexAt(part, x, z) {
  if (!isBeam(part)) return -1;
  const a = rad(part.angle);
  const dx = x - part.x, dz = z - part.z;
  const u = dx * Math.cos(a) + dz * Math.sin(a);
  const v = -dx * Math.sin(a) + dz * Math.cos(a);
  if (Math.abs(v) > EPS) return -1;
  const i = Math.round(u / P);
  if (i < 0 || i >= part.holes || Math.abs(u - i * P) > EPS) return -1;
  return i;
}

// ---------------------------------------------------------------- blocks and other solids
// A block is {c: centre of its first cell (world mm, on the lattice), s: cells along x, y, z}.
export function blockBox(b) {
  return { min: [b.c[0] - P / 2, b.c[1] - P / 2, b.c[2] - P / 2], max: [b.c[0] + (b.s[0] - 0.5) * P, b.c[1] + (b.s[1] - 0.5) * P, b.c[2] + (b.s[2] - 0.5) * P] };
}
function blockHas(b, w) {
  const p = [w.x, w.y, w.z];
  for (let k = 0; k < 3; k++) {
    if (!lat(p[k] - b.c[k])) return false;
    const i = Math.round((p[k] - b.c[k]) / P);
    if (i < 0 || i >= b.s[k]) return false;
  }
  return true;
}

// The case of a servo in its own frame: {c: centre, h: half sizes}. The shaft is at the origin,
// the case hangs behind the horn layer (local +y).
export function servoLocalBox(servo) {
  const sp = servoSpec(servo) || SERVO_MODELS.SG90;
  const y0 = LAYER / 2 + SERVO_GAP, y1 = LAYER / 2 + sp.layers * LAYER;
  return { c: [sp.body[0] / 2 - sp.shaft, (y0 + y1) / 2, 0], h: [sp.body[0] / 2, (y1 - y0) / 2, sp.body[1] / 2] };
}
export function servoBox(servo) {
  const b = servoLocalBox(servo), ps = partPose(servo);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = vadd(ps.pos, qRot(ps.quat, [b.c[0] + sx * b.h[0], b.c[1] + sy * b.h[1], b.c[2] + sz * b.h[2]]));
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { min, max };
}
// Axis-aligned box of a solid part (block or servo case), or null for beams.
export function solidBox(part) {
  if (isBlock(part)) return blockBox(part);
  if (isServo(part)) return servoBox(part);
  return null;
}
// Do two boxes share volume (more than `slack` mm on every axis)?
export function boxesOverlap(a, b, slack = 0.5) {
  for (let k = 0; k < 3; k++) if (Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) <= slack) return false;
  return true;
}
// Do two boxes touch face to face (or overlap)?
function boxesTouch(a, b) {
  let wide = 0;
  for (let k = 0; k < 3; k++) {
    const o = Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
    if (o < -0.9) return false;
    if (o > 1) wide++;
  }
  return wide >= 2;
}
const WALL_BOX = { min: [BOARD.x0 - P, -4, FLOOR.z], max: [BOARD.x1 + P, 4, BOARD.z1 + P] };

// What a servo drives: the parts with a hole on its shaft, in the horn layer or the one after.
export function shaftMembers(doc, servo) {
  const out = [], n = fam(servo), d = servo.dir || 1;
  for (const L of [servo.layer, servo.layer + d]) {
    const h = holeAt(doc, n, servo.x, servo.z, L);
    if (h && h.kind === 'part' && h.part.id !== servo.id && !out.includes(h.part)) out.push(h.part);
  }
  return out;
}
// What a servo sits on: whatever has a hole right under its case, on the shaft axis.
export function servoMount(doc, servo) {
  const sp = servoSpec(servo) || SERVO_MODELS.SG90;
  return holeAt(doc, fam(servo), servo.x, servo.z, servo.layer - (servo.dir || 1) * (sp.layers + 1)) || { kind: 'world' };
}

// Rigid joins that need no pin: solids (blocks, servo cases) stick to the solids, the wall and the
// baseplate they touch, and a servo to what it is mounted on. Pairs [a, b] of part ids, 'G' = fixed.
export function glueLinks(doc) {
  const out = [];
  const solids = doc.parts.filter((p) => !isBeam(p)).map((p) => ({ p, box: solidBox(p), glue: p.glue !== false }));
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i];
    if (a.glue && (a.box.min[2] <= FLOOR.z + 0.9 || boxesTouch(a.box, WALL_BOX))) out.push([a.p.id, 'G']);
    if (isServo(a.p)) {
      const m = servoMount(doc, a.p);
      if (m.kind === 'part') out.push([a.p.id, m.part.id]);
      else if (m.kind === 'board') out.push([a.p.id, 'G']);
    }
    if (!a.glue) continue;
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j];
      if (b.glue && boxesTouch(a.box, b.box)) out.push([a.p.id, b.p.id]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- holes, pins, mounts
// What has a hole at (x, z) on layer L of family n:
// {kind:'board', floor?} | {kind:'part', part, i} | null. Blocks have i = -1.
export function holeAt(doc, n, x, z, L) {
  if (L === 0 && n === 'y' && onGrid(x, z)) return { kind: 'board' };
  if (L === 0 && n === 'z' && onFloor(x, z)) return { kind: 'board', floor: true };
  let w = null;
  for (const part of doc.parts) {
    if (isBeam(part)) {
      if (fam(part) !== n || part.layer !== L) continue;
      const i = holeIndexAt(part, x, z);
      if (i >= 0) return { kind: 'part', part, i };
    } else if (isBlock(part)) {
      w ||= toWorld(n, x, z, L);
      if (blockHas(part, w)) return { kind: 'part', part, i: -1 };
    }
  }
  return null;
}

// Nearest layer on the far side of L (stepping by -sgn) with a hole at (x, z) that belongs to
// something other than `except`, or null.
export function layerBehind(doc, n, x, z, L, sgn = 1, except = null) {
  for (let k = 1; k <= 16; k++) {
    const h = holeAt(doc, n, x, z, L - sgn * k);
    if (h && !(h.kind === 'part' && h.part === except)) return L - sgn * k;
  }
  return null;
}

// Members joined by a pin: [{kind:'board'} | {kind:'part', part, i}] sorted by layer.
export function pinMembers(doc, pin) {
  const out = [], n = fam(pin);
  for (let L = pin.lo; L <= pin.hi; L++) {
    if (L === 0 && ((n === 'y' && onGrid(pin.x, pin.z)) || (n === 'z' && onFloor(pin.x, pin.z)))) { out.push({ kind: 'board', layer: 0 }); continue; }
    let w = null;
    for (const part of doc.parts) {
      if (isBeam(part)) {
        if (fam(part) !== n || part.layer !== L) continue;
        const i = holeIndexAt(part, pin.x, pin.z);
        if (i >= 0) out.push({ kind: 'part', part, i, layer: L });
      } else if (isBlock(part)) {
        w ||= toWorld(n, pin.x, pin.z, L);
        if (blockHas(part, w) && !out.some((m) => m.part === part)) out.push({ kind: 'part', part, i: -1, layer: L });
      }
    }
  }
  return out;
}

export function pinAt(doc, n, x, z, L) {
  return doc.pins.find((p) => fam(p) === n && near(p, { x, z }) && (L === undefined || (L >= p.lo && L <= p.hi))) || null;
}

// The thing a pulley/winch is mounted on (whatever has a hole right behind it).
export function mountOf(doc, item) {
  return holeAt(doc, fam(item), item.x, item.z, item.layer - (item.dir || 1)) || { kind: 'world' };
}
export const wheelWorld = (w) => toWorld(fam(w), w.x, w.z, w.layer);

export function findById(doc, id) {
  for (const k of ['parts', 'pins', 'pulleys', 'winches', 'strings']) {
    const o = doc[k].find((e) => e.id === id);
    if (o) return { coll: k, obj: o };
  }
  return null;
}

// World position (mm) of a string anchor.
export function anchorPos(doc, a) {
  if (a.t === 'hole' || a.t === 'guide' || a.t === 'pt') {
    const part = doc.parts.find((p) => p.id === a.part);
    if (!part) return null;
    if (a.t === 'pt') return localToWorld(part, a.p);
    if (!isBeam(part)) return null;
    return a.t === 'hole' ? holeWorld(part, a.i) : guideWorld(part, a.i, a.side);
  }
  if (a.t === 'board') return { x: a.x, y: -BEAM_W / 2, z: a.z };
  if (a.t === 'world') return { x: a.p[0], y: a.p[1], z: a.p[2] };
  if (a.t === 'pulley') {
    const p = doc.pulleys.find((e) => e.id === a.id);
    if (!p) return null;
    return toWorld(fam(p), p.x + a.sx * p.r, p.z + a.sz * p.r, p.layer);
  }
  if (a.t === 'winch') {
    const w = doc.winches.find((e) => e.id === a.id);
    return w ? wheelWorld(w) : null;
  }
  return null;
}

export function partLabel(part) {
  if (isBlock(part)) return `Blocco ${part.s.join('×')}`;
  if (isServo(part)) return `Servo ${part.model}`;
  return `Trave da ${part.holes} fori`;
}

// Move anything (part, pin, pulley, winch) by a world displacement d = [dx, dy, dz] in whole cells.
export function shiftItem(o, d) {
  if (o.c) { o.c = [o.c[0] + d[0], o.c[1] + d[1], o.c[2] + d[2]]; return; }
  const f = toFam(fam(o), { x: d[0], y: d[1], z: d[2] });
  o.x = r6(o.x + f.x); o.z = r6(o.z + f.z);
  const dl = Math.round(f.layer);
  if (o.lo !== undefined) { o.lo += dl; o.hi += dl; } else o.layer += dl;
}

// Remove everything that depended on deleted objects.
export function prune(doc) {
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const pulIds = new Set(doc.pulleys.map((p) => p.id));
  const winIds = new Set(doc.winches.map((p) => p.id));
  for (const s of doc.strings) {
    s.anchors = s.anchors.filter((a) => {
      if (a.t === 'hole' || a.t === 'guide') { const p = byId.get(a.part); return !!p && isBeam(p) && a.i < p.holes; }
      if (a.t === 'pt') return byId.has(a.part);
      return a.t === 'board' || a.t === 'world' || (a.t === 'pulley' && pulIds.has(a.id)) || (a.t === 'winch' && winIds.has(a.id));
    });
    // a string cannot start or end on a pulley
    while (s.anchors.length && s.anchors[0].t === 'pulley') s.anchors.shift();
    while (s.anchors.length && s.anchors[s.anchors.length - 1].t === 'pulley') s.anchors.pop();
  }
  doc.strings = doc.strings.filter((s) => s.anchors.length >= 2);
  doc.pins = doc.pins.filter((p) => pinMembers(doc, p).length > 0);
}

// World bounding box of the whole design: {min, max} or null when empty.
export function docBounds(doc) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (p, r = 4) => { const q = arr(p); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], q[k] - r); max[k] = Math.max(max[k], q[k] + r); } };
  for (const p of doc.parts) {
    if (isBeam(p)) { add(holeWorld(p, 0)); add(holeWorld(p, p.holes - 1)); }
    else { const b = solidBox(p); add({ x: b.min[0], y: b.min[1], z: b.min[2] }, 0); add({ x: b.max[0], y: b.max[1], z: b.max[2] }, 0); }
  }
  for (const w of [...doc.winches, ...doc.pulleys]) add(wheelWorld(w), w.r);
  return min[0] === Infinity ? null : { min, max };
}
