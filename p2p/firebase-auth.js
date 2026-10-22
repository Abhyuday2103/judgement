// Stand-in for Firebase anonymous sign-in. Each browser keeps one id, so a refresh keeps your seat.
import { uid } from './core.js';
const auth = { currentUser: { uid, isAnonymous: true }, authStateReady: async () => {} };
export const getAuth = () => auth;
export const signInAnonymously = async () => ({ user: auth.currentUser });
export const connectAuthEmulator = () => {};
