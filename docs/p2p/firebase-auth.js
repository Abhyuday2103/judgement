// Stand-in for Firebase anonymous sign-in. Uses the real Firebase id when the cloud is reachable,
// otherwise a saved id for this browser. Either way a refresh keeps your seat.
import * as core from './core.js';
import { getCloud } from './hybrid.js';
const auth = {
  get currentUser() { return { uid: core.uid, isAnonymous: true }; },
  authStateReady: async () => { await getCloud(); },
};
export const getAuth = () => auth;
export const signInAnonymously = async () => { await getCloud(); return { user: auth.currentUser }; };
export const connectAuthEmulator = () => {};
