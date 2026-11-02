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
    this.setControls({});
    mj.mj_forward(this.model, this.data);
  }

  // controls: { winch: {winchId: mm the drum has turned}, servo: {pinId: deg} }
  // A string that winds on the drum gets shorter by that much, one that unwinds gets longer.
  setControls(c) {
    const ctrl = this.data.ctrl;
    for (const [sid, a] of Object.entries(this.actId)) {
      const info = this.meta.strings[sid];
      const turn = (c.winch?.[info.winch] ?? 0) / 1000;
      ctrl[a] = Math.max(0, (this.lengths[sid] ?? 0) - info.wind * turn);
    }
    for (const [pid, a] of Object.entries(this.servoId)) ctrl[a] = ((c.servo?.[pid] ?? 0) * Math.PI) / 180;
  }

  step(seconds, drag) {
    const dt = this.model.opt.timestep;
    const n = Math.min(400, Math.max(1, Math.round(seconds / dt)));
    for (let i = 0; i < n; i++) {
      if (drag) drag(this);
      mj.mj_step(this.model, this.data);
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
    for (let k = 0; k < num; k++) {
      const i = adr + k;
      const p = [xp[3 * i], xp[3 * i + 1], xp[3 * i + 2]];
      const o = obj[i];
      if (o >= 0 && k > 0 && obj[i - 1] === o) {
        // second tangent point on a pulley: draw the arc around its axis
        const g = o;
        const c = [this.data.geom_xpos[3 * g], this.data.geom_xpos[3 * g + 1], this.data.geom_xpos[3 * g + 2]];
        const a = pts[pts.length - 1];
        const a0 = Math.atan2(a[2] - c[2], a[0] - c[0]);
        let a1 = Math.atan2(p[2] - c[2], p[0] - c[0]);
        let d = a1 - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const r = Math.hypot(a[0] - c[0], a[2] - c[2]);
        const steps = Math.max(2, Math.ceil(Math.abs(d) / 0.2));
        for (let s = 1; s < steps; s++) {
          const ang = a0 + (d * s) / steps;
          pts.push([c[0] + r * Math.cos(ang), a[1] + ((p[1] - a[1]) * s) / steps, c[2] + r * Math.sin(ang)]);
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
