// Project storage: the page's server-side database when running as a claude.ai Artifact,
// otherwise this browser's localStorage. Same interface either way.

const LS_KEY = 'robotbuilder.projects.v1';
const LS_LAST = 'robotbuilder.last.v1';

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function lsWrite(all) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
}

export function lastProjectId() { try { return localStorage.getItem(LS_LAST); } catch { return null; } }
export function setLastProjectId(id) { try { localStorage.setItem(LS_LAST, id); } catch { /* ignore */ } }

class LocalStore {
  constructor() { this.where = 'Salvati solo in questo browser.'; this.remote = false; }
  async list() {
    return Object.entries(lsRead()).map(([id, p]) => ({ id, name: p.name, updatedAt: p.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async load(id) { const p = lsRead()[id]; return p ? { id, name: p.name, doc: p.doc } : null; }
  async save(id, name, doc) { const all = lsRead(); all[id] = { name, doc, updatedAt: Date.now() }; lsWrite(all); }
  async remove(id) { const all = lsRead(); delete all[id]; lsWrite(all); }
}

class RemoteStore {
  constructor(db, uid) {
    this.db = db; this.uid = uid; this.remote = true;
    this.where = 'Salvati sul server, legati al tuo account: li ritrovi da qualunque dispositivo.';
    this.local = new LocalStore();
  }
  col() { return this.db.collection('data/users/' + this.uid); }
  async list() {
    const snap = await withTimeout(this.col().get(), 10000);
    return snap.docs.map((d) => ({ id: d.id, name: d.data()?.name || 'Senza nome', updatedAt: d.data()?.updatedAt || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async load(id) {
    const s = await withTimeout(this.col().doc(id).get(), 10000);
    if (!s.exists) return this.local.load(id);
    const d = s.data();
    return { id, name: d.name, doc: JSON.parse(d.doc) };
  }
  async save(id, name, doc) {
    await this.local.save(id, name, doc); // local copy first, so nothing is lost if the network drops
    await withTimeout(this.col().doc(id).set({ name, doc: JSON.stringify(doc), updatedAt: Date.now() }), 15000);
  }
  async remove(id) { await this.local.remove(id); await this.col().doc(id).delete(); }
}

function withTimeout(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

export async function openStore() {
  const local = new LocalStore();
  const claude = window.claude;
  if (!claude?.use) return local;
  try {
    const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
    if (!db || !user) return local;
    const uid = await user.id();
    if (!uid) return local;
    return new RemoteStore(db, uid);
  } catch {
    return local;
  }
}

// Offer a file to the viewer: the artifact's downloads capability, or a plain link elsewhere.
export async function saveFile(filename, text, mime) {
  const claude = window.claude;
  if (claude?.use) {
    try {
      const dl = await claude.use('downloads');
      if (dl) { await dl.save({ filename, data: new Blob([text], { type: mime }) }); return true; }
    } catch (e) {
      if (e?.code === 'declined') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}
