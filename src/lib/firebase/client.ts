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

/**
 * Whether the browser bundle has Firebase credentials.
 *
 * Auth is optional: planning a date works signed-out, and a local clone with no
 * Firebase project should still run. Anything that touches the SDK has to check
 * this first, because initializeApp() with an undefined apiKey throws.
 */
export function isFirebaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  );
}

function getClientApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase is not configured in this environment.");
  }
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
 * Fetch wrapper that attaches the current Firebase ID token when there is one.
 *
 * Degrades to a plain fetch when Firebase is unconfigured or no user is signed
 * in, because every read endpoint serves anonymous callers. Failing to get a
 * token must never turn into a failed request - that turns "not signed in"
 * into what looks like a network outage.
 *
 * Always reads the token fresh from the SDK rather than caching it: Firebase
 * rotates ID tokens hourly, and a cached one produces intermittent 401s that
 * are painful to diagnose.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  if (isFirebaseConfigured()) {
    try {
      const user = getClientAuth().currentUser;
      if (user) {
        headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
      }
    } catch (error) {
      console.warn("[auth] could not attach ID token; continuing anonymously", error);
    }
  }

  return fetch(input, { ...init, headers });
}

/**
 * Like `authedFetch`, but first exchanges the current Firebase ID token for a
 * short-lived, scoped app token (`POST /api/auth/token`) and attaches it as
 * `X-App-Token`. Use this for routes that require one - currently just
 * reviews submission. Throws if the caller isn't signed in, since these
 * scopes are never valid for anonymous requests.
 */
export async function scopedAuthedFetch(
  input: RequestInfo | URL,
  scope: "reviews:write",
  init: RequestInit = {},
) {
  const user = getClientAuth().currentUser;
  if (!user) {
    throw new Error("Sign in required for this action.");
  }

  const idToken = await user.getIdToken();
  const tokenResponse = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ scope }),
  });
  if (!tokenResponse.ok) {
    throw new Error("Could not authorize this action.");
  }
  const { token: appToken } = (await tokenResponse.json()) as { token: string };

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${idToken}`);
  headers.set("X-App-Token", appToken);

  return fetch(input, { ...init, headers });
}
