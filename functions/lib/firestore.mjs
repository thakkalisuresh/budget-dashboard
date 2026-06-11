/**
 * Firebase Admin / Firestore singleton.
 * In Cloud Functions the Admin SDK auto-discovers credentials, so
 * initializeApp() needs no arguments. getDb() is memoized across warm
 * invocations.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db = null;

export function getDb() {
  if (!db) {
    if (getApps().length === 0) initializeApp();
    db = getFirestore();
  }
  return db;
}
