// MuJoCo (WebAssembly) wrapper: compile the document, step it, read results back.
import loadMujoco from '@mujoco/mujoco';
import { buildMJCF } from './mjcf.js';

let mj = null;
export async function initPhysics() {
  if (!mj) mj = await loadMujoco();
  return mj;
}

export class Sim {
  constructor(doc) {
    this.doc = doc;
    // pass 1: measure the rest length of every string in the design pose
    const first = buildMJCF(doc);
    const m1 = mj.MjModel.from_xml_string(first.xml);
    const d1 = new mj.MjData(m1);
    mj.mj_forward(m1, d1);
    const lengths = {};
    for (const [sid, info] of Object.entries(first.meta.strings)) {
      const id = mj.mj_name2id(m1, mj.mjtObj.mjOBJ_TENDON.value, info.tendon);
      if (id >= 0) lengths[sid] = d1.ten_length[id];
    }
    d1.delete(); m1.delete();
    // pass 2: the real model, with rope lengths and spring rest lengths baked in
    const built = buildMJCF(doc, { lengths });
    this.xml = built.xml;
    this.meta = built.meta;
    this.warnings = built.warnings;
    this.lengths = lengths;
    this.model = mj.MjModel.from_xml_string(built.xml);
    this.data = new mj.MjData(this.model);
    const id = (type, name) => mj.mj_name2id(this.model, mj.mjtObj[type].value, name);
    this.bodyId = {};
    for (const [pid, name] of Object.entries(this.meta.parts)) this.bodyId[pid] = id('mjOBJ_BODY', name);
    this.tendonId = {}; this.actId = {}; this.rest = {};
    for (const [sid, info] of Object.entries(this.meta.strings)) {
      this.tendonId[sid] = id('mjOBJ_TENDON', info.tendon);
      if (info.actuator) this.actId[sid] = id('mjOBJ_ACTUATOR', info.actuator);
    }
    this.servoId = {}; this.servoDof = {};
    for (const [pinId, s] of Object.entries(this.meta.servos)) {
      this.servoId[pinId] = id('mjOBJ_ACTUATOR', s.actuator);
      const j = id('mjOBJ_JOINT', s.joint);
      this.servoDof[pinId] = this.model.jnt_dofadr[j];
    }
    this.pinJoint = {};
    for (const [pinId, names] of Object.entries(this.meta.pins)) {
      const j = id('mjOBJ_JOINT', names[0]);
      this.pinJoint[pinId] = { qpos: this.model.jnt_qposadr[j], dof: this.model.jnt_dofadr[j] };
    }
    this.limitType = mj.mjtConstraint.mjCNSTR_LIMIT_TENDON.value;
    this.time = 0;
    this.snaps = new Set(); // ids of strings seen jumping round a pulley
    this.setControls({}, true);
    mj.mj_forward(this.model, this.data);
  }

  // controls: { winch: {winchId: mm the drum has turned}, servo: {id: deg} }
  // A string that winds on the drum gets shorter by that much, one that unwinds gets longer.
  // Motors with a known top speed (the standard servo models) travel towards the new target at
  // that speed; the others jump to it.
  setControls(c, instant = false) {
    const ctrl = this.data.ctrl;
    this.target ||= new Map();
    const set = (a, v, speed) => {
      if (!speed || instant) { ctrl[a] = v; this.target.delete(a); } else this.target.set(a, { v, speed });
    };
    for (const [sid, a] of Object.entries(this.actId)) {
      const info = this.meta.strings[sid];
      const turn = (c.winch?.[info.winch] ?? 0) / 1000;
      set(a, Math.max(0, (this.lengths[sid] ?? 0) - info.wind * turn), info.speed);
    }
    for (const [pid, a] of Object.entries(this.servoId)) set(a, ((c.servo?.[pid] ?? 0) * Math.PI) / 180, this.meta.servos[pid].speed);
  }

  step(seconds, drag) {
    const dt = this.model.opt.timestep;
    const n = Math.min(400, Math.max(1, Math.round(seconds / dt)));
    const L = this.data.ten_length, tids = Object.entries(this.tendonId).filter(([, t]) => t >= 0);
    const ctrl = this.data.ctrl;
    for (let i = 0; i < n; i++) {
      if (drag) drag(this);
      for (const [a, t] of this.target) {
        const d = t.v - ctrl[a], lim = t.speed * dt;
        ctrl[a] += Math.max(-lim, Math.min(lim, d));
      }
      const before = tids.map(([, t]) => L[t]);
      mj.mj_step(this.model, this.data);
      // a string that jumps to the far side of a pulley changes length by millimetres in one
      // half-millisecond step, far faster than anything can move: remember it, the app warns
      tids.forEach(([sid, t], j) => { if (Math.abs(L[t] - before[j]) > 0.002) this.snaps.add(sid); });
    }
    this.time = this.data.time;
  }

  bodyPose(partId) {
    const b = this.bodyId[partId];
    if (b === undefined || b < 0) return null;
    const p = this.data.xpos, q = this.data.xquat;
    return { pos: [p[3 * b], p[3 * b + 1], p[3 * b + 2]], quat: [q[4 * b], q[4 * b + 1], q[4 * b + 2], q[4 * b + 3]] };
  }

  // Polyline of a string's current path (m), wrapping arcs included.
  tendonPath(sid) {
    const t = this.tendonId[sid];
    if (t === undefined || t < 0) return null;
    const adr = this.data.ten_wrapadr[t], num = this.data.ten_wrapnum[t];
    const xp = this.data.wrap_xpos, obj = this.data.wrap_obj;
    const pts = [];
    pts.wraps = []; // index of the middle of each arc around a pulley
    for (let k = 0; k < num; k++) {
      const i = adr + k;
      const p = [xp[3 * i], xp[3 * i + 1], xp[3 * i + 2]];
      const o = obj[i];
      if (o >= 0 && k > 0 && obj[i - 1] === o) {
        // second tangent point on a pulley: draw the arc around its axis
        const g = o, X = this.data.geom_xmat;
        const c = [this.data.geom_xpos[3 * g], this.data.geom_xpos[3 * g + 1], this.data.geom_xpos[3 * g + 2]];
        const ax = [X[9 * g + 2], X[9 * g + 5], X[9 * g + 8]];
        const a = pts[pts.length - 1];
        const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const ra = [a[0] - c[0], a[1] - c[1], a[2] - c[2]], rp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        const ha = dot(ra, ax), hp = dot(rp, ax);
        const e1 = [ra[0] - ha * ax[0], ra[1] - ha * ax[1], ra[2] - ha * ax[2]];
        const r = Math.hypot(...e1) || 1e-9;
        e1[0] /= r; e1[1] /= r; e1[2] /= r;
        const e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
        const d = Math.atan2(dot(rp, e2), dot(rp, e1)); // signed angle from a to p, the short way round
        const steps = Math.max(2, Math.ceil(Math.abs(d) / 0.2));
        for (let s = 1; s < steps; s++) {
          const ang = (d * s) / steps, h = ha + ((hp - ha) * s) / steps, cs = Math.cos(ang) * r, sn = Math.sin(ang) * r;
          pts.push([c[0] + cs * e1[0] + sn * e2[0] + h * ax[0], c[1] + cs * e1[1] + sn * e2[1] + h * ax[1], c[2] + cs * e1[2] + sn * e2[2] + h * ax[2]]);
          if (s === Math.floor(steps / 2)) pts.wraps.push(pts.length - 1);
        }
      }
      pts.push(p);
    }
    return pts;
  }

  // Tension in newtons (>= 0).
  tension(sid) {
    const t = this.tendonId[sid];
    if (t === undefined || t < 0) return 0;
    let T = 0;
    const a = this.actId[sid];
    if (a !== undefined && a >= 0) T += -this.data.actuator_force[a];
    const info = this.meta.strings[sid];
    if (info.kind === 'elastic' || this.model.tendon_stiffness[t] > 0) {
      const L = this.data.ten_length[t];
      const rest = this.model.tendon_lengthspring[2 * t + 1];
      const k = this.model.tendon_stiffness[t];
      if (L > rest) T += k * (L - rest);
    }
    const nefc = this.data.nefc;
    if (nefc > 0) {
      const ty = this.data.efc_type, id = this.data.efc_id, fo = this.data.efc_force;
      for (let i = 0; i < nefc; i++) if (ty[i] === this.limitType && id[i] === t) T += Math.abs(fo[i]);
    }
    return Math.max(0, T);
  }

  tendonLength(sid) {
    const t = this.tendonId[sid];
    return t >= 0 ? this.data.ten_length[t] : 0;
  }

  servoTorque(pinId) {
    const a = this.servoId[pinId];
    return a >= 0 ? this.data.actuator_force[a] : 0;
  }

  pinAngle(pinId) {
    const j = this.pinJoint[pinId];
    return j ? (this.data.qpos[j.qpos] * 180) / Math.PI : null;
  }

  // Torque the strings and motors apply at a pin (N*m).
  pinTorque(pinId) {
    const j = this.pinJoint[pinId];
    if (!j) return null;
    return this.data.qfrc_actuator[j.dof] + this.data.qfrc_passive[j.dof] + this.data.qfrc_constraint[j.dof];
  }

  applyForce(partId, pointWorld, force) {
    const b = this.bodyId[partId];
    if (b === undefined || b < 0) return;
    const xi = this.data.xipos;
    const r = [pointWorld[0] - xi[3 * b], pointWorld[1] - xi[3 * b + 1], pointWorld[2] - xi[3 * b + 2]];
    const x = this.data.xfrc_applied;
    x[6 * b] = force[0]; x[6 * b + 1] = force[1]; x[6 * b + 2] = force[2];
    x[6 * b + 3] = r[1] * force[2] - r[2] * force[1];
    x[6 * b + 4] = r[2] * force[0] - r[0] * force[2];
    x[6 * b + 5] = r[0] * force[1] - r[1] * force[0];
  }

  clearForces() { this.data.xfrc_applied.fill(0); }

  dispose() {
    this.data?.delete(); this.model?.delete();
    this.data = this.model = null;
  }
}
