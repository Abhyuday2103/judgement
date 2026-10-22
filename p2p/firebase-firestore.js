// Stand-in for the Firestore calls the game pages use. Each table lives either in the cloud
// (real Firestore) or on the host (core.js); this sends every read and write to the right one.
import { watch, read, write, hydrate, TS_SENTINEL } from './core.js';
import { sideOf, cloud } from './hybrid.js';
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const connectFirestoreEmulator = () => {};
export const serverTimestamp = () => ({ [TS_SENTINEL]: true });
export const doc = (_db, ...segs) => ({ type: 'doc', segs: segs.map(String), path: segs.join('/'), id: String(segs[segs.length - 1]) });
export const collection = (_db, ...segs) => ({ type: 'col', segs: segs.map(String), path: segs.join('/'), id: String(segs[segs.length - 1]) });
const real = (ref) => (ref.type === 'col' ? cloud.fsM.collection(cloud.db, ...ref.segs) : cloud.fsM.doc(cloud.db, ...ref.segs));
const onCloud = (ref) => cloud && sideOf(ref.path) === 'cloud';
const docSnap = (ref, v) => ({ id: ref.id, ref, exists: () => v !== undefined && v !== null, data: () => (v == null ? undefined : hydrate(v)) });
const colSnap = (ref, list) => {
  const docs = (list || []).map((d) => docSnap({ type: 'doc', path: ref.path + '/' + d.id, id: d.id }, d.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
};
export function onSnapshot(ref, next, error) {
  if (onCloud(ref)) return cloud.fsM.onSnapshot(real(ref), next, error);
  try {
    return watch(ref.path, ref.type, (v) => { try { next(ref.type === 'col' ? colSnap(ref, v) : docSnap(ref, v)); } catch (e) { console.error(e); } });
  } catch (e) { if (error) error(e); return () => {}; }
}
export async function getDoc(ref) {
  if (onCloud(ref)) return cloud.fsM.getDoc(real(ref));
  return docSnap(ref, await read(ref.path, 'doc'));
}
export async function getDocFromServer(ref) {
  if (onCloud(ref)) return cloud.fsM.getDocFromServer(real(ref));
  return docSnap(ref, await read(ref.path, 'doc'));
}
export async function getDocs(ref) {
  if (onCloud(ref)) return cloud.fsM.getDocs(real(ref));
  return colSnap(ref, await read(ref.path, 'col'));
}
export async function setDoc(ref, data) {
  if (onCloud(ref)) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) out[k] = v && v[TS_SENTINEL] ? cloud.fsM.serverTimestamp() : v;
    return cloud.fsM.setDoc(real(ref), out);
  }
  await write(ref.path, data);
}
