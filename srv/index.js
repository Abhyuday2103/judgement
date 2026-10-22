// Judgment online tables. Same Firebase project as Teen Patti and Declare, but its own
// function (jg), its own codebase (judgment) and its own collection (jtables), so deploying
// one game never touches the others.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { makeServer } from './server.js';

initializeApp();
const server = makeServer(getFirestore(), { stamp: () => FieldValue.serverTimestamp() });

export const jg = onCall({ cors: true, maxInstances: 10 }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  try {
    return await server.handle(uid, req.data || {});
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('failed-precondition', (e && e.message) || 'Something went wrong');
  }
});
