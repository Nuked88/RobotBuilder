// Example: a three-phalanx finger pulled by a winch, opened again by an elastic band.
import { emptyDoc } from './model.js';

export function fingerDemo() {
  const d = emptyDoc();
  const part = (x, z, angle, holes, layer, color) => { const p = { id: d.nextId++, type: 'beam', x, z, angle, holes, layer, color }; d.parts.push(p); return p; };
  const pin = (x, z, lo, hi, type, range) => { const p = { id: d.nextId++, x, z, lo, hi, type }; if (range) p.range = range; d.pins.push(p); return p; };
  const pulley = (x, z, layer, r = 6) => { const p = { id: d.nextId++, x, z, layer, r }; d.pulleys.push(p); return p; };

  const palm = part(0, 40, 90, 7, 1, '#2b2f36');
  const ph1 = part(0, 88, 90, 5, 2, '#d8342c');
  const ph2 = part(0, 120, 90, 4, 3, '#f2b51c');
  const ph3 = part(0, 144, 90, 3, 4, '#2a6fdb');
  pin(0, 40, 0, 1, 'weld');
  pin(0, 48, 0, 1, 'weld');
  pin(0, 88, 1, 2, 'hinge', [-10, 95]);
  pin(0, 120, 2, 3, 'hinge', [-10, 95]);
  pin(0, 144, 3, 4, 'hinge', [-10, 95]);
  const j0 = pulley(0, 88, 3);
  const j1 = pulley(0, 120, 4);
  const j2 = pulley(0, 144, 5);
  const winch = { id: d.nextId++, x: 32, z: 48, layer: 1, r: 8, fmax: 8 };
  d.winches.push(winch);

  const hole = (p, i) => ({ t: 'hole', part: p.id, i });
  const over = (p, sx) => ({ t: 'pulley', id: p.id, sx, sz: 0 });
  d.strings.push({
    id: d.nextId++, kind: 'string', name: 'Flessore',
    anchors: [{ t: 'winch', id: winch.id }, hole(palm, 5), over(j0, 1), hole(ph1, 2), over(j1, 1), hole(ph2, 2), over(j2, 1), hole(ph3, 2)],
  });
  // one elastic band per joint, so each joint has its own return spring
  const band = (name, a, pul, b) => d.strings.push({ id: d.nextId++, kind: 'elastic', name, stiffness: 60, pretension: 2, anchors: [a, over(pul, -1), b] });
  band('Estensore 1', hole(palm, 4), j0, hole(ph1, 2));
  band('Estensore 2', hole(ph1, 3), j1, hole(ph2, 2));
  band('Estensore 3', hole(ph2, 1), j2, hole(ph3, 2));
  return d;
}
