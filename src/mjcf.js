// Turns the editor document into a MuJoCo MJCF model.
import { P, BEAM_W, LAYER, layerY, rad, holePos, pinMembers, mountOf } from './model.js';

const m = (mm) => +(mm / 1000).toFixed(6); // mm -> m
const f = (...v) => v.map((x) => (+x.toFixed(6)).toString()).join(' ');

export const DEFAULTS = {
  winchKp: 3000,      // N/m
  servoKp: 0.4,       // N*m/rad
  jointDamping: 1e-4, // N*m*s/rad
  armature: 2e-6,
  density: 1200,      // kg/m^3 (PLA-like)
};

// Pose of a frame: world (x, y, z) in mm and rotation angle (deg) about -Y (beam direction in the XZ plane).
function framePose(node) {
  if (!node) return { x: 0, y: 0, z: 0, a: 0 };
  return { x: node.x, y: layerY(node.layer), z: node.z, a: rad(node.angle) };
}

// Point (world mm) expressed in a frame.
function toLocal(fr, p) {
  const dx = p.x - fr.x, dz = p.z - fr.z;
  const c = Math.cos(fr.a), s = Math.sin(fr.a);
  return { u: c * dx + s * dz, y: p.y - fr.y, v: -s * dx + c * dz };
}

// Quaternion for a rotation of `a` radians that maps local x to (cos a, 0, sin a).
const quatY = (a) => [Math.cos(-a / 2), 0, Math.sin(-a / 2), 0];

// Hinges stop just short of a full turn unless the pin is marked free: a string wrapped on a
// coaxial pulley would otherwise let a joint spin through itself.
function limitAttr(pin) {
  if (pin.free) return '';
  const r = pin.range || [-170, 170];
  return ` range="${f(rad(r[0]), rad(r[1]))}"`;
}

export function buildMJCF(doc, opts = {}) {
  const L0 = opts.lengths || {};  // stringId -> rest length (m) from a previous compile
  const warnings = [];
  const meta = { parts: {}, strings: {}, servos: {}, pins: {}, pulleys: {}, winches: {} };

  // ---- connection graph -------------------------------------------------
  const G = 'G';
  const adj = new Map([[G, []]]);
  for (const p of doc.parts) adj.set(p.id, []);
  const edges = [];
  for (const pin of doc.pins) {
    const mem = pinMembers(doc, pin);
    if (mem.length < 2) continue;
    const key = (e) => (e.kind === 'board' ? G : e.part.id);
    const base = key(mem[0]);
    for (let k = 1; k < mem.length; k++) {
      const e = { a: base, b: key(mem[k]), pin, type: pin.type, used: false };
      edges.push(e);
      adj.get(e.a).push(e);
      adj.get(e.b).push(e);
    }
  }
  // spanning forest, grounded first
  const parent = new Map(); // nodeId -> {edge, from}
  const children = new Map([[G, []]]);
  for (const p of doc.parts) children.set(p.id, []);
  const visited = new Set();
  const freeRoots = [];
  const bfs = (root) => {
    visited.add(root);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      // weld edges first so rigid clusters stay together
      const list = [...adj.get(n)].sort((x, y) => (x.type === 'weld' ? 0 : 1) - (y.type === 'weld' ? 0 : 1));
      for (const e of list) {
        if (e.used) continue;
        const o = e.a === n ? e.b : e.a;
        if (visited.has(o)) continue;
        e.used = true;
        visited.add(o);
        parent.set(o, { edge: e, from: n });
        children.get(n).push(o);
        q.push(o);
      }
    }
  };
  bfs(G);
  for (const p of doc.parts) {
    if (visited.has(p.id)) continue;
    freeRoots.push(p.id);
    children.get(G).push(p.id);
    bfs(p.id);
  }
  if (freeRoots.length) warnings.push({ level: 'warn', text: `${freeRoots.length === 1 ? 'Un pezzo non è fissato' : freeRoots.length + ' pezzi non sono fissati'} alla base: ${freeRoots.length === 1 ? 'cadrà' : 'cadranno'}.`, ids: freeRoots });
  for (const pin of doc.pins) if (pinMembers(doc, pin).length < 2) warnings.push({ level: 'info', text: 'Un perno non collega niente.', ids: [pin.id] });

  const partById = new Map(doc.parts.map((p) => [p.id, p]));
  const frameOf = (nodeId) => (nodeId === G ? framePose(null) : framePose(partById.get(nodeId)));
  const bodyName = (nodeId) => (nodeId === G ? null : `part${nodeId}`);

  // ---- things hanging off bodies (sites, pulleys) -----------------------
  const extras = new Map([[G, []]]);
  for (const p of doc.parts) extras.set(p.id, []);
  const mountNode = (item) => {
    const mt = mountOf(doc, item);
    return mt.kind === 'part' ? mt.part.id : G;
  };
  for (const pul of doc.pulleys) {
    const node = mountNode(pul);
    meta.pulleys[pul.id] = { node };
    const fr = frameOf(node);
    const c = toLocal(fr, { x: pul.x, y: layerY(pul.layer), z: pul.z });
    extras.get(node).push(`<geom name="pul${pul.id}" type="cylinder" size="${f(m(pul.r), m(BEAM_W / 2 - 0.4))}" pos="${f(m(c.u), m(c.y), m(c.v))}" euler="1.5708 0 0" contype="0" conaffinity="0" mass="0.0005" rgba="0.9 0.9 0.9 1"/>`);
  }
  for (const w of doc.winches) {
    meta.winches[w.id] = { node: mountNode(w) };
  }

  // ---- tendons ----------------------------------------------------------
  const tendonXml = [];
  const actuatorXml = [];
  let siteN = 0;
  const addSite = (node, p) => {
    const name = `s${++siteN}`;
    const fr = frameOf(node);
    const c = toLocal(fr, p);
    extras.get(node).push(`<site name="${name}" pos="${f(m(c.u), m(c.y), m(c.v))}" size="0.0008"/>`);
    return name;
  };
  for (const s of doc.strings) {
    const items = [];
    let winch = null;
    s.anchors.forEach((a, k) => {
      if (a.t === 'hole') {
        const part = partById.get(a.part);
        if (!part) return;
        const h = holePos(part, a.i);
        items.push({ kind: 'site', name: addSite(part.id, { x: h.x, y: layerY(part.layer), z: h.z }) });
      } else if (a.t === 'board') {
        items.push({ kind: 'site', name: addSite(G, { x: a.x, y: layerY(0) - BEAM_W / 2, z: a.z }) });
      } else if (a.t === 'winch') {
        const w = doc.winches.find((e) => e.id === a.id);
        if (!w) return;
        if ((k === 0 || k === s.anchors.length - 1) && !winch) winch = w;
        items.push({ kind: 'site', name: addSite(meta.winches[w.id].node, { x: w.x, y: layerY(w.layer), z: w.z }) });
      } else if (a.t === 'pulley') {
        const pul = doc.pulleys.find((e) => e.id === a.id);
        if (!pul) return;
        const node = meta.pulleys[pul.id].node;
        const prev = items[items.length - 1];
        if (prev && prev.kind === 'geom') {
          // two pulleys in a row: put a pass-through point on their common tangent
          const pp = prev.pul, ps = prev.side;
          const mid = {
            x: (pp.x + pul.x) / 2 + ((ps.sx + a.sx) / 2) * ((pp.r + pul.r) / 2),
            y: (layerY(pp.layer) + layerY(pul.layer)) / 2,
            z: (pp.z + pul.z) / 2 + ((ps.sz + a.sz) / 2) * ((pp.r + pul.r) / 2),
          };
          items.push({ kind: 'site', name: addSite(meta.pulleys[pp.id].node, mid) });
        }
        const side = addSite(node, { x: pul.x + a.sx * pul.r * 1.8, y: layerY(pul.layer), z: pul.z + a.sz * pul.r * 1.8 });
        items.push({ kind: 'geom', name: `pul${pul.id}`, pul, side: { sx: a.sx, sz: a.sz }, sidesite: side });
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
      attrs = ` limited="true" range="0 ${f(rest)}"`;
    }
    tendonXml.push(`<spatial name="${tname}" width="0.0006" damping="0.3"${attrs}>${path}</spatial>`);
    meta.strings[s.id] = { tendon: tname, kind: s.kind, winch: winch ? winch.id : null };
    if (winch) {
      const fmax = winch.fmax ?? 10;
      const len = rest ?? 0.1;
      const aname = `winch${winch.id}_${s.id}`;
      actuatorXml.push(`<position name="${aname}" tendon="${tname}" kp="${DEFAULTS.winchKp}" dampratio="1" ctrlrange="0 ${f(len * 2 + 0.05)}" forcerange="${f(-fmax)} 0"/>`);
      meta.strings[s.id].actuator = aname;
    }
  }

  // ---- bodies -------------------------------------------------------------
  const out = [];
  const indent = (d) => '  '.repeat(d);
  const emitBody = (nodeId, parentId, depth) => {
    const part = partById.get(nodeId);
    const pf = frameOf(parentId);
    const cf = frameOf(nodeId);
    const pos = toLocal(pf, { x: cf.x, y: cf.y, z: cf.z });
    const q = quatY(cf.a - pf.a);
    out.push(`${indent(depth)}<body name="${bodyName(nodeId)}" pos="${f(m(pos.u), m(pos.y), m(pos.v))}" quat="${f(...q)}">`);
    const link = parent.get(nodeId);
    if (!link) {
      out.push(`${indent(depth + 1)}<freejoint name="free${nodeId}"/>`);
    } else if (link.edge.type === 'hinge' || link.edge.type === 'servo') {
      const pin = link.edge.pin;
      const jp = toLocal(cf, { x: pin.x, y: cf.y, z: pin.z });
      const jname = `pin${pin.id}_${nodeId}`;
      out.push(`${indent(depth + 1)}<joint name="${jname}" type="hinge" pos="${f(m(jp.u), 0, m(jp.v))}" axis="0 1 0"${limitAttr(pin)} damping="${DEFAULTS.jointDamping}" armature="${DEFAULTS.armature}"/>`);
      (meta.pins[pin.id] ||= []).push(jname);
      if (link.edge.type === 'servo' && !meta.servos[pin.id]) {
        const tmax = pin.tmax ?? 0.2;
        actuatorXml.push(`<position name="servo${pin.id}" joint="${jname}" kp="${DEFAULTS.servoKp}" dampratio="1" ctrlrange="-3.1416 3.1416" forcerange="${f(-tmax, tmax)}"/>`);
        meta.servos[pin.id] = { actuator: `servo${pin.id}`, joint: jname };
      }
    }
    const len = (part.holes - 1) * P;
    const bit = 1 << (1 + ((part.layer - 1) % 14));
    out.push(`${indent(depth + 1)}<geom name="geom${nodeId}" type="box" size="${f(m(len / 2 + BEAM_W / 2), m(BEAM_W / 2), m(BEAM_W / 2))}" pos="${f(m(len / 2), 0, 0)}" density="${DEFAULTS.density}" contype="${bit}" conaffinity="${bit | 1}" rgba="0.8 0.2 0.2 1"/>`);
    for (const x of extras.get(nodeId)) out.push(indent(depth + 1) + x);
    for (const c of children.get(nodeId)) emitBody(c, nodeId, depth + 1);
    out.push(`${indent(depth)}</body>`);
    meta.parts[nodeId] = bodyName(nodeId);
  };
  for (const c of children.get(G)) emitBody(c, G, 2);

  // ---- loop closures ------------------------------------------------------
  const eqXml = [];
  for (const e of edges) {
    if (e.used) continue;
    const [a, b] = e.a === G ? [e.b, G] : [e.a, e.b];
    const b2 = b === G ? '' : ` body2="${bodyName(b)}"`;
    if (e.type === 'weld') {
      eqXml.push(`<weld body1="${bodyName(a)}"${b2}/>`);
    } else {
      const fr = frameOf(a);
      const ap = toLocal(fr, { x: e.pin.x, y: fr.y, z: e.pin.z });
      eqXml.push(`<connect body1="${bodyName(a)}"${b2} anchor="${f(m(ap.u), 0, m(ap.v))}"/>`);
      if (e.type === 'servo') warnings.push({ level: 'warn', text: 'Un servo chiude un anello del meccanismo e non può muoverlo: spostalo su un altro perno.', ids: [e.pin.id] });
    }
  }

  const g = doc.settings?.gravity === false ? '0 0 0' : '0 0 -9.81';
  const xml = `<mujoco model="robotbuilder">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.0005" integrator="implicitfast" gravity="${g}"/>
  <size memory="20M"/>
  <default>
    <joint solreflimit="0.002 1" solimplimit="0.99 0.999 0.001"/>
    <tendon solreflimit="0.002 1" solimplimit="0.99 0.999 0.001"/>
    <equality solref="0.002 1" solimp="0.99 0.999 0.001"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.01" contype="1" conaffinity="65535"/>
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
