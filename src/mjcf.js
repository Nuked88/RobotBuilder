// Turns the editor document into a MuJoCo MJCF model.
//
// Parts that are rigidly joined (cross pins, blocks and servo cases glued by contact, a servo and
// what it is mounted on) form a cluster. A cluster is one moving body: its first part carries the
// joint, the others are nested inside it without joints, so every part still has a body of its own
// to read a pose from. Smooth pins and servo shafts are the hinges between clusters.
import {
  P, BEAM_W, LAYER, rad, holeWorld, guideWorld, pinMembers, mountOf, isBeam, isBlock, isServo, fam, NVEC, toWorld, famDir,
  partPose, glueLinks, shaftMembers, servoSpec, servoLocalBox, SERVO_MODELS, winchForce, wheelWorld, localToWorld, FLOOR,
  qInv, qMul, qRot, vadd, vsub, vscale, arr,
} from './model.js';

const mm = (v) => v / 1000; // mm -> m
const f = (...v) => v.map((x) => (+(+x).toFixed(6)).toString()).join(' ');
const fm = (v) => f(...v.map(mm));

export const DEFAULTS = {
  winchKp: 3000,      // N/m
  servoKp: 0.4,       // N*m/rad
  jointDamping: 1e-4, // N*m*s/rad
  armature: 2e-6,
  density: 1200,      // kg/m^3 (PLA-like)
  blockDensity: 600,  // printed blocks are mostly infill
};

const IDENT = { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
const localPt = (pose, p) => qRot(qInv(pose.quat), vsub(p, pose.pos));
const localDir = (pose, d) => qRot(qInv(pose.quat), d);
const relPose = (parent, child) => ({ pos: localPt(parent, child.pos), quat: qMul(qInv(parent.quat), child.quat) });

// Torque, speed and travel of a motorised joint: a servo part, or a pin of type servo.
export function servoParams(o) {
  const sp = servoSpec(o) || (isServo(o) ? SERVO_MODELS.SG90 : null);
  const tmax = o.tmax ?? (sp ? sp.torque : 0.2);
  const half = sp ? sp.range / 2 : 170;
  const range = o.free ? null : (o.range || [-half, half]);
  const kp = sp ? Math.max(DEFAULTS.servoKp, tmax / 0.15) : DEFAULTS.servoKp;
  return { tmax, range, kp, speed: sp ? rad(sp.speed) : null, armature: sp ? kp / 62500 : DEFAULTS.armature, travel: sp ? [-half, half] : [-150, 150] };
}

export function buildMJCF(doc, opts = {}) {
  const L0 = opts.lengths || {};  // stringId -> rest length (m) from a previous compile
  const warnings = [];
  const meta = { parts: {}, strings: {}, servos: {}, pins: {}, pulleys: {}, winches: {} };
  const G = 'G';
  const partById = new Map(doc.parts.map((p) => [p.id, p]));
  const poses = new Map([[G, IDENT]]);
  for (const p of doc.parts) poses.set(p.id, partPose(p));
  const flat = doc.parts.every((p) => isBeam(p) && fam(p) === 'y');

  // ---- rigid clusters -----------------------------------------------------
  const up = new Map([[G, G]]);
  for (const p of doc.parts) up.set(p.id, p.id);
  const find = (a) => { while (up.get(a) !== a) { up.set(a, up.get(up.get(a))); a = up.get(a); } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a === b) return; if (b === G) up.set(a, b); else up.set(b, a); };
  const key = (e) => (e.kind === 'board' ? G : e.part.id);
  const pinMem = new Map();
  for (const pin of doc.pins) {
    const mem = pinMembers(doc, pin);
    pinMem.set(pin, mem);
    if (mem.length < 2) warnings.push({ level: 'info', text: 'Un perno non collega niente.', ids: [pin.id] });
    else if (pin.type === 'weld') for (let k = 1; k < mem.length; k++) union(key(mem[0]), key(mem[k]));
  }
  for (const [a, b] of glueLinks(doc)) union(a, b);
  const driven = new Map();
  for (const s of doc.parts) {
    if (!isServo(s)) continue;
    const mem = shaftMembers(doc, s);
    driven.set(s, mem);
    for (let k = 1; k < mem.length; k++) union(mem[0].id, mem[k].id);
    if (!mem.length) warnings.push({ level: 'info', text: `Il servo ${s.model} non muove niente: metti una trave o un blocco sul suo albero.`, ids: [s.id] });
  }

  // ---- hinges between clusters ---------------------------------------------
  const edges = [];
  const adj = new Map();
  const link = (a, b, joint) => {
    a = find(a); b = find(b);
    if (a === b) return false;
    const e = { a, b, joint, used: false };
    edges.push(e);
    for (const n of [a, b]) { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(e); }
    return true;
  };
  for (const pin of doc.pins) {
    const mem = pinMem.get(pin);
    if (mem.length < 2 || pin.type === 'weld') continue;
    const n = fam(pin);
    let any = false;
    for (let k = 1; k < mem.length; k++) {
      any = link(key(mem[0]), key(mem[k]), { id: pin.id, kind: pin.type, obj: pin, pos: arr(toWorld(n, pin.x, pin.z, pin.lo)), axis: vscale(NVEC[n], -1), name: `pin${pin.id}_${key(mem[k])}` }) || any;
    }
    if (!any) warnings.push({ level: 'info', text: 'Un perno liscio unisce pezzi che sono già bloccati tra loro: non può girare.', ids: [pin.id] });
  }
  for (const [s, mem] of driven) {
    if (!mem.length) continue;
    const n = fam(s);
    const ok = link(s.id, mem[0].id, { id: s.id, kind: 'servo', obj: s, pos: poses.get(s.id).pos, axis: vscale(NVEC[n], -(s.dir || 1)), name: `servo${s.id}_j` });
    if (!ok) warnings.push({ level: 'warn', text: `Il servo ${s.model} è incollato al pezzo che dovrebbe muovere: allontanali o togli la colla dal blocco.`, ids: [s.id] });
  }

  // ---- spanning forest, grounded first -------------------------------------
  const gc = find(G);
  const members = new Map();
  for (const p of doc.parts) { const c = find(p.id); if (!members.has(c)) members.set(c, []); members.get(c).push(p); }
  const parent = new Map(); // cluster -> {edge, sign}
  const children = new Map();
  const visited = new Set();
  const bfs = (root) => {
    visited.add(root);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      for (const e of adj.get(n) || []) {
        if (e.used) continue;
        const o = e.a === n ? e.b : e.a;
        if (visited.has(o)) continue;
        e.used = true;
        visited.add(o);
        parent.set(o, { edge: e, sign: o === e.b ? 1 : -1 });
        if (!children.has(n)) children.set(n, []);
        children.get(n).push(o);
        q.push(o);
      }
    }
  };
  bfs(gc);
  const freeRoots = [];
  for (const c of members.keys()) {
    if (visited.has(c)) continue;
    freeRoots.push(c);
    bfs(c);
  }
  if (freeRoots.length) warnings.push({ level: 'warn', text: `${freeRoots.length === 1 ? 'Un pezzo non è fissato' : freeRoots.length + ' pezzi non sono fissati'} alla base: ${freeRoots.length === 1 ? 'cadrà' : 'cadranno'}.`, ids: freeRoots.map((c) => members.get(c)[0].id) });

  const bodyName = (id) => `part${id}`;
  const repOf = (c) => (c === gc ? G : members.get(c)[0].id);
  const clusterBody = (c) => (c === gc ? null : bodyName(repOf(c)));

  // ---- things hanging off bodies (sites, pulleys) ---------------------------
  const extras = new Map([[G, []]]);
  for (const p of doc.parts) extras.set(p.id, []);
  const mountNode = (item) => {
    const mt = mountOf(doc, item);
    return mt.kind === 'part' ? mt.part.id : G;
  };
  for (const pul of doc.pulleys) {
    const node = mountNode(pul);
    meta.pulleys[pul.id] = { node };
    const pose = poses.get(node);
    const c = localPt(pose, arr(wheelWorld(pul)));
    const ax = localDir(pose, NVEC[fam(pul)]);
    extras.get(node).push(`<geom name="pul${pul.id}" type="cylinder" size="${f(mm(pul.r), mm(BEAM_W / 2 - 0.4))}" pos="${fm(c)}" zaxis="${f(...ax)}" contype="0" conaffinity="0" mass="0.0005" rgba="0.9 0.9 0.9 1"/>`);
  }
  for (const w of doc.winches) meta.winches[w.id] = { node: mountNode(w) };

  // ---- tendons ----------------------------------------------------------
  const tendonXml = [];
  const actuatorXml = [];
  let siteN = 0;
  const addSite = (node, p) => {
    const name = `s${++siteN}`;
    extras.get(node).push(`<site name="${name}" pos="${fm(localPt(poses.get(node), arr(p)))}" size="0.0008"/>`);
    return name;
  };
  for (const s of doc.strings) {
    const items = [];
    let winch = null;
    s.anchors.forEach((a, k) => {
      if (a.t === 'hole' || a.t === 'guide') {
        const part = partById.get(a.part);
        if (!part || !isBeam(part)) return;
        items.push({ kind: 'site', name: addSite(part.id, a.t === 'hole' ? holeWorld(part, a.i) : guideWorld(part, a.i, a.side)) });
      } else if (a.t === 'pt') {
        const part = partById.get(a.part);
        if (part) items.push({ kind: 'site', name: addSite(part.id, localToWorld(part, a.p)) });
      } else if (a.t === 'board') {
        items.push({ kind: 'site', name: addSite(G, { x: a.x, y: -BEAM_W / 2, z: a.z }) });
      } else if (a.t === 'world') {
        items.push({ kind: 'site', name: addSite(G, { x: a.p[0], y: a.p[1], z: a.p[2] }) });
      } else if (a.t === 'winch') {
        const w = doc.winches.find((e) => e.id === a.id);
        if (!w) return;
        if ((k === 0 || k === s.anchors.length - 1) && !winch) winch = w;
        items.push({ kind: 'site', name: addSite(meta.winches[w.id].node, wheelWorld(w)) });
      } else if (a.t === 'pulley') {
        const pul = doc.pulleys.find((e) => e.id === a.id);
        if (!pul) return;
        const node = meta.pulleys[pul.id].node;
        const c = arr(wheelWorld(pul)), side = famDir(fam(pul), a.sx, a.sz);
        const prev = items[items.length - 1];
        if (prev && prev.kind === 'geom') {
          // two pulleys in a row: put a pass-through point on their common tangent
          const mid = vadd(vscale(vadd(prev.c, c), 0.5), vscale(vadd(prev.side, side), (prev.pul.r + pul.r) / 4));
          items.push({ kind: 'site', name: addSite(meta.pulleys[prev.pul.id].node, { x: mid[0], y: mid[1], z: mid[2] }) });
        }
        const sp = vadd(c, vscale(side, pul.r * 1.8));
        const sidesite = addSite(node, { x: sp[0], y: sp[1], z: sp[2] });
        items.push({ kind: 'geom', name: `pul${pul.id}`, pul, c, side, sidesite });
      }
    });
    while (items.length && items[0].kind === 'geom') items.shift();
    while (items.length && items[items.length - 1].kind === 'geom') items.pop();
    if (items.length < 2) continue;
    const tname = `str${s.id}`;
    const path = items.map((it) => (it.kind === 'site' ? `<site site="${it.name}"/>` : `<geom geom="${it.name}" sidesite="${it.sidesite}"/>`)).join('');
    const rest = L0[s.id];
    let attrs = '';
    if (s.kind === 'elastic') {
      const pre = (s.pretension ?? 4) / 1000;
      const k = s.stiffness ?? 60;
      if (rest !== undefined) attrs = ` stiffness="${f(k)}" springlength="0 ${f(Math.max(0.001, rest - pre))}"`;
    } else if (!winch && rest !== undefined) {
      // a plain string: inextensible (hard limit), or a stiff cord that stretches a little if it has a stiffness
      attrs = s.stiffness > 0 ? ` stiffness="${f(s.stiffness)}" springlength="0 ${f(rest)}"` : ` limited="true" range="0 ${f(rest)}"`;
    }
    tendonXml.push(`<spatial name="${tname}" width="0.0006" damping="0.3"${attrs}>${path}</spatial>`);
    meta.strings[s.id] = { tendon: tname, kind: s.kind, winch: winch ? winch.id : null, wind: s.wind === -1 ? -1 : 1 };
    if (winch) {
      const fmax = winchForce(winch);
      const len = rest ?? 0.1;
      const aname = `winch${winch.id}_${s.id}`;
      actuatorXml.push(`<position name="${aname}" tendon="${tname}" kp="${DEFAULTS.winchKp}" dampratio="1" ctrlrange="0 ${f(len * 2 + 0.05)}" forcerange="${f(-fmax)} 0"/>`);
      meta.strings[s.id].actuator = aname;
      const sp = servoSpec(winch);
      if (sp) meta.strings[s.id].speed = rad(sp.speed) * mm(winch.r); // m/s of string
    }
  }

  // ---- bodies -------------------------------------------------------------
  const out = [];
  const indent = (d) => '  '.repeat(d);
  const partGeom = (part) => {
    if (isBlock(part)) {
      const h = part.s.map((n) => (n * P) / 2 - 0.05), c = part.s.map((n) => ((n - 1) * P) / 2);
      return `<geom name="geom${part.id}" type="box" size="${fm(h)}" pos="${fm(c)}" ${part.mass > 0 ? `mass="${f(part.mass / 1000)}"` : `density="${DEFAULTS.blockDensity}"`} contype="1" conaffinity="65535"/>`;
    }
    if (isServo(part)) {
      const b = servoLocalBox(part), sp = servoSpec(part) || SERVO_MODELS.SG90;
      return `<geom name="geom${part.id}" type="box" size="${fm(b.h)}" pos="${fm(b.c)}" mass="${f(sp.mass)}" contype="1" conaffinity="65535"/>`;
    }
    const len = (part.holes - 1) * P;
    const bit = 1 << (1 + ((((part.layer - 1) % 14) + 14) % 14));
    return `<geom name="geom${part.id}" type="box" size="${f(mm(len / 2 + BEAM_W / 2), mm(BEAM_W / 2), mm(BEAM_W / 2))}" pos="${f(mm(len / 2), 0, 0)}" density="${DEFAULTS.density}" contype="${bit}" conaffinity="${bit | 1}" rgba="0.8 0.2 0.2 1"/>`;
  };
  const openBody = (part, parentPose, depth) => {
    const r = relPose(parentPose, poses.get(part.id));
    out.push(`${indent(depth)}<body name="${bodyName(part.id)}" pos="${fm(r.pos)}" quat="${f(...r.quat)}">`);
    meta.parts[part.id] = bodyName(part.id);
  };
  const fill = (part, depth) => {
    out.push(indent(depth) + partGeom(part));
    for (const x of extras.get(part.id)) out.push(indent(depth) + x);
  };
  const emitCluster = (c, parentPose, depth) => {
    const kids = children.get(c) || [];
    if (c === gc) {
      for (const part of members.get(c) || []) { openBody(part, IDENT, depth); fill(part, depth + 1); out.push(`${indent(depth)}</body>`); }
      for (const k of kids) emitCluster(k, IDENT, depth);
      return;
    }
    const [rep, ...rest] = members.get(c);
    const pose = poses.get(rep.id);
    openBody(rep, parentPose, depth);
    const linkTo = parent.get(c);
    if (!linkTo) {
      out.push(`${indent(depth + 1)}<freejoint name="free${rep.id}"/>`);
    } else {
      const j = linkTo.edge.joint;
      const sv = j.kind === 'servo' ? servoParams(j.obj) : null;
      const range = sv ? sv.range : j.obj.free ? null : (j.obj.range || [-170, 170]);
      const lim = range ? ` range="${f(rad(range[0] - (sv && isServo(j.obj) ? 3 : 0)), rad(range[1] + (sv && isServo(j.obj) ? 3 : 0)))}"` : '';
      out.push(`${indent(depth + 1)}<joint name="${j.name}" type="hinge" pos="${fm(localPt(pose, j.pos))}" axis="${f(...localDir(pose, vscale(j.axis, linkTo.sign)))}"${lim} damping="${DEFAULTS.jointDamping}" armature="${f(sv ? sv.armature : DEFAULTS.armature)}"/>`);
      (meta.pins[j.id] ||= []).push(j.name);
      if (sv && !meta.servos[j.id]) {
        actuatorXml.push(`<position name="servo${j.id}" joint="${j.name}" kp="${f(sv.kp)}" dampratio="1" ctrlrange="-3.1416 3.1416" forcerange="${f(-sv.tmax, sv.tmax)}"/>`);
        meta.servos[j.id] = { actuator: `servo${j.id}`, joint: j.name, speed: sv.speed };
      }
    }
    fill(rep, depth + 1);
    for (const part of rest) { openBody(part, pose, depth + 1); fill(part, depth + 2); out.push(`${indent(depth + 1)}</body>`); }
    for (const k of kids) emitCluster(k, pose, depth + 1);
    out.push(`${indent(depth)}</body>`);
  };
  emitCluster(gc, IDENT, 2);
  for (const c of freeRoots) emitCluster(c, IDENT, 2);

  // ---- loop closures ------------------------------------------------------
  const eqXml = [];
  for (const e of edges) {
    if (e.used) continue;
    const [a, b] = e.a === gc ? [e.b, e.a] : [e.a, e.b];
    const b2 = b === gc ? '' : ` body2="${clusterBody(b)}"`;
    const pose = poses.get(repOf(a));
    // on the wall one point is enough (everything turns about the same axis); in space a hinge
    // needs two points on its axis
    const pts = flat ? [e.joint.pos] : [vadd(e.joint.pos, vscale(e.joint.axis, 4)), vadd(e.joint.pos, vscale(e.joint.axis, -4))];
    for (const p of pts) eqXml.push(`<connect body1="${clusterBody(a)}"${b2} anchor="${fm(localPt(pose, p))}"/>`);
    if (e.joint.kind === 'servo') warnings.push({ level: 'warn', text: 'Un servo chiude un anello del meccanismo e non può muoverlo: spostalo su un altro perno.', ids: [e.joint.id] });
  }

  const g = doc.settings?.gravity === false ? '0 0 0' : '0 0 -9.81';
  const xml = `<mujoco model="robotbuilder">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.0005" integrator="implicitfast" gravity="${g}"/>
  <size memory="40M"/>
  <default>
    <joint solreflimit="0.002 1" solimplimit="0.99 0.999 0.001"/>
    <tendon solreflimit="0.002 1" solimplimit="0.99 0.999 0.001"/>
    <equality solref="0.002 1" solimp="0.99 0.999 0.001"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" pos="0 0 ${f(mm(FLOOR.z))}" size="1 1 0.01" contype="1" conaffinity="65535"/>
${extras.get(G).map((x) => '    ' + x).join('\n')}
${out.join('\n')}
  </worldbody>
  <tendon>
    ${tendonXml.join('\n    ')}
  </tendon>
  <equality>
    ${eqXml.join('\n    ')}
  </equality>
  <actuator>
    ${actuatorXml.join('\n    ')}
  </actuator>
</mujoco>`;
  return { xml, meta, warnings };
}

export { LAYER };
