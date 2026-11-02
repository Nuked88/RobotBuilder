import './style.css';
import { View, THREE, stringColor } from './scene.js';
import { ViewCube } from './viewcube.js';
import { initPhysics, Sim } from './physics.js';
import { fingerDemo, fingerBeltDemo } from './demo.js';
import { openStore, lastProjectId, setLastProjectId, saveFile } from './storage.js';
import {
  P, BEAM_W, LAYER, layerY, rad, emptyDoc, holePos, holeIndexAt, onGrid, snapGrid, topLayerAt, layerBehind, holeAt,
  pinAt, pinMembers, findById, prune, BEAM_COLORS, PIN_LABEL, STRING_LABEL, BOARD, EPS, guidePos, anchorPos,
} from './model.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 1) => x.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });

// ------------------------------------------------------------------ state
const S = {
  doc: emptyDoc(),
  projectId: null,
  projectName: 'Progetto senza nome',
  undo: [], redo: [],
  tool: 'beam',
  pinType: 'hinge',
  stringKind: 'string',
  layerMode: 'auto',
  draw: null,          // beam being drawn: {start:{x,z,base}, layer}
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
  select: 'Clicca un pezzo per vederne le proprietà. In simulazione <b>trascinalo</b> per spingerlo con la mano.',
  beam0: 'Clicca un <b>foro</b> (della tavola o di una trave) dove inizia la trave.',
  beam1: 'Muovi il mouse e clicca dove finisce. Ogni nuova trave nasce <b>imperniata</b> al foro di partenza. <b>Esc</b> per finire.',
  pin: 'Clicca un foro per metterci un perno: unisce il pezzo con quello che c\'è dietro. Clicca un perno esistente per <b>cambiarne il tipo</b>.',
  pulley: 'Clicca un foro per montarci una <b>puleggia</b>: il filo ci gira attorno e cambia direzione.',
  string0: 'Clicca il punto di partenza del filo: un <b>verricello</b> (filo motorizzato) o un foro.',
  string1: 'Clicca i fori e le pulegge da cui passa. Sulla puleggia, clicca <b>dal lato</b> in cui vuoi il filo. Doppio clic o <b>Invio</b> per chiudere, <b>Esc</b> per annullare.',
  winch: 'Clicca un foro per montare un <b>verricello</b>: poi partici con un filo e lo comandi con lo slider.',
  erase: 'Clicca quello che vuoi togliere.',
  run: 'Simulazione in corso: usa gli <b>slider</b> a destra o <b>trascina</b> i pezzi. Premi ■ per tornare a costruire.',
};
function updateHint() {
  let k = S.tool;
  if (S.mode === 'run') k = 'run';
  else if (S.tool === 'beam') k = S.draw ? 'beam1' : 'beam0';
  else if (S.tool === 'string') k = S.stringDraft ? 'string1' : 'string0';
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
  view.frontView(false);
  schedulePreview();
  renderPanel();
  refreshUndoButtons();
  setLastProjectId(p.id);
  $('chkGravity').checked = S.doc.settings?.gravity !== false;
  $('saveState').textContent = store?.remote ? 'Salvato sul server' : 'Salvato in questo browser';
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
  view.frontView(S.doc.parts.length > 0);
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
      s.fmaxRef = w ? (S.doc.winches.find((x) => x.id === w.id)?.fmax ?? 10) : 3;
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
// Finds what is under the cursor: a winch/pulley, a hole of a part, or a hole of the board.
function hoverTarget(sx, sy, opts = {}) {
  const doc = S.doc;
  let best = null;
  if (opts.wheels) {
    for (const [arr, t] of [[doc.winches, 'winch'], [doc.pulleys, 'pulley']]) {
      for (const w of arr) {
        const c = view.project({ x: w.x, y: layerY(w.layer), z: w.z });
        const e = view.project({ x: w.x + w.r, y: layerY(w.layer), z: w.z });
        const rpx = Math.hypot(e.x - c.x, e.y - c.y);
        const d = Math.hypot(sx - c.x, sy - c.y);
        if (d < rpx * 1.08 + 2 && (!best || d < best.d)) {
          const wp = view.planePoint(sx, sy, layerY(w.layer));
          let sxv = 1, szv = 0;
          if (wp) { const L = Math.hypot(wp.x - w.x, wp.z - w.z) || 1; sxv = (wp.x - w.x) / L; szv = (wp.z - w.z) / L; }
          best = { t, id: w.id, x: w.x, z: w.z, layer: w.layer, d, sx: sxv, sz: szv };
        }
      }
    }
  }
  const wheel = best;
  best = null;
  for (const part of doc.parts) {
    for (let i = 0; i < part.holes; i++) {
      const h = holePos(part, i);
      const s = view.project({ x: h.x, y: layerY(part.layer) - BEAM_W / 2, z: h.z });
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d < 13 && (!best || d < best.d - 3 || (Math.abs(d - best.d) <= 3 && part.layer > best.layer))) best = { t: 'hole', part, i, x: h.x, z: h.z, layer: part.layer, d };
    }
  }
  // cable guides on the beam sides: they win when the cursor is closer to them than to the hole
  if (opts.guides) {
    let g = null;
    for (const part of doc.parts) {
      for (let i = 0; i < part.holes; i++) {
        for (const side of [1, -1]) {
          const q = guidePos(part, i, side);
          const s = view.project({ x: q.x, y: layerY(part.layer) - BEAM_W / 2, z: q.z });
          const d = Math.hypot(sx - s.x, sy - s.y);
          if (d < 9 && (!g || d < g.d - 2 || (Math.abs(d - g.d) <= 2 && part.layer > g.layer))) g = { t: 'guide', part, i, side, x: q.x, z: q.z, layer: part.layer, d };
        }
      }
    }
    if (g && (!best || g.d < best.d)) best = g;
  }
  // a wheel wins unless the cursor sits right on a hole
  if (wheel && !(best && best.d < 5 && best.d < wheel.d)) return wheel;
  if (best) return best;
  if (opts.board !== false) {
    const wp = view.planePoint(sx, sy, -BEAM_W / 2);
    if (wp && wp.x > BOARD.x0 - P && wp.x < BOARD.x1 + P && wp.z > BOARD.z0 - P && wp.z < BOARD.z1 + P) {
      const g = snapGrid(wp.x, wp.z);
      const s = view.project({ x: g.x, y: -BEAM_W / 2, z: g.z });
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d < 16) return { t: 'board', x: g.x, z: g.z, layer: 0, d };
    }
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
const ghostLineMat = new THREE.LineDashedMaterial({ color: 0xf2b51c, dashSize: 3, gapSize: 2, depthTest: false });

function clearGhost() { ghost.clear(); }
function ring(x, y, z, scale = 1) {
  const m = new THREE.Mesh(ringGeo, ringMat);
  m.position.set(x, y, z);
  m.scale.setScalar(scale);
  m.renderOrder = 10;
  ghost.add(m);
}
let ghostLabels = [];
function showGhostLabels(items) { ghostLabels = items; }

function updateGhost(sx, sy) {
  clearGhost();
  ghostLabels = [];
  if (S.mode === 'run') return;
  const tool = S.tool;
  if (tool === 'beam') {
    if (!S.draw) {
      const h = hoverTarget(sx, sy);
      S.hover = h;
      if (h) ring(h.x, layerY(h.layer) - BEAM_W / 2 - 0.4, h.z);
    } else {
      const end = beamEndFor(sx, sy);
      S.draw.end = end;
      if (end) {
        const len = end.n * P;
        const g = view.beamGeometry(end.n + 1);
        const mesh = new THREE.Mesh(g, ghostBeamMat);
        mesh.position.set(S.draw.start.x, layerY(S.draw.layer), S.draw.start.z);
        mesh.rotation.y = -rad(end.angle);
        ghost.add(mesh);
        ring(end.x, layerY(S.draw.layer) - BEAM_W / 2 - 0.4, end.z, end.snapped ? 1.2 : 0.9);
        const a = ((end.angle % 360) + 360) % 360;
        ghostLabels.push({ text: `${end.n + 1} fori · ${fmt(a > 180 ? a - 360 : a, 0)}°${end.snapped ? ' · aggancio' : ''}`, pos: [S.draw.start.x + (len / 2) * Math.cos(rad(end.angle)), layerY(S.draw.layer) - 6, S.draw.start.z + (len / 2) * Math.sin(rad(end.angle))], cls: 'ghost' });
      }
    }
  } else if (tool === 'pin' || tool === 'pulley' || tool === 'winch') {
    const h = hoverTarget(sx, sy);
    S.hover = h;
    if (h) {
      ring(h.x, layerY(h.layer) - BEAM_W / 2 - 0.4, h.z);
      if (tool !== 'pin') {
        const r = tool === 'winch' ? 8 : 6;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, BEAM_W - 1, 28), ghostBeamMat);
        c.position.set(h.x, layerY(h.layer + 1), h.z);
        ghost.add(c);
      } else {
        const ex = pinAt(S.doc, h.x, h.z, h.layer);
        if (ex) ghostLabels.push({ text: `${PIN_LABEL[ex.type]} → ${PIN_LABEL[nextPinType(ex.type)]}`, pos: [h.x, layerY(h.layer) - 8, h.z + 6], cls: 'ghost' });
      }
    }
  } else if (tool === 'string') {
    const h = hoverTarget(sx, sy, { wheels: true, guides: true });
    S.hover = h;
    const pts = [];
    if (S.stringDraft) for (const a of S.stringDraft.anchors) pts.push(anchorPoint(a));
    if (h) {
      const a = targetToAnchor(h);
      if (a) {
        const p = anchorPoint(a);
        pts.push(p);
        if (h.t === 'pulley' || h.t === 'winch') {
          const w = (h.t === 'pulley' ? S.doc.pulleys : S.doc.winches).find((e) => e.id === h.id);
          ring(w.x, layerY(w.layer) - BEAM_W / 2, w.z, (w.r + 1.5) / HOLE());
        } else if (h.t === 'guide') ring(h.x, layerY(h.layer) - BEAM_W / 2 - 0.4, h.z, 0.6);
        else ring(h.x, layerY(h.layer) - BEAM_W / 2 - 0.4, h.z);
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
  const st = S.draw.start;
  const wp = view.planePoint(sx, sy, layerY(S.draw.layer));
  if (!wp) return null;
  // snap to an existing hole at a whole number of pitches from the start
  const h = hoverTarget(sx, sy);
  if (h && !(Math.abs(h.x - st.x) < EPS && Math.abs(h.z - st.z) < EPS)) {
    const dist = Math.hypot(h.x - st.x, h.z - st.z);
    const n = Math.round(dist / P);
    if (n >= 1 && n <= 24 && Math.abs(dist - n * P) < 0.35) {
      return { x: h.x, z: h.z, n, angle: (Math.atan2(h.z - st.z, h.x - st.x) * 180) / Math.PI, snapped: h.t === 'hole' ? h : null };
    }
  }
  const dx = wp.x - st.x, dz = wp.z - st.z;
  const n = Math.max(1, Math.min(24, Math.round(Math.hypot(dx, dz) / P)));
  const angle = Math.round((Math.atan2(dz, dx) * 180) / Math.PI / 15) * 15;
  return { x: st.x + n * P * Math.cos(rad(angle)), z: st.z + n * P * Math.sin(rad(angle)), n, angle, snapped: null };
}

function anchorPoint(a) {
  const doc = S.doc;
  if (a.t === 'hole') { const p = doc.parts.find((e) => e.id === a.part); const h = holePos(p, a.i); return { x: h.x, y: layerY(p.layer), z: h.z }; }
  if (a.t === 'guide') return anchorPos(doc, a);
  if (a.t === 'board') return { x: a.x, y: -BEAM_W / 2, z: a.z };
  if (a.t === 'pulley') { const p = doc.pulleys.find((e) => e.id === a.id); return { x: p.x + a.sx * p.r, y: layerY(p.layer), z: p.z + a.sz * p.r }; }
  if (a.t === 'winch') { const w = doc.winches.find((e) => e.id === a.id); return { x: w.x, y: layerY(w.layer), z: w.z }; }
}

function targetToAnchor(h) {
  if (!h) return null;
  if (h.t === 'hole') return { t: 'hole', part: h.part.id, i: h.i };
  if (h.t === 'guide') return { t: 'guide', part: h.part.id, i: h.i, side: h.side };
  if (h.t === 'board') return { t: 'board', x: h.x, z: h.z };
  if (h.t === 'pulley') return { t: 'pulley', id: h.id, sx: h.sx, sz: h.sz };
  if (h.t === 'winch') return { t: 'winch', id: h.id };
  return null;
}

// ------------------------------------------------------------------ actions
const nextPinType = (t) => ({ hinge: 'weld', weld: 'servo', servo: 'hinge' }[t]);
const layerColor = (L) => BEAM_COLORS[(L - 1) % BEAM_COLORS.length];

function ensurePin(x, z, lo, hi, type = 'hinge') {
  const ex = S.doc.pins.find((p) => Math.abs(p.x - x) < EPS && Math.abs(p.z - z) < EPS && p.hi >= lo - 1 && p.lo <= hi + 1);
  if (ex) { ex.lo = Math.min(ex.lo, lo); ex.hi = Math.max(ex.hi, hi); return ex; }
  const pin = { id: S.doc.nextId++, x, z, lo, hi, type };
  S.doc.pins.push(pin);
  return pin;
}

function clickBeam() {
  if (!S.draw) {
    const h = S.hover;
    if (!h) return;
    const base = h.layer;
    let layer = S.layerMode === 'auto' ? base + 1 : +S.layerMode;
    if (S.layerMode === 'auto' && h.t === 'board') layer = Math.max(1, topLayerAt(S.doc, h.x, h.z) + 1);
    S.draw = { start: { x: h.x, z: h.z, base: h.t === 'board' ? 0 : base, onPart: h.t === 'hole' }, layer };
    updateHint();
    return;
  }
  const end = S.draw.end;
  if (!end) return;
  pushUndo();
  const st = S.draw.start;
  const part = { id: S.doc.nextId++, type: 'beam', x: st.x, z: st.z, angle: +end.angle.toFixed(4), holes: end.n + 1, layer: S.draw.layer, color: layerColor(S.draw.layer) };
  S.doc.parts.push(part);
  // pin at the start: joins the new beam to whatever it was started from
  if (S.draw.layer !== st.base) ensurePin(st.x, st.z, Math.min(st.base, S.draw.layer), Math.max(st.base, S.draw.layer), 'hinge');
  // pin at the end if it landed on another beam's hole
  if (end.snapped && end.snapped.t === 'hole' && end.snapped.layer !== part.layer) {
    ensurePin(end.x, end.z, Math.min(end.snapped.layer, part.layer), Math.max(end.snapped.layer, part.layer), 'hinge');
  }
  commit();
  // keep drawing: the next beam starts from this one's end, one layer forward
  const nextLayer = S.layerMode === 'auto' ? part.layer + 1 : part.layer;
  S.draw = { start: { x: end.x, z: end.z, base: part.layer, onPart: true }, layer: nextLayer };
  if (end.snapped) S.draw = null; // closed a loop: stop chaining
  updateHint();
}

function clickPin() {
  const h = S.hover;
  if (!h) return;
  pushUndo();
  const ex = pinAt(S.doc, h.x, h.z, h.layer);
  if (ex) {
    ex.type = nextPinType(ex.type);
    toast(PIN_LABEL[ex.type]);
  } else {
    let lo = h.t === 'board' ? 0 : layerBehind(S.doc, h.x, h.z, h.layer);
    let hi = h.layer;
    if (h.t === 'board') hi = 1;
    if (lo < 0) { lo = h.layer; hi = h.layer + 1; }
    const pin = { id: S.doc.nextId++, x: h.x, z: h.z, lo, hi, type: S.pinType };
    S.doc.pins.push(pin);
  }
  commit();
}

function clickWheel(kind) {
  const h = S.hover;
  if (!h) return;
  pushUndo();
  const item = { id: S.doc.nextId++, x: h.x, z: h.z, layer: h.layer + 1, r: kind === 'winch' ? 8 : 6 };
  if (kind === 'winch') { item.fmax = 10; S.doc.winches.push(item); } else S.doc.pulleys.push(item);
  commit();
  if (kind === 'winch') toast('Verricello montato. Ora scegli Filo e parti da qui.');
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
  const last = list[list.length - 1];
  const again = a && sameAnchor(a, last);
  if (again && a.t === 'pulley') { list[list.length - 1] = a; return; } // clicked the same pulley: just change side
  if (a && !again) list.push(a);
  const finish = dbl || again || (a && a.t === 'winch' && list.length > 1);
  if (finish) finishString();
  updateHint();
}
function sameAnchor(a, b) {
  return a && b && a.t === b.t && (a.t === 'hole' ? a.part === b.part && a.i === b.i : a.t === 'guide' ? a.part === b.part && a.i === b.i && a.side === b.side : a.t === 'board' ? a.x === b.x && a.z === b.z : a.id === b.id);
}
function finishString() {
  const d = S.stringDraft;
  S.stringDraft = null;
  if (!d) return;
  while (d.anchors.length && d.anchors[d.anchors.length - 1].t === 'pulley') d.anchors.pop();
  if (d.anchors.length < 2) { toast('Un filo ha bisogno di almeno due punti.'); updateHint(); return; }
  pushUndo();
  const s = { id: S.doc.nextId++, kind: d.kind, anchors: d.anchors };
  if (d.kind === 'elastic') { s.stiffness = 60; s.pretension = 3; }
  S.doc.strings.push(s);
  S.selected = s.id;
  commit();
  updateHint();
}

function eraseAt(sx, sy) {
  const hit = view.pickObject(sx, sy);
  if (!hit) return;
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
    const p = f.obj;
    const mounted = (it) => it.layer === p.layer + 1 && holeIndexAt(p, it.x, it.z) >= 0;
    doc.pulleys = doc.pulleys.filter((it) => !mounted(it));
    doc.winches = doc.winches.filter((it) => !mounted(it));
  }
  doc[f.coll] = doc[f.coll].filter((e) => e.id !== id);
}

function cancelDrafts() {
  S.draw = null;
  S.stringDraft = null;
  clearGhost();
  updateHint();
}

// ------------------------------------------------------------------ tools
function setTool(t, silent) {
  if (S.mode === 'run' && t !== 'select') return;
  if (S.tool === 'string' && S.stringDraft && t !== 'string') finishString();
  S.tool = t;
  S.draw = null;
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
  const seg = (label, opts, cur, onPick) => {
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = label; el.appendChild(l);
    for (const [v, txt] of opts) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.className = cur === v ? 'on' : '';
      b.onclick = () => { onPick(v); renderSubtools(); };
      el.appendChild(b);
    }
  };
  if (S.tool === 'pin') seg('Tipo', [['hinge', 'Liscio · ruota'], ['weld', 'A croce · bloccato'], ['servo', 'Servo · motore']], S.pinType, (v) => (S.pinType = v));
  else if (S.tool === 'string') seg('Tipo', [['string', 'Filo · non si allunga'], ['elastic', 'Elastico · richiama']], S.stringKind, (v) => { S.stringKind = v; if (S.stringDraft) S.stringDraft.kind = v; });
  else if (S.tool === 'beam') seg('Strato', [['auto', 'Automatico'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], S.layerMode, (v) => (S.layerMode = v));
  el.hidden = !el.children.length;
}

// ------------------------------------------------------------------ pointer input
const canvas = view.renderer.domElement;
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.offsetX, y: e.offsetY, b: e.button, t: performance.now() };
  if (e.button !== 0) return;
  // left drag on empty space orbits when nothing else wants it
  const hit = S.tool === 'select' ? view.pickObject(e.offsetX, e.offsetY) : null;
  if (S.mode === 'run' && hit && hit.kind === 'part' && hit.point) {
    const pose = S.sim.bodyPose(hit.id);
    const q = new THREE.Quaternion(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
    const pm = hit.point.clone().multiplyScalar(0.001);
    const local = pm.clone().sub(new THREE.Vector3(...pose.pos)).applyQuaternion(q.invert());
    S.drag = { partId: hit.id, local, target: pm.clone(), planeY: hit.point.y };
    view.controls.mouseButtons.LEFT = null;
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  view.controls.mouseButtons.LEFT = S.tool === 'select' && !hit ? THREE.MOUSE.ROTATE : null;
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (S.drag) {
    const wp = view.planePoint(e.offsetX, e.offsetY, S.drag.planeY);
    if (wp) S.drag.target.copy(wp.multiplyScalar(0.001));
    return;
  }
  if (down && (e.buttons & 6)) return; // orbiting / panning
  updateGhost(e.offsetX, e.offsetY);
});

canvas.addEventListener('pointerup', (e) => {
  if (S.drag) { S.drag = null; S.sim?.clearForces(); canvas.releasePointerCapture(e.pointerId); return; }
  if (!down) return;
  const moved = Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5;
  const b = down.b;
  down = null;
  if (moved) return;
  if (b === 2) { // right click without drag: step back
    if (S.draw) { S.draw = null; clearGhost(); updateHint(); }
    else if (S.stringDraft) finishString();
    return;
  }
  if (b !== 0) return;
  onClick(e.offsetX, e.offsetY, e.detail >= 2);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerleave', () => { if (!S.draw && !S.stringDraft) clearGhost(); setHover(null); });

function onClick(sx, sy, dbl) {
  if (S.mode === 'run') return;
  updateGhost(sx, sy);
  switch (S.tool) {
    case 'beam': clickBeam(); break;
    case 'pin': clickPin(); break;
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
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') {
    if (S.stringDraft) { S.stringDraft = null; clearGhost(); updateHint(); }
    else if (S.draw) { S.draw = null; clearGhost(); updateHint(); }
    else select(null);
    return;
  }
  if (k === 'enter' && S.stringDraft) { finishString(); return; }
  if (k === ' ') { e.preventDefault(); startSim(); return; }
  if (k === 's') { toggleSchema(); return; }
  if ((k === 'delete' || k === 'backspace') && S.selected !== null && S.mode === 'edit') { pushUndo(); removeObject(S.selected); S.selected = null; commit(); return; }
  const map = { v: 'select', b: 'beam', p: 'pin', u: 'pulley', f: 'string', w: 'winch', x: 'erase' };
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

function renderControls() {
  const el = $('controls');
  el.innerHTML = '';
  const doc = S.doc;
  const items = [];
  for (const w of doc.winches) {
    const list = winchStrings(w);
    if (!list.length) continue;
    const lens = list.filter((x) => x.wind === 1).map((x) => (S.preview?.lengths?.[x.s.id] ?? S.sim?.lengths?.[x.s.id] ?? 0.1) * 1000);
    const max = Math.max(10, Math.floor(Math.min(...(lens.length ? lens : [60])) * 0.8));
    items.push({ kind: 'winch', w, list, max });
  }
  for (const pin of doc.pins) if (pin.type === 'servo') items.push({ kind: 'servo', pin });
  if (!items.length) {
    el.innerHTML = '<p class="empty">Qui compaiono gli slider dei motori. Monta un <b>verricello</b> e fai partire un filo da lì, oppure metti un perno <b>servo</b>.</p>';
    return;
  }
  let nw = 0, ns = 0;
  for (const it of items) {
    const box = document.createElement('div');
    box.className = 'ctl';
    if (it.kind === 'winch') {
      const id = `ctl_w${it.w.id}`;
      const v = S.controls.winch[it.w.id] ?? 0;
      const rows = it.list.map(({ s, wind }) => `<div class="strrow" data-sid="${s.id}">
          <span class="sname"><span class="wind">${wind === 1 ? '⟲ avvolge' : '⟳ svolge'}</span> ${escapeHtml(s.name || 'Filo')}</span><span class="val" data-t>—</span>
          <div class="meter" data-m><i></i></div></div>`).join('');
      box.innerHTML = `<div class="row"><label class="name" for="${id}">Verricello ${++nw}</label><span class="val" data-v>gira ${fmt(v, 0)} mm</span></div>
        <input type="range" id="${id}" min="0" max="${it.max}" step="0.5" value="${v}">
        ${rows}
        <div class="row"><span class="val muted">forza max per filo</span><span class="val">${fmt(it.w.fmax ?? 10, 0)} N</span></div>
        <div class="note" data-n hidden></div>`;
      const r = box.querySelector('input');
      r.oninput = () => { S.controls.winch[it.w.id] = +r.value; box.querySelector('[data-v]').textContent = `gira ${fmt(+r.value, 0)} mm`; S.sim?.setControls(S.controls); markDirty(); };
      box.dataset.winch = it.w.id;
    } else {
      const id = `ctl_p${it.pin.id}`;
      const v = S.controls.servo[it.pin.id] ?? 0;
      box.innerHTML = `<div class="row"><label class="name" for="${id}">Servo ${++ns}</label><span class="val" data-v>${fmt(v, 0)}°</span></div>
        <input type="range" id="${id}" min="-150" max="150" step="1" value="${v}">
        <div class="row"><span class="val" data-t>coppia —</span><span class="val">max ${fmt((it.pin.tmax ?? 0.2) * 100, 0)} N·cm</span></div>
        <div class="meter" data-m><i></i></div><div class="note" data-n hidden></div>`;
      const r = box.querySelector('input');
      r.oninput = () => { S.controls.servo[it.pin.id] = +r.value; box.querySelector('[data-v]').textContent = `${fmt(+r.value, 0)}°`; S.sim?.setControls(S.controls); markDirty(); };
      box.dataset.pin = it.pin.id;
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
      const max = w?.fmax ?? 10;
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
      const pin = S.doc.pins.find((x) => x.id === pid);
      const val = Math.abs(sim.servoTorque(pid)), max = pin?.tmax ?? 0.2;
      box.querySelector('[data-t]').textContent = `coppia ${fmt(val * 100, 1)} N·cm`;
      const m = box.querySelector('[data-m]');
      m.querySelector('i').style.width = Math.min(100, (val / max) * 100) + '%';
      m.classList.toggle('hot', val >= max * 0.98);
      if (val >= max * 0.98) note = 'Il servo è al limite di coppia.';
    }
    const n = box.querySelector('[data-n]');
    n.hidden = !note;
    n.textContent = note;
  }
}

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
  const delBtn = () => {
    const b = add(`<button class="danger" ${editable ? '' : 'disabled'}>Elimina</button>`);
    b.onclick = () => { pushUndo(); removeObject(o.id); S.selected = null; commit(); };
  };
  if (f.coll === 'parts') {
    $('inspTitle').textContent = 'Trave';
    add(`<div class="prop"><label>Fori</label><span class="num">${o.holes} · ${fmt((o.holes - 1) * P + BEAM_W, 1)} mm</span></div>`);
    numProp('Lunghezza (fori)', o.holes, 2, 25, 1, (v) => (o.holes = v));
    numProp('Angolo', +(+o.angle).toFixed(1), -180, 180, 15, (v) => (o.angle = v), '°');
    numProp('Strato', o.layer, 1, 12, 1, (v) => (o.layer = v));
    const sw = add('<div class="swatches"></div>');
    for (const c of BEAM_COLORS) {
      const b = document.createElement('button');
      b.style.background = c; b.className = o.color === c ? 'on' : ''; b.title = 'Colore'; b.setAttribute('aria-label', 'Colore ' + c);
      b.disabled = !editable;
      b.onclick = () => { pushUndo(); o.color = c; commit(); };
      sw.appendChild(b);
    }
    delBtn();
  } else if (f.coll === 'pins') {
    $('inspTitle').textContent = PIN_LABEL[o.type];
    const seg = add('<div class="seg"></div>');
    for (const t of ['hinge', 'weld', 'servo']) {
      const b = document.createElement('button');
      b.textContent = PIN_LABEL[t]; b.className = o.type === t ? 'on' : ''; b.disabled = !editable;
      b.onclick = () => { pushUndo(); o.type = t; commit(); };
      seg.appendChild(b);
    }
    const mem = pinMembers(S.doc, o);
    add(`<p class="empty">Unisce ${mem.length} ${mem.length === 1 ? 'pezzo' : 'pezzi'} (strati ${o.lo}–${o.hi})${mem.some((m) => m.kind === 'board') ? ', tavola compresa' : ''}.</p>`);
    if (o.type !== 'weld') {
      const lim = add(`<label class="prop"><span>Giro completo libero</span><input type="checkbox" ${o.free ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>`);
      lim.querySelector('input').onchange = (e) => { pushUndo(); if (e.target.checked) o.free = true; else delete o.free; commit(); };
      if (!o.free) {
        const r = o.range || [-170, 170];
        numProp('Ruota da', r[0], -180, 0, 5, (v) => (o.range = [v, (o.range || r)[1]]), '°');
        numProp('fino a', r[1], 0, 180, 5, (v) => (o.range = [(o.range || r)[0], v]), '°');
      }
    }
    if (o.type === 'servo') numProp('Coppia max', +((o.tmax ?? 0.2) * 100).toFixed(1), 1, 500, 1, (v) => (o.tmax = v / 100), 'N·cm');
    if (S.mode === 'run' && S.sim) {
      const a = S.sim.pinAngle(o.id);
      if (a !== null) add(`<div class="prop"><label>Angolo adesso</label><span class="num">${fmt(a, 1)}°</span></div>`);
    }
    delBtn();
  } else if (f.coll === 'pulleys') {
    $('inspTitle').textContent = 'Puleggia';
    numProp('Raggio', o.r, 3, 24, 1, (v) => (o.r = v), 'mm');
    add('<p class="empty">Il braccio di leva del filo attorno al perno è circa uguale al raggio: più grande, più coppia con la stessa forza.</p>');
    delBtn();
  } else if (f.coll === 'winches') {
    $('inspTitle').textContent = 'Verricello';
    numProp('Forza max', o.fmax ?? 10, 0.5, 200, 0.5, (v) => (o.fmax = v), 'N');
    delBtn();
  } else if (f.coll === 'strings') {
    $('inspTitle').textContent = STRING_LABEL[o.kind];
    const nm = add(`<div class="prop"><label for="strName">Nome</label><input id="strName" value="${escapeHtml(o.name || '')}" placeholder="es. Flessore" style="width:150px;padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--raised)" ${editable ? '' : 'disabled'}></div>`);
    nm.querySelector('input').onchange = (e) => { pushUndo(); o.name = e.target.value.slice(0, 40); commit(); };
    const seg = add('<div class="seg"></div>');
    for (const t of ['string', 'elastic']) {
      const b = document.createElement('button');
      b.textContent = STRING_LABEL[t]; b.className = o.kind === t ? 'on' : ''; b.disabled = !editable;
      b.onclick = () => { pushUndo(); o.kind = t; if (t === 'elastic') { o.stiffness ??= 60; o.pretension ??= 3; } commit(); };
      seg.appendChild(b);
    }
    add(`<div class="prop"><label>Passa per</label><span class="num">${o.anchors.length} punti</span></div>`);
    const onWinch = o.anchors[0]?.t === 'winch' || o.anchors[o.anchors.length - 1]?.t === 'winch';
    if (onWinch) {
      add('<p class="empty">Sul tamburo del verricello questo filo:</p>');
      const seg = add('<div class="seg"></div>');
      for (const [v, txt] of [[1, '⟲ si avvolge (tira)'], [-1, '⟳ si svolge (rilascia)']]) {
        const b = document.createElement('button');
        b.textContent = txt; b.className = (o.wind === -1 ? -1 : 1) === v ? 'on' : ''; b.disabled = !editable;
        b.onclick = () => { pushUndo(); if (v === -1) o.wind = -1; else delete o.wind; commit(); };
        seg.appendChild(b);
      }
      add('<p class="empty">Due fili sullo stesso verricello, uno che si avvolge e uno che si svolge, lavorano come una cinghia: uno chiude, l\'altro riapre.</p>');
    }
    if (o.kind === 'elastic') {
      numProp('Rigidezza', o.stiffness ?? 60, 1, 5000, 5, (v) => (o.stiffness = v), 'N/m');
      numProp('Precarico', o.pretension ?? 3, 0, 50, 0.5, (v) => (o.pretension = v), 'mm');
    } else if (!onWinch) {
      numProp('Rigidezza (0 = non si allunga)', o.stiffness ?? 0, 0, 100000, 100, (v) => { if (v > 0) o.stiffness = v; else delete o.stiffness; }, 'N/m');
    }
    const sim = S.mode === 'run' ? S.sim : S.preview;
    if (sim) add(`<div class="prop"><label>Lunghezza</label><span class="num">${fmt(sim.tendonLength(o.id) * 1000, 1)} mm</span></div>`);
    if (S.mode === 'run' && S.sim) add(`<div class="prop"><label>Tensione</label><span class="num">${fmt(S.sim.tension(o.id), 2)} N</span></div>`);
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
$('wEmpty').onclick = () => { $('welcome').hidden = true; setTool('beam'); };
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
  setTool('beam');
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
