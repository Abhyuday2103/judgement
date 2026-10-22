// Stand-in for Firebase callable functions: the call goes to the host's browser (or runs here if we host).
import { call } from './core.js';
export const getFunctions = () => ({});
export const connectFunctionsEmulator = () => {};
export function httpsCallable(_fns, _name, opts = {}) {
  return async (data) => {
    try { return { data: await call(data) }; }
    catch (e) { const err = new Error((e && e.message) || 'Request failed'); err.code = 'functions/failed-precondition'; throw err; }
  };
}
