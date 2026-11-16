// A page opened while signed out (e.g. a «Tayyor» notification after the session
// expired) is remembered and opened right after the PIN / password sign-in.
const KEY = 'ff-after-login';
// Only this application's own pages are remembered.
const allowed = /^\/(ofitsiant|kassa|buyurtmalar)(\/|\?|$)/;

export function rememberTarget(path: string) {
  try {
    if (allowed.test(path)) sessionStorage.setItem(KEY, path);
  } catch {
    /* storage blocked: the user lands on the start page */
  }
}

/** The remembered page (once), or null. */
export function takeTarget(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path && allowed.test(path) ? path : null;
  } catch {
    return null;
  }
}
