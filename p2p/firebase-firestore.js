// Stand-in for the bits of Firestore the game pages use, backed by the host's in-memory table.
import { watch, read, write, hydrate, TS_SENTINEL } from './core.js';
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const connectFirestoreEmulator = () => {};
export const serverTimestamp = () => ({ [TS_SENTINEL]: true });
const join = (segs) => segs.map(String).join('/');
export const doc = (_db, ...segs) => ({ type: 'doc', path: join(segs), id: String(segs[segs.length - 1]) });
export const collection = (_db, ...segs) => ({ type: 'col', path: join(segs), id: String(segs[segs.length - 1]) });
const docSnap = (ref, v) => ({ id: ref.id, ref, exists: () => v !== undefined && v !== null, data: () => (v == null ? undefined : hydrate(v)) });
const colSnap = (ref, list) => {
  const docs = (list || []).map((d) => docSnap({ type: 'doc', path: ref.path + '/' + d.id, id: d.id }, d.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
};
export function onSnapshot(ref, next, error) {
  try {
    return watch(ref.path, ref.type, (v) => { try { next(ref.type === 'col' ? colSnap(ref, v) : docSnap(ref, v)); } catch (e) { console.error(e); } });
  } catch (e) { if (error) error(e); return () => {}; }
}
export async function getDoc(ref) { return docSnap(ref, await read(ref.path, 'doc')); }
export const getDocFromServer = getDoc;
export async function getDocs(ref) { return colSnap(ref, await read(ref.path, 'col')); }
export async function setDoc(ref, data) { await write(ref.path, data); }
