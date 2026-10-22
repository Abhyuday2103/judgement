// Stand-in for Firebase callable functions: cloud server first, the host's browser if the cloud is down.
import { call } from './hybrid.js';
export const getFunctions = () => ({});
export const connectFunctionsEmulator = () => {};
export function httpsCallable() {
  return async (data) => {
    try { return { data: await call(data) }; }
    catch (e) { const err = new Error((e && e.message) || 'Request failed'); err.code = 'functions/failed-precondition'; throw err; }
  };
}
