// Stand-in for firebase-functions/v2/https so the game's server file runs unchanged in the host's browser.
export function onCall(opts, fn) { return typeof opts === 'function' ? opts : fn; }
export class HttpsError extends Error { constructor(code, message) { super(message || code); this.code = code; } }
export const onRequest = () => () => {};
