// Operations on groups of pieces, the kind a CAD has: copy, repeat in a row, mirror,
// bill of materials, interference check. Pure functions on the document.
import {
  P, isBeam, isBlock, isServo, fam, pinMembers, mountOf, shiftItem, docBounds, solidBox, boxesOverlap, holeWorld, partLabel,
  PIN_LABEL, SERVO_MODELS, FLOOR, glueLinks, shaftMembers, toWorld, toFam, famDir, NVEC, guideWorld, localToWorld, worldToLocal, wheelWorld, rad,
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
    else if (isServo(p)) add(`Servo ${p.model}`, p.id, SERVO_MODELS[p.model] ? `${String(SERVO_MODELS[p.model].kgcm).replace('.', ',')} kg·cm` : '');
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

// The scene as a tree: what hangs from what, starting from the fixed base (wall and baseplate).
// {fixed: [node], loose: [node], strings: [{id, via}]}, node = {id, kind, label, color, via, children}.
export function sceneTree(doc) {
  const adj = new Map();
  const link = (a, b, ab, ba = ab) => {
    for (const [x, y, via] of [[a, b, ab], [b, a, ba]]) { if (!adj.has(x)) adj.set(x, []); adj.get(x).push({ to: y, via }); }
  };
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  for (const pin of doc.pins) {
    const mem = pinMembers(doc, pin).map((m) => (m.kind === 'part' ? m.part.id : 'G'));
    for (let i = 0; i + 1 < mem.length; i++) if (mem[i] !== mem[i + 1]) link(mem[i], mem[i + 1], PIN_LABEL[pin.type].toLowerCase());
  }
  for (const [a, b] of glueLinks(doc)) link(a, b, [a, b].some((id) => id !== 'G' && isServo(byId.get(id))) ? 'montato' : 'incollato');
  for (const s of doc.parts) if (isServo(s)) for (const m of shaftMembers(doc, s)) link(s.id, m.id, 'gira sull\'albero', 'servo che lo muove');
  const wheels = new Map();
  const loose = [], fixedWheels = [];
  for (const [list, kind] of [[doc.pulleys, 'pulley'], [doc.winches, 'winch']]) {
    for (const w of list) {
      const m = mountOf(doc, w);
      const node = { id: w.id, kind, label: kind === 'pulley' ? `Puleggia Ø ${w.r * 2}` : 'Verricello' + (w.model ? ' ' + w.model : ''), via: 'montato', children: [] };
      if (m.kind === 'part') { if (!wheels.has(m.part.id)) wheels.set(m.part.id, []); wheels.get(m.part.id).push(node); }
      else if (m.kind === 'board') fixedWheels.push(node);
      else loose.push({ ...node, via: '' });
    }
  }
  const seen = new Set();
  const grow = (id, via) => {
    seen.add(id);
    const p = byId.get(id);
    const node = { id, kind: 'part', label: p.name || partLabel(p), color: isServo(p) ? '#31343a' : p.color, via, children: [] };
    // breadth first, so every piece hangs from the one closest to the base
    const next = (adj.get(id) || []).filter((e) => e.to !== 'G' && !seen.has(e.to));
    for (const e of next) seen.add(e.to);
    for (const e of next) node.children.push(grow(e.to, e.via));
    node.children.push(...(wheels.get(id) || []));
    return node;
  };
  const roots = (adj.get('G') || []).filter((e, i, l) => l.findIndex((x) => x.to === e.to) === i);
  for (const e of roots) seen.add(e.to);
  const fixed = roots.map((e) => grow(e.to, e.via));
  fixed.push(...fixedWheels);
  for (const p of doc.parts) if (!seen.has(p.id)) loose.push(grow(p.id, ''));
  const strings = doc.strings.map((s) => {
    const n = (t) => s.anchors.filter((a) => t.includes(a.t)).length;
    const bits = [];
    if (n(['winch'])) bits.push('verricello');
    if (n(['pulley'])) bits.push(`${n(['pulley'])} pul.`);
    if (n(['guide'])) bits.push(`${n(['guide'])} occh.`);
    return { id: s.id, via: bits.join(' · ') || `${s.anchors.length} punti` };
  });
  return { fixed, loose, strings };
}

// ---------------------------------------------------------------- rotation
// Turn pieces about a world axis (k = 0 x, 1 y, 2 z) through `pivot` [x, y, z] by `deg` degrees.
// Everything lives on three plane families, so quarter turns always work; any other angle works
// only for flat pieces turning in their own plane. Returns false (document untouched in meaning,
// but possibly half changed: the caller restores it) when the result cannot be represented.
export function rotateItems(doc, items, k, deg, pivot) {
  const a = rad(deg), c = Math.round(Math.cos(a) * 1e9) / 1e9, s = Math.round(Math.sin(a) * 1e9) / 1e9;
  const i = (k + 1) % 3, j = (k + 2) % 3;
  const rv = (v) => { const o = [...v]; o[i] = v[i] * c - v[j] * s; o[j] = v[i] * s + v[j] * c; return o; };
  const rp = (p) => { const v = rv([p.x - pivot[0], p.y - pivot[1], p.z - pivot[2]]); return { x: v[0] + pivot[0], y: v[1] + pivot[1], z: v[2] + pivot[2] }; };
  const famOf = (N) => { for (const n of ['y', 'z', 'x']) { const d = N[0] * NVEC[n][0] + N[1] * NVEC[n][1] + N[2] * NVEC[n][2]; if (Math.abs(d) > 0.999) return { n, sign: Math.sign(d) }; } return null; };
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const tag = (o, n) => { if (n === 'y') delete o.n; else o.n = n; };
  const set = new Set(items);
  const partIds = new Set(doc.parts.filter((p) => set.has(p)).map((p) => p.id));
  const wheelIds = new Set([...doc.pulleys, ...doc.winches].filter((w) => set.has(w)).map((w) => w.id));
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  // where the string points on these pieces are now, to find them again afterwards
  const marks = [];
  for (const st of doc.strings) for (const an of st.anchors) {
    if (an.t === 'guide' && partIds.has(an.part)) marks.push({ an, w: rp(guideWorld(byId.get(an.part), an.i, an.side)) });
    else if (an.t === 'pt' && partIds.has(an.part)) marks.push({ an, w: rp(localToWorld(byId.get(an.part), an.p)) });
    else if (an.t === 'pulley' && wheelIds.has(an.id)) { const w = doc.pulleys.find((e) => e.id === an.id); marks.push({ an, d: rv(famDir(fam(w), an.sx, an.sz)) }); }
  }
  for (const o of items) {
    if (o.c) { // block
      if (deg % 90) return false;
      const p0 = rp({ x: o.c[0], y: o.c[1], z: o.c[2] }), p1 = rp({ x: o.c[0] + (o.s[0] - 1) * P, y: o.c[1] + (o.s[1] - 1) * P, z: o.c[2] + (o.s[2] - 1) * P });
      const A = [p0.x, p0.y, p0.z], B = [p1.x, p1.y, p1.z];
      o.c = A.map((v, q) => Math.round(Math.min(v, B[q])));
      o.s = A.map((v, q) => Math.round(Math.abs(v - B[q]) / P) + 1);
      continue;
    }
    const n = fam(o), f = famOf(rv(NVEC[n]));
    if (!f) return false;
    if (o.lo !== undefined) { // pin
      const q0 = toFam(f.n, rp(toWorld(n, o.x, o.z, o.lo))), q1 = toFam(f.n, rp(toWorld(n, o.x, o.z, o.hi)));
      o.x = r6(q0.x); o.z = r6(q0.z);
      o.lo = Math.round(Math.min(q0.layer, q1.layer)); o.hi = Math.round(Math.max(q0.layer, q1.layer));
      tag(o, f.n);
      continue;
    }
    const q = toFam(f.n, rp(toWorld(n, o.x, o.z, o.layer)));
    if (o.angle !== undefined) { // beam or servo: the direction it points in its plane
      const d = rv(famDir(n, Math.cos(rad(o.angle)), Math.sin(rad(o.angle))));
      const fd = toFam(f.n, { x: d[0], y: d[1], z: d[2] });
      let ang = Math.round((Math.atan2(fd.z, fd.x) * 180) / Math.PI * 1e4) / 1e4;
      if (isServo(o)) { if (Math.abs(ang / 90 - Math.round(ang / 90)) > 1e-3) return false; ang = ((Math.round(ang / 90) * 90) % 360 + 360) % 360; }
      else if (ang <= -180) ang += 360;
      o.angle = ang;
    }
    if (!isBeam(o)) { // servo and wheels have a side they stick out from
      const dir = (o.dir || 1) * f.sign;
      if (dir === 1) delete o.dir; else o.dir = -1;
    }
    o.x = r6(q.x); o.z = r6(q.z); o.layer = Math.round(q.layer);
    tag(o, f.n);
  }
  for (const m of marks) {
    const an = m.an;
    if (an.t === 'guide') {
      const part = byId.get(an.part), dist = (sd) => { const g = guideWorld(part, an.i, sd); return Math.hypot(g.x - m.w.x, g.y - m.w.y, g.z - m.w.z); };
      an.side = dist(1) <= dist(-1) ? 1 : -1;
    } else if (an.t === 'pt') an.p = worldToLocal(byId.get(an.part), m.w).map((v) => +v.toFixed(3));
    else { const w = doc.pulleys.find((e) => e.id === an.id), fd = toFam(fam(w), { x: m.d[0], y: m.d[1], z: m.d[2] }); an.sx = r6(fd.x); an.sz = r6(fd.z); }
  }
  return true;
}
