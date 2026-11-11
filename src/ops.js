// Operations on groups of pieces, the kind a CAD has: copy, repeat in a row, mirror,
// bill of materials, interference check. Pure functions on the document.
import {
  P, isBeam, isBlock, isServo, fam, pinMembers, mountOf, shiftItem, docBounds, solidBox, boxesOverlap, holeWorld, partLabel,
  PIN_LABEL, SERVO_MODELS, FLOOR,
} from './model.js';

const COLLS = ['parts', 'pins', 'pulleys', 'winches', 'strings'];

// Everything that belongs with a selection: the chosen pieces, the pins that only hold them, the
// wheels mounted on them and the strings that run only over them.
export function withDependents(doc, ids) {
  const sel = new Set(ids);
  const parts = doc.parts.filter((p) => sel.has(p.id));
  const pid = new Set(parts.map((p) => p.id));
  const pins = doc.pins.filter((pin) => {
    if (sel.has(pin.id)) return true;
    const mem = pinMembers(doc, pin).filter((m) => m.kind === 'part');
    return mem.length > 0 && mem.every((m) => pid.has(m.part.id));
  });
  const wheel = (w) => { if (sel.has(w.id)) return true; const m = mountOf(doc, w); return m.kind === 'part' && pid.has(m.part.id); };
  const pulleys = doc.pulleys.filter(wheel), winches = doc.winches.filter(wheel);
  const have = new Set([...pid, ...pulleys.map((w) => w.id), ...winches.map((w) => w.id)]);
  const strings = doc.strings.filter((s) => {
    const refs = s.anchors.map((a) => a.part ?? a.id).filter((r) => r !== undefined);
    return refs.length > 0 && refs.every((r) => have.has(r));
  });
  return { parts, pins, pulleys, winches, strings };
}

export function boundsOf(set) {
  return docBounds({ parts: set.parts, pulleys: set.pulleys, winches: set.winches });
}

// Copy a selection. xf says where the copy goes: {item(copy), anchor(anchor, owner)}.
// Returns the ids of the new parts and wheels.
export function cloneItems(doc, ids, xf) {
  const set = withDependents(doc, ids);
  const map = new Map(), owner = new Map(), out = [];
  for (const k of COLLS.slice(0, 4)) {
    for (const o of set[k]) {
      const c = JSON.parse(JSON.stringify(o));
      c.id = doc.nextId++;
      map.set(o.id, c.id);
      owner.set(o.id, o);
      xf.item(c);
      doc[k].push(c);
      if (k !== 'pins') out.push(c.id);
    }
  }
  for (const s of set.strings) {
    const c = JSON.parse(JSON.stringify(s));
    c.id = doc.nextId++;
    delete c.fmaxRef;
    c.anchors = c.anchors.map((a) => {
      const o = owner.get(a.part ?? a.id);
      const b = xf.anchor({ ...a }, o);
      if (b.part !== undefined) b.part = map.get(b.part);
      if (b.id !== undefined) b.id = map.get(b.id);
      return b;
    });
    doc.strings.push(c);
  }
  return out;
}

// Slide the copy by d = [dx, dy, dz] mm.
export function xfShift(d) {
  return {
    item: (o) => shiftItem(o, d),
    anchor: (a) => {
      if (a.t === 'board') { if (d[1] === 0) { a.x += d[0]; a.z += d[2]; } else return { t: 'world', p: [a.x + d[0], -3.6 + d[1], a.z + d[2]] }; }
      if (a.t === 'world') a.p = [a.p[0] + d[0], a.p[1] + d[1], a.p[2] + d[2]];
      return a;
    },
  };
}

// Mirror the copy left to right about the plane x = m.
export function xfMirrorX(m) {
  const norm = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  return {
    item: (o) => {
      if (o.range) o.range = [-o.range[1], -o.range[0]];
      if (o.c) { o.c[0] = 2 * m - (o.c[0] + (o.s[0] - 1) * P); return; }
      if (fam(o) !== 'x') {
        o.x = 2 * m - o.x;
        if (o.angle !== undefined) o.angle = norm(180 - o.angle);
        return;
      }
      const M = (2 * m) / P;
      if (o.lo !== undefined) { const lo = o.lo; o.lo = M - o.hi; o.hi = M - lo; return; }
      o.layer = M - o.layer;
      if (o.holes === undefined) { if ((o.dir || 1) === 1) o.dir = -1; else delete o.dir; }
    },
    anchor: (a, o) => {
      if (a.t === 'guide' && fam(o) !== 'x') a.side = -a.side;
      if (a.t === 'pulley' && fam(o) !== 'x') a.sx = -a.sx;
      if (a.t === 'pt' && o && isBlock(o)) a.p = [(o.s[0] - 1) * P - a.p[0], a.p[1], a.p[2]];
      if (a.t === 'board') a.x = 2 * m - a.x;
      if (a.t === 'world') a.p = [2 * m - a.p[0], a.p[1], a.p[2]];
      return a;
    },
  };
}

// Bill of materials: [{label, count, ids, note}], pieces of the same kind on one row.
export function bom(doc, lengths = {}) {
  const rows = new Map();
  const add = (label, id, note) => { if (!rows.has(label)) rows.set(label, { label, count: 0, ids: [], note }); const r = rows.get(label); r.count++; r.ids.push(id); };
  for (const p of doc.parts) {
    if (isBlock(p)) { const s = [...p.s].sort((a, b) => b - a); add(`Blocco ${s.join('×')}`, p.id, `${s.map((n) => n * P).join('×')} mm`); }
    else if (isServo(p)) add(`Servo ${p.model}`, p.id, SERVO_MODELS[p.model]?.kind);
    else add(partLabel(p), p.id, `${(p.holes - 1) * P + 7.2} mm`.replace('.', ','));
  }
  for (const p of doc.pins) add(PIN_LABEL[p.type] + (p.model ? ' ' + p.model : ''), p.id);
  for (const p of doc.pulleys) add(`Puleggia Ø ${p.r * 2}`, p.id);
  for (const w of doc.winches) add('Verricello' + (w.model ? ' ' + w.model : ''), w.id);
  const out = [...rows.values()];
  for (const kind of ['string', 'elastic']) {
    const list = doc.strings.filter((s) => s.kind === kind);
    if (!list.length) continue;
    const mm = list.reduce((a, s) => a + (lengths[s.id] ?? 0) * 1000, 0);
    out.push({ label: kind === 'elastic' ? 'Elastico' : 'Filo', count: list.length, ids: list.map((s) => s.id), note: mm ? `${Math.round(mm)} mm in tutto` : '' });
  }
  return out;
}

export function bomCsv(rows) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return ['Pezzo;Quantità;Note', ...rows.map((r) => [q(r.label), r.count, q(r.note)].join(';'))].join('\r\n');
}

// Pieces that occupy the same space: two solids, or a beam running through a solid.
export function interferences(doc) {
  const out = [];
  const solids = doc.parts.filter((p) => !isBeam(p)).map((p) => ({ p, box: solidBox(p) }));
  for (let i = 0; i < solids.length; i++) {
    const a = solids[i];
    if (a.box.min[2] < FLOOR.z - 0.5) out.push({ level: 'warn', text: `${partLabel(a.p)} affonda nel pavimento.`, ids: [a.p.id] });
    for (let j = i + 1; j < solids.length; j++) {
      if (boxesOverlap(a.box, solids[j].box, 0.8)) out.push({ level: 'warn', text: `${partLabel(a.p)} e ${partLabel(solids[j].p).toLowerCase()} occupano lo stesso spazio.`, ids: [a.p.id, solids[j].p.id] });
    }
  }
  for (const b of doc.parts) {
    if (!isBeam(b)) continue;
    for (const s of solids) {
      let hit = false;
      for (let i = 0; i < b.holes && !hit; i++) {
        const h = holeWorld(b, i), q = [h.x, h.y, h.z];
        hit = q.every((v, k) => v > s.box.min[k] + 1 && v < s.box.max[k] - 1);
      }
      if (hit) out.push({ level: 'warn', text: `Una trave passa dentro ${partLabel(s.p).toLowerCase()}.`, ids: [b.id, s.p.id] });
    }
  }
  return out.slice(0, 8);
}
