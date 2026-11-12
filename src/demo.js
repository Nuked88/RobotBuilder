// Examples. Both are a three-phalanx finger on the board, flexed by a winch.
import { emptyDoc } from './model.js';

function fingerBase() {
  const d = emptyDoc();
  const part = (x, z, angle, holes, layer, color) => { const p = { id: d.nextId++, type: 'beam', x, z, angle, holes, layer, color }; d.parts.push(p); return p; };
  const pin = (x, z, lo, hi, type, range) => { const p = { id: d.nextId++, x, z, lo, hi, type }; if (range) p.range = range; d.pins.push(p); return p; };
  const pulley = (x, z, layer, r = 6) => { const p = { id: d.nextId++, x, z, layer, r }; d.pulleys.push(p); return p; };
  const f = {
    d,
    palm: part(0, 40, 90, 7, 1, '#2b2f36'),
    ph1: part(0, 88, 90, 5, 2, '#d8342c'),
    ph2: part(0, 120, 90, 4, 3, '#f2b51c'),
    ph3: part(0, 144, 90, 3, 4, '#2a6fdb'),
  };
  pin(0, 40, 0, 1, 'weld');
  pin(0, 48, 0, 1, 'weld');
  pin(0, 88, 1, 2, 'hinge', [-10, 95]);
  pin(0, 120, 2, 3, 'hinge', [-10, 95]);
  pin(0, 144, 3, 4, 'hinge', [-10, 95]);
  f.j0 = pulley(0, 88, 3);
  f.j1 = pulley(0, 120, 4);
  f.j2 = pulley(0, 144, 5);
  f.hole = (p, i) => ({ t: 'hole', part: p.id, i });
  f.over = (p, sx) => ({ t: 'pulley', id: p.id, sx, sz: 0 });
  // eyelet on the side of a beam; on these upright beams side -1 is towards +x (right), +1 towards -x
  f.guide = (p, i, side) => ({ t: 'guide', part: p.id, i, side });
  return f;
}

// v1: the winch pulls a flexor; three elastic bands, one per joint, open the finger again.
export function fingerDemo() {
  const { d, palm, ph1, ph2, ph3, j0, j1, j2, hole, over } = fingerBase();
  const winch = { id: d.nextId++, x: 32, z: 48, layer: 1, r: 8, fmax: 8 };
  d.winches.push(winch);
  d.strings.push({
    id: d.nextId++, kind: 'string', name: 'Flessore',
    anchors: [{ t: 'winch', id: winch.id }, hole(palm, 5), over(j0, 1), hole(ph1, 2), over(j1, 1), hole(ph2, 2), over(j2, 1), hole(ph3, 2)],
  });
  const band = (name, a, pul, b) => d.strings.push({ id: d.nextId++, kind: 'elastic', name, stiffness: 60, pretension: 2, anchors: [a, over(pul, -1), b] });
  band('Estensore 1', hole(palm, 4), j0, hole(ph1, 2));
  band('Estensore 2', hole(ph1, 3), j1, hole(ph2, 2));
  band('Estensore 3', hole(ph2, 1), j2, hole(ph3, 2));
  return d;
}

// v2: no springs. The drum winds the flexor and unwinds the extensor by the same amount (a belt),
// and pairs of crossed strings couple each joint to the one before, so all three bend together
// and the whole motor force goes into the grip.
export function fingerBeltDemo() {
  const { d, palm, ph1, ph2, ph3, j0, j1, j2, over, guide } = fingerBase();
  const winch = { id: d.nextId++, x: 32, z: 48, layer: 1, r: 8, fmax: 8 };
  d.winches.push(winch);
  const w = { t: 'winch', id: winch.id };
  // every cord runs in the eyelets on the sides of the beams (side -1 is the right side, +1 the left)
  const R = -1, Lf = 1;
  d.strings.push({ id: d.nextId++, kind: 'string', name: 'Flessore', wind: 1, anchors: [w, guide(palm, 3, R), guide(palm, 5, R), over(j0, 1), guide(ph1, 1, R), guide(ph1, 2, R)] });
  d.strings.push({ id: d.nextId++, kind: 'string', name: 'Estensore', wind: -1, anchors: [w, guide(palm, 2, Lf), guide(palm, 5, Lf), over(j0, -1), guide(ph1, 1, Lf), guide(ph1, 2, Lf)] });
  // crossed pairs (a figure of eight): when a joint turns, one strand of the pair would have to stretch
  // unless the next joint turns too. Each strand changes side on the middle phalanx.
  // A stiff cord (3000 N/m) rather than an ideal one: crossing between layers the geometry is not
  // perfectly length-preserving, and a little stretch keeps the pair from binding.
  const cross = (name, A, j, B, k, C) => {
    for (const [suffix, s0] of [[' A', R], [' B', Lf]]) {
      const s1 = -s0;
      d.strings.push({ id: d.nextId++, kind: 'string', name: name + suffix, stiffness: 3000, anchors: [
        guide(A.p, A.i, s0), guide(A.p, A.i + 1, s0), over(j, s0 === R ? 1 : -1),
        guide(B.p, B.i, s0), guide(B.p, B.out, s1), over(k, s1 === R ? 1 : -1),
        guide(C.p, C.i, s1), guide(C.p, C.i + 1, s1),
      ] });
    }
  };
  cross('Accoppiamento 1-2', { p: palm, i: 3 }, j0, { p: ph1, i: 1, out: 3 }, j1, { p: ph2, i: 1 });
  cross('Accoppiamento 2-3', { p: ph1, i: 2 }, j1, { p: ph2, i: 1, out: 2 }, j2, { p: ph3, i: 1 });
  return d;
}

// A small arm built in space: a plate of blocks on the baseplate, an MG996R standing on it that
// turns a turret, and an SG90 on the side of the turret that lifts a beam.
export function armDemo() {
  const d = emptyDoc();
  const add = (p) => { const o = { id: d.nextId++, ...p }; d.parts.push(o); return o; };
  add({ type: 'block', c: [-24, -56, 8], s: [7, 5, 1], color: '#2b2f36' });                 // base plate
  add({ type: 'servo', model: 'MG996R', n: 'z', x: 8, z: -40, layer: 7, angle: 180 });       // shaft up
  add({ type: 'block', c: [0, -40, 56], s: [2, 1, 2], color: '#f2b51c' });                   // turret on the shaft
  add({ type: 'servo', model: 'SG90', n: 'x', x: -40, z: 64, layer: -4, angle: 0, dir: -1 }); // on the turret, shaft to the left
  add({ type: 'beam', n: 'x', x: -40, z: 64, layer: -4, angle: 90, holes: 7, color: '#d8342c' }); // the arm, on that shaft
  return d;
}
