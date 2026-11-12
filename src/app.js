import './style.css';
import { View, THREE, stringColor } from './scene.js';
import { ViewCube } from './viewcube.js';
import { initPhysics, Sim } from './physics.js';
import { fingerDemo, fingerBeltDemo, armDemo } from './demo.js';
import { openStore, lastProjectId, setLastProjectId, saveFile } from './storage.js';
import { servoParams } from './mjcf.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { withDependents, boundsOf, cloneItems, xfShift, xfMirrorX, sceneTree, rotateItems, bom, bomCsv, interferences } from './ops.js';
import {
  P, BEAM_W, LAYER, rad, emptyDoc, holePos, holeAt, holeIndexAt, layerBehind, pinAt, pinMembers, findById, prune, BEAM_COLORS, BLOCK_COLORS, PIN_LABEL,
  STRING_LABEL, BOARD, FLOOR, EPS, guidePos, anchorPos, mountOf, fam, NVEC, toWorld, toFam, famQuat, isBeam, isBlock, isServo, holeWorld,
  guideWorld, wheelWorld, worldToLocal, partPose, SERVO_MODELS, servoSpec, PULLEY_SIZES, winchForce, solidBox, boxesOverlap, glueLinks,
  shaftMembers, shiftItem, partLabel, docBounds,
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
  tab: 'controls', peak: {}, rot: null, box: null, clip: [],
  tour: null,          // guided tutorial: {i, doneAt, was}
  nodeSel: null, nodeHot: null, nodeDrag: null, // string path editing
  typed: { v: '', a: '', f: 0 }, // dimension being typed: value, angle, active field
  join: null,          // join tool: {id, i} the beam hole that will be moved
  draw: null,          // beam being drawn: {n, start:{x,z,base}, layer, sgn}
  blockDraft: null,    // block being stretched: {a, b, normal}
  stringDraft: null,   // {kind, anchors}
  hover: null,
  selected: null,      // id of the piece shown in the panel
  multi: [],           // ids when more than one piece is selected
  hidden: new Set(),   // pieces hidden from view (not saved)
  measure: null,       // tape measure: {a, b}
  showCom: false,
  seq: null,           // pose sequence being played: {i, t}
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
  select: '<b>Clicca</b> un pezzo, <b>Shift+clic</b> ne aggiunge, <b>Shift+trascina</b> nel vuoto fa un riquadro, <b>doppio clic</b> prende il gruppo. <b>Frecce</b> spostano, <b>anelli</b> ruotano, <b>piastrine</b> allungano: mentre tiri puoi scrivere il numero. <b>R</b> ruota, <b>H</b> nasconde, <b>Ctrl+C/V</b> copia.',
  measure: 'Clicca due punti per misurare la distanza: si aggancia ai fori. <b>Esc</b> toglie la misura.',
  block: '<b>Clicca una faccia</b> (pavimento, muro o un altro pezzo) per appoggiarci un blocco. <b>Trascina</b> per farne uno lungo o una piastra. <b>Clic destro</b> lo toglie. I blocchi che si toccano restano incollati.',
  block1: 'Rilascia per posare il blocco, oppure <b>scrivi la lunghezza in fori</b> e premi <b>Invio</b>. <b>Esc</b> annulla.',
  beam0: 'Clicca un <b>foro</b> dove inizia la trave: del muro, del pavimento, di una trave o di un blocco. La trave si stende sul piano della faccia che clicchi.',
  beam1: 'Muovi il mouse e clicca dove finisce, oppure <b>scrivi i fori</b>, <b>Tab</b> per l\'angolo e <b>Invio</b>. Ogni nuova trave nasce <b>imperniata</b> al foro di partenza. <b>Esc</b> per finire.',
  join0: '<b>Unisci</b>: clicca il foro della trave che vuoi spostare.',
  join1: 'Ora clicca il foro di destinazione (muro, pavimento, un altro pezzo, l\'albero di un servo): la trave ci va da sola e viene imperniata. <b>Esc</b> annulla.',
  pin: 'Clicca un foro per metterci un perno: unisce il pezzo con quello che c\'è dietro. Clicca un perno esistente per <b>cambiarne il tipo</b>.',
  servo: 'Clicca un foro per montarci il <b>servo</b>: l\'albero esce verso di te. <b>R</b> gira il corpo. Poi appoggia una trave o un blocco sull\'albero: è quello che il servo fa girare.',
  pulley: 'Clicca un foro per montarci una <b>puleggia</b>: il filo ci gira attorno e cambia direzione.',
  string0: 'Clicca il punto di partenza del filo: un <b>verricello</b> (filo motorizzato) o un foro. Per un <b>occhiello</b> punta <b>di fianco alla trave</b>: si aggancia da solo.',
  string1: 'Clicca in ordine i punti da cui passa: fori, <b>occhielli</b> (punta di fianco alla trave), pulegge (dal <b>lato</b> in cui vuoi il filo). I numeri mostrano il percorso. <b>Backspace</b> toglie l\'ultimo punto, doppio clic o <b>Invio</b> chiude, <b>Esc</b> annulla.',
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
  else if (S.tool === 'join') k = S.join ? 'join1' : 'join0';
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
  S.multi = S.multi.filter((id) => findById(S.doc, id));
  if (S.multi.length < 2) { S.selected = S.multi[0] ?? S.selected; S.multi = []; }
  if (S.selected !== null && !findById(S.doc, S.selected)) S.selected = S.multi[0] ?? null;
  view.rebuild(S.doc);
  applyHidden();
  for (const id of selIds()) view.setHighlight(id, true, 0x3a6fd8);
  updateGizmo();
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
  S.selected = null; S.multi = []; S.hidden.clear(); S.measure = null; S.seq = null;
  drawMeasure(); applyHidden();
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
  S.selected = null; S.multi = []; S.hidden.clear(); S.measure = null; S.seq = null;
  drawMeasure(); applyHidden();
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
  S.warnings = [...warnings, ...interferences(S.doc)];
  S.mass = S.preview ? S.preview.massProps().mass : 0;
  drawStrings();
  renderWarnings();
  renderControls();
  renderModel();
  renderSeq();
  updateCom();
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
  S.peak = {};
  if (S.tab !== 'controls') setTab('controls');
  renderWarnings();
  syncRunUI();
  renderPanel();
  updateGizmo();
}
function stopSim() {
  if (S.mode !== 'run') return;
  S.seq = null;
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
  const consider = (cand, p, lim, bonus = 0) => {
    const s = view.project(p);
    let d = Math.hypot(sx - s.x, sy - s.y);
    if (d >= lim) return;
    const rd = d;
    d = Math.max(0, d - bonus);
    const depth = depthOf(p);
    if (depth > surf.distance + 6) return; // hidden behind something
    if (!best || d < best.d - 3 || (Math.abs(d - best.d) <= 3 && depth < best.depth)) best = { ...cand, d, rd, depth };
  };
  for (const part of doc.parts) {
    if (S.hidden.has(part.id)) continue;
    if (isBeam(part)) {
      const n = fam(part);
      if (!famOk(n)) continue;
      const sgn = view.facing(n, holeWorld(part, 0));
      if (opts.guides) {
        // the strip along each edge of a beam belongs to its eyelets: point beside the beam, not at
        // the tiny ring, and the nearest eyelet on that side is taken
        const fp = view.famPoint(sx, sy, n, part.layer + sgn * 0.45);
        // not when another piece is what you are really pointing at
        const other = surf.id !== undefined && surf.id !== part.id && doc.parts.some((q) => q.id === surf.id);
        if (fp && !other) {
          const a = rad(part.angle), dx = fp.x - part.x, dz = fp.z - part.z;
          const u = dx * Math.cos(a) + dz * Math.sin(a), v = -dx * Math.sin(a) + dz * Math.cos(a);
          if (Math.abs(v) > 2.4 && Math.abs(v) < 8.5 && u > -P / 2 && u < (part.holes - 0.5) * P) {
            const i = clamp(Math.round(u / P), 0, part.holes - 1), side = Math.sign(v);
            const q = guidePos(part, i, side);
            consider({ t: 'guide', part, i, side, n, x: q.x, z: q.z, layer: part.layer, sgn, zone: true }, facePoint(n, q.x, q.z, part.layer, sgn), 40, 40);
          }
        }
      }
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
  if (wheel && !(best && best.rd < 5 && best.d < wheel.d)) return wheel;
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

// Faint rings on every eyelet of a beam, so you see where a string can be threaded.
const ringDimMat = new THREE.MeshBasicMaterial({ color: 0xf2b51c, depthTest: false, transparent: true, opacity: 0.45 });
function showEyelets(h) {
  const part = h?.part;
  if (!part || !isBeam(part)) return;
  for (let i = 0; i < part.holes; i++) for (const side of [1, -1]) {
    if (h.t === 'guide' && h.i === i && h.side === side) continue;
    const q = guidePos(part, i, side);
    const m = new THREE.Mesh(ringGeo, ringDimMat);
    const p = facePoint(fam(part), q.x, q.z, part.layer, h.sgn, 0.4);
    m.position.set(p.x, p.y, p.z);
    setQ(m, famQuat(fam(part)));
    m.scale.setScalar(0.5);
    m.renderOrder = 10;
    ghost.add(m);
  }
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
        } else { ring(h, h.t === 'guide' ? 0.75 : 1); showEyelets(h); }
        ghostLabels.push({ text: stringClickText(a), pos: [p.x, p.y, p.z + 5], cls: 'ghost' });
      }
    }
    if (pts.length >= 2) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      const l = new THREE.Line(g, ghostLineMat);
      l.computeLineDistances();
      l.renderOrder = 11;
      ghost.add(l);
    }
  } else if (tool === 'join') {
    const h = hoverTarget(sx, sy, { shafts: !!S.join });
    S.hover = null;
    if (!S.join) {
      if (h && h.t === 'hole' && h.part && isBeam(h.part) && h.i >= 0) { S.hover = h; ring(h); }
    } else if (h && h.part?.id !== S.join.id) {
      const part = S.doc.parts.find((p) => p.id === S.join.id);
      if (part) {
        S.hover = h;
        ring(h, 1.2);
        const r = joinResult(part, S.join.i, h);
        const mesh = new THREE.Mesh(view.beamGeometry(part.holes), ghostBeamMat);
        const w = toWorld(r.n, r.x, r.z, r.layer);
        mesh.position.set(w.x, w.y, w.z);
        setQ(mesh, famQuat(r.n, part.angle));
        ghost.add(mesh);
      }
    }
  } else if (tool === 'measure') {
    const q = measurePoint(sx, sy);
    if (q?.h) ring(q.h, q.h.t === 'guide' ? 0.6 : 1);
    if (S.measure && !S.measure.b) { drawMeasure(q?.p); if (S.measure.label) ghostLabels.push(S.measure.label); }
  } else if (tool === 'erase' || tool === 'select') {
    const hit = view.pickObject(sx, sy);
    setHover(hit?.id ?? null);
  }
}

let hoverId = null;
function setHover(id) {
  if (hoverId === id) return;
  if (hoverId !== null && !selIds().includes(hoverId)) view.setHighlight(hoverId, false);
  hoverId = id;
  if (id !== null && !selIds().includes(id)) view.setHighlight(id, true, S.tool === 'erase' ? 0xff3b30 : 0x888888);
}

// What you type wins over where the mouse is: holes for the length, degrees for the angle.
function beamEndFor(sx, sy) {
  const r = beamEndRaw(sx, sy), t = S.typed;
  if (!r || (!t.v && !/\d/.test(t.a))) return r;
  const st = S.draw.start;
  const k = t.v ? clamp(+t.v - 1, 1, 24) : r.n, angle = /\d/.test(t.a) ? +t.a : r.angle;
  const x = st.x + k * P * Math.cos(rad(angle)), z = st.z + k * P * Math.sin(rad(angle));
  if (Math.abs(x - r.x) < EPS && Math.abs(z - r.z) < EPS) return r;
  const L = S.draw.layer - S.draw.sgn, hp = holeAt(S.doc, S.draw.n, x, z, L);
  return { x, z, n: k, angle, snapped: hp && hp.kind === 'part' ? { layer: L } : null };
}
function beamEndRaw(sx, sy) {
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
  typedReset();
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

// Join, like the joint of a CAD: pick a hole of a beam, then the hole it must sit on. The beam
// goes there by itself (changing plane if it has to) and a free pin holds the two together.
function joinResult(part, i, h) {
  const a = rad(part.angle);
  return { n: h.n, layer: h.layer + h.sgn, x: h.x - i * P * Math.cos(a), z: h.z - i * P * Math.sin(a) };
}
function clickJoin() {
  const h = S.hover;
  if (!h) { if (!S.join) toast('Parti da un foro di una trave: è il pezzo che si sposta.'); return; }
  if (!S.join) { S.join = { id: h.part.id, i: h.i }; view.setHighlight(h.part.id, true, 0x3a6fd8); updateHint(); return; }
  const part = S.doc.parts.find((p) => p.id === S.join.id);
  if (!part) { S.join = null; updateHint(); return; }
  const r = joinResult(part, S.join.i, h);
  pushUndo();
  const held = S.doc.pins.filter((pin) => pinMembers(S.doc, pin).some((m) => m.kind === 'part' && m.part === part));
  const items = moveSet(part.id, false);
  if (fam(part) === r.n) {
    const a = toWorld(r.n, part.x, part.z, part.layer), b = toWorld(r.n, r.x, r.z, r.layer);
    for (const o of items) shiftItem(o, [b.x - a.x, b.y - a.y, b.z - a.z]);
  } else {
    // another plane: the beam is laid on it, its wheels follow hole by hole, its own pins are left behind
    const ang = rad(part.angle);
    for (const o of items) {
      if (o === part) continue;
      if (o.lo !== undefined) { S.doc.pins.splice(S.doc.pins.indexOf(o), 1); continue; }
      const j = holeIndexAt(part, o.x, o.z), dl = o.layer - part.layer;
      o.x = r.x + j * P * Math.cos(ang); o.z = r.z + j * P * Math.sin(ang); o.layer = r.layer + dl;
      if (r.n === 'y') delete o.n; else o.n = r.n;
    }
    part.x = r.x; part.z = r.z; part.layer = r.layer;
    if (r.n === 'y') delete part.n; else part.n = r.n;
  }
  // pins the beam has come off, and that now hold nothing, go away
  for (const pin of held) if (S.doc.pins.includes(pin) && pinMembers(S.doc, pin).length < 2) S.doc.pins.splice(S.doc.pins.indexOf(pin), 1);
  if (h.t !== 'shaft') ensurePin(r.n, h.x, h.z, Math.min(h.layer, r.layer), Math.max(h.layer, r.layer), 'hinge');
  S.join = null;
  commit();
  updateHint();
  toast(h.t === 'shaft' ? 'Montata sull\'albero: gira col servo.' : 'Unita con un perno libero. Con l\'attrezzo Perno un clic lo blocca o lo motorizza.');
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

function clickString(dbl) { clickStringRaw(dbl); updateNodes(); }
function clickStringRaw(dbl) {
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
  if (old) { old.anchors = d.anchors; S.selected = old.id; commit(); setTool('select'); return; }
  const s = { id: S.doc.nextId++, kind: d.kind, anchors: d.anchors };
  if (d.kind === 'elastic') { s.stiffness = 60; s.pretension = 3; }
  S.doc.strings.push(s);
  S.selected = s.id; S.multi = [];
  commit();
  // back to the hand with the new string selected: its numbered points are there to be adjusted
  setTool('select');
  toast('Filo creato. Trascina i numeri per correggere il percorso, F per un altro filo.');
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
  nodeLabels = []; nodeList = [];
  clearGhost();
  updateHint();
}

// ------------------------------------------------------------------ tools
const TOOLS = ['select', 'block', 'beam', 'pin', 'servo', 'pulley', 'string', 'winch', 'erase', 'measure', 'join'];
function setTool(t, silent) {
  if (S.mode === 'run' && t !== 'select') return;
  if (S.tool === 'string' && S.stringDraft && t !== 'string') finishString();
  S.tool = t;
  S.draw = null;
  S.blockDraft = null;
  S.join = null;
  typedReset();
  clearGhost();
  setHover(null);
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const vp = $('viewport');
  vp.className = 'viewport ' + (t === 'select' ? 'cursor-grab' : t === 'erase' ? 'cursor-erase' : 'cursor-cross');
  renderSubtools();
  updateGizmo();
  if (t !== 'measure' && S.measure) { S.measure = null; drawMeasure(); }
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
  const nd = S.mode === 'edit' && S.tool === 'select' ? pickNode(e.offsetX, e.offsetY) : null;
  if (nd) { S.nodeDrag = { sid: S.selected, i: nd.i, plus: nd.plus, x: e.offsetX, y: e.offsetY, moved: false, cand: null }; canvas.setPointerCapture(e.pointerId); return; }
  const giz = S.mode === 'edit' && S.tool === 'select' ? pickGizmo(e.offsetX, e.offsetY) : null;
  if (giz) { startGizmo(giz, e.offsetX, e.offsetY); canvas.setPointerCapture(e.pointerId); return; }
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
    if (S.move) canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (S.mode === 'edit' && S.tool === 'select' && !hit && e.shiftKey) {
    // Shift + drag on empty space: a selection rectangle
    S.box = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY };
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
  // a piece of a multiple selection drags the whole selection
  const inSel = S.multi.includes(partId);
  const items = inSel ? moveItems(S.multi) : moveSet(partId, group);
  let normal = new THREE.Vector3(...NVEC[fam(part)]);
  if (!isBeam(part)) {
    const a = [Math.abs(surf.normal.x), Math.abs(surf.normal.y), Math.abs(surf.normal.z)];
    const k = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
    normal = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
  }
  S.move = { p0: surf.point.clone(), normal, items, orig: items.map(coordsOf), d: [0, 0, 0], undone: false, selectId: partId, keep: inSel, shift: group };
}
function updateMove(sx, sy) {
  const m = S.move;
  let d;
  if (m.axis) {
    const t = /\d/.test(S.typed.v) ? clamp(+S.typed.v, -200, 200) * P : snapP(axisParam(sx, sy, m.p0, m.axis));
    d = [m.axis.x * t, m.axis.y * t, m.axis.z * t].map((v) => Math.round(v));
  } else {
    const p = view.planeThrough(sx, sy, m.normal, m.p0);
    if (!p) return;
    d = [snapP(p.x - m.p0.x), snapP(p.y - m.p0.y), snapP(p.z - m.p0.z)];
  }
  if (d.every((v, k) => v === m.d[k])) return;
  if (!m.undone) { pushUndo(); m.undone = true; }
  m.d = d;
  m.items.forEach((o, k) => { restoreCoords(o, m.orig[k]); shiftItem(o, d); });
  view.rebuild(S.doc);
  for (const id of m.keep ? selIds() : [m.selectId]) view.setHighlight(id, true, 0x3a6fd8);
  ghostLabels = [{ text: d.map((v, k) => (v ? `${'↔⤢↕'[k]} ${Math.abs(v) / P} fori` : '')).filter(Boolean).join('  ') || '0', pos: [m.p0.x + d[0], m.p0.y + d[1], m.p0.z + d[2] + 6], cls: 'ghost' }];
  if (m.keep) updateGizmo();
  schedulePreview();
}
function endMove() {
  const m = S.move;
  S.move = null;
  ghostLabels = [];
  if (m.undone) { if (!m.keep) { S.multi = []; S.selected = m.selectId; } commit(); }
  else if (!m.axis) select(m.selectId, m.shift);
}
// Arrow keys: push the selected piece one hole along a world axis.
function nudgeSelected(d) {
  const items = moveItems(selIds());
  if (!items.length) return;
  pushUndo();
  for (const o of items) shiftItem(o, d);
  commit();
}
// R: turn the selected piece. A beam turns 15 degrees about its first hole (pins and wheels used
// only by it turn too), a servo a quarter turn about its shaft, a block swaps two of its sides.
// Lay a beam or a wheel on another plane, keeping the point it sits at.
const AXIS_LABEL = { y: 'verso di te', z: 'in alto', x: 'di lato' };
function replane(o, n2) {
  const w = toWorld(fam(o), o.x, o.z, o.layer), f = toFam(n2, w);
  o.x = Math.round(f.x * 1e6) / 1e6; o.z = Math.round(f.z * 1e6) / 1e6; o.layer = Math.round(f.layer);
  if (n2 === 'y') delete o.n; else o.n = n2;
}
function flipWheel(o) { if ((o.dir || 1) === 1) o.dir = -1; else delete o.dir; }
function rotateSelected(deg) {
  const doc = S.doc;
  const wheel = [...doc.pulleys, ...doc.winches].find((w) => w.id === S.selected);
  if (wheel) {
    // a wheel is round: turning it means pointing its axis somewhere else
    pushUndo();
    if (deg > 0) replane(wheel, { y: 'z', z: 'x', x: 'y' }[fam(wheel)]); else flipWheel(wheel);
    commit();
    toast(deg > 0 ? `Ora l'asse punta ${AXIS_LABEL[fam(wheel)]}.` : 'Capovolto: ora si monta dal lato opposto.');
    return;
  }
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
  if (S.nodeDrag) { updateNodeDrag(e.offsetX, e.offsetY); return; }
  if (S.box) { updateBox(e.offsetX, e.offsetY); return; }
  if (S.rot) { updateRotate(e.offsetX, e.offsetY); return; }
  if (S.resize) { updateResize(e.offsetX, e.offsetY); return; }
  if (S.move) { updateMove(e.offsetX, e.offsetY); return; }
  if (S.blockDraft) { dragBlock(e.offsetX, e.offsetY); return; }
  if (S.drag) {
    const wp = view.planeThrough(e.offsetX, e.offsetY, S.drag.normal, S.drag.origin);
    if (wp) S.drag.target.copy(wp.multiplyScalar(0.001));
    return;
  }
  if (down && (e.buttons & 6)) return; // orbiting / panning
  updateGhost(e.offsetX, e.offsetY);
});

function dragBlock(sx, sy) {
  const d = S.blockDraft;
  const p = view.planeThrough(sx, sy, new THREE.Vector3(...d.normal), new THREE.Vector3(...d.a));
  if (p) d.b = [p.x, p.y, p.z].map((v, k) => (d.normal[k] ? d.a[k] : clamp(snapP(v), d.a[k] - 39 * P, d.a[k] + 39 * P)));
  if (S.typed.v) {
    // the typed length goes along the direction you are dragging
    const ax = [0, 1, 2].filter((k) => !d.normal[k]).sort((i, j) => Math.abs(d.b[j] - d.a[j]) - Math.abs(d.b[i] - d.a[i]))[0];
    d.b[ax] = d.a[ax] + (d.b[ax] < d.a[ax] ? -1 : 1) * (clamp(+S.typed.v, 1, 40) - 1) * P;
  }
  d.b[2] = Math.max(P, d.b[2]);
  updateGhost(sx, sy);
}

canvas.addEventListener('pointerup', (e) => {
  if (!S.draw && !S.rot) typedReset();
  if (S.nodeDrag) { endNodeDrag(); down = null; return; }
  if (S.box) { endBox(); down = null; return; }
  if (S.rot) { endRotate(); canvas.releasePointerCapture(e.pointerId); down = null; return; }
  if (S.drag) { S.drag = null; S.sim?.clearForces(); canvas.releasePointerCapture(e.pointerId); return; }
  if (S.resize) { const r = S.resize; S.resize = null; ghostLabels = []; if (r.undone) commit(); canvas.releasePointerCapture(e.pointerId); down = null; return; }
  if (S.move) { endMove(); canvas.releasePointerCapture(e.pointerId); down = null; return; }
  if (S.blockDraft) { placeBlock(); canvas.releasePointerCapture(e.pointerId); down = null; updateGhost(e.offsetX, e.offsetY); return; }
  if (!down) return;
  const moved = Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5;
  const b = down.b;
  down = null;
  if (moved) return;
  if (b === 2) { // right click without drag: step back, or take a block away
    const nd = S.mode === 'edit' && S.tool === 'select' ? pickNode(e.offsetX, e.offsetY) : null;
    if (nd && !nd.plus) { removeNode(nd.i); return; }
    if (S.draw) { S.draw = null; clearGhost(); updateHint(); }
    else if (S.stringDraft) finishString();
    else if (S.tool === 'block' && S.mode === 'edit') { eraseAt(e.offsetX, e.offsetY, true); updateGhost(e.offsetX, e.offsetY); }
    return;
  }
  if (b !== 0) return;
  onClick(e.offsetX, e.offsetY, e.detail >= 2, e.shiftKey);
});
canvas.addEventListener('dblclick', (e) => {
  if (S.mode !== 'edit' || S.tool !== 'select') return;
  const hit = view.pickObject(e.offsetX, e.offsetY);
  if (hit?.kind === 'part') selectMany(attachedTo(hit.id));
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerleave', () => { if (!S.draw && !S.stringDraft && !S.blockDraft) clearGhost(); setHover(null); });

function onClick(sx, sy, dbl, shift) {
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
    case 'measure': clickMeasure(sx, sy); break;
    case 'join': clickJoin(); break;
    case 'select': {
      const hit = view.pickObject(sx, sy);
      select(hit ? hit.id : null, shift);
      break;
    }
  }
  updateGhost(sx, sy);
}

// ------------------------------------------------------------------ keyboard
let lastMouse = null;
canvas.addEventListener('pointermove', (e) => { lastMouse = { x: e.offsetX, y: e.offsetY }; if (S.typed.v || S.typed.a) showTyped(); });

// ---- typed dimensions: while you draw a beam or pull an arrow, a pad or a new block, type the
// number of holes and press Enter, as in a CAD. For a beam, Tab switches to the angle.
function numCtx() {
  if (S.mode !== 'edit') return null;
  return S.rot ? 'rot' : S.resize ? 'resize' : S.move?.axis ? 'move' : S.blockDraft ? 'block' : S.draw ? 'beam' : null;
}
function showTyped() {
  const el = $('typed'), t = S.typed, ctx = numCtx();
  el.hidden = !ctx || (!t.v && !t.a && !t.f);
  if (el.hidden) return;
  const box = (v, on, unit) => `<span class="${on ? 'on' : ''}">${v || '…'}</span>${unit}`;
  el.innerHTML = (ctx === 'beam' ? box(t.v, t.f === 0, ' fori') + ' ' + box(t.a, t.f === 1, '°') : box(t.v, true, ctx === 'rot' ? '°' : ' fori')) + '<small>Invio</small>';
  const m = lastMouse || { x: 200, y: 200 };
  el.style.left = `${m.x + 18}px`; el.style.top = `${m.y + 18}px`;
}
function typedReset() { if (!S.typed.v && !S.typed.a && !S.typed.f) return; S.typed = { v: '', a: '', f: 0 }; showTyped(); }
function applyTyped() {
  showTyped();
  const m = lastMouse || (down && { x: down.x, y: down.y });
  if (!m) return;
  if (S.rot) updateRotate(m.x, m.y); else if (S.resize) updateResize(m.x, m.y); else if (S.move) updateMove(m.x, m.y); else if (S.blockDraft) dragBlock(m.x, m.y); else updateGhost(m.x, m.y);
}
function commitTyped() {
  const ctx = numCtx();
  if (ctx === 'beam') { if (lastMouse) updateGhost(lastMouse.x, lastMouse.y); clickBeam(); typedReset(); if (lastMouse) updateGhost(lastMouse.x, lastMouse.y); return; }
  typedReset();
  if (ctx === 'rot') endRotate();
  else if (ctx === 'resize') { const r = S.resize; S.resize = null; ghostLabels = []; if (r.undone) commit(); }
  else if (ctx === 'move') endMove();
  else if (ctx === 'block') { placeBlock(); if (lastMouse) updateGhost(lastMouse.x, lastMouse.y); }
  down = null;
}
// Returns true when the key was a typed dimension.
function typedKey(e, k) {
  const ctx = numCtx();
  if (!ctx) return false;
  const t = S.typed, f = ctx === 'beam' && t.f === 1 ? 'a' : 'v';
  if (/^[0-9]$/.test(k)) { if (t[f].length < 4) t[f] += k; applyTyped(); return true; }
  if (k === '-' && !t[f] && (f === 'a' || ctx === 'move' || ctx === 'rot')) { t[f] = '-'; showTyped(); return true; }
  if (k === 'backspace' && (t.v || t.a)) { t[f] = t[f].slice(0, -1); applyTyped(); return true; }
  if (k === 'tab' && ctx === 'beam') { e.preventDefault(); t.f = 1 - t.f; showTyped(); return true; }
  if (k === 'enter') { commitTyped(); return true; }
  if (k === 'escape' && (t.v || t.a || t.f)) { typedReset(); applyTyped(); return true; }
  return false;
}
const NUDGE = { arrowleft: [-P, 0, 0], arrowright: [P, 0, 0], arrowup: [0, 0, P], arrowdown: [0, 0, -P], pageup: [0, P, 0], pagedown: [0, -P, 0] };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type=checkbox]), select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'c' && S.mode === 'edit' && selIds().length) { S.clip = [...selIds()]; toast('Copiato: Ctrl+V lo incolla accanto.'); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'v' && S.mode === 'edit') {
    const ids = (S.clip || []).filter((id) => findById(S.doc, id));
    if (ids.length) { e.preventDefault(); setTool('select'); selectMany(ids); duplicateSelected(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'd' && S.mode === 'edit') { e.preventDefault(); duplicateSelected(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'a' && S.mode === 'edit') { e.preventDefault(); setTool('select'); selectMany([...S.doc.parts, ...S.doc.pulleys, ...S.doc.winches].filter((o) => !S.hidden.has(o.id)).map((o) => o.id)); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (typedKey(e, k)) return;
  if (k === 'tab' && S.mode === 'edit') {
    // straight to the numbers of the selected piece
    const f = $('inspector').querySelector('input[type=number]:not(:disabled)');
    if (f) { e.preventDefault(); f.focus(); f.select(); }
    return;
  }
  if (k === 'escape') {
    if (S.stringDraft) { S.stringDraft = null; clearGhost(); updateHint(); }
    else if (S.draw || S.blockDraft) { S.draw = null; S.blockDraft = null; clearGhost(); updateHint(); }
    else if (S.measure) { S.measure = null; drawMeasure(); clearGhost(); }
    else if (S.join) { view.setHighlight(S.join.id, false); S.join = null; clearGhost(); updateHint(); }
    else select(null);
    return;
  }
  if (k === 'enter' && S.stringDraft) { finishString(); return; }
  if (k === ' ') { e.preventDefault(); startSim(); return; }
  if (k === 's') { toggleSchema(); return; }
  if (k === 'backspace' && S.stringDraft) {
    // step back one point while drawing a string
    S.stringDraft.anchors.pop();
    if (!S.stringDraft.anchors.length && S.stringDraft.replaceId == null) S.stringDraft = null;
    updateNodes(); updateHint();
    if (lastMouse) updateGhost(lastMouse.x, lastMouse.y);
    return;
  }
  if ((k === 'delete' || k === 'backspace') && S.mode === 'edit') { if (S.nodeSel != null && nodeString()) removeNode(S.nodeSel); else deleteSelection(); return; }
  if (k === 'h' && S.mode === 'edit') { if (e.shiftKey) { S.hidden.clear(); applyHidden(); } else hideSelection(); return; }
  if (NUDGE[k] && S.mode === 'edit' && S.selected !== null) { e.preventDefault(); nudgeSelected(NUDGE[k]); return; }
  if (k === 'r' && S.mode === 'edit') {
    if (S.tool === 'servo') { S.servoAngle = (S.servoAngle + (e.shiftKey ? 270 : 90)) % 360; if (lastMouse) updateGhost(lastMouse.x, lastMouse.y); return; }
    if (S.selected !== null) { rotateSelected(e.shiftKey ? -15 : 15); return; }
  }
  if (/^[0-9]$/.test(k)) { setTool(TOOLS[(+k + 9) % 10]); return; }
  const map = { v: 'select', c: 'block', b: 'beam', p: 'pin', m: 'servo', u: 'pulley', f: 'string', w: 'winch', x: 'erase', t: 'measure', j: 'join' };
  if (map[k]) setTool(map[k]);
});

// ------------------------------------------------------------------ selection (one or many)
function selIds() { return S.multi.length ? S.multi : S.selected !== null ? [S.selected] : []; }
function showSelection() {
  for (const i of selIds()) view.setHighlight(i, true, 0x3a6fd8);
  drawStrings();
  renderLegend();
  renderInspector();
  renderTree();
  updateGizmo();
}
function select(id, add = false) {
  if (id !== S.selected) S.nodeSel = null;
  if (id !== null && S.tab !== 'tree' && S.tab !== 'props') setTab('props');
  for (const i of selIds()) view.setHighlight(i, false);
  if (add && id !== null) {
    const cur = new Set(selIds());
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    const list = [...cur];
    S.selected = cur.has(id) ? id : (list[list.length - 1] ?? null);
    S.multi = list.length > 1 ? list : [];
  } else if (!(add && id === null)) { S.multi = []; S.selected = id; }
  showSelection();
}
function selectMany(ids) {
  if (ids.length && S.tab !== 'tree' && S.tab !== 'props') setTab('props');
  for (const i of selIds()) view.setHighlight(i, false);
  S.multi = ids.length > 1 ? [...ids] : [];
  S.selected = ids[0] ?? null;
  showSelection();
}
// Everything attached to a piece: what is pinned, glued or geared to it, with wheels and strings.
function attachedTo(partId) {
  const parts = moveSet(partId, true).filter((o) => S.doc.parts.includes(o)).map((p) => p.id);
  const set = withDependents(S.doc, parts);
  return [...parts, ...set.pulleys.map((w) => w.id), ...set.winches.map((w) => w.id)];
}
// What moves when the selection moves.
function moveItems(ids, group = false) {
  const set = new Set();
  for (const id of ids) {
    const f = findById(S.doc, id);
    if (!f || f.coll === 'strings') continue;
    if (f.coll === 'parts') moveSet(id, group).forEach((o) => set.add(o)); else set.add(f.obj);
  }
  // pins that only hold pieces of this selection travel with it
  for (const pin of S.doc.pins) { const mem = pinMembers(S.doc, pin).filter((m) => m.kind === 'part'); if (mem.length && mem.every((m) => set.has(m.part))) set.add(pin); }
  return [...set];
}
function selectionSet() { return withDependents(S.doc, selIds()); }
function deleteSelection() {
  const ids = selIds();
  if (!ids.length) return;
  pushUndo();
  ids.forEach(removeObject);
  S.selected = null; S.multi = [];
  commit();
}
// Copies of the selection in a row: `count` pieces in all, `step` holes apart along a world axis.
function repeatSelection(count, axis, step) {
  const set = selectionSet(), b = boundsOf(set);
  if (!b) return;
  const pitch = step > 0 ? step * P : Math.max(P, Math.ceil((b.max[axis] - b.min[axis] - 0.5) / P) * P);
  pushUndo();
  const made = [];
  for (let i = 1; i < count; i++) {
    const d = [0, 0, 0];
    d[axis] = (axis === 1 ? -1 : 1) * pitch * i; // "depth" grows towards you
    made.push(...cloneItems(S.doc, selIds(), xfShift(d)));
  }
  const keep = selIds();
  commit();
  selectMany([...keep, ...made]);
  toast(`${count - 1} ${count === 2 ? 'copia' : 'copie'} in fila, a ${pitch / P} fori di passo.`);
}
function duplicateSelected() {
  const set = selectionSet(), b = boundsOf(set);
  if (!b) return;
  pushUndo();
  const made = cloneItems(S.doc, selIds(), xfShift([Math.max(P, Math.ceil((b.max[0] - b.min[0] - 0.5) / P) * P), 0, 0]));
  commit();
  selectMany(made);
}
function mirrorSelection() {
  const set = selectionSet(), b = boundsOf(set);
  if (!b) return;
  pushUndo();
  const m = Math.ceil((b.max[0] + 0.5) / P) * P; // a lattice plane just to the right of the selection
  const made = cloneItems(S.doc, selIds(), xfMirrorX(m));
  commit();
  selectMany(made);
  toast('Copia specchiata a destra: trascinala dove serve.');
}
function hideSelection() {
  const ids = selIds().filter((id) => { const f = findById(S.doc, id); return f && f.coll !== 'strings'; });
  if (!ids.length) return;
  ids.forEach((id) => S.hidden.add(id));
  select(null);
  applyHidden();
}
function applyHidden() {
  for (const id of [...S.hidden]) if (!findById(S.doc, id)) S.hidden.delete(id);
  view.setHidden(S.hidden);
  const b = $('btnShowAll');
  b.hidden = !S.hidden.size;
  b.textContent = `Mostra tutto (${S.hidden.size} nascosti)`;
}

// ------------------------------------------------------------------ move arrows and stretch pads
// Like the triad of a CAD: a coloured arrow per axis moves the selection along it, and a single
// block also gets a pad on every face to pull it longer or push it shorter.
const gizmo = new THREE.Group();
view.scene.add(gizmo);
const AX_COL = [0xe03131, 0x2f9e44, 0x1c7ed6];
const AX_DIR = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const gizMat = AX_COL.map((c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.95 }));
const ringGizMat = AX_COL.map((c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.55 }));
const grabMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
const padMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.92 });
const yUp = new THREE.Vector3(0, 1, 0);
function updateGizmo() {
  updateNodes();
  gizmo.clear();
  if (S.mode !== 'edit' || S.tool !== 'select') return;
  const ids = new Set(selIds());
  const sel = { parts: S.doc.parts.filter((p) => ids.has(p.id)), pulleys: S.doc.pulleys.filter((p) => ids.has(p.id)), winches: S.doc.winches.filter((p) => ids.has(p.id)) };
  const b = boundsOf(sel);
  if (!b) return;
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const half = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) / 2);
  const k = view.camera === view.ortho ? clamp(view.orthoHalf / view.ortho.zoom / 110, 0.7, 3) : clamp(view.camera.position.distanceTo(c) / 320, 0.7, 3);
  for (let a = 0; a < 3; a++) {
    // the depth arrow points towards you
    const dir = AX_DIR[a].clone().multiplyScalar(a === 1 ? -1 : 1);
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.8 * k, 0.8 * k, 11 * k, 10), gizMat[a]);
    shaft.position.y = 5.5 * k;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(2.4 * k, 6 * k, 14), gizMat[a]);
    tip.position.y = 14 * k;
    g.add(shaft, tip);
    g.quaternion.setFromUnitVectors(yUp, dir);
    g.position.copy(c).addScaledVector(dir, half[a] + 3.5 * k);
    g.traverse((m) => { m.renderOrder = 20; m.userData.giz = { type: 'move', dir }; });
    gizmo.add(g);
  }
  // rotation rings: one per axis, a quarter turn at a time (15° for flat pieces in their own plane)
  const rr = Math.max(...half) + 9 * k;
  for (let a = 0; a < 3; a++) {
    const turn = (g) => { if (a === 0) g.rotateY(Math.PI / 2); else if (a === 1) g.rotateX(Math.PI / 2); return g; };
    const vis = new THREE.Mesh(turn(new THREE.TorusGeometry(rr, 0.45 * k, 6, 72)), ringGizMat[a]);
    const grab = new THREE.Mesh(turn(new THREE.TorusGeometry(rr, 2.4 * k, 6, 48)), grabMat);
    vis.raycast = () => {};
    for (const m of [vis, grab]) { m.position.copy(c); m.renderOrder = 19; m.userData.giz = { type: 'rot', axis: a }; gizmo.add(m); }
  }
  if (sel.parts.length === 1 && ids.size === 1 && isBlock(sel.parts[0])) {
    for (let a = 0; a < 3; a++) for (const side of [1, -1]) {
      const dims = [5 * k, 5 * k, 5 * k];
      dims[a] = 1;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(...dims), padMat);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(pad.geometry), new THREE.LineBasicMaterial({ color: AX_COL[a], depthTest: false }));
      pad.add(edge);
      pad.position.copy(c).addScaledVector(AX_DIR[a], side * (half[a] + 0.6));
      pad.renderOrder = 21; edge.renderOrder = 22;
      pad.userData.giz = { type: 'size', axis: a, side, dir: AX_DIR[a].clone().multiplyScalar(side) };
      edge.raycast = () => {};
      gizmo.add(pad);
    }
  }
}
function pickGizmo(sx, sy) {
  if (!gizmo.children.length) return null;
  const hits = view.ray(sx, sy).intersectObjects(gizmo.children, true).filter((h) => h.object.userData.giz);
  const hit = hits.find((h) => h.object.userData.giz.type !== 'rot') || hits[0];
  return hit ? { ...hit.object.userData.giz, point: hit.point } : null;
}
// How far along the line (p0, dir) the mouse is pointing.
function axisParam(sx, sy, p0, dir) {
  const ray = view.ray(sx, sy).ray;
  const w = p0.clone().sub(ray.origin);
  const b = dir.dot(ray.direction), d = dir.dot(w), e = ray.direction.dot(w);
  const den = 1 - b * b;
  return den < 1e-4 ? 0 : (b * e - d) / den;
}
// ---- selection rectangle
function updateBox(sx, sy) {
  const b = S.box, el = $('selbox');
  b.x1 = sx; b.y1 = sy;
  el.hidden = false;
  el.style.left = `${Math.min(b.x0, b.x1)}px`; el.style.top = `${Math.min(b.y0, b.y1)}px`;
  el.style.width = `${Math.abs(b.x1 - b.x0)}px`; el.style.height = `${Math.abs(b.y1 - b.y0)}px`;
}
function endBox() {
  const b = S.box;
  S.box = null;
  $('selbox').hidden = true;
  if (Math.abs(b.x1 - b.x0) < 5 && Math.abs(b.y1 - b.y0) < 5) return;
  const inside = (w) => { const q = view.project(w); return q.x >= Math.min(b.x0, b.x1) && q.x <= Math.max(b.x0, b.x1) && q.y >= Math.min(b.y0, b.y1) && q.y <= Math.max(b.y0, b.y1); };
  const ids = new Set(selIds().filter((id) => { const f = findById(S.doc, id); return f && f.coll !== 'strings' && f.coll !== 'pins'; }));
  for (const p of S.doc.parts) {
    if (S.hidden.has(p.id)) continue;
    const bb = docBounds({ parts: [p], pulleys: [], winches: [] });
    if (bb && inside({ x: (bb.min[0] + bb.max[0]) / 2, y: (bb.min[1] + bb.max[1]) / 2, z: (bb.min[2] + bb.max[2]) / 2 })) ids.add(p.id);
  }
  for (const w of [...S.doc.pulleys, ...S.doc.winches]) if (!S.hidden.has(w.id) && inside(wheelWorld(w))) ids.add(w.id);
  selectMany([...ids]);
}
// ---- turning with the rings
function rotPivot(items) {
  const ids = selIds(), one = ids.length === 1 ? findById(S.doc, ids[0]) : null;
  if (one && one.coll === 'parts' && !isBlock(one.obj)) { const w = toWorld(fam(one.obj), one.obj.x, one.obj.z, one.obj.layer); return [w.x, w.y, w.z]; }
  if (one && (one.coll === 'pulleys' || one.coll === 'winches')) { const w = wheelWorld(one.obj); return [w.x, w.y, w.z]; }
  const b = docBounds({ parts: items.filter((o) => S.doc.parts.includes(o)), pulleys: items.filter((o) => S.doc.pulleys.includes(o)), winches: items.filter((o) => S.doc.winches.includes(o)) });
  return b ? [0, 1, 2].map((q) => snapP((b.min[q] + b.max[q]) / 2)) : [0, 0, 0];
}
function ringAngle(sx, sy, r) {
  const ax = AX_DIR[r.axis], p = view.planeThrough(sx, sy, ax, new THREE.Vector3(...r.pivot));
  if (!p) return null;
  const v = [p.x - r.pivot[0], p.y - r.pivot[1], p.z - r.pivot[2]];
  return (Math.atan2(v[(r.axis + 2) % 3], v[(r.axis + 1) % 3]) * 180) / Math.PI;
}
function fitsWorld() {
  for (const p of S.doc.parts) {
    if (isBeam(p)) { for (const i of [0, p.holes - 1]) { const h = holeWorld(p, i); if (h.z < FLOOR.z - 0.5 || h.y > 0.5) return false; } }
    else { const b = solidBox(p); if (b.min[2] < FLOOR.z - 0.5 || b.max[1] > 0.5) return false; }
  }
  return true;
}
function startRotate(g, sx, sy) {
  const items = moveItems(selIds());
  if (!items.length) return;
  const flat = items.every((o) => !o.c && !isServo(o) && Math.abs(NVEC[fam(o)][g.axis]) > 0.5);
  const r = { axis: g.axis, pivot: rotPivot(items), ids: items.map((o) => o.id), snap: snapshot(), deg: 0, undone: false, step: flat ? 15 : 90, bad: false };
  r.a0 = ringAngle(sx, sy, r) ?? 0;
  S.rot = r;
}
function updateRotate(sx, sy) {
  const r = S.rot;
  let deg;
  if (/\d/.test(S.typed.v)) deg = +S.typed.v;
  else { const a = ringAngle(sx, sy, r); if (a === null) return; deg = a - r.a0; }
  deg = Math.round(deg / r.step) * r.step;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  if (deg === r.deg) return;
  S.doc = JSON.parse(r.snap);
  r.bad = false;
  if (deg !== 0) {
    const items = r.ids.map((id) => findById(S.doc, id)?.obj).filter(Boolean);
    const ok = rotateItems(S.doc, items, r.axis, deg, r.pivot);
    if (!ok || !fitsWorld()) { S.doc = JSON.parse(r.snap); r.bad = ok ? 'Così finirebbe dentro il muro o il pavimento' : 'Su questo asse gira solo a quarti di giro: raddrizzalo prima'; }
    else if (!r.undone) { S.undo.push(r.snap); if (S.undo.length > 150) S.undo.shift(); S.redo = []; r.undone = true; }
  }
  r.deg = r.bad ? 0 : deg;
  view.rebuild(S.doc);
  applyHidden();
  for (const id of selIds()) view.setHighlight(id, true, 0x3a6fd8);
  updateGizmo();
  ghostLabels = [{ text: r.bad ? r.bad : `${deg}°${r.step === 90 ? ' (a quarti di giro)' : ''}`, pos: [r.pivot[0], r.pivot[1], r.pivot[2] + 10], cls: r.bad ? 'warn' : 'ghost' }];
  schedulePreview();
}
function endRotate() {
  const r = S.rot;
  S.rot = null;
  typedReset();
  ghostLabels = [];
  if (!r.undone) return;
  if (r.deg === 0) S.undo.pop();
  commit();
}
function startGizmo(g, sx, sy) {
  if (g.type === 'rot') { startRotate(g, sx, sy); return; }
  if (g.type === 'move') {
    const items = moveItems(selIds());
    S.move = { p0: g.point.clone(), axis: g.dir, items, orig: items.map(coordsOf), d: [0, 0, 0], undone: false, selectId: S.selected, keep: true };
  } else {
    const part = S.doc.parts.find((p) => p.id === S.selected);
    S.resize = { part, axis: g.axis, side: g.side, dir: g.dir, p0: g.point.clone(), s0: [...part.s], c0: [...part.c], undone: false };
  }
}
function updateResize(sx, sy) {
  const r = S.resize, p = r.part, a = r.axis;
  const n = clamp(S.typed.v ? +S.typed.v : r.s0[a] + Math.round(axisParam(sx, sy, r.p0, r.dir) / P), 1, 40);
  if (n === p.s[a]) return;
  const was = { s: [...p.s], c: [...p.c] };
  if (!r.undone) { pushUndo(); r.undone = true; }
  p.s[a] = n;
  p.c[a] = r.side < 0 ? r.c0[a] - (n - r.s0[a]) * P : r.c0[a];
  if (blocked(p, p.id)) { p.s = was.s; p.c = was.c; return; }
  view.rebuild(S.doc);
  view.setHighlight(p.id, true, 0x3a6fd8);
  updateGizmo();
  ghostLabels = [{ text: `${p.s[0]}×${p.s[1]}×${p.s[2]} fori · ${p.s.map((v) => v * P).join('×')} mm`, pos: [p.c[0] + (p.s[0] - 1) * P / 2, p.c[1] + (p.s[1] - 1) * P / 2, p.c[2] + (p.s[2] - 0.5) * P + 4], cls: 'ghost' }];
  schedulePreview();
}

// ------------------------------------------------------------------ tape measure
const measureG = new THREE.Group();
view.scene.add(measureG);
const measMat = new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false });
const measLine = new THREE.LineBasicMaterial({ color: 0x111418, depthTest: false });
function measurePoint(sx, sy) {
  const h = hoverTarget(sx, sy, { shafts: false });
  if (h && h.t !== 'guide') { const p = facePoint(h.n, h.x, h.z, h.layer, h.sgn, h.i === -1 || h.t === 'floor' ? P / 2 - BEAM_W / 2 : 0); return { p: [p.x, p.y, p.z], h }; }
  const s = view.pickSurface(sx, sy);
  return s.point ? { p: [s.point.x, s.point.y, s.point.z] } : null;
}
function distText(a, b) {
  const d = a.map((v, k) => b[k] - v), L = Math.hypot(...d);
  let t = `${fmt(L, 1)} mm`;
  const holes = L / P;
  if (L > 1 && Math.abs(holes - Math.round(holes)) < 0.02) t += ` · ${Math.round(holes)} ${Math.round(holes) === 1 ? 'foro' : 'fori'}`;
  const comp = [['↔', d[0]], ['⤢', d[1]], ['↕', d[2]]].filter(([, v]) => Math.abs(v) > 0.05);
  if (comp.length > 1) t += '   ' + comp.map(([s, v]) => `${s} ${fmt(Math.abs(v), 1)}`).join('  ');
  return t;
}
function drawMeasure(live = null) {
  measureG.clear();
  const m = S.measure;
  if (!m) return;
  const pts = [m.a, m.b || live].filter(Boolean);
  for (const p of pts) { const s = new THREE.Mesh(new THREE.SphereGeometry(1.3, 12, 10), measMat); s.position.set(...p); s.renderOrder = 15; measureG.add(s); }
  if (pts.length === 2) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), measLine);
    l.renderOrder = 15;
    measureG.add(l);
    m.label = { text: distText(pts[0], pts[1]), pos: pts[0].map((v, k) => (v + pts[1][k]) / 2), cls: 'measure' };
  } else m.label = null;
}
function clickMeasure(sx, sy) {
  const q = measurePoint(sx, sy);
  if (!q) return;
  if (!S.measure || S.measure.b) S.measure = { a: q.p, b: null }; else S.measure.b = q.p;
  drawMeasure();
}

// ------------------------------------------------------------------ model facts: weight, centre of mass, bill of materials
const comG = new THREE.Group();
view.scene.add(comG);
function updateCom() {
  comG.clear();
  const sim = S.mode === 'run' ? S.sim : S.preview;
  if (!S.showCom || !sim) return;
  const m = sim.massProps();
  if (!m.mass) return;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf2b51c, depthTest: false }));
  ball.position.set(...m.com);
  ball.renderOrder = 16;
  const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...m.com), new THREE.Vector3(m.com[0], m.com[1], FLOOR.z)]), new THREE.LineDashedMaterial({ color: 0x111418, dashSize: 2, gapSize: 2, depthTest: false }));
  drop.computeLineDistances();
  drop.renderOrder = 16;
  comG.add(ball, drop);
  S.comLabel = { text: `baricentro · ${fmt(m.mass * 1000, 1)} g`, pos: m.com, cls: 'ghost' };
}
function renderModel() {
  const doc = S.doc;
  const rows = bom(doc, (S.mode === 'run' ? S.sim : S.preview)?.lengths || {});
  $('modelSec').hidden = !rows.length;
  if (!rows.length) return;
  const n = doc.parts.length;
  const mass = S.mass ? `${fmt(S.mass * 1000, S.mass < 0.1 ? 1 : 0)} g` : '—';
  $('massInfo').innerHTML = `<span>${n} ${n === 1 ? 'pezzo' : 'pezzi'}</span><span class="num">${mass}</span>`;
  const ul = $('bom');
  ul.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="bq">${r.count}×</span><span class="bl"></span><span class="bn"></span>`;
    li.querySelector('.bl').textContent = r.label;
    li.querySelector('.bn').textContent = r.note || '';
    li.title = 'Clicca per selezionarli tutti';
    li.onclick = () => { if (S.mode === 'edit') setTool('select'); selectMany(r.ids); };
    ul.appendChild(li);
  }
}
function exportStl() {
  const ids = new Set(selIds());
  let parts = S.doc.parts.filter((p) => !isServo(p) && ids.has(p.id));
  if (!parts.length) parts = S.doc.parts.filter((p) => !isServo(p));
  if (!parts.length) { toast('Non ci sono travi o blocchi da esportare.'); return; }
  const g = new THREE.Group();
  for (const p of parts) {
    const m = new THREE.Group();
    if (isBlock(p)) m.add(new THREE.Mesh(view.blockGeometry(p.s)));
    else m.add(new THREE.Mesh(view.beamGeometry(p.holes)), new THREE.Mesh(view.guideGeometry(p.holes)));
    view.placePart(m, p);
    g.add(m);
  }
  g.updateMatrixWorld(true);
  const data = new STLExporter().parse(g, { binary: true });
  saveFile(slug(S.projectName) + '.stl', data, 'model/stl');
  toast(`${parts.length} ${parts.length === 1 ? 'pezzo esportato' : 'pezzi esportati'} in STL (millimetri).`);
}

// ------------------------------------------------------------------ string path as numbered nodes
// A selected string shows the points it runs through as numbered nodes, in order. Drag a node onto
// another hole, eyelet or pulley to move it; drag a "+" to make the string pass somewhere new;
// right click (or Canc) takes a point away. The same numbers appear while a string is being drawn.
let nodeLabels = [], nodeList = [];
function anchorLabel(a) {
  const part = a.part !== undefined ? S.doc.parts.find((p) => p.id === a.part) : null;
  if (a.t === 'winch') return 'Verricello';
  if (a.t === 'pulley') { const w = S.doc.pulleys.find((e) => e.id === a.id); return `Puleggia Ø ${w ? w.r * 2 : ''}`; }
  if (a.t === 'guide') return `Occhiello · ${part ? partLabel(part).toLowerCase() : ''}, foro ${a.i + 1}`;
  if (a.t === 'hole') return `Foro ${a.i + 1} · ${part ? partLabel(part).toLowerCase() : ''}`;
  if (a.t === 'pt') return part ? partLabel(part) : 'Pezzo';
  return a.t === 'board' ? 'Foro del muro' : 'Foro del pavimento';
}
function pathProblem(list) {
  if (list.length < 2) return 'Un filo ha bisogno di almeno due punti.';
  if (list[0].t === 'pulley' || list[list.length - 1].t === 'pulley') return 'Il filo non può iniziare o finire su una puleggia.';
  if (list.some((a, i) => a.t === 'winch' && i > 0 && i < list.length - 1)) return 'Il verricello può stare solo a un capo del filo.';
  if (list.some((a, i) => i > 0 && sameAnchor(a, list[i - 1]))) return 'Due punti uguali di seguito.';
  return null;
}
function nodeString() {
  if (S.mode !== 'edit') return null;
  if (S.tool === 'string' && S.stringDraft) return { anchors: S.stringDraft.anchors, draft: true };
  if (S.tool === 'select' && S.selected !== null && !S.multi.length) return S.doc.strings.find((x) => x.id === S.selected) || null;
  return null;
}
function updateNodes() {
  nodeLabels = []; nodeList = [];
  const s = nodeString();
  if (!s) { S.nodeSel = null; return; }
  const pts = s.anchors.map((a) => anchorPos(S.doc, a));
  pts.forEach((p, i) => {
    if (!p) return;
    nodeList.push({ i, plus: false, p });
    nodeLabels.push({ text: String(i + 1), pos: [p.x, p.y, p.z], cls: 'node' + (i === S.nodeSel || i === S.nodeHot ? ' sel' : '') });
  });
  if (s.draft) return;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (!a || !b) continue;
    const p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    nodeList.push({ i, plus: true, p });
    nodeLabels.push({ text: '+', pos: [p.x, p.y, p.z], cls: 'node plus' });
  }
}
function pickNode(sx, sy) {
  let best = null;
  for (const n of nodeList) {
    const q = view.project(n.p), d = Math.hypot(q.x - sx, q.y - sy) + (n.plus ? 3 : 0);
    if (d < 13 && (!best || d < best.d)) best = { ...n, d };
  }
  return best;
}
function removeNode(i) {
  const s = nodeString();
  if (!s || s.draft) return;
  const list = s.anchors.filter((_, k) => k !== i), bad = pathProblem(list);
  if (bad) { toast(bad); return; }
  pushUndo();
  s.anchors = list;
  S.nodeSel = null;
  commit();
}
function updateNodeDrag(sx, sy) {
  const d = S.nodeDrag, s = S.doc.strings.find((x) => x.id === d.sid);
  if (!s) return;
  if (Math.hypot(sx - d.x, sy - d.y) > 5) d.moved = true;
  if (!d.moved) return;
  clearGhost();
  ghostLabels = [];
  d.cand = null;
  const h = hoverTarget(sx, sy, { wheels: true, guides: true, shafts: false });
  const a = targetToAnchor(h), p = a && anchorPos(S.doc, a);
  if (!p) return;
  const list = s.anchors.map((x) => ({ ...x }));
  if (d.plus) list.splice(d.i + 1, 0, a); else list[d.i] = a;
  const at = d.plus ? d.i + 1 : d.i, bad = pathProblem(list);
  if (h.t === 'pulley' || h.t === 'winch') {
    const w = (h.t === 'pulley' ? S.doc.pulleys : S.doc.winches).find((e) => e.id === h.id);
    ring({ ...h, sgn: view.facing(h.n, p) }, (w.r + 1.5) / HOLE());
  } else { ring(h, h.t === 'guide' ? 0.75 : 1); showEyelets(h); }
  const line = [list[at - 1], a, list[at + 1]].filter(Boolean).map((x) => anchorPos(S.doc, x)).filter(Boolean);
  if (line.length >= 2) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line.map((q) => new THREE.Vector3(q.x, q.y, q.z))), ghostLineMat);
    l.computeLineDistances();
    l.renderOrder = 11;
    ghost.add(l);
  }
  ghostLabels.push({ text: bad || `${at + 1} · ${anchorLabel(a)}`, pos: [p.x, p.y, p.z + 5], cls: bad ? 'warn' : 'ghost' });
  if (!bad) d.cand = list;
}
function endNodeDrag() {
  const d = S.nodeDrag, s = S.doc.strings.find((x) => x.id === d.sid);
  S.nodeDrag = null;
  clearGhost();
  ghostLabels = [];
  if (!s) return;
  if (d.moved && d.cand) { pushUndo(); s.anchors = d.cand; S.nodeSel = d.plus ? d.i + 1 : d.i; commit(); return; }
  if (!d.moved) {
    if (d.plus) toast('Trascina il + su un foro, un occhiello o una puleggia: il filo passerà da lì.');
    else S.nodeSel = S.nodeSel === d.i ? null : d.i;
  }
  updateNodes();
  renderInspector();
}
// What a click of the string tool will do, said next to the cursor.
function stringClickText(a) {
  const list = S.stringDraft?.anchors || [];
  if (!list.length) return a.t === 'winch' ? 'Parte dal verricello: filo motorizzato' : a.t === 'pulley' ? 'Non si parte da una puleggia' : '1 · lega qui l\'inizio';
  const n = list.length + 1, last = list[list.length - 1];
  if (sameAnchor(a, last)) return a.t === 'pulley' ? 'Cambia il lato della puleggia' : 'Clic: il filo finisce qui';
  if (a.t === 'winch') return `${n} · finisce sul verricello`;
  if (a.t === 'pulley') return `${n} · gira attorno alla puleggia da questo lato`;
  if (a.t === 'guide') return `${n} · passa nell'occhiello`;
  return `${n} · passa da qui (doppio clic: finisce qui)`;
}

// ------------------------------------------------------------------ panel tabs
const TABS = ['props', 'controls', 'tree', 'lib', 'model'];
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('#panel .tabpane').forEach((d) => (d.hidden = d.dataset.pane !== t));
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// ------------------------------------------------------------------ library of ready-made groups
// Whole sub-assemblies dropped next to what is already there, ready to be moved, joined, mirrored.
const PREFABS = [
  { name: 'Servo con leva', sub: 'Base, un MG996R e una trave sul suo albero', make: () => tourDoc(4) },
  { name: 'Braccio a due servo', sub: 'Torretta che gira e braccio che si alza', make: armDemo },
  { name: 'Dito con elastici', sub: 'Tre falangi sul muro: un verricello chiude, gli elastici riaprono', make: fingerDemo },
  { name: 'Dito a cinghia', sub: 'Tre falangi accoppiate, un filo chiude e uno riapre', make: fingerBeltDemo },
];
function insertPrefab(pf) {
  if (S.mode === 'run') stopSim();
  const sub = migrate(JSON.parse(JSON.stringify(pf.make())));
  const cur = docBounds(S.doc), sb = docBounds(sub);
  // to the right of the model if there is room on the wall and the baseplate, else to the left
  let dx = 0, fits = true;
  if (cur && sb) {
    const right = Math.ceil((cur.max[0] - sb.min[0] + P) / P) * P, left = Math.floor((cur.min[0] - sb.max[0] - P) / P) * P;
    const ok = (d) => sb.min[0] + d >= BOARD.x0 - P && sb.max[0] + d <= BOARD.x1 + P;
    fits = ok(right) || ok(left);
    dx = ok(right) ? right : ok(left) ? left : 0;
  }
  pushUndo();
  const map = new Map(), made = [], xf = xfShift([dx, 0, 0]);
  for (const k of ['parts', 'pins', 'pulleys', 'winches']) for (const o of sub[k]) {
    const id = S.doc.nextId++;
    map.set(o.id, id); o.id = id;
    shiftItem(o, [dx, 0, 0]);
    S.doc[k].push(o);
    if (k !== 'pins') made.push(id);
  }
  for (const st of sub.strings) {
    st.id = S.doc.nextId++;
    delete st.fmaxRef;
    st.anchors = st.anchors.map((a) => { const b = xf.anchor({ ...a }); if (b.part !== undefined) b.part = map.get(b.part); if (b.id !== undefined) b.id = map.get(b.id); return b; });
    S.doc.strings.push(st);
  }
  commit();
  setTool('select');
  selectMany(made);
  setTab('lib');
  view.isoView();
  toast(!fits ? `${pf.name} inserito sopra al modello, di fianco non c'era posto: trascinalo via.` : `${pf.name} inserito e selezionato: trascinalo dove serve.`);
}
function renderLib() {
  const el = $('lib');
  if (el.childElementCount) { el.querySelectorAll('button').forEach((b) => (b.disabled = false)); return; }
  for (const pf of PREFABS) {
    const d = document.createElement('div');
    d.className = 'libitem';
    d.innerHTML = '<div><b></b><span></span></div><button>Inserisci</button>';
    d.querySelector('b').textContent = pf.name;
    d.querySelector('span').textContent = pf.sub;
    d.querySelector('button').onclick = () => insertPrefab(pf);
    el.appendChild(d);
  }
}

// ------------------------------------------------------------------ object tree
// What hangs from what, starting from the fixed base. Redrawn whenever the model or the selection changes.
function renderTree() {
  const el = $('tree');
  if (!el) return;
  const t = sceneTree(S.doc), sel = new Set(selIds());
  $('treeSec').hidden = !S.doc.parts.length && !S.doc.strings.length;
  el.innerHTML = '';
  const row = (n, depth) => {
    const d = document.createElement('div');
    d.className = 'trow' + (sel.has(n.id) ? ' sel' : '');
    d.style.paddingLeft = `${6 + depth * 14}px`;
    d.innerHTML = `<span class="dot ${n.kind}" style="${n.color ? `background:${n.color}` : ''}"></span><span class="tl"></span><span class="tv"></span>`;
    d.querySelector('.tl').textContent = n.label;
    d.querySelector('.tv').textContent = n.via || '';
    d.onmouseenter = () => { if (!selIds().includes(n.id)) view.setHighlight(n.id, true, 0x888888); };
    d.onmouseleave = () => { if (!selIds().includes(n.id)) view.setHighlight(n.id, false); };
    d.onclick = (e) => { if (S.mode === 'edit' && S.tool !== 'select') setTool('select'); select(n.id, e.shiftKey); };
    el.appendChild(d);
    for (const c of n.children || []) row(c, depth + 1);
  };
  const head = (text, cls, count) => { const h = document.createElement('div'); h.className = 'thead2 ' + (cls || ''); h.innerHTML = `<span></span><small>${count}</small>`; h.firstChild.textContent = text; el.appendChild(h); };
  const size = (list) => list.reduce((a, n) => a + 1 + size(n.children || []), 0);
  head('Base fissa: muro e pavimento', '', size(t.fixed));
  if (!t.fixed.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Niente è ancora fissato alla base.'; el.appendChild(p); }
  t.fixed.forEach((n) => row(n, 1));
  if (t.loose.length) { head('Non fissati: cadranno', 'warn', size(t.loose)); t.loose.forEach((n) => row(n, 1)); }
  if (t.strings.length) {
    head('Fili', '', t.strings.length);
    for (const st of t.strings) row({ id: st.id, kind: 'string', label: stringName(S.doc.strings.find((x) => x.id === st.id)), via: st.via }, 1);
  }
}

// ------------------------------------------------------------------ guided tutorial
// Started on request. Each step asks for one thing, notices when it is done and moves on;
// "Fallo tu" does the step for you, so nobody gets stuck.
const TOUR_COLOR = '#2b2f36';
function tourDoc(stage) {
  const d = emptyDoc();
  const add = (p) => d.parts.push({ id: d.nextId++, ...p });
  add({ type: 'block', c: stage >= 2 ? [-24, -56, 8] : [-8, -56, 8], s: stage >= 2 ? [7, 5, 1] : [5, 5, 1], color: TOUR_COLOR });
  if (stage >= 3) add({ type: 'servo', model: 'MG996R', n: 'z', x: 8, z: -40, layer: 7, angle: 180 });
  if (stage >= 4) add({ type: 'beam', n: 'z', x: 8, z: -40, layer: 7, angle: 0, holes: 7, color: '#d8342c' });
  return d;
}
function tourSet(stage) {
  stopSim();
  pushUndo();
  S.doc = migrate(tourDoc(stage));
  S.selected = null; S.multi = [];
  cancelDrafts();
  commit();
}
const servoParts = () => S.doc.parts.filter(isServo);
const TOUR = [
  { t: 'Guardati intorno',
    h: 'Tieni premuto il <b>tasto destro</b> e muovi il mouse per girare la vista, la <b>rotella</b> avvicina, il <b>tasto centrale</b> sposta. Il cubo in alto a destra e i due pulsanti sotto riportano la vista dritta.<br>Costruiremo un piccolo braccio che gira. Premi <b>Avanti</b>.' },
  { t: '1. Posa un blocco',
    h: 'Con l\'attrezzo <b>Blocco</b> (tasto <kbd>C</kbd>) <b>clicca sul pavimento</b> e, senza lasciare, <b>trascina</b> per farne una piastra. I blocchi si incollano da soli a ciò che toccano.',
    enter: () => setTool('block'), done: () => S.doc.parts.some(isBlock), auto: () => tourSet(1) },
  { t: '2. Dagli la misura giusta',
    h: 'Passa alla <b>Mano</b> (<kbd>V</kbd>) e clicca il blocco. Tira una delle <b>piastrine bianche</b> sulle facce per allargarlo, oppure mentre tiri <b>scrivi un numero</b> e premi Invio. Le <b>frecce colorate</b> invece lo spostano.',
    enter: () => { setTool('select'); S.tourRef = JSON.stringify(S.doc.parts.filter(isBlock).map((b) => b.s)); },
    done: () => JSON.stringify(S.doc.parts.filter(isBlock).map((b) => b.s)) !== S.tourRef, auto: () => tourSet(2) },
  { t: '3. Monta un servo',
    h: 'Prendi il <b>Servo</b> (<kbd>M</kbd>), scegli il modello in alto e <b>clicca un foro sopra il blocco</b>. L\'albero esce dalla faccia che clicchi, <kbd>R</kbd> gira il corpo.',
    enter: () => setTool('servo'), done: () => servoParts().length > 0, auto: () => tourSet(3) },
  { t: '4. Metti una trave sull\'albero',
    h: 'Con la <b>Trave</b> (<kbd>B</kbd>) <b>clicca l\'albero del servo</b>, poi scrivi <kbd>7</kbd> e premi <kbd>Invio</kbd>: nasce una trave da 7 fori. Tutto ciò che sta sull\'albero gira con il servo. <kbd>Esc</kbd> per smettere di disegnare.',
    enter: () => setTool('beam'), done: () => servoParts().some((sv) => shaftMembers(S.doc, sv).length > 0), auto: () => tourSet(4) },
  { t: '5. Simula',
    h: 'Premi <b>Simula</b> (o <kbd>Spazio</kbd>) e muovi lo <b>slider del servo</b> a destra. Puoi anche afferrare i pezzi col mouse. Nel pannello leggi la coppia che il servo sta facendo.',
    enter: () => setTab('controls'),
    done: () => S.mode === 'run' && Object.values(S.controls.servo).some((v) => Math.abs(v) > 5),
    auto: () => { if (!servoParts().length) tourSet(4); if (S.mode !== 'run') startSim(); const sv = servoParts()[0]; if (sv && S.mode === 'run') { S.controls.servo[sv.id] = 60; S.sim.setControls(S.controls); renderControls(); } } },
  { t: '6. Copia tutto in un colpo',
    h: 'Premi <b>■</b> per tornare a costruire. Poi <kbd>Ctrl</kbd>+<kbd>A</kbd> seleziona tutto e nella scheda <b>Pezzo</b> a destra premi <b>Specchia</b>: ottieni il braccio gemello. <b>Ripeti</b> ne fa una fila, <b>Shift+clic</b> sceglie solo alcuni pezzi.',
    enter: () => { S.tourRef = servoParts().length; },
    done: () => S.mode === 'edit' && servoParts().length > S.tourRef,
    auto: () => { stopSim(); if (!servoParts().length) tourSet(4); setTool('select'); selectMany(S.doc.parts.map((p) => p.id)); mirrorSelection(); } },
  { t: '7. Falli muovere da soli',
    enter: () => setTab('controls'),
    h: 'Nella scheda <b>Comandi</b>, riquadro <b>Sequenza di pose</b>: metti gli slider in una posizione e premi <b>Salva posa</b>, cambiali e salvane un\'altra. Con due pose compare <b>Riproduci in sequenza</b> e il robot le ripete.',
    done: () => (S.doc.poses || []).length >= 2,
    auto: () => {
      const ids = servoParts().map((p) => p.id);
      S.doc.poses = [-60, 60].map((a) => ({ winch: {}, servo: Object.fromEntries(ids.map((id, k) => [id, k % 2 ? -a : a])) }));
      markDirty(); renderSeq();
      if (S.mode !== 'run') startSim();
      if (S.mode === 'run') { S.paused = false; S.seq = { i: 0, t: 0, paused: false }; syncRunUI(); renderSeq(); }
    } },
  { t: 'Fatto! Cos\'altro c\'è',
    h: `<ul>
      <li><b>Unisci</b> <kbd>J</kbd>: foro di una trave, poi foro di destinazione, e la trave ci va da sola.</li>
      <li><b>Perno</b> <kbd>P</kbd>: unisce due pezzi su un foro. Un altro clic lo blocca o lo motorizza.</li>
      <li><b>Puleggia</b> <kbd>U</kbd>, <b>Verricello</b> <kbd>W</kbd> e <b>Filo</b> <kbd>F</kbd>: per dita e tendini. Guarda <i>Esempi, Dito con elastici</i>.</li>
      <li>Un <b>filo</b> selezionato mostra il percorso a <b>numeri</b>: trascinali per spostare un punto, trascina un <b>+</b> per aggiungerne uno, clic destro lo toglie.</li>
      <li>Schede a destra: <b>Albero</b> mostra cosa è attaccato a cosa, <b>Libreria</b> inserisce gruppi già pronti, <b>Distinta</b> conta i pezzi.</li>
      <li><b>Metro</b> <kbd>T</kbd> misura, <b>Baricentro</b> mostra dove pesa, <kbd>H</kbd> nasconde un pezzo.</li>
      <li><b>STL</b> e JSON nel menu File. Su un blocco puoi scrivere un <b>peso di prova</b>, e i servo mostrano il <b>picco di coppia</b>.</li>
      <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> annulla sempre. I progetti si salvano da soli.</li>
    </ul>Puoi riaprire questo tutorial quando vuoi dal pulsante <b>Tutorial</b> in alto.` },
];
function tourStart() {
  $('welcome').hidden = true;
  $('exMenu').hidden = true; $('fileMenu').hidden = true;
  newProject(emptyDoc(), 'Tutorial');
  view.isoView();
  tourGo(0);
}
function tourGo(i) {
  if (i < 0) return;
  if (i >= TOUR.length) { tourEnd(); return; }
  const st = TOUR[i];
  S.tour = { i, doneAt: 0, was: false };
  st.enter?.();
  S.tour.was = !!st.done?.();
  $('tour').hidden = false;
  $('tourN').textContent = `${i + 1} di ${TOUR.length}`;
  $('tourT').textContent = st.t;
  $('tourB').innerHTML = st.h;
  $('tourOk').hidden = !S.tour.was;
  $('tourBack').disabled = i === 0;
  $('tourAuto').hidden = !st.auto;
  $('tourNext').textContent = i === TOUR.length - 1 ? 'Fine' : 'Avanti';
  $('tourNext').classList.toggle('primary', !st.done || S.tour.was);
}
function tourEnd() { S.tour = null; $('tour').hidden = true; }
// Watches for the step being done, then moves on by itself.
function tourTick(now) {
  const q = S.tour, st = TOUR[q.i];
  if (!st.done || q.was) return;
  if (!q.doneAt) { if (st.done()) { q.doneAt = now; $('tourOk').hidden = false; $('tourNext').classList.add('primary'); } }
  else if (now - q.doneAt > 1400 && !S.move && !S.resize && !S.blockDraft) tourGo(q.i + 1);
}
$('btnTour').onclick = tourStart;
$('wTour').onclick = tourStart;
$('tourClose').onclick = tourEnd;
$('tourBack').onclick = () => tourGo(S.tour.i - 1);
$('tourNext').onclick = () => tourGo(S.tour.i + 1);
$('tourAuto').onclick = () => { const q = S.tour; TOUR[q.i].auto(); };

// ------------------------------------------------------------------ pose sequence
// Save the slider positions as poses; with two or more the robot plays them in a loop.
const clonePose = (c) => ({ winch: { ...c.winch }, servo: { ...c.servo } });
function hasMotors() { return servoList().length > 0 || S.doc.winches.some((w) => winchStrings(w).length); }
function renderSeq() {
  const sec = $('seqSec'), el = $('seq');
  sec.hidden = !hasMotors();
  if (sec.hidden) return;
  const poses = (S.doc.poses ||= []);
  el.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'seg';
  poses.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pose' + (S.seq && S.seq.i === i ? ' on' : '');
    b.innerHTML = `${i + 1}<span class="x" title="Togli questa posa">×</span>`;
    b.title = 'Vai a questa posa';
    b.onclick = (e) => {
      if (e.target.classList.contains('x')) { poses.splice(i, 1); stopSeq(); markDirty(); renderSeq(); return; }
      stopSeq();
      S.controls = clonePose(p);
      if (S.mode !== 'run') startSim();
      S.sim?.setControls(S.controls); renderControls(); markDirty();
    };
    row.appendChild(b);
  });
  const add = document.createElement('button');
  add.textContent = '＋ Salva posa';
  add.title = 'Ricorda la posizione attuale degli slider';
  add.onclick = () => { poses.push(clonePose(S.controls)); markDirty(); renderSeq(); };
  row.appendChild(add);
  el.appendChild(row);
  if (poses.length >= 2) {
    const bar = document.createElement('div');
    bar.className = 'seqbar';
    const play = document.createElement('button');
    play.className = 'primary';
    const going = S.seq && !S.seq.paused;
    play.textContent = going ? '❚❚ Pausa' : S.seq ? '▶ Riprendi' : '▶ Riproduci';
    play.title = going ? 'Ferma la sequenza dove si trova' : 'Ripete le pose una dopo l\'altra';
    play.onclick = () => {
      if (S.seq) S.seq.paused = !S.seq.paused;
      else { if (S.mode !== 'run') startSim(); if (S.mode === 'run') { S.paused = false; S.seq = { i: 0, t: 0, paused: false }; syncRunUI(); } }
      renderSeq();
    };
    const stop = document.createElement('button');
    stop.textContent = '■ Stop';
    stop.title = 'Ferma la sequenza e torna alla prima posa';
    stop.disabled = !S.seq;
    stop.onclick = () => { S.seq = null; S.controls = clonePose(poses[0]); S.sim?.setControls(S.controls); renderControls(); renderSeq(); };
    bar.append(play, stop);
    el.appendChild(bar);
  } else {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Muovi gli slider: il robot si mette in posizione. Quando ti piace premi Salva posa. Con due o più pose le ripete una dopo l\'altra.';
    el.appendChild(p);
  }
}
function stopSeq() { if (S.seq) { S.seq = null; renderSeq(); } }
function stepSeq(dt) {
  const poses = S.doc.poses || [], q = S.seq;
  if (!q || poses.length < 2) { S.seq = null; return; }
  if (q.paused) return;
  const MOVE = 1.0, HOLD = 0.5;
  q.t += dt;
  const a = poses[q.i % poses.length], b = poses[(q.i + 1) % poses.length];
  const u = Math.min(1, q.t / MOVE), e = u * u * (3 - 2 * u);
  for (const k of ['winch', 'servo']) for (const id of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) S.controls[k][id] = (a[k][id] ?? 0) + ((b[k][id] ?? 0) - (a[k][id] ?? 0)) * e;
  S.sim.setControls(S.controls);
  if (q.t > MOVE + HOLD) { q.i = (q.i + 1) % poses.length; q.t = 0; renderSeq(); }
}
// keep the sliders in step while a sequence drives them
function syncSliders() {
  for (const box of $('controls').querySelectorAll('.ctl')) {
    const r = box.querySelector('input[type=range]');
    const w = box.dataset.winch, v = w ? S.controls.winch[w] ?? 0 : S.controls.servo[box.dataset.pin] ?? 0;
    r.value = v;
    box.querySelector('[data-v]').textContent = w ? `gira ${fmt(v, 0)} mm` : `${fmt(v, 0)}°`;
  }
}

// Number fields of the panel: Enter confirms and gives the keyboard back to the scene, Tab confirms
// and goes to the next field, the mouse wheel steps the value.
$('panel').addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.matches('input[type=number]') || (e.key !== 'Enter' && e.key !== 'Tab')) return;
  e.preventDefault();
  const sel = 'input[type=number]:not(:disabled)';
  const i = [...$('inspector').querySelectorAll(sel)].indexOf(t);
  t.blur(); // fires change, which may redraw the inspector
  if (e.key === 'Tab' && i >= 0) {
    const list = [...$('inspector').querySelectorAll(sel)];
    const n = list[(i + (e.shiftKey ? list.length - 1 : 1)) % list.length];
    if (n) { n.focus(); n.select(); }
  }
});
$('panel').addEventListener('wheel', (e) => {
  const t = e.target;
  if (!t.matches('input[type=number]') || t.disabled || S.mode !== 'edit') return;
  e.preventDefault();
  if (e.deltaY < 0) t.stepUp(); else t.stepDown();
  t.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });

// ------------------------------------------------------------------ side panel
function renderPanel() { renderLib(); renderControls(); renderSeq(); renderLegend(); renderInspector(); renderTree(); renderWarnings(); renderModel(); }

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

// Moving a slider while building starts the simulation, so you see the position you are choosing.
// The sliders are left alone meanwhile, or the one under the mouse would be torn away.
function liveStart() {
  if (S.mode === 'run') return;
  S.keepCtl = true;
  try { startSim(); } finally { S.keepCtl = false; }
  if (S.mode !== 'run') return;
  $('controls').querySelector('p.empty')?.remove();
  toast('Simulazione avviata per mostrarti la posizione. Premi ■ per tornare a costruire.');
}
function renderControls() {
  if (S.keepCtl) return;
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
      r.oninput = () => { liveStart(); S.controls.winch[it.w.id] = +r.value; box.querySelector('[data-v]').textContent = `gira ${fmt(+r.value, 0)} mm`; S.sim?.setControls(S.controls); markDirty(); };
      box.dataset.winch = it.w.id;
    } else {
      const o = it.o, sv = servoParams(o);
      const lo = Math.max(sv.travel[0], sv.range ? sv.range[0] : -Infinity), hi = Math.min(sv.travel[1], sv.range ? sv.range[1] : Infinity);
      const id = `ctl_p${o.id}`;
      const v = clamp(S.controls.servo[o.id] ?? 0, lo, hi);
      box.innerHTML = `<div class="row"><label class="name" for="${id}">Servo ${++ns}${o.model ? ' · ' + o.model : ''}</label><span class="val" data-v>${fmt(v, 0)}°</span></div>
        <input type="range" id="${id}" min="${lo}" max="${hi}" step="1" value="${v}">
        <div class="row"><span class="val" data-t>coppia —</span><span class="val">max ${fmt(kgcm(sv.tmax), 1)} kg·cm</span></div>
        <div class="meter" data-m><i></i></div>
        <div class="row"><span class="val muted">picco in questa prova</span><span class="val" data-p>—</span></div><div class="note" data-n hidden></div>`;
      const r = box.querySelector('input');
      r.oninput = () => { liveStart(); S.controls.servo[o.id] = +r.value; box.querySelector('[data-v]').textContent = `${fmt(+r.value, 0)}°`; S.sim?.setControls(S.controls); markDirty(); };
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
      const pk = (S.peak[pid] = Math.max(S.peak[pid] || 0, val));
      const pe = box.querySelector('[data-p]');
      if (pe) { pe.textContent = `${fmt(Math.min(100, (pk / max) * 100), 0)}% del massimo`; pe.classList.toggle('hot', pk >= max * 0.98); }
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
  const many = S.multi.length > 1;
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

  // what a CAD calls pattern, mirror, hide: for one piece or for the whole selection
  const groupActions = () => {
    if (!many && f.coll === 'parts') {
      const nm = add(`<div class="prop"><label for="partName">Nome</label><input id="partName" value="${escapeHtml(o.name || '')}" placeholder="${escapeHtml(partLabel(o))}" style="width:150px;padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--raised)" ${editable ? '' : 'disabled'}></div>`);
      nm.querySelector('input').onchange = (e) => { pushUndo(); const v = e.target.value.trim().slice(0, 40); if (v) o.name = v; else delete o.name; commit(); };
    }
    add(`<h3 class="sub">${many ? 'Tutti insieme' : 'Copie'}</h3>`);
    const row = add(`<div class="pattern"><label>Ripeti <input type="number" id="patN" min="2" max="30" value="3" ${editable ? '' : 'disabled'}> volte</label>
      <label>ogni <input type="number" id="patStep" min="0" max="60" value="0" title="0 = una accanto all'altra" ${editable ? '' : 'disabled'}> fori</label></div>`);
    const seg = add('<div class="seg"></div>');
    for (const [axis, txt, tip] of [[0, '→ a destra', 'Lungo la larghezza'], [2, '↑ in alto', 'In altezza'], [1, '↙ verso di te', 'In profondità']]) {
      const b = document.createElement('button');
      b.textContent = txt; b.title = tip; b.disabled = !editable;
      b.onclick = () => repeatSelection(clamp(+row.querySelector('#patN').value || 2, 2, 30), axis, clamp(+row.querySelector('#patStep').value || 0, 0, 60));
      seg.appendChild(b);
    }
    const seg2 = add('<div class="seg"></div>');
    for (const [txt, tip, fn] of [['Specchia', 'Copia speculare, come mano destra e sinistra', mirrorSelection], ['Duplica', 'Ctrl+D', duplicateSelected], ['Nascondi', 'H · Shift+H mostra tutto', hideSelection]]) {
      const b = document.createElement('button');
      b.textContent = txt; b.title = tip; b.disabled = !editable;
      b.onclick = fn;
      seg2.appendChild(b);
    }
  };
  if (many) {
    const set = selectionSet(), bb = boundsOf(set);
    $('inspTitle').textContent = `${S.multi.length} pezzi selezionati`;
    if (bb) info('Ingombro', `${[0, 1, 2].map((k) => fmt(bb.max[k] - bb.min[k], 0)).join(' × ')} mm`);
    add(`<p class="empty">Con loro vengono ${set.pins.length} perni e ${set.strings.length} fili. Trascina uno dei pezzi o le frecce per spostarli tutti.</p>`);
    groupActions();
    const b = add(`<button class="danger" ${editable ? '' : 'disabled'}>Elimina tutti</button>`);
    b.onclick = deleteSelection;
    return;
  }
  if (f.coll === 'parts' && isBlock(o)) {
    $('inspTitle').textContent = 'Blocco';
    info('Misura', `${o.s.map((n) => n * P).join(' × ')} mm`);
    const dims = ['Larghezza', 'Profondità', 'Altezza'];
    dims.forEach((lbl, k) => numProp(lbl, o.s[k], 1, 40, 1, (v) => { const old = o.s[k]; o.s[k] = v; if (blocked(o, o.id)) { o.s[k] = old; toast('Non c\'è spazio per allungarlo.'); } }, 'fori'));
    const rbk = add(`<button ${editable ? '' : 'disabled'}>Ruota di 90° (R)</button>`);
    rbk.onclick = () => rotateSelected(90);
    swatches(BLOCK_COLORS);
    numProp('Peso di prova', o.mass ?? 0, 0, 5000, 10, (v) => { if (v > 0) o.mass = v; else delete o.mass; }, 'g');
    add('<p class="empty">0 = il peso vero della plastica. Scrivi i grammi per simulare un carico, per esempio l\'oggetto che il braccio deve alzare.</p>');
    const gl = add(`<label class="prop"><span>Si incolla a ciò che tocca</span><input type="checkbox" ${o.glue !== false ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>`);
    gl.querySelector('input').onchange = (e) => { pushUndo(); if (e.target.checked) delete o.glue; else o.glue = false; commit(); };
    add('<p class="empty">Ha un foro su ogni faccia: ci passano perni e alberi dei servo, e i fili ci si legano. Togli la colla se deve muoversi accanto ad altri blocchi.</p>');
    groupActions();
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
    groupActions();
    delBtn();
  } else if (f.coll === 'parts') {
    $('inspTitle').textContent = 'Trave';
    info('Fori', `${o.holes} · ${fmt((o.holes - 1) * P + BEAM_W, 1)} mm`);
    numProp('Lunghezza (fori)', o.holes, 2, 25, 1, (v) => (o.holes = v));
    numProp('Angolo', +(+o.angle).toFixed(1), -180, 180, 15, (v) => (o.angle = v), '°');
    numProp('Strato', o.layer, -40, 40, 1, (v) => (o.layer = v));
    const rot = add('<div class="seg"></div>');
    for (const [txt, d] of [['↺ Ruota 15°', 15], ['↻ Ruota 15°', -15], ['Ruota 90°', 90]]) {
      const b = document.createElement('button');
      b.textContent = txt; b.title = 'R ruota, Shift+R al contrario'; b.disabled = !editable;
      b.onclick = () => rotateSelected(d);
      rot.appendChild(b);
    }
    add('<p class="empty">Piano su cui è stesa (gira attorno al primo foro):</p>');
    segProp(['y', 'z', 'x'].map((n) => [n, FAM_LABEL[n]]), fam(o), (n) => replane(o, n));
    swatches(BEAM_COLORS);
    groupActions();
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
    add('<h3 class="sub">Orientamento</h3>');
    add('<p class="empty">Dove punta l\'asse (tasto <b>R</b> li scorre, <b>Shift+R</b> capovolge):</p>');
    segProp(['y', 'z', 'x'].map((n) => [n, AXIS_LABEL[n]]), fam(o), (n) => replane(o, n));
    const fb = add(`<button ${editable ? '' : 'disabled'}>Capovolgi: monta dal lato opposto</button>`);
    fb.onclick = () => { pushUndo(); flipWheel(o); commit(); };
    const mnt = mountOf(S.doc, o);
    add(`<p class="empty">${mnt.kind === 'part' ? `Montato su: ${partLabel(mnt.part).toLowerCase()}.` : mnt.kind === 'board' ? 'Montato sulla base fissa.' : 'Non tocca nessun foro: resta fermo nello spazio. Spostalo con le frecce su un foro.'}</p>`);
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
    add('<h3 class="sub">Orientamento</h3>');
    add('<p class="empty">Dove punta l\'asse (tasto <b>R</b> li scorre, <b>Shift+R</b> capovolge):</p>');
    segProp(['y', 'z', 'x'].map((n) => [n, AXIS_LABEL[n]]), fam(o), (n) => replane(o, n));
    const fb = add(`<button ${editable ? '' : 'disabled'}>Capovolgi: monta dal lato opposto</button>`);
    fb.onclick = () => { pushUndo(); flipWheel(o); commit(); };
    const mnt = mountOf(S.doc, o);
    add(`<p class="empty">${mnt.kind === 'part' ? `Montato su: ${partLabel(mnt.part).toLowerCase()}.` : mnt.kind === 'board' ? 'Montato sulla base fissa.' : 'Non tocca nessun foro: resta fermo nello spazio. Spostalo con le frecce su un foro.'}</p>`);
    delBtn();
  } else if (f.coll === 'strings') {
    $('inspTitle').textContent = STRING_LABEL[o.kind];
    const nm = add(`<div class="prop"><label for="strName">Nome</label><input id="strName" value="${escapeHtml(o.name || '')}" placeholder="es. Flessore" style="width:150px;padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--raised)" ${editable ? '' : 'disabled'}></div>`);
    nm.querySelector('input').onchange = (e) => { pushUndo(); o.name = e.target.value.slice(0, 40); commit(); };
    segProp(['string', 'elastic'].map((t) => [t, STRING_LABEL[t]]), o.kind, (t) => { o.kind = t; if (t === 'elastic') { o.stiffness ??= 60; o.pretension ??= 3; } });
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
    add('<h3 class="sub">Percorso</h3>');
    const ol = add('<ol class="path"></ol>');
    o.anchors.forEach((a, i) => {
      const li = document.createElement('li');
      li.className = i === S.nodeSel ? 'sel' : '';
      li.innerHTML = `<span class="pn">${i + 1}</span><span class="pl"></span><button class="px" title="Togli questo punto" ${editable ? '' : 'disabled'}>×</button>`;
      li.querySelector('.pl').textContent = anchorLabel(a);
      li.onmouseenter = () => { S.nodeHot = i; updateNodes(); };
      li.onmouseleave = () => { S.nodeHot = null; updateNodes(); };
      li.onclick = (e) => { if (e.target.classList.contains('px')) { S.nodeHot = null; removeNode(i); return; } S.nodeSel = S.nodeSel === i ? null : i; updateNodes(); renderInspector(); };
      ol.appendChild(li);
    });
    if (editable) add('<p class="empty">Nella scena: <b>trascina un numero</b> su un altro foro, occhiello o puleggia per spostare quel punto. <b>Trascina un +</b> per far passare il filo da un punto nuovo. <b>Clic destro</b> su un numero lo toglie.</p>');
    const rb = add(`<button ${editable ? '' : 'disabled'}>Rifai il percorso da capo</button>`);
    rb.title = 'Riclicca i punti da cui passa: il filo tiene nome e impostazioni';
    rb.onclick = () => { setTool('string'); S.stringDraft = { kind: o.kind, anchors: [], replaceId: o.id }; updateHint(); };
    delBtn();
  }
}

function renderWarnings() {
  const list = S.warnings || [];
  $('warnSec').hidden = !list.length;
  const ul = $('warnings');
  ul.innerHTML = '';
  for (const w of list) {
    const li = document.createElement('li');
    li.className = w.level;
    li.textContent = w.text;
    const ids = (w.ids || []).filter((id) => findById(S.doc, id));
    if (ids.length) { li.classList.add('go'); li.title = 'Clicca per vedere quali pezzi'; li.onclick = () => { if (S.mode === 'edit') setTool('select'); selectMany(ids); }; }
    ul.appendChild(li);
  }
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
$('btnExportStl').onclick = exportStl;
$('btnBomCsv').onclick = () => saveFile(slug(S.projectName) + '-distinta.csv', '\ufeff' + bomCsv(bom(S.doc, S.preview?.lengths || {})), 'text/csv');
$('btnShowAll').onclick = () => { S.hidden.clear(); applyHidden(); };
$('chkCom').onchange = (e) => { S.showCom = e.target.checked; S.comLabel = null; updateCom(); };
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
  if (S.tour) tourTick(now);
  if (S.mode === 'run' && S.sim) {
    if (!S.paused) {
      if (S.seq) stepSeq(dt * S.speed);
      S.sim.step(dt * S.speed, S.drag ? dragForce : null);
      if (S.sim.snaps.size > (S.snapsShown || 0)) reportSnaps();
    }
    view.applySimPose(S.sim);
    const { tensions } = drawStrings();
    $('simTime').textContent = fmt(S.sim.time, 2) + ' s';
    if (now - labelT > 120) {
      labelT = now;
      updateLiveReadouts();
      if (S.seq) syncSliders();
      if (S.showCom) updateCom();
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
      if (S.showCom && S.comLabel) labels.push(S.comLabel);
      view.setLabels(labels);
      if (S.selected !== null) renderInspectorLive();
    }
  } else if (now - labelT > 100) {
    labelT = now;
    view.setLabels([...nodeLabels, ...ghostLabels, ...(S.measure?.b && S.measure.label ? [S.measure.label] : []), ...(S.showCom && S.comLabel ? [S.comLabel] : [])]);
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

