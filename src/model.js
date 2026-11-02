// Document model and geometry helpers.
// Editor units are millimetres. World axes follow MuJoCo: x right, z up, y into the board.
// The board (layer 0) sits at y = 0; layer k sits at y = -k * LAYER (towards the viewer).

export const P = 8;            // hole pitch (mm)
export const LAYER = 8;        // layer pitch (mm)
export const BEAM_W = 7.2;     // beam width and thickness (mm)
export const HOLE_R = 2.4;     // hole radius (mm)
export const BOARD = { x0: -160, x1: 160, z0: 8, z1: 240 }; // grid of board holes
export const EPS = 0.6;
export const GUIDE_R = 1.5;    // eyelet (cable guide) ring radius (mm)
export const GUIDE_OFF = BEAM_W / 2 + GUIDE_R - 0.2; // eyelet centre from the beam axis (mm)        // mm tolerance for "same hole"

export const PIN_TYPES = ['hinge', 'weld', 'servo'];
export const PIN_LABEL = { hinge: 'Perno liscio', weld: 'Perno a croce', servo: 'Servo' };
export const STRING_LABEL = { string: 'Filo', elastic: 'Elastico' };
export const BEAM_COLORS = ['#d8342c', '#f2b51c', '#2a6fdb', '#3c9a4a', '#ee7a1a', '#8a4fd0', '#2b2f36'];

export const layerY = (L) => -L * LAYER;

export function emptyDoc() {
  return { app: 'RobotBuilder', version: 1, nextId: 1, parts: [], pins: [], pulleys: [], winches: [], strings: [], settings: { gravity: true } };
}

export function newId(doc) { return doc.nextId++; }

export const rad = (deg) => (deg * Math.PI) / 180;

// World position of hole i of a beam.
export function holePos(part, i) {
  const a = rad(part.angle);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return { x: r6(part.x + i * P * Math.cos(a)), z: r6(part.z + i * P * Math.sin(a)) };
}

// World position of the cable guide (eyelet) beside hole i, on side +1 (left of the beam
// direction) or -1 (right).
export function guidePos(part, i, side) {
  const h = holePos(part, i), a = rad(part.angle);
  return { x: h.x - side * GUIDE_OFF * Math.sin(a), z: h.z + side * GUIDE_OFF * Math.cos(a) };
}

export function beamEnd(part) { return holePos(part, part.holes - 1); }

export function onGrid(x, z) {
  const gx = Math.round(x / P) * P, gz = Math.round(z / P) * P;
  return Math.abs(gx - x) < EPS && Math.abs(gz - z) < EPS && gx >= BOARD.x0 - EPS && gx <= BOARD.x1 + EPS && gz >= BOARD.z0 - EPS && gz <= BOARD.z1 + EPS;
}

export function snapGrid(x, z) {
  return {
    x: Math.min(BOARD.x1, Math.max(BOARD.x0, Math.round(x / P) * P)),
    z: Math.min(BOARD.z1, Math.max(BOARD.z0, Math.round(z / P) * P)),
  };
}

const near = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.z - b.z) < EPS;

// Index of the hole of `part` at (x, z), or -1.
export function holeIndexAt(part, x, z) {
  const a = rad(part.angle);
  const dx = x - part.x, dz = z - part.z;
  const u = dx * Math.cos(a) + dz * Math.sin(a);
  const v = -dx * Math.sin(a) + dz * Math.cos(a);
  if (Math.abs(v) > EPS) return -1;
  const i = Math.round(u / P);
  if (i < 0 || i >= part.holes || Math.abs(u - i * P) > EPS) return -1;
  return i;
}

// What has a hole at (x, z) on layer L: {kind:'board'} | {kind:'part', part, i} | null
export function holeAt(doc, x, z, L) {
  if (L === 0) return onGrid(x, z) ? { kind: 'board' } : null;
  for (const part of doc.parts) {
    if (part.layer !== L) continue;
    const i = holeIndexAt(part, x, z);
    if (i >= 0) return { kind: 'part', part, i };
  }
  return null;
}

// Highest layer at (x, z) that has a hole (0 = board), or -1 if nothing at all.
export function topLayerAt(doc, x, z) {
  let top = onGrid(x, z) ? 0 : -1;
  for (const part of doc.parts) if (part.layer > top && holeIndexAt(part, x, z) >= 0) top = part.layer;
  return top;
}

// Highest layer below L that has a hole at (x, z), or -1.
export function layerBehind(doc, x, z, L) {
  for (let k = L - 1; k >= 0; k--) if (holeAt(doc, x, z, k)) return k;
  return -1;
}

// Members joined by a pin: [{kind:'board'} | {kind:'part', part, i}] sorted back to front.
export function pinMembers(doc, pin) {
  const out = [];
  for (let L = pin.lo; L <= pin.hi; L++) {
    if (L === 0) { if (onGrid(pin.x, pin.z)) out.push({ kind: 'board', layer: 0 }); continue; }
    for (const part of doc.parts) {
      if (part.layer !== L) continue;
      const i = holeIndexAt(part, pin.x, pin.z);
      if (i >= 0) out.push({ kind: 'part', part, i, layer: L });
    }
  }
  return out;
}

export function pinAt(doc, x, z, L) {
  return doc.pins.find((p) => near(p, { x, z }) && (L === undefined || (L >= p.lo && L <= p.hi))) || null;
}

// The thing a pulley/winch at layer L is mounted on (whatever has a hole right behind it).
export function mountOf(doc, item) {
  const h = holeAt(doc, item.x, item.z, item.layer - 1);
  if (!h) return { kind: 'world' };
  return h;
}

export function findById(doc, id) {
  for (const k of ['parts', 'pins', 'pulleys', 'winches', 'strings']) {
    const o = doc[k].find((e) => e.id === id);
    if (o) return { coll: k, obj: o };
  }
  return null;
}

// World position (mm, with y) of a string anchor.
export function anchorPos(doc, a) {
  if (a.t === 'hole') {
    const part = doc.parts.find((p) => p.id === a.part);
    if (!part) return null;
    const h = holePos(part, a.i);
    return { x: h.x, y: layerY(part.layer), z: h.z };
  }
  if (a.t === 'guide') {
    const part = doc.parts.find((p) => p.id === a.part);
    if (!part) return null;
    const g = guidePos(part, a.i, a.side);
    return { x: g.x, y: layerY(part.layer), z: g.z };
  }
  if (a.t === 'board') return { x: a.x, y: layerY(0) - BEAM_W / 2, z: a.z };
  if (a.t === 'pulley') {
    const p = doc.pulleys.find((e) => e.id === a.id);
    if (!p) return null;
    return { x: p.x + a.sx * p.r, y: layerY(p.layer), z: p.z + a.sz * p.r };
  }
  if (a.t === 'winch') {
    const w = doc.winches.find((e) => e.id === a.id);
    if (!w) return null;
    return { x: w.x, y: layerY(w.layer), z: w.z };
  }
  return null;
}

export function partLabel(part) { return `Trave da ${part.holes} fori`; }

// Remove everything that depended on deleted objects.
export function prune(doc) {
  const partIds = new Set(doc.parts.map((p) => p.id));
  const pulIds = new Set(doc.pulleys.map((p) => p.id));
  const winIds = new Set(doc.winches.map((p) => p.id));
  for (const s of doc.strings) {
    s.anchors = s.anchors.filter((a) =>
      ((a.t === 'hole' || a.t === 'guide') && partIds.has(a.part) && a.i < doc.parts.find((p) => p.id === a.part).holes) ||
      a.t === 'board' || (a.t === 'pulley' && pulIds.has(a.id)) || (a.t === 'winch' && winIds.has(a.id)));
    // a string cannot start or end on a pulley
    while (s.anchors.length && s.anchors[0].t === 'pulley') s.anchors.shift();
    while (s.anchors.length && s.anchors[s.anchors.length - 1].t === 'pulley') s.anchors.pop();
  }
  doc.strings = doc.strings.filter((s) => s.anchors.length >= 2);
  doc.pins = doc.pins.filter((p) => pinMembers(doc, p).length > 0);
}
