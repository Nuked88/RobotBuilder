import './style.css';
import { View, THREE, stringColor } from './scene.js';
import { ViewCube } from './viewcube.js';
import { initPhysics, Sim } from './physics.js';
import { fingerDemo, fingerBeltDemo, armDemo } from './demo.js';
import { openStore, lastProjectId, setLastProjectId, saveFile } from './storage.js';
import { servoParams } from './mjcf.js';
import {
  P, BEAM_W, LAYER, rad, emptyDoc, holePos, holeAt, layerBehind, pinAt, pinMembers, findById, prune, BEAM_COLORS, BLOCK_COLORS, PIN_LABEL,
  STRING_LABEL, BOARD, FLOOR, EPS, guidePos, anchorPos, mountOf, fam, NVEC, toWorld, toFam, famQuat, isBeam, isBlock, isServo, holeWorld,
  guideWorld, wheelWorld, worldToLocal, partPose, SERVO_MODELS, servoSpec, PULLEY_SIZES, winchForce, solidBox, boxesOverlap, glueLinks,
  shaftMembers, shiftItem, partLabel,
} from './model.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 1) => x.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });

// ------------------------------------------------------------------ state
const S = {
  doc: emptyDoc(),
  projectId: null,
  projectName: 'Progetto senza nome',
  undo: [], redo: [],
  tool: 'block',
  pinType: 'hinge',
  stringKind: 'string',
  layerMode: 'auto',
  blockColor: BLOCK_COLORS[0],
  servoModel: 'SG90',
  servoAngle: 0,
  pulleyR: 6,
  draw: null,          // beam being drawn: {n, start:{x,z,base}, layer, sgn}
  blockDraft: null,    // block being stretched: {a, b, normal}
  stringDraft: null,   // {kind, anchors}
  hover: null,
  selected: null,      // id
  mode: 'edit',        // 'edit' | 'run'
  paused: false,
  speed: 1,
  sim: null,
  preview: null,       // Sim compiled for the edit pose (string paths, warnings)
  controls: { winch: {}, servo: {} },
  drag: null,
  dirty: false,
};

const view = new View($('viewport'));
const cube = new ViewCube($('navcube'), view);
$('navcube').prepend(cube.renderer.domElement);
let store = null;

// ------------------------------------------------------------------ hint strip
const HINTS = {
  select: '<b>Trascina</b> un pezzo per spostarlo (con <b>Shift</b> sposti tutto quello che gli è attaccato). <b>Frecce</b> e <b>Pag↑/Pag↓</b> lo spostano di un foro, <b>R</b> lo ruota, <b>Ctrl+D</b> lo duplica. In simulazione trascinando spingi i pezzi.',
  block: '<b>Clicca una faccia</b> (pavimento, muro o un altro pezzo) per appoggiarci un blocco. <b>Trascina</b> per farne uno lungo o una piastra. <b>Clic destro</b> lo toglie. I blocchi che si toccano restano incollati.',
  block1: 'Rilascia per posare il blocco. <b>Esc</b> annulla.',
  beam0: 'Clicca un <b>foro</b> dove inizia la trave: del muro, del pavimento, di una trave o di un blocco. La trave si stende sul piano della faccia che clicchi.',
  beam1: 'Muovi il mouse e clicca dove finisce. Ogni nuova trave nasce <b>imperniata</b> al foro di partenza. <b>Esc</b> per finire.',
  pin: 'Clicca un foro per metterci un perno: unisce il pezzo con quello che c\'è dietro. Clicca un perno esistente per <b>cambiarne il tipo</b>.',
  servo: 'Clicca un foro per montarci il <b>servo</b>: l\'albero esce verso di te. <b>R</b> gira il corpo. Poi appoggia una trave o un blocco sull\'albero: è quello che il servo fa girare.',
  pulley: 'Clicca un foro per montarci una <b>puleggia</b>: il filo ci gira attorno e cambia direzione.',
  string0: 'Clicca il punto di partenza del filo: un <b>verricello</b> (filo motorizzato) o un foro.',
  string1: 'Clicca i fori, gli <b>occhielli</b> ai lati delle travi e le pulegge da cui passa. Sulla puleggia, clicca <b>dal lato</b> in cui vuoi il filo. Doppio clic o <b>Invio</b> per chiudere, <b>Esc</b> per annullare.',
  winch: 'Clicca un foro per montare un <b>verricello</b>: poi partici con un filo e lo comandi con lo slider.',
  erase: 'Clicca quello che vuoi togliere.',
  reroute: 'Rifai il percorso: clicca di nuovo, in ordine, tutti i punti da cui passa il filo (verricello, fori, <b>occhielli</b>, pulegge). <b>Esc</b> lascia il percorso di prima.',
  run: 'Simulazione in corso: usa gli <b>slider</b> a destra o <b>trascina</b> i pezzi. Premi ■ per tornare a costruire.',
};
function updateHint() {
  let k = S.tool;
  if (S.mode === 'run') k = 'run';
  else if (S.tool === 'beam') k = S.draw ? 'beam1' : 'beam0';
  else if (S.tool === 'block') k = S.blockDraft ? 'block1' : 'block';
  else if (S.tool === 'string') k = S.stringDraft?.replaceId != null && !S.stringDraft.anchors.length ? 'reroute' : S.stringDraft ? 'string1' : 'string0';
  $('hint').innerHTML = HINTS[k] || '';
}

let toastT = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------------ undo / commit
function snapshot() { return JSON.stringify(S.doc); }
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 150) S.undo.shift(); S.redo = []; }
function commit() {
  prune(S.doc);
  if (S.selected && !findById(S.doc, S.selected)) S.selected = null;
  view.rebuild(S.doc);
  if (S.selected) view.setHighlight(S.selected, true);
  schedulePreview();
  renderPanel();
  markDirty();
  refreshUndoButtons();
}
function undo() {
  if (S.mode === 'run' || !S.undo.length) return;
  S.redo.push(snapshot());
  S.doc = JSON.parse(S.undo.pop());
  cancelDrafts();
  commit();
}
function redo() {
  if (S.mode === 'run' || !S.redo.length) return;
  S.undo.push(snapshot());
  S.doc = JSON.parse(S.redo.pop());
  cancelDrafts();
  commit();
}
function refreshUndoButtons() {
  $('btnUndo').disabled = !S.undo.length || S.mode === 'run';
  $('btnRedo').disabled = !S.redo.length || S.mode === 'run';
}

// ------------------------------------------------------------------ saving
let saveT = 0;
function markDirty() {
  S.dirty = true;
  $('saveState').textContent = 'Modifiche non salvate';
  clearTimeout(saveT);
  saveT = setTimeout(saveNow, 1200);
}
async function saveNow() {
  if (!store) return;
  if (!S.projectId) S.projectId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = { ...S.doc, controls: S.controls };
  try {
    $('saveState').textContent = 'Salvo…';
    await store.save(S.projectId, S.projectName, doc);
    setLastProjectId(S.projectId);
    S.dirty = false;
    $('saveState').textContent = store.remote ? 'Salvato sul server' : 'Salvato in questo browser';
  } catch (e) {
    $('saveState').textContent = 'Salvataggio non riuscito: riprovo';
    clearTimeout(saveT);
    saveT = setTimeout(saveNow, 5000);
  }
}

async function loadProject(p) {
  stopSim();
  S.projectId = p.id;
  S.projectName = p.name || 'Progetto senza nome';
  $('projName').value = S.projectName;
  S.doc = migrate(p.doc);
  S.controls = p.doc.controls || { winch: {}, servo: {} };
  delete S.doc.controls;
  S.undo = []; S.redo = [];
  S.selected = null;
  cancelDrafts();
  view.rebuild(S.doc);
  resetView(false);
  if (S.doc.parts.length) { setTool('select', true); updateHint(); }
  schedulePreview();
  renderPanel();
  refreshUndoButtons();
  setLastProjectId(p.id);
  $('chkGravity').checked = S.doc.settings?.gravity !== false;
  $('saveState').textContent = store?.remote ? 'Salvato sul server' : 'Salvato in questo browser';
}

// Flat designs on the wall open from the front, anything built in space from three quarters.
const isFlat = (doc) => doc.parts.every((p) => isBeam(p) && fam(p) === 'y');
function resetView(animate) {
  if (S.doc.parts.length && isFlat(S.doc)) view.frontView(animate); else view.isoView(animate);
}

function migrate(doc) {
  const d = { ...emptyDoc(), ...JSON.parse(JSON.stringify(doc)) };
  d.settings = { gravity: true, ...(d.settings || {}) };
  return d;
}

function newProject(doc = emptyDoc(), name = 'Progetto senza nome') {
  stopSim();
  if (S.dirty) saveNow();
  S.projectId = null;
  S.projectName = name;
  $('projName').value = name;
  S.doc = migrate(doc);
  S.controls = { winch: {}, servo: {} };
  S.undo = []; S.redo = [];
  S.selected = null;
  cancelDrafts();
  view.rebuild(S.doc);
  resetView(S.doc.parts.length > 0);
  if (S.doc.parts.length) { setTool('select', true); updateHint(); }
  schedulePreview();
  renderPanel();
  refreshUndoButtons();
  $('chkGravity').checked = S.doc.settings.gravity !== false;
  markDirty();
}

// ------------------------------------------------------------------ physics preview in edit mode
let prevT = 0;
function schedulePreview() {
  clearTimeout(prevT);
  prevT = setTimeout(runPreview, 60);
}
function runPreview() {
  if (S.mode === 'run') return;
  S.preview?.dispose();
  S.preview = null;
  let warnings = [];
  try {
    if (S.doc.parts.length || S.doc.strings.length) {
      S.preview = new Sim(S.doc);
      warnings = S.preview.warnings;
    }
  } catch (e) {
    warnings = [{ level: 'error', text: 'Il modello non si compila: ' + String(e.message || e).replace(/^MuJoCo Error:\s*/, '').split('\n')[0] }];
  }
  S.warnings = warnings;
  drawStrings();
  renderWarnings();
  renderControls();
}

// strings that jumped to the other side of a pulley during the run make everything shake
function reportSnaps() {
  S.snapsShown = S.sim.snaps.size;
  const extra = [...S.sim.snaps].map((sid) => {
    const s = S.doc.strings.find((x) => String(x.id) === String(sid));
    return { level: 'warn', text: `${s ? stringName(s) : 'Un filo'} scatta dall'altra parte di una puleggia quando il giunto si piega: per questo trema. Di solito succede se è legato troppo vicino alla ruota (a un solo foro): legalo un foro più in là.`, ids: s ? [s.id] : [] };
  });
  S.warnings = [...S.sim.warnings, ...extra];
  renderWarnings();
  toast('Un filo scatta su una puleggia: guarda «Da controllare»');
}

function drawStrings() {
  const sim = S.mode === 'run' ? S.sim : S.preview;
  const paths = new Map(), tensions = {};
  if (sim) {
    for (const s of S.doc.strings) {
      const p = sim.tendonPath(s.id);
      if (p) { const mm = p.map((q) => q.map((v) => v * 1000)); mm.wraps = p.wraps; paths.set(s.id, mm); }
      if (S.mode === 'run') tensions[s.id] = sim.tension(s.id);
      const w = s.anchors.find((a) => a.t === 'winch');
      const wo = w && S.doc.winches.find((x) => x.id === w.id);
      s.fmaxRef = wo ? winchForce(wo) : 3;
    }
  }
  view.syncStrings(paths, tensions, S.mode === 'run' ? sim : null);
  return { paths, tensions };
}

// ------------------------------------------------------------------ simulation
function startSim() {
  if (S.mode === 'run') { S.paused = !S.paused; syncRunUI(); return; }
  cancelDrafts();
  try {
    S.sim = new Sim(S.doc);
  } catch (e) {
    toast('Non riesco a simulare: ' + String(e.message || e).split('\n')[0]);
    return;
  }
  S.sim.setControls(S.controls);
  S.mode = 'run';
  S.paused = false;
  S.warnings = S.sim.warnings;
  S.snapsShown = 0;
  renderWarnings();
  syncRunUI();
  renderPanel();
}
function stopSim() {
  if (S.mode !== 'run') return;
  S.sim?.dispose();
  S.sim = null;
  S.mode = 'edit';
  S.drag = null;
  view.resetPose();
  view.setLabels([]);
  syncRunUI();
  schedulePreview();
  renderPanel();
}
function syncRunUI() {
  const run = S.mode === 'run';
  const b = $('btnPlay');
  b.classList.toggle('running', run && !S.paused);
  b.querySelector('span').textContent = !run ? 'Simula' : S.paused ? 'Riprendi' : 'Pausa';
  b.querySelector('svg').innerHTML = run && !S.paused ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>' : '<path d="M7 4v16l13-8z"/>';
  $('btnStop').disabled = !run;
  $('runinfo').hidden = !run;
  $('runinfo').classList.toggle('paused', S.paused);
  $('btnPause').textContent = S.paused ? 'Riprendi' : 'Pausa';
  document.querySelectorAll('.tools button').forEach((t) => (t.disabled = run && t.dataset.tool !== 'select'));
  if (run) setTool('select', true);
  refreshUndoButtons();
  updateHint();
  renderSubtools();
}

// mouse drag ("hand of god") during the simulation
function dragForce(sim) {
  const d = S.drag;
  if (!d) return;
  const pose = sim.bodyPose(d.partId);
  if (!pose) return;
  const q = new THREE.Quaternion(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
  const p = d.local.clone().applyQuaternion(q).add(new THREE.Vector3(...pose.pos));
  const k = 4, c = 0.05; // N/m, N*s/m
  const v = d.prev ? p.clone().sub(d.prev).divideScalar(sim.model.opt.timestep) : new THREE.Vector3();
  d.prev = p.clone();
  const F = d.target.clone().sub(p).multiplyScalar(k).sub(v.multiplyScalar(c));
  sim.applyForce(d.partId, [p.x, p.y, p.z], [F.x, F.y, F.z]);
  d.point = p;
}

// ------------------------------------------------------------------ hover targets
const snapP = (v) => Math.round(v / P) * P;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const famTag = (o, n) => { if (n !== 'y') o.n = n; return o; };

// Centre of the visible face of a hole: its lattice point pushed half a beam towards the eye side.
function facePoint(n, x, z, layer, sgn, extra = 0) {
  const w = toWorld(n, x, z, layer), N = NVEC[n], k = sgn * (BEAM_W / 2 + extra);
  return { x: w.x + N[0] * k, y: w.y + N[1] * k, z: w.z + N[2] * k };
}

// Finds the "socket" under the cursor: a hole of a beam, a cell face of a block, a hole of the wall
// or of the baseplate, and (for strings) wheels and eyelets. A socket says which family it belongs
// to (n), where it is in that family (x, z, layer) and which side you are looking at it from (sgn):
// new pieces go on layer + sgn. Only what is actually visible counts, like pointing at it.
function hoverTarget(sx, sy, opts = {}) {
  const doc = S.doc;
  const surf = view.pickSurface(sx, sy);
  const o = surf.ray.origin, dr = surf.ray.direction;
  const depthOf = (p) => (p.x - o.x) * dr.x + (p.y - o.y) * dr.y + (p.z - o.z) * dr.z;
  const famOk = (n) => !opts.fam || opts.fam === n;

  let wheel = null;
  if (opts.wheels) {
    for (const [list, t] of [[doc.winches, 'winch'], [doc.pulleys, 'pulley']]) {
      for (const w of list) {
        const n = fam(w), cw = wheelWorld(w);
        if (depthOf(cw) > surf.distance + w.r + 6) continue;
        const c = view.project(cw);
        const e1 = view.project(toWorld(n, w.x + w.r, w.z, w.layer)), e2 = view.project(toWorld(n, w.x, w.z + w.r, w.layer));
        const rpx = Math.max(Math.hypot(e1.x - c.x, e1.y - c.y), Math.hypot(e2.x - c.x, e2.y - c.y));
        const d = Math.hypot(sx - c.x, sy - c.y);
        if (d < rpx * 1.08 + 2 && (!wheel || d < wheel.d)) {
          const fp = view.famPoint(sx, sy, n, w.layer);
          let sxv = 1, szv = 0;
          if (fp) { const L = Math.hypot(fp.x - w.x, fp.z - w.z) || 1; sxv = (fp.x - w.x) / L; szv = (fp.z - w.z) / L; }
          wheel = { t, id: w.id, n, x: w.x, z: w.z, layer: w.layer, sgn: w.dir || 1, d, sx: sxv, sz: szv };
        }
      }
    }
  }

  let best = null;
  const consider = (cand, p, lim) => {
    const s = view.project(p);
    const d = Math.hypot(sx - s.x, sy - s.y);
    if (d >= lim) return;
    const depth = depthOf(p);
    if (depth > surf.distance + 6) return; // hidden behind something
    if (!best || d < best.d - 3 || (Math.abs(d - best.d) <= 3 && depth < best.depth)) best = { ...cand, d, depth };
  };
  for (const part of doc.parts) {
    if (isBeam(part)) {
      const n = fam(part);
      if (!famOk(n)) continue;
      const sgn = view.facing(n, holeWorld(part, 0));
      for (let i = 0; i < part.holes; i++) {
        const h = holePos(part, i);
        consider({ t: 'hole', part, i, n, x: h.x, z: h.z, layer: part.layer, sgn }, facePoint(n, h.x, h.z, part.layer, sgn), 13);
        if (opts.guides) for (const side of [1, -1]) {
          const q = guidePos(part, i, side);
          consider({ t: 'guide', part, i, side, n, x: q.x, z: q.z, layer: part.layer, sgn }, facePoint(n, q.x, q.z, part.layer, sgn), 9);
        }
      }
    } else if (isServo(part) && opts.shafts !== false) {
      const n = fam(part), dir = part.dir || 1;
      if (famOk(n)) consider({ t: 'shaft', servo: part, n, x: part.x, z: part.z, layer: part.layer - dir, sgn: dir }, facePoint(n, part.x, part.z, part.layer, dir), 12);
    }
  }
  // a wheel wins unless the cursor sits right on a hole
  if (wheel && !(best && best.d < 5 && best.d < wheel.d)) return wheel;
  if (best) return best;
  if (!surf.point) return null;

  const pt = surf.point, nr = surf.normal;
  if (surf.surface === 'board') {
    if (nr.y > -0.5 || !famOk('y')) return null;
    return { t: 'board', n: 'y', x: clamp(snapP(pt.x), BOARD.x0, BOARD.x1), z: clamp(snapP(pt.z), BOARD.z0, BOARD.z1), layer: 0, sgn: 1, d: 0 };
  }
  if (surf.surface === 'floor') {
    if (nr.z < 0.5 || !famOk('z')) return null;
    return { t: 'floor', n: 'z', x: clamp(snapP(pt.x), FLOOR.x0, FLOOR.x1), z: clamp(snapP(pt.y), FLOOR.y0, FLOOR.y1), layer: 0, sgn: 1, d: 0 };
  }
  const part = doc.parts.find((p) => p.id === surf.id);
  if (!part) return null;
  if (isBlock(part)) {
    // the cell face you point at: a hole along the axis of that face
    const a = [Math.abs(nr.x), Math.abs(nr.y), Math.abs(nr.z)];
    const k = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
    const n = 'xyz'[k];
    if (!famOk(n)) return null;
    const side = Math.sign([nr.x, nr.y, nr.z][k]) || 1;
    const p = [pt.x, pt.y, pt.z];
    const cell = p.map((v, j) => part.c[j] + clamp(Math.round((v - (j === k ? side * P / 2 : 0) - part.c[j]) / P), 0, part.s[j] - 1) * P);
    const f = toFam(n, { x: cell[0], y: cell[1], z: cell[2] });
    return { t: 'hole', part, i: -1, n, x: f.x, z: f.z, layer: Math.round(f.layer), sgn: side * NVEC[n][k], d: 0, cell };
  }
  if (isBeam(part) && famOk(fam(part))) {
    // pointing at a beam between two holes: take the nearer one
    const n = fam(part), f = toFam(n, pt), a = rad(part.angle);
    const i = clamp(Math.round(((f.x - part.x) * Math.cos(a) + (f.z - part.z) * Math.sin(a)) / P), 0, part.holes - 1);
    const h = holePos(part, i);
    return { t: 'hole', part, i, n, x: h.x, z: h.z, layer: part.layer, sgn: view.facing(n, pt), d: 0 };
  }
  return null;
}

// ------------------------------------------------------------------ ghost graphics
const ghost = new THREE.Group();
view.scene.add(ghost);
const ringGeo = new THREE.TorusGeometry(HOLE(), 0.55, 8, 28);
ringGeo.rotateX(Math.PI / 2);
function HOLE() { return 3.6; }
const ringMat = new THREE.MeshBasicMaterial({ color: 0xf2b51c, depthTest: false, transparent: true });
const ghostBeamMat = new THREE.MeshStandardMaterial({ color: 0xf2b51c, transparent: true, opacity: 0.55, depthWrite: false });
const ghostBadMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, transparent: true, opacity: 0.45, depthWrite: false });
const ghostLineMat = new THREE.LineDashedMaterial({ color: 0xf2b51c, dashSize: 3, gapSize: 2, depthTest: false });
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitEdges = new THREE.LineSegments(new THREE.EdgesGeometry(unitBox), new THREE.LineBasicMaterial({ color: 0x231a00, transparent: true, opacity: 0.6 }));
const wheelGeo = new Map();
const servoGhosts = new Map();
const setQ = (obj, q) => obj.quaternion.set(q[1], q[2], q[3], q[0]);

let ghostLabels = [];
function clearGhost() { ghost.clear(); ghostLabels = []; }
// Ring round a socket, lying on the face you are looking at.
function ring(h, scale = 1) {
  const m = new THREE.Mesh(ringGeo, ringMat);
  const p = facePoint(h.n, h.x, h.z, h.layer, h.sgn, 0.4);
  m.position.set(p.x, p.y, p.z);
  setQ(m, famQuat(h.n));
  m.scale.setScalar(scale);
  m.renderOrder = 10;
  ghost.add(m);
}

// Box of cells from a to b (lattice points, any order): {c: first cell, s: size in cells}.
function cellBox(a, b) {
  const c = a.map((v, k) => Math.min(v, b[k]));
  return { c, s: a.map((v, k) => Math.round(Math.abs(v - b[k]) / P) + 1) };
}
// Is there already a solid piece where this one would go?
function blocked(part, exceptId = null) {
  const box = solidBox(part);
  if (box.min[2] < FLOOR.z - 0.5) return true;
  return S.doc.parts.some((p) => p.id !== exceptId && !isBeam(p) && boxesOverlap(box, solidBox(p)));
}
// The cell a new block would take when you point at a face.
function blockCellAt(sx, sy) {
  const s = view.pickSurface(sx, sy);
  if (!s.point) return null;
  const a = [Math.abs(s.normal.x), Math.abs(s.normal.y), Math.abs(s.normal.z)];
  const k = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
  const normal = [0, 0, 0];
  normal[k] = Math.sign([s.normal.x, s.normal.y, s.normal.z][k]) || 1;
  const p = [s.point.x, s.point.y, s.point.z].map((v, j) => snapP(v + normal[j] * P / 2));
  p[2] = Math.max(P, p[2]);
  return { c: p, normal };
}
function ghostBlock(box) {
  const bad = blocked({ type: 'block', ...box });
  const m = new THREE.Mesh(unitBox, bad ? ghostBadMat : ghostBeamMat);
  m.scale.set(box.s[0] * P, box.s[1] * P, box.s[2] * P);
  m.position.set(box.c[0] + (box.s[0] - 1) * P / 2, box.c[1] + (box.s[1] - 1) * P / 2, box.c[2] + (box.s[2] - 1) * P / 2);
  const e = unitEdges.clone();
  e.scale.copy(m.scale); e.position.copy(m.position);
  ghost.add(m, e);
  if (box.s.some((v) => v > 1)) ghostLabels.push({ text: `${box.s[0]}×${box.s[1]}×${box.s[2]}`, pos: [m.position.x, m.position.y, m.position.z + box.s[2] * P / 2 + 3], cls: 'ghost' });
  return !bad;
}

// The servo that clicking this socket would mount: case on the face, shaft pointing out.
function servoCandidate(h) {
  const sp = SERVO_MODELS[S.servoModel];
  const s = famTag({ type: 'servo', model: S.servoModel, x: h.x, z: h.z, layer: h.layer + h.sgn * (sp.layers + 1), angle: S.servoAngle }, h.n);
  if (h.sgn < 0) s.dir = -1;
  return s;
}
function ghostServo(cand) {
  const bad = blocked(cand);
  const key = cand.model + (bad ? '!' : '');
  let g = servoGhosts.get(key);
  if (!g) {
    const sm = view.servoMeshes(cand);
    g = new THREE.Group();
    g.add(sm.body, sm.horn);
    g.traverse((m) => {
      if (!m.isMesh) return;
      m.material = m.material.clone();
      m.material.transparent = true; m.material.opacity = 0.62; m.material.depthWrite = false;
      if (bad) m.material.color.set(0xff3b30);
    });
    servoGhosts.set(key, g);
  }
  const pose = partPose(cand);
  g.position.set(...pose.pos);
  setQ(g, pose.quat);
  ghost.add(g);
  return !bad;
}

function updateGhost(sx, sy) {
  clearGhost();
  ghostLabels = [];
  if (S.mode === 'run') return;
  const tool = S.tool;
  if (tool === 'block') {
    if (S.blockDraft) { S.blockDraft.ok = ghostBlock(cellBox(S.blockDraft.a, S.blockDraft.b)); return; }
    const c = blockCellAt(sx, sy);
    S.hoverCell = c;
    if (c) ghostBlock(cellBox(c.c, c.c));
  } else if (tool === 'beam') {
    if (!S.draw) {
      const h = hoverTarget(sx, sy);
      S.hover = h;
      if (h) ring(h);
    } else {
      const end = beamEndFor(sx, sy);
      S.draw.end = end;
      if (end) {
        const { n, layer, start } = S.draw;
        const len = end.n * P;
        const mesh = new THREE.Mesh(view.beamGeometry(end.n + 1), ghostBeamMat);
        const w = toWorld(n, start.x, start.z, layer);
        mesh.position.set(w.x, w.y, w.z);
        setQ(mesh, famQuat(n, end.angle));
        ghost.add(mesh);
        ring({ n, x: end.x, z: end.z, layer, sgn: S.draw.sgn }, end.snapped ? 1.2 : 0.9);
        const a = ((end.angle % 360) + 360) % 360;
        const mid = facePoint(n, start.x + (len / 2) * Math.cos(rad(end.angle)), start.z + (len / 2) * Math.sin(rad(end.angle)), layer, S.draw.sgn, 3);
        ghostLabels.push({ text: `${end.n + 1} fori · ${fmt(a > 180 ? a - 360 : a, 0)}°${end.snapped ? ' · aggancio' : ''}`, pos: [mid.x, mid.y, mid.z], cls: 'ghost' });
      }
    }
  } else if (tool === 'pin' || tool === 'pulley' || tool === 'winch') {
    const h = hoverTarget(sx, sy, { shafts: false });
    S.hover = h;
    if (h) {
      ring(h);
      if (tool !== 'pin') {
        const r = tool === 'winch' ? 8 : S.pulleyR;
        if (!wheelGeo.has(r)) wheelGeo.set(r, new THREE.CylinderGeometry(r, r, BEAM_W - 1, 28));
        const c = new THREE.Mesh(wheelGeo.get(r), ghostBeamMat);
        const w = toWorld(h.n, h.x, h.z, h.layer + h.sgn);
        c.position.set(w.x, w.y, w.z);
        setQ(c, famQuat(h.n));
        ghost.add(c);
      } else {
        const ex = pinAt(S.doc, h.n, h.x, h.z, h.layer);
        const p = facePoint(h.n, h.x, h.z, h.layer, h.sgn, 5);
        if (ex) ghostLabels.push({ text: `${PIN_LABEL[ex.type]} → ${PIN_LABEL[nextPinType(ex.type)]}`, pos: [p.x, p.y, p.z], cls: 'ghost' });
      }
    }
  } else if (tool === 'servo') {
    const h = hoverTarget(sx, sy, { shafts: false });
    S.hover = h;
    S.servoCand = null;
    if (h) {
      const cand = servoCandidate(h);
      ring(h);
      if (ghostServo(cand)) S.servoCand = cand;
      const sp = SERVO_MODELS[cand.model], top = toWorld(cand.n || 'y', cand.x, cand.z, cand.layer + (cand.dir || 1));
      ghostLabels.push({ text: `${sp.name} · ${fmt(sp.kgcm, 1)} kg·cm`, pos: [top.x, top.y, top.z], cls: 'ghost' });
    }
  } else if (tool === 'string') {
    const h = hoverTarget(sx, sy, { wheels: true, guides: true, shafts: false });
    S.hover = h;
    const pts = [];
    if (S.stringDraft) for (const a of S.stringDraft.anchors) { const p = anchorPos(S.doc, a); if (p) pts.push(p); }
    if (h) {
      const a = targetToAnchor(h);
      const p = a && anchorPos(S.doc, a);
      if (p) {
        pts.push(p);
        if (h.t === 'pulley' || h.t === 'winch') {
          const w = (h.t === 'pulley' ? S.doc.pulleys : S.doc.winches).find((e) => e.id === h.id);
          ring({ ...h, sgn: view.facing(h.n, p) }, (w.r + 1.5) / HOLE());
        } else ring(h, h.t === 'guide' ? 0.6 : 1);
      }
    }
    if (pts.length >= 2) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      const l = new THREE.Line(g, ghostLineMat);
      l.computeLineDistances();
      l.renderOrder = 11;
      ghost.add(l);
    }
  } else if (tool === 'erase' || tool === 'select') {
    const hit = view.pickObject(sx, sy);
    setHover(hit?.id ?? null);
  }
}

let hoverId = null;
function setHover(id) {
  if (hoverId === id) return;
  if (hoverId !== null && hoverId !== S.selected) view.setHighlight(hoverId, false);
  hoverId = id;
  if (id !== null) view.setHighlight(id, true, S.tool === 'erase' ? 0xff3b30 : 0x888888);
}

function beamEndFor(sx, sy) {
  const st = S.draw.start, n = S.draw.n;
  const wp = view.famPoint(sx, sy, n, S.draw.layer);
  if (!wp) return null;
  // snap to an existing hole at a whole number of pitches from the start
  const h = hoverTarget(sx, sy, { fam: n, shafts: false });
  if (h && !(Math.abs(h.x - st.x) < EPS && Math.abs(h.z - st.z) < EPS)) {
    const dist = Math.hypot(h.x - st.x, h.z - st.z);
    const k = Math.round(dist / P);
    if (k >= 1 && k <= 24 && Math.abs(dist - k * P) < 0.35) {
      return { x: h.x, z: h.z, n: k, angle: (Math.atan2(h.z - st.z, h.x - st.x) * 180) / Math.PI, snapped: h.t === 'hole' ? h : null };
    }
  }
  const dx = wp.x - st.x, dz = wp.z - st.z;
  const k = Math.max(1, Math.min(24, Math.round(Math.hypot(dx, dz) / P)));
  const angle = Math.round((Math.atan2(dz, dx) * 180) / Math.PI / 15) * 15;
  return { x: st.x + k * P * Math.cos(rad(angle)), z: st.z + k * P * Math.sin(rad(angle)), n: k, angle, snapped: null };
}

function targetToAnchor(h) {
  if (!h) return null;
  if (h.t === 'hole' && h.i >= 0) return { t: 'hole', part: h.part.id, i: h.i };
  if (h.t === 'hole') return { t: 'pt', part: h.part.id, p: worldToLocal(h.part, facePoint(h.n, h.x, h.z, h.layer, h.sgn, P / 2 - BEAM_W / 2)).map((v) => +v.toFixed(3)) };
  if (h.t === 'guide') return { t: 'guide', part: h.part.id, i: h.i, side: h.side };
  if (h.t === 'board') return { t: 'board', x: h.x, z: h.z };
  if (h.t === 'floor') return { t: 'world', p: [h.x, h.z, FLOOR.z] };
  if (h.t === 'pulley') return { t: 'pulley', id: h.id, sx: h.sx, sz: h.sz };
  if (h.t === 'winch') return { t: 'winch', id: h.id };
  return null;
}

// ------------------------------------------------------------------ actions
const nextPinType = (t) => ({ hinge: 'weld', weld: 'servo', servo: 'hinge' }[t]);
const layerColor = (L) => BEAM_COLORS[(((L - 1) % BEAM_COLORS.length) + BEAM_COLORS.length) % BEAM_COLORS.length];

function ensurePin(n, x, z, lo, hi, type = 'hinge') {
  const ex = S.doc.pins.find((p) => fam(p) === n && Math.abs(p.x - x) < EPS && Math.abs(p.z - z) < EPS && p.hi >= lo - 1 && p.lo <= hi + 1);
  if (ex) { ex.lo = Math.min(ex.lo, lo); ex.hi = Math.max(ex.hi, hi); return ex; }
  const pin = famTag({ id: S.doc.nextId++, x, z, lo, hi, type }, n);
  S.doc.pins.push(pin);
  return pin;
}

function clickBeam() {
  if (!S.draw) {
    const h = S.hover;
    if (!h) return;
    let layer = h.layer + h.sgn;
    if (S.layerMode !== 'auto' && h.n === 'y') layer = +S.layerMode;
    S.draw = { n: h.n, start: { x: h.x, z: h.z, base: h.layer, shaft: h.t === 'shaft' }, layer, sgn: h.sgn };
    updateHint();
    return;
  }
  const end = S.draw.end;
  if (!end) return;
  pushUndo();
  const { start: st, n, layer, sgn } = S.draw;
  const part = famTag({ id: S.doc.nextId++, type: 'beam', x: st.x, z: st.z, angle: +end.angle.toFixed(4), holes: end.n + 1, layer, color: layerColor(layer) }, n);
  S.doc.parts.push(part);
  // pin at the start: joins the new beam to whatever it was started from (a servo shaft needs none)
  if (!st.shaft && layer !== st.base) ensurePin(n, st.x, st.z, Math.min(st.base, layer), Math.max(st.base, layer), 'hinge');
  // pin at the end if it landed on another piece's hole
  if (end.snapped && end.snapped.layer !== layer) ensurePin(n, end.x, end.z, Math.min(end.snapped.layer, layer), Math.max(end.snapped.layer, layer), 'hinge');
  commit();
  // keep drawing: the next beam starts from this one's end, one layer forward
  S.draw = { n, start: { x: end.x, z: end.z, base: layer }, layer: S.layerMode === 'auto' ? layer + sgn : layer, sgn };
  if (end.snapped) S.draw = null; // closed a loop: stop chaining
  updateHint();
}

function clickPin() {
  const h = S.hover;
  if (!h) return;
  pushUndo();
  const ex = pinAt(S.doc, h.n, h.x, h.z, h.layer);
  if (ex) {
    ex.type = nextPinType(ex.type);
    toast(PIN_LABEL[ex.type]);
  } else {
    let a = h.layer, b = h.layer + h.sgn; // nothing behind: the pin sticks out, ready for the next piece
    if (h.t !== 'board' && h.t !== 'floor') {
      const behind = layerBehind(S.doc, h.n, h.x, h.z, h.layer, h.sgn, h.part);
      if (behind !== null) b = behind;
    }
    S.doc.pins.push(famTag({ id: S.doc.nextId++, x: h.x, z: h.z, lo: Math.min(a, b), hi: Math.max(a, b), type: S.pinType }, h.n));
  }
  commit();
}

function clickWheel(kind) {
  const h = S.hover;
  if (!h) return;
  pushUndo();
  const item = famTag({ id: S.doc.nextId++, x: h.x, z: h.z, layer: h.layer + h.sgn, r: kind === 'winch' ? 8 : S.pulleyR }, h.n);
  if (h.sgn < 0) item.dir = -1;
  if (kind === 'winch') { item.fmax = 10; S.doc.winches.push(item); } else S.doc.pulleys.push(item);
  commit();
  if (kind === 'winch') toast('Verricello montato. Ora scegli Filo e parti da qui.');
}

function clickServo() {
  const cand = S.servoCand;
  if (!cand) { if (S.hover) toast('Qui il servo non ci sta: c\'è già un altro pezzo.'); return; }
  pushUndo();
  const s = { id: S.doc.nextId++, ...cand };
  S.doc.parts.push(s);
  commit();
  toast(`${s.model} montato. Appoggia una trave o un blocco sul suo albero.`);
}

function placeBlock() {
  const d = S.blockDraft;
  S.blockDraft = null;
  updateHint();
  if (!d) return;
  const box = cellBox(d.a, d.b);
  if (blocked({ type: 'block', ...box })) { toast('Lì c\'è già un altro pezzo.'); return; }
  pushUndo();
  S.doc.parts.push({ id: S.doc.nextId++, type: 'block', c: box.c, s: box.s, color: S.blockColor });
  commit();
}

function clickString(dbl) {
  const h = S.hover;
  const a = targetToAnchor(h);
  if (!S.stringDraft) {
    if (!a) return;
    if (a.t === 'pulley') { toast('Il filo deve partire da un foro o da un verricello.'); return; }
    S.stringDraft = { kind: S.stringKind, anchors: [a] };
    updateHint();
    return;
  }
  const list = S.stringDraft.anchors;
  if (!list.length && a?.t === 'pulley') { toast('Il filo deve partire da un foro, un occhiello o un verricello.'); return; }
  const last = list[list.length - 1];
  const again = a && sameAnchor(a, last);
  if (again && a.t === 'pulley') { list[list.length - 1] = a; return; } // clicked the same pulley: just change side
  if (a && !again) list.push(a);
  const finish = dbl || again || (a && a.t === 'winch' && list.length > 1);
  if (finish) finishString();
  updateHint();
}
function sameAnchor(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  if (a.t === 'hole') return a.part === b.part && a.i === b.i;
  if (a.t === 'guide') return a.part === b.part && a.i === b.i && a.side === b.side;
  if (a.t === 'board') return a.x === b.x && a.z === b.z;
  if (a.t === 'pt') return a.part === b.part && a.p.every((v, k) => Math.abs(v - b.p[k]) < 0.5);
  if (a.t === 'world') return a.p.every((v, k) => Math.abs(v - b.p[k]) < 0.5);
  return a.id === b.id;
}
function finishString() {
  const d = S.stringDraft;
  S.stringDraft = null;
  if (!d) return;
  while (d.anchors.length && d.anchors[d.anchors.length - 1].t === 'pulley') d.anchors.pop();
  if (d.anchors.length < 2) { toast('Un filo ha bisogno di almeno due punti.'); updateHint(); return; }
  pushUndo();
  const old = d.replaceId != null ? S.doc.strings.find((x) => x.id === d.replaceId) : null;
  if (old) { old.anchors = d.anchors; S.selected = old.id; commit(); updateHint(); return; }
  const s = { id: S.doc.nextId++, kind: d.kind, anchors: d.anchors };
  if (d.kind === 'elastic') { s.stiffness = 60; s.pretension = 3; }
  S.doc.strings.push(s);
  S.selected = s.id;
  commit();
  updateHint();
}

function eraseAt(sx, sy, onlySolids = false) {
  const hit = view.pickObject(sx, sy);
  if (!hit) return;
  if (onlySolids) { const p = S.doc.parts.find((e) => e.id === hit.id); if (!p || isBeam(p)) return; }
  pushUndo();
  removeObject(hit.id);
  hoverId = null;
  commit();
}
function removeObject(id) {
  const f = findById(S.doc, id);
  if (!f) return;
  const doc = S.doc;
  if (f.coll === 'parts') {
    // pulleys/winches mounted on it go too
    const mounted = (it) => { const m = mountOf(doc, it); return m.kind === 'part' && m.part === f.obj; };
    doc.pulleys = doc.pulleys.filter((it) => !mounted(it));
    doc.winches = doc.winches.filter((it) => !mounted(it));
  }
  doc[f.coll] = doc[f.coll].filter((e) => e.id !== id);
}

function cancelDrafts() {
  S.draw = null;
  S.blockDraft = null;
  S.stringDraft = null;
  clearGhost();
  updateHint();
}

// ------------------------------------------------------------------ tools
const TOOLS = ['select', 'block', 'beam', 'pin', 'servo', 'pulley', 'string', 'winch', 'erase'];
function setTool(t, silent) {
  if (S.mode === 'run' && t !== 'select') return;
  if (S.tool === 'string' && S.stringDraft && t !== 'string') finishString();
  S.tool = t;
  S.draw = null;
  S.blockDraft = null;
  clearGhost();
  setHover(null);
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const vp = $('viewport');
  vp.className = 'viewport ' + (t === 'select' ? 'cursor-grab' : t === 'erase' ? 'cursor-erase' : 'cursor-cross');
  renderSubtools();
  if (!silent) updateHint();
}

function renderSubtools() {
  const el = $('subtools');
  el.innerHTML = '';
  if (S.mode === 'run') { el.hidden = true; return; }
  const label = (txt) => { const l = document.createElement('span'); l.className = 'lbl'; l.textContent = txt; el.appendChild(l); };
  const seg = (lbl, opts, cur, onPick) => {
    label(lbl);
    for (const [v, txt, sub] of opts) {
      const b = document.createElement('button');
      b.innerHTML = sub ? `<b>${txt}</b><small>${sub}</small>` : txt;
      b.className = (cur === v ? 'on' : '') + (sub ? ' card2' : '');
      b.onclick = () => { onPick(v); renderSubtools(); };
      el.appendChild(b);
    }
  };
  if (S.tool === 'pin') seg('Tipo', [['hinge', 'Liscio · ruota'], ['weld', 'A croce · bloccato'], ['servo', 'Motore generico']], S.pinType, (v) => (S.pinType = v));
  else if (S.tool === 'string') seg('Tipo', [['string', 'Filo · non si allunga'], ['elastic', 'Elastico · richiama']], S.stringKind, (v) => { S.stringKind = v; if (S.stringDraft) S.stringDraft.kind = v; });
  else if (S.tool === 'beam') seg('Strato sul muro', [['auto', 'Automatico'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], S.layerMode, (v) => (S.layerMode = v));
  else if (S.tool === 'servo') seg('Modello', Object.values(SERVO_MODELS).map((m) => [m.name, m.name, `${fmt(m.kgcm, 1)} kg·cm · ${fmt(m.mass * 1000, 0)} g`]), S.servoModel, (v) => (S.servoModel = v));
  else if (S.tool === 'pulley') seg('Misura', PULLEY_SIZES.map(([r, t]) => [r, t + ' mm']), S.pulleyR, (v) => (S.pulleyR = v));
  else if (S.tool === 'block') {
    label('Colore');
    for (const c of BLOCK_COLORS) {
      const b = document.createElement('button');
      b.className = 'sw' + (S.blockColor === c ? ' on' : '');
      b.style.background = c;
      b.title = 'Colore dei nuovi blocchi'; b.setAttribute('aria-label', 'Colore ' + c);
      b.onclick = () => { S.blockColor = c; renderSubtools(); };
      el.appendChild(b);
    }
  }
  el.hidden = !el.children.length;
}

// ------------------------------------------------------------------ pointer input
const canvas = view.renderer.domElement;
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.offsetX, y: e.offsetY, b: e.button, t: performance.now() };
  if (e.button !== 0) return;
  view.controls.mouseButtons.LEFT = null;
  if (S.mode === 'edit' && S.tool === 'block') {
    // press on a face: a block starts there; dragging stretches it along that face
    const c = blockCellAt(e.offsetX, e.offsetY);
    if (c) { S.blockDraft = { a: c.c, b: c.c, normal: c.normal }; canvas.setPointerCapture(e.pointerId); updateHint(); updateGhost(e.offsetX, e.offsetY); }
    return;
  }
  const hit = S.tool === 'select' ? view.pickObject(e.offsetX, e.offsetY) : null;
  if (S.mode === 'run' && hit && hit.kind === 'part' && hit.point) {
    const pose = S.sim.bodyPose(hit.id);
    if (!pose) return;
    const q = new THREE.Quaternion(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
    const pm = hit.point.clone().multiplyScalar(0.001);
    const local = pm.clone().sub(new THREE.Vector3(...pose.pos)).applyQuaternion(q.invert());
    // pull in the plane that faces you, through the point you grabbed
    S.drag = { partId: hit.id, local, target: pm.clone(), normal: view.toEye(hit.point), origin: hit.point.clone() };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (S.mode === 'edit' && hit && hit.kind === 'part' && hit.point) {
    startMove(hit.id, e.shiftKey, e.offsetX, e.offsetY);
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // left drag on empty space orbits when nothing else wants it
  view.controls.mouseButtons.LEFT = S.tool === 'select' && !hit ? THREE.MOUSE.ROTATE : null;
}, { capture: true });

// ---- moving pieces in the editor: grab one and drop it on the lattice. A beam slides in its own
// plane, a block or a servo along the face you grab it by. Pins used only by what is being moved
// come along (so a beam pinned to the board stays pinned at its new place); pins shared with other
// parts stay, so the piece comes off them. Holes dropped onto an existing pin join it.
function moveSet(partId, group) {
  const doc = S.doc;
  const ids = new Set([partId]);
  if (group) {
    // everything pinned, glued or geared to it, the fixed base excluded
    const glue = glueLinks(doc).filter(([a, b]) => a !== 'G' && b !== 'G');
    for (const s of doc.parts) if (isServo(s)) for (const m of shaftMembers(doc, s)) glue.push([s.id, m.id]);
    for (let grown = true; grown;) {
      grown = false;
      for (const pin of doc.pins) {
        const mem = pinMembers(doc, pin).filter((m) => m.kind === 'part').map((m) => m.part.id);
        if (mem.some((id) => ids.has(id)) && mem.some((id) => !ids.has(id))) { mem.forEach((id) => ids.add(id)); grown = true; }
      }
      for (const [a, b] of glue) if (ids.has(a) !== ids.has(b)) { ids.add(a); ids.add(b); grown = true; }
    }
  }
  const pins = doc.pins.filter((pin) => { const mem = pinMembers(doc, pin).filter((m) => m.kind === 'part'); return mem.length && mem.every((m) => ids.has(m.part.id)); });
  const wheels = [...doc.pulleys, ...doc.winches].filter((w) => { const m = mountOf(doc, w); return m.kind === 'part' && ids.has(m.part.id); });
  return [...doc.parts.filter((p) => ids.has(p.id)), ...pins, ...wheels];
}
const coordsOf = (o) => ({ x: o.x, z: o.z, layer: o.layer, lo: o.lo, hi: o.hi, c: o.c && [...o.c] });
function restoreCoords(o, c) { for (const k of Object.keys(c)) if (c[k] !== undefined) o[k] = Array.isArray(c[k]) ? [...c[k]] : c[k]; }

function startMove(partId, group, sx, sy) {
  const part = S.doc.parts.find((p) => p.id === partId);
  const surf = view.pickSurface(sx, sy);
  if (!part || !surf.point) return;
  const items = moveSet(partId, group);
  let normal = new THREE.Vector3(...NVEC[fam(part)]);
  if (!isBeam(part)) {
    const a = [Math.abs(surf.normal.x), Math.abs(surf.normal.y), Math.abs(surf.normal.z)];
    const k = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
    normal = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
  }
  S.move = { p0: surf.point.clone(), normal, items, orig: items.map(coordsOf), d: [0, 0, 0], undone: false, selectId: partId };
}
function updateMove(sx, sy) {
  const m = S.move;
  const p = view.planeThrough(sx, sy, m.normal, m.p0);
  if (!p) return;
  const d = [snapP(p.x - m.p0.x), snapP(p.y - m.p0.y), snapP(p.z - m.p0.z)];
  if (d.every((v, k) => v === m.d[k])) return;
  if (!m.undone) { pushUndo(); m.undone = true; }
  m.d = d;
  m.items.forEach((o, k) => { restoreCoords(o, m.orig[k]); shiftItem(o, d); });
  view.rebuild(S.doc);
  view.setHighlight(m.selectId, true, 0x3a6fd8);
  schedulePreview();
}
function endMove() {
  const m = S.move;
  S.move = null;
  if (m.undone) { S.selected = m.selectId; commit(); }
  else select(m.selectId);
}
// Arrow keys: push the selected piece one hole along a world axis.
function nudgeSelected(d) {
  const f = S.selected !== null ? findById(S.doc, S.selected) : null;
  if (!f || f.coll === 'strings') return;
  pushUndo();
  for (const o of f.coll === 'parts' ? moveSet(f.obj.id, false) : [f.obj]) shiftItem(o, d);
  commit();
}
function duplicateSelected() {
  const f = S.selected !== null ? findById(S.doc, S.selected) : null;
  if (!f || f.coll !== 'parts') return;
  const src = f.obj, box = isBeam(src) ? null : solidBox(src);
  const span = (k) => (box ? Math.ceil((box.max[k] - box.min[k] - 0.5) / P) || 1 : 1) * P;
  // next to the original: the first free place to the right, above, to the left, in front
  let copy = null;
  for (const d of [[span(0), 0, 0], [0, 0, span(2)], [-span(0), 0, 0], [0, -span(1), 0]]) {
    const c = JSON.parse(JSON.stringify(src));
    shiftItem(c, d);
    if (!box || !blocked(c)) { copy = c; break; }
  }
  if (!copy) { toast('Non c\'è posto accanto per la copia.'); return; }
  pushUndo();
  copy.id = S.doc.nextId++;
  S.doc.parts.push(copy);
  S.selected = copy.id;
  commit();
}
// R: turn the selected piece. A beam turns 15 degrees about its first hole (pins and wheels used
// only by it turn too), a servo a quarter turn about its shaft, a block swaps two of its sides.
function rotateSelected(deg) {
  const doc = S.doc;
  const part = doc.parts.find((p) => p.id === S.selected);
  if (!part) return;
  pushUndo();
  if (isServo(part)) {
    part.angle = (((part.angle || 0) + (deg > 0 ? 90 : -90)) % 360 + 360) % 360;
  } else if (isBlock(part)) {
    part.s = deg > 0 ? [part.s[1], part.s[0], part.s[2]] : [part.s[0], part.s[2], part.s[1]];
  } else {
    const own = [
      ...doc.pins.filter((pin) => { const mem = pinMembers(doc, pin).filter((m) => m.kind === 'part'); return mem.length && mem.every((m) => m.part.id === part.id); }),
      ...[...doc.pulleys, ...doc.winches].filter((w) => { const m = mountOf(doc, w); return m.kind === 'part' && m.part.id === part.id; }),
    ].filter((o) => Math.hypot(o.x - part.x, o.z - part.z) > EPS);
    const a = rad(deg), c = Math.cos(a), sn = Math.sin(a);
    for (const o of own) {
      const dx = o.x - part.x, dz = o.z - part.z;
      o.x = Math.round((part.x + dx * c - dz * sn) * 1e6) / 1e6;
      o.z = Math.round((part.z + dx * sn + dz * c) * 1e6) / 1e6;
    }
    part.angle = ((((part.angle + deg) + 180) % 360) + 360) % 360 - 180;
  }
  commit();
}

canvas.addEventListener('pointermove', (e) => {
  if (S.move) { updateMove(e.offsetX, e.offsetY); return; }
  if (S.blockDraft) {
    const d = S.blockDraft;
    const p = view.planeThrough(e.offsetX, e.offsetY, new THREE.Vector3(...d.normal), new THREE.Vector3(...d.a));
    if (p) d.b = [p.x, p.y, p.z].map((v, k) => (d.normal[k] ? d.a[k] : clamp(snapP(v), d.a[k] - 39 * P, d.a[k] + 39 * P)));
    d.b[2] = Math.max(P, d.b[2]);
    updateGhost(e.offsetX, e.offsetY);
    return;
  }
  if (S.drag) {
    const wp = view.planeThrough(e.offsetX, e.offsetY, S.drag.normal, S.drag.origin);
    if (wp) S.drag.target.copy(wp.multiplyScalar(0.001));
    return;
  }
  if (down && (e.buttons & 6)) return; // orbiting / panning
  updateGhost(e.offsetX, e.offsetY);
});

canvas.addEventListener('pointerup', (e) => {
  if (S.drag) { S.drag = null; S.sim?.clearForces(); canvas.releasePointerCapture(e.pointerId); return; }
  if (S.move) { endMove(); canvas.releasePointerCapture(e.pointerId); down = null; return; }
  if (S.blockDraft) { placeBlock(); canvas.releasePointerCapture(e.pointerId); down = null; updateGhost(e.offsetX, e.offsetY); return; }
  if (!down) return;
  const moved = Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5;
  const b = down.b;
  down = null;
  if (moved) return;
  if (b === 2) { // right click without drag: step back, or take a block away
    if (S.draw) { S.draw = null; clearGhost(); updateHint(); }
    else if (S.stringDraft) finishString();
    else if (S.tool === 'block' && S.mode === 'edit') { eraseAt(e.offsetX, e.offsetY, true); updateGhost(e.offsetX, e.offsetY); }
    return;
  }
  if (b !== 0) return;
  onClick(e.offsetX, e.offsetY, e.detail >= 2);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerleave', () => { if (!S.draw && !S.stringDraft && !S.blockDraft) clearGhost(); setHover(null); });

function onClick(sx, sy, dbl) {
  if (S.mode === 'run') return;
  updateGhost(sx, sy);
  switch (S.tool) {
    case 'beam': clickBeam(); break;
    case 'pin': clickPin(); break;
    case 'servo': clickServo(); break;
    case 'pulley': clickWheel('pulley'); break;
    case 'winch': clickWheel('winch'); break;
    case 'string': clickString(dbl); break;
    case 'erase': eraseAt(sx, sy); break;
    case 'select': {
      const hit = view.pickObject(sx, sy);
      select(hit ? hit.id : null);
      break;
    }
  }
  updateGhost(sx, sy);
}

function select(id) {
  if (S.selected !== null) view.setHighlight(S.selected, false);
  S.selected = id;
  if (id !== null) view.setHighlight(id, true, 0x3a6fd8);
  drawStrings();
  renderLegend();
  renderInspector();
}

// ------------------------------------------------------------------ keyboard
let lastMouse = null;
canvas.addEventListener('pointermove', (e) => { lastMouse = { x: e.offsetX, y: e.offsetY }; });
const NUDGE = { arrowleft: [-P, 0, 0], arrowright: [P, 0, 0], arrowup: [0, 0, P], arrowdown: [0, 0, -P], pageup: [0, P, 0], pagedown: [0, -P, 0] };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd' && S.mode === 'edit') { e.preventDefault(); duplicateSelected(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') {
    if (S.stringDraft) { S.stringDraft = null; clearGhost(); updateHint(); }
    else if (S.draw || S.blockDraft) { S.draw = null; S.blockDraft = null; clearGhost(); updateHint(); }
    else select(null);
    return;
  }
  if (k === 'enter' && S.stringDraft) { finishString(); return; }
  if (k === ' ') { e.preventDefault(); startSim(); return; }
  if (k === 's') { toggleSchema(); return; }
  if ((k === 'delete' || k === 'backspace') && S.selected !== null && S.mode === 'edit') { pushUndo(); removeObject(S.selected); S.selected = null; commit(); return; }
  if (NUDGE[k] && S.mode === 'edit' && S.selected !== null) { e.preventDefault(); nudgeSelected(NUDGE[k]); return; }
  if (k === 'r' && S.mode === 'edit') {
    if (S.tool === 'servo') { S.servoAngle = (S.servoAngle + (e.shiftKey ? 270 : 90)) % 360; if (lastMouse) updateGhost(lastMouse.x, lastMouse.y); return; }
    if (S.selected !== null) { rotateSelected(e.shiftKey ? -15 : 15); return; }
  }
  if (/^[1-9]$/.test(k)) { setTool(TOOLS[+k - 1]); return; }
  const map = { v: 'select', c: 'block', b: 'beam', p: 'pin', m: 'servo', u: 'pulley', f: 'string', w: 'winch', x: 'erase' };
  if (map[k]) setTool(map[k]);
});

// ------------------------------------------------------------------ side panel
function renderPanel() { renderControls(); renderLegend(); renderInspector(); renderWarnings(); }

function stringName(s) {
  if (s.name) return s.name;
  const same = S.doc.strings.filter((x) => x.kind === s.kind);
  return `${s.kind === 'elastic' ? 'Elastico' : 'Filo'} ${same.indexOf(s) + 1}`;
}

// One row per string: its colour in the schematic view, name, what drives it and, while simulating, its tension.
function renderLegend() {
  const ul = $('legend');
  $('legendSec').hidden = !S.doc.strings.length;
  ul.innerHTML = '';
  for (const s of S.doc.strings) {
    const li = document.createElement('li');
    li.dataset.sid = s.id;
    li.className = S.selected === s.id ? 'sel' : '';
    const onW = s.anchors[0]?.t === 'winch' || s.anchors[s.anchors.length - 1]?.t === 'winch';
    const what = s.kind === 'elastic' ? 'elastico' : onW ? (s.wind === -1 ? 'si svolge dal verricello' : 'si avvolge sul verricello') : s.stiffness ? 'cavo' : 'filo fisso';
    li.innerHTML = `<span class="sw${s.kind === 'elastic' ? ' el' : ''}" style="background:${stringColor(S.doc, s)}"></span><span class="ln"></span><span class="lt" data-t></span>`;
    li.querySelector('.ln').innerHTML = `${escapeHtml(stringName(s))} <small>${what}</small>`;
    li.onmouseenter = () => { view.hoverString = s.id; drawStrings(); };
    li.onmouseleave = () => { view.hoverString = null; drawStrings(); };
    li.onclick = () => { if (S.tool !== 'select' && S.mode === 'edit') setTool('select'); select(s.id); renderLegend(); };
    ul.appendChild(li);
  }
}

// Strings tied to a winch: [{s, wind}] where wind is +1 (winds on, pulls) or -1 (unwinds, pays out).
function winchStrings(w) {
  const out = [];
  for (const s of S.doc.strings) {
    const first = s.anchors[0], last = s.anchors[s.anchors.length - 1];
    if ((first?.t === 'winch' && first.id === w.id) || (last?.t === 'winch' && last.id === w.id)) out.push({ s, wind: s.wind === -1 ? -1 : 1 });
  }
  return out;
}

// Everything with a motor on a joint: pins of type servo and servo parts.
function servoList() {
  return [...S.doc.pins.filter((p) => p.type === 'servo'), ...S.doc.parts.filter(isServo)];
}
const kgcm = (nm) => nm / 0.0980665;
// How far a winch can reel in (mm): half a turn of the drum each way for a servo with a spool.
function winchTravel(w) {
  const sp = servoSpec(w);
  return sp ? rad(sp.range) * w.r : Infinity;
}

function renderControls() {
  const el = $('controls');
  el.innerHTML = '';
  const doc = S.doc;
  const items = [];
  for (const w of doc.winches) {
    const list = winchStrings(w);
    if (!list.length) continue;
    const lens = list.filter((x) => x.wind === 1).map((x) => (S.preview?.lengths?.[x.s.id] ?? S.sim?.lengths?.[x.s.id] ?? 0.1) * 1000);
    const max = Math.max(10, Math.floor(Math.min(winchTravel(w), Math.min(...(lens.length ? lens : [60])) * 0.8)));
    items.push({ kind: 'winch', w, list, max });
  }
  for (const o of servoList()) items.push({ kind: 'servo', o });
  if (!items.length) {
    el.innerHTML = '<p class="empty">Qui compaiono gli slider dei motori. Monta un <b>servo</b> e appoggia una trave sul suo albero, oppure monta un <b>verricello</b> e fai partire un filo da lì.</p>';
    return;
  }
  let nw = 0, ns = 0;
  for (const it of items) {
    const box = document.createElement('div');
    box.className = 'ctl';
    if (it.kind === 'winch') {
      const id = `ctl_w${it.w.id}`;
      const v = Math.min(it.max, S.controls.winch[it.w.id] ?? 0);
      const rows = it.list.map(({ s, wind }) => `<div class="strrow" data-sid="${s.id}">
          <span class="sname"><span class="wind">${wind === 1 ? '⟲ avvolge' : '⟳ svolge'}</span> ${escapeHtml(s.name || 'Filo')}</span><span class="val" data-t>—</span>
          <div class="meter" data-m><i></i></div></div>`).join('');
      box.innerHTML = `<div class="row"><label class="name" for="${id}">Verricello ${++nw}${it.w.model ? ' · ' + it.w.model : ''}</label><span class="val" data-v>gira ${fmt(v, 0)} mm</span></div>
        <input type="range" id="${id}" min="0" max="${it.max}" step="0.5" value="${v}">
        ${rows}
        <div class="row"><span class="val muted">forza max per filo</span><span class="val">${fmt(winchForce(it.w), 0)} N</span></div>
        <div class="note" data-n hidden></div>`;
      const r = box.querySelector('input');
      r.oninput = () => { S.controls.winch[it.w.id] = +r.value; box.querySelector('[data-v]').textContent = `gira ${fmt(+r.value, 0)} mm`; S.sim?.setControls(S.controls); markDirty(); };
      box.dataset.winch = it.w.id;
    } else {
      const o = it.o, sv = servoParams(o);
      const lo = Math.max(sv.travel[0], sv.range ? sv.range[0] : -Infinity), hi = Math.min(sv.travel[1], sv.range ? sv.range[1] : Infinity);
      const id = `ctl_p${o.id}`;
      const v = clamp(S.controls.servo[o.id] ?? 0, lo, hi);
      box.innerHTML = `<div class="row"><label class="name" for="${id}">Servo ${++ns}${o.model ? ' · ' + o.model : ''}</label><span class="val" data-v>${fmt(v, 0)}°</span></div>
        <input type="range" id="${id}" min="${lo}" max="${hi}" step="1" value="${v}">
        <div class="row"><span class="val" data-t>coppia —</span><span class="val">max ${fmt(kgcm(sv.tmax), 1)} kg·cm</span></div>
        <div class="meter" data-m><i></i></div><div class="note" data-n hidden></div>`;
      const r = box.querySelector('input');
      r.oninput = () => { S.controls.servo[o.id] = +r.value; box.querySelector('[data-v]').textContent = `${fmt(+r.value, 0)}°`; S.sim?.setControls(S.controls); markDirty(); };
      box.onmouseenter = () => { if (S.selected !== o.id) view.setHighlight(o.id, true, 0x888888); };
      box.onmouseleave = () => { if (S.selected !== o.id) view.setHighlight(o.id, false); };
      box.dataset.pin = o.id;
      box.dataset.tmax = sv.tmax;
    }
    el.appendChild(box);
  }
  if (S.mode !== 'run') {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Premi Simula per vedere le forze.';
    el.appendChild(p);
  }
}

function updateLiveReadouts() {
  const sim = S.sim;
  if (!sim) return;
  for (const li of $('legend').querySelectorAll('li')) li.querySelector('[data-t]').textContent = fmt(sim.tension(+li.dataset.sid), 2) + ' N';
  for (const box of $('controls').querySelectorAll('.ctl')) {
    let note = '';
    if (box.dataset.winch) {
      const w = S.doc.winches.find((x) => x.id === +box.dataset.winch);
      const max = w ? winchForce(w) : 10;
      for (const row of box.querySelectorAll('.strrow')) {
        const sid = +row.dataset.sid;
        const s = S.doc.strings.find((x) => x.id === sid);
        const T = sim.tension(sid);
        row.querySelector('[data-t]').textContent = `${fmt(T, 2)} N`;
        const m = row.querySelector('[data-m]');
        m.querySelector('i').style.width = Math.min(100, (T / max) * 100) + '%';
        m.classList.toggle('hot', T >= max * 0.98);
        if (T >= max * 0.98) note = 'Il motore è al limite: non ce la fa a tirare di più.';
        else if (!note && T < 0.005 && s?.wind !== -1 && (S.controls.winch[w.id] ?? 0) > 0) note = `${s?.name || 'Il filo'} è lasco: non sta tirando niente.`;
      }
    } else {
      const pid = +box.dataset.pin;
      const val = Math.abs(sim.servoTorque(pid)), max = +box.dataset.tmax || 0.2;
      box.querySelector('[data-t]').textContent = `coppia ${fmt(kgcm(val), 2)} kg·cm`;
      const m = box.querySelector('[data-m]');
      m.querySelector('i').style.width = Math.min(100, (val / max) * 100) + '%';
      m.classList.toggle('hot', val >= max * 0.98);
      if (val >= max * 0.98) note = 'Il servo è al limite di coppia: il carico è troppo per questo modello.';
    }
    const n = box.querySelector('[data-n]');
    n.hidden = !note;
    n.textContent = note;
  }
}

const FAM_LABEL = { y: 'Contro il muro', z: 'In piano (fori in su)', x: 'Di taglio (fori di lato)' };

function renderInspector() {
  const el = $('inspector');
  const f = S.selected !== null ? findById(S.doc, S.selected) : null;
  el.innerHTML = '';
  if (!f) {
    $('inspTitle').textContent = 'Selezione';
    el.innerHTML = '<p class="empty">Con la <b>Mano</b> (V) clicca un pezzo, un perno o un filo per modificarlo.</p>';
    return;
  }
  const o = f.obj;
  const editable = S.mode === 'edit';
  const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d.firstElementChild); return el.lastElementChild; };
  const numProp = (label, value, min, max, step, onChange, unit = '') => {
    const id = 'in_' + label.replace(/\W+/g, '_');
    const row = add(`<div class="prop"><label for="${id}">${label}</label><span><input type="number" id="${id}" value="${value}" min="${min}" max="${max}" step="${step}" ${editable ? '' : 'disabled'}> ${unit}</span></div>`);
    row.querySelector('input').onchange = (e) => { const v = Math.min(max, Math.max(min, +e.target.value)); pushUndo(); onChange(v); commit(); };
  };
  const info = (label, value) => add(`<div class="prop"><label>${label}</label><span class="num">${value}</span></div>`);
  const segProp = (opts, cur, onPick) => {
    const seg = add('<div class="seg"></div>');
    for (const [v, txt] of opts) {
      const b = document.createElement('button');
      b.textContent = txt; b.className = cur === v ? 'on' : ''; b.disabled = !editable;
      b.onclick = () => { pushUndo(); onPick(v); commit(); };
      seg.appendChild(b);
    }
  };
  const swatches = (colors) => {
    const sw = add('<div class="swatches"></div>');
    for (const c of colors) {
      const b = document.createElement('button');
      b.style.background = c; b.className = o.color === c ? 'on' : ''; b.title = 'Colore'; b.setAttribute('aria-label', 'Colore ' + c);
      b.disabled = !editable;
      b.onclick = () => { pushUndo(); o.color = c; commit(); };
      sw.appendChild(b);
    }
  };
  const delBtn = () => {
    const b = add(`<button class="danger" ${editable ? '' : 'disabled'}>Elimina</button>`);
    b.onclick = () => { pushUndo(); removeObject(o.id); S.selected = null; commit(); };
  };
  // model picker shared by servo parts, motor pins and winches
  const modelPicker = (allowGeneric, onPick) => {
    segProp([...(allowGeneric ? [['', 'Generico']] : []), ...Object.keys(SERVO_MODELS).map((k) => [k, k])], o.model || '', onPick);
  };
  const specSheet = (sp) => {
    add(`<p class="empty">${sp.kind}</p>`);
    info('Coppia', `${fmt(sp.kgcm, 1)} kg·cm`);
    info('Velocità', `${fmt(60 / sp.speed, 2)} s / 60°`);
    info('Corsa', `${sp.range}°`);
    info('Peso', `${fmt(sp.mass * 1000, 0)} g`);
    info('Corpo', `${fmt(sp.body[0], 1)} × ${fmt(sp.body[1], 1)} mm`);
    info('Tensione', sp.volt);
  };

  if (f.coll === 'parts' && isBlock(o)) {
    $('inspTitle').textContent = 'Blocco';
    info('Misura', `${o.s.map((n) => n * P).join(' × ')} mm`);
    const dims = ['Larghezza', 'Profondità', 'Altezza'];
    dims.forEach((lbl, k) => numProp(lbl, o.s[k], 1, 40, 1, (v) => { const old = o.s[k]; o.s[k] = v; if (blocked(o, o.id)) { o.s[k] = old; toast('Non c\'è spazio per allungarlo.'); } }, 'fori'));
    swatches(BLOCK_COLORS);
    const gl = add(`<label class="prop"><span>Si incolla a ciò che tocca</span><input type="checkbox" ${o.glue !== false ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>`);
    gl.querySelector('input').onchange = (e) => { pushUndo(); if (e.target.checked) delete o.glue; else o.glue = false; commit(); };
    add('<p class="empty">Ha un foro su ogni faccia: ci passano perni e alberi dei servo, e i fili ci si legano. Togli la colla se deve muoversi accanto ad altri blocchi.</p>');
    delBtn();
  } else if (f.coll === 'parts' && isServo(o)) {
    $('inspTitle').textContent = 'Servo ' + o.model;
    modelPicker(false, (v) => { const old = o.model, L = o.layer; o.layer += (o.dir || 1) * (SERVO_MODELS[v].layers - SERVO_MODELS[old].layers); o.model = v; if (blocked(o, o.id)) { o.model = old; o.layer = L; toast('Questo modello qui non ci sta.'); } });
    specSheet(SERVO_MODELS[o.model]);
    info('Montato', FAM_LABEL[fam(o)].toLowerCase());
    const drives = shaftMembers(S.doc, o);
    add(`<p class="empty">${drives.length ? `Fa girare: ${drives.map(partLabel).join(', ').toLowerCase()}.` : 'Non muove ancora niente: appoggia una trave o un blocco sul suo albero.'}</p>`);
    const rb = add(`<button ${editable ? '' : 'disabled'}>Gira il corpo di 90° (R)</button>`);
    rb.onclick = () => rotateSelected(90);
    if (S.mode === 'run' && S.sim) {
      const a = S.sim.pinAngle(o.id);
      if (a !== null) info('Angolo adesso', `${fmt(a, 1)}°`);
    }
    delBtn();
  } else if (f.coll === 'parts') {
    $('inspTitle').textContent = 'Trave';
    info('Fori', `${o.holes} · ${fmt((o.holes - 1) * P + BEAM_W, 1)} mm`);
    numProp('Lunghezza (fori)', o.holes, 2, 25, 1, (v) => (o.holes = v));
    numProp('Angolo', +(+o.angle).toFixed(1), -180, 180, 15, (v) => (o.angle = v), '°');
    numProp('Strato', o.layer, -40, 40, 1, (v) => (o.layer = v));
    info('Piano', FAM_LABEL[fam(o)]);
    swatches(BEAM_COLORS);
    delBtn();
  } else if (f.coll === 'pins') {
    $('inspTitle').textContent = PIN_LABEL[o.type];
    segProp(['hinge', 'weld', 'servo'].map((t) => [t, PIN_LABEL[t]]), o.type, (t) => (o.type = t));
    const mem = pinMembers(S.doc, o);
    add(`<p class="empty">Unisce ${mem.length} ${mem.length === 1 ? 'pezzo' : 'pezzi'} (strati ${o.lo}–${o.hi})${mem.some((m) => m.kind === 'board') ? ', base compresa' : ''}.</p>`);
    if (o.type === 'servo') {
      add('<p class="empty">Motore:</p>');
      modelPicker(true, (v) => { if (v) { o.model = v; delete o.tmax; delete o.range; delete o.free; } else delete o.model; });
      const sp = servoSpec(o);
      if (sp) { info('Coppia', `${fmt(sp.kgcm, 1)} kg·cm`); info('Velocità', `${fmt(60 / sp.speed, 2)} s / 60°`); info('Corsa', `${sp.range}°`); }
    }
    if (o.type !== 'weld' && !servoSpec(o)) {
      const lim = add(`<label class="prop"><span>Giro completo libero</span><input type="checkbox" ${o.free ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>`);
      lim.querySelector('input').onchange = (e) => { pushUndo(); if (e.target.checked) o.free = true; else delete o.free; commit(); };
      if (!o.free) {
        const r = o.range || [-170, 170];
        numProp('Ruota da', r[0], -180, 0, 5, (v) => (o.range = [v, (o.range || r)[1]]), '°');
        numProp('fino a', r[1], 0, 180, 5, (v) => (o.range = [(o.range || r)[0], v]), '°');
      }
    }
    if (o.type === 'servo' && !servoSpec(o)) numProp('Coppia max', +((o.tmax ?? 0.2) * 100).toFixed(1), 1, 500, 1, (v) => (o.tmax = v / 100), 'N·cm');
    if (S.mode === 'run' && S.sim) {
      const a = S.sim.pinAngle(o.id);
      if (a !== null) info('Angolo adesso', `${fmt(a, 1)}°`);
    }
    delBtn();
  } else if (f.coll === 'pulleys') {
    $('inspTitle').textContent = 'Puleggia';
    segProp(PULLEY_SIZES.map(([r, t]) => [r, t]), o.r, (v) => (o.r = v));
    numProp('Raggio', o.r, 3, 24, 1, (v) => (o.r = v), 'mm');
    add('<p class="empty">Il braccio di leva del filo attorno al perno è circa uguale al raggio: più grande, più coppia con la stessa forza.</p>');
    delBtn();
  } else if (f.coll === 'winches') {
    $('inspTitle').textContent = 'Verricello';
    add('<p class="empty">Motore che fa girare il tamburo:</p>');
    modelPicker(true, (v) => { if (v) o.model = v; else delete o.model; });
    numProp('Raggio del tamburo', o.r, 4, 20, 1, (v) => (o.r = v), 'mm');
    const sp = servoSpec(o);
    if (sp) {
      info('Forza sul filo', `${fmt(winchForce(o), 1)} N`);
      info('Corsa del filo', `${fmt(winchTravel(o), 0)} mm`);
      info('Velocità', `${fmt(rad(sp.speed) * o.r, 0)} mm/s`);
      add(`<p class="empty">${sp.name}: ${fmt(sp.kgcm, 1)} kg·cm su un tamburo di ${o.r} mm di raggio. Tamburo più piccolo, più forza ma meno corsa.</p>`);
    } else numProp('Forza max', o.fmax ?? 10, 0.5, 200, 0.5, (v) => (o.fmax = v), 'N');
    delBtn();
  } else if (f.coll === 'strings') {
    $('inspTitle').textContent = STRING_LABEL[o.kind];
    const nm = add(`<div class="prop"><label for="strName">Nome</label><input id="strName" value="${escapeHtml(o.name || '')}" placeholder="es. Flessore" style="width:150px;padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--raised)" ${editable ? '' : 'disabled'}></div>`);
    nm.querySelector('input').onchange = (e) => { pushUndo(); o.name = e.target.value.slice(0, 40); commit(); };
    segProp(['string', 'elastic'].map((t) => [t, STRING_LABEL[t]]), o.kind, (t) => { o.kind = t; if (t === 'elastic') { o.stiffness ??= 60; o.pretension ??= 3; } });
    info('Passa per', `${o.anchors.length} punti`);
    const onWinch = o.anchors[0]?.t === 'winch' || o.anchors[o.anchors.length - 1]?.t === 'winch';
    if (onWinch) {
      add('<p class="empty">Sul tamburo del verricello questo filo:</p>');
      segProp([[1, '⟲ si avvolge (tira)'], [-1, '⟳ si svolge (rilascia)']], o.wind === -1 ? -1 : 1, (v) => { if (v === -1) o.wind = -1; else delete o.wind; });
      add('<p class="empty">Due fili sullo stesso verricello, uno che si avvolge e uno che si svolge, lavorano come una cinghia: uno chiude, l\'altro riapre.</p>');
    }
    if (o.kind === 'elastic') {
      numProp('Rigidezza', o.stiffness ?? 60, 1, 5000, 5, (v) => (o.stiffness = v), 'N/m');
      numProp('Precarico', o.pretension ?? 3, 0, 50, 0.5, (v) => (o.pretension = v), 'mm');
    } else if (!onWinch) {
      numProp('Rigidezza (0 = non si allunga)', o.stiffness ?? 0, 0, 100000, 100, (v) => { if (v > 0) o.stiffness = v; else delete o.stiffness; }, 'N/m');
    }
    const sim = S.mode === 'run' ? S.sim : S.preview;
    if (sim) info('Lunghezza', `${fmt(sim.tendonLength(o.id) * 1000, 1)} mm`);
    if (S.mode === 'run' && S.sim) info('Tensione', `${fmt(S.sim.tension(o.id), 2)} N`);
    const count = (...t) => o.anchors.filter((a) => t.includes(a.t)).length;
    const parts = [[count('guide'), 'occhiell', 'o', 'i'], [count('pulley'), 'puleg', 'gia', 'ge'], [count('hole', 'pt', 'board', 'world'), 'for', 'o', 'i']].filter((x) => x[0]).map(([n, w, s1, sp]) => `${n} ${w}${n === 1 ? s1 : sp}`);
    add(`<p class="empty">Passa da ${parts.join(', ') || 'due punti'}.</p>`);
    const rb = add(`<button ${editable ? '' : 'disabled'}>Rifai il percorso</button>`);
    rb.title = 'Riclicca i punti da cui passa: il filo tiene nome e impostazioni';
    rb.onclick = () => { setTool('string'); S.stringDraft = { kind: o.kind, anchors: [], replaceId: o.id }; updateHint(); };
    delBtn();
  }
}

function renderWarnings() {
  const list = S.warnings || [];
  $('warnSec').hidden = !list.length;
  $('warnings').innerHTML = list.map((w) => `<li class="${w.level}">${escapeHtml(w.text)}</li>`).join('');
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ------------------------------------------------------------------ projects dialog
async function openProjects() {
  $('projDialog').hidden = false;
  $('projWhere').textContent = store.where;
  const ul = $('projList');
  ul.innerHTML = '<li class="empty">Carico…</li>';
  let list = [];
  try { list = await store.list(); } catch { ul.innerHTML = '<li class="empty">Non riesco a leggere i progetti salvati. Riprova tra poco.</li>'; return; }
  if (!list.length) { ul.innerHTML = '<li class="empty">Nessun progetto salvato ancora.</li>'; return; }
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.className = p.id === S.projectId ? 'cur' : '';
    const when = p.updatedAt ? new Date(p.updatedAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    li.innerHTML = `<span class="pn"></span><span class="pd">${when}</span><button data-a="open">Apri</button><button data-a="del" class="danger">Elimina</button>`;
    li.querySelector('.pn').textContent = p.name;
    li.querySelector('[data-a=open]').onclick = async () => {
      if (S.dirty) await saveNow();
      const full = await store.load(p.id);
      if (full) loadProject(full);
      $('projDialog').hidden = true;
    };
    const del = li.querySelector('[data-a=del]');
    del.onclick = async () => {
      if (del.dataset.confirm) {
        await store.remove(p.id);
        if (p.id === S.projectId) S.projectId = null;
        openProjects();
      } else { del.dataset.confirm = '1'; del.textContent = 'Sicuro?'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Elimina'; }, 3000); }
    };
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ wiring
document.querySelectorAll('.tools button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnPlay').onclick = startSim;
$('btnStop').onclick = stopSim;
$('btnPause').onclick = () => { S.paused = !S.paused; syncRunUI(); };
$('selSpeed').onchange = (e) => (S.speed = +e.target.value);
$('btnFront').onclick = () => view.frontView();
$('btnIso').onclick = () => view.isoView();
function toggleSchema() {
  const on = !view.schema;
  view.setSchema(on);
  $('btnSchema').setAttribute('aria-pressed', String(on));
  drawStrings();
}
$('btnSchema').onclick = toggleSchema;
$('btnProj').onclick = () => {
  const ortho = view.camera !== view.ortho;
  view.setOrthographic(ortho);
  $('btnProj').textContent = ortho ? 'Ortogonale' : 'Prospettiva';
};
$('chkGravity').onchange = (e) => {
  pushUndo();
  S.doc.settings.gravity = e.target.checked;
  commit();
  if (S.mode === 'run') { stopSim(); startSim(); }
};
$('btnExample').onclick = (e) => { e.stopPropagation(); $('exMenu').hidden = !$('exMenu').hidden; $('fileMenu').hidden = true; };
$('btnEx1').onclick = () => { newProject(fingerDemo(), 'Dito con elastici'); toast('Esempio caricato: premi Simula e muovi lo slider del verricello.'); };
$('btnEx2').onclick = () => { newProject(fingerBeltDemo(), 'Dito a cinghia'); toast('Esempio caricato: premi Simula e muovi lo slider del verricello.'); };
$('btnEx3').onclick = () => { newProject(armDemo(), 'Braccio con due servo'); toast('Esempio caricato: premi Simula e muovi gli slider dei due servo.'); };
$('btnFile').onclick = (e) => { e.stopPropagation(); $('fileMenu').hidden = !$('fileMenu').hidden; $('exMenu').hidden = true; };
document.addEventListener('click', () => { $('fileMenu').hidden = true; $('exMenu').hidden = true; });
$('btnNew').onclick = () => newProject();
$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'RobotBuilder') throw new Error('not ours');
    newProject(data.doc || data, data.name || file.name.replace(/\.json$/i, ''));
    if (data.doc?.controls || data.controls) S.controls = data.doc?.controls || data.controls;
  } catch { toast('Questo file non è un progetto RobotBuilder.'); }
};
$('btnExportJson').onclick = () => {
  const data = { app: 'RobotBuilder', version: 1, name: S.projectName, doc: { ...S.doc, controls: S.controls } };
  saveFile(slug(S.projectName) + '.json', JSON.stringify(data, null, 1), 'application/json');
};
$('btnExportMjcf').onclick = () => {
  try {
    const sim = new Sim(S.doc);
    const xml = sim.xml;
    sim.dispose();
    saveFile(slug(S.projectName) + '.xml', xml, 'application/xml');
  } catch (e) { toast('Il modello non si compila: ' + String(e.message || e).split('\n')[0]); }
};
$('projName').onchange = (e) => { S.projectName = e.target.value.trim() || 'Progetto senza nome'; markDirty(); };
$('btnProjects').onclick = openProjects;
$('projClose').onclick = () => ($('projDialog').hidden = true);
$('projNew').onclick = () => { newProject(); $('projDialog').hidden = true; };
$('wExample').onclick = () => { $('welcome').hidden = true; newProject(fingerDemo(), 'Dito con elastici'); };
$('wExample2').onclick = () => { $('welcome').hidden = true; newProject(fingerBeltDemo(), 'Dito a cinghia'); };
$('wExample3').onclick = () => { $('welcome').hidden = true; newProject(armDemo(), 'Braccio con due servo'); };
$('wEmpty').onclick = () => { $('welcome').hidden = true; setTool('block'); };
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'robotbuilder';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : darkQuery.matches;
const applyTheme = () => view.setTheme(isDark());
darkQuery.addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyTheme();

// ------------------------------------------------------------------ main loop
let last = performance.now();
let labelT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (S.mode === 'run' && S.sim) {
    if (!S.paused) {
      S.sim.step(dt * S.speed, S.drag ? dragForce : null);
      if (S.sim.snaps.size > (S.snapsShown || 0)) reportSnaps();
    }
    view.applySimPose(S.sim);
    const { tensions } = drawStrings();
    $('simTime').textContent = fmt(S.sim.time, 2) + ' s';
    if (now - labelT > 120) {
      labelT = now;
      updateLiveReadouts();
      const labels = [];
      for (const s of S.doc.strings) {
        const line = view.stringLines.get(s.id);
        const pts = line?.userData.pts;
        if (!pts?.length) continue;
        const T = tensions[s.id] ?? 0;
        const motorized = s.anchors.some((a) => a.t === 'winch');
        if (!motorized && s.kind !== 'elastic' && s.id !== S.selected) continue;
        const mid = pts[Math.floor(pts.length / 2)];
        labels.push({ text: T < 0.005 ? 'lasco' : `${fmt(T, 2)} N`, pos: [mid[0], mid[1] - 4, mid[2]], cls: T < 0.005 ? 'slack' : T >= (s.fmaxRef ?? 10) * 0.98 ? 'warn' : '' });
      }
      if (S.drag?.point) labels.push({ text: '✋', pos: [S.drag.target.x * 1000, S.drag.target.y * 1000, S.drag.target.z * 1000], cls: 'ghost' });
      view.setLabels(labels);
      if (S.selected !== null) renderInspectorLive();
    }
  } else if (now - labelT > 100) {
    labelT = now;
    view.setLabels(ghostLabels);
  }
  view.render();
  cube.render();
  requestAnimationFrame(frame);
}
let inspT = 0;
function renderInspectorLive() {
  // refresh numbers without stealing focus from an input
  if (document.activeElement && $('inspector').contains(document.activeElement)) return;
  if (performance.now() - inspT < 400) return;
  inspT = performance.now();
  renderInspector();
}

// ------------------------------------------------------------------ boot
async function boot() {
  view.rebuild(S.doc);
  view.isoView(false);
  setTool('block');
  requestAnimationFrame(frame);
  try {
    await initPhysics();
  } catch (e) {
    $('loading').classList.add('err');
    $('loading').querySelector('span').textContent = 'Il motore fisico non si è caricato: ' + (e.message || e);
    return;
  }
  $('loading').remove();
  store = await openStore();
  let loaded = false;
  try {
    const lastId = lastProjectId();
    const list = await store.list();
    const pick = list.find((p) => p.id === lastId) || list[0];
    if (pick) { const full = await store.load(pick.id); if (full) { loadProject(full); loaded = true; } }
  } catch { /* first run or offline */ }
  if (!loaded) { $('welcome').hidden = false; schedulePreview(); renderPanel(); }
  updateHint();
}
boot();
window.__rb = { S, view };

window.addEventListener('beforeunload', () => { if (S.dirty) saveNow(); });

