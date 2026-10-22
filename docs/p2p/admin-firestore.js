// Stand-in for firebase-admin/firestore, backed by the host's in-memory table.
import { mem, hydrate, TS_SENTINEL } from './core.js';
export const FieldValue = { serverTimestamp: () => ({ [TS_SENTINEL]: true }) };
export const Timestamp = { now: () => hydrate({ __ts: Date.now() }), fromMillis: (ms) => hydrate({ __ts: ms }) };
class DocRef {
  constructor(path) { this.path = path; this.id = path.split('/').pop(); }
  collection(n) { return new ColRef(this.path + '/' + n); }
  async get() { return snapOf(this, mem.get(this.path)); }
  async set(data) { mem.set(this.path, data); }
}
class ColRef {
  constructor(path) { this.path = path; this.id = path.split('/').pop(); }
  doc(id) { return new DocRef(this.path + '/' + (id || Math.random().toString(36).slice(2, 12))); }
  async get() { return qsnap(this, mem.list(this.path)); }
}
const snapOf = (ref, v) => ({ id: ref.id, ref, exists: v !== undefined && v !== null, data: () => (v == null ? undefined : hydrate(v)) });
const qsnap = (ref, list) => {
  const docs = list.map((d) => snapOf(new DocRef(ref.path + '/' + d.id), d.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
};
const db = {
  collection: (n) => new ColRef(n),
  doc: (p) => new DocRef(p),
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data) => { writes.push([ref.path, data]); return tx; },
      update: (ref, data) => { writes.push([ref.path, { ...(mem.get(ref.path) || {}), ...data }]); return tx; },
      create: (ref, data) => { writes.push([ref.path, data]); return tx; },
    };
    const out = await fn(tx);
    for (const [p, d] of writes) mem.set(p, d);
    return out;
  },
};
export const getFirestore = () => db;
