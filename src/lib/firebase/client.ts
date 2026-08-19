"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onIdTokenChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

function getClientApp(): FirebaseApp {
  if (getApps().length > 0) return getApp();
  return initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  });
}

export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}

export function signInWithGoogle() {
  return signInWithPopup(getClientAuth(), new GoogleAuthProvider());
}

export function signOutUser() {
  return signOut(getClientAuth());
}

export function subscribeToUser(callback: (user: User | null) => void) {
  return onIdTokenChanged(getClientAuth(), callback);
}

/**
 * Fetch wrapper that attaches the current Firebase ID token.
 *
 * Always reads the token fresh from the SDK rather than caching it: Firebase
 * rotates ID tokens hourly, and a cached one produces intermittent 401s that
 * are painful to diagnose.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const user = getClientAuth().currentUser;
  const headers = new Headers(init.headers);

  if (user) {
    headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
  }

  return fetch(input, { ...init, headers });
}
