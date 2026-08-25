/**
 * Where to go back to once a launch completes.
 *
 * A launch started from a gated screen should come back to that screen, not to the home page — being
 * returned to the catalogue after signing in to send one particular form is the kind of small
 * discourtesy that makes a gate feel like a wall.
 *
 * It cannot ride through the OAuth flow. `redirectUri` in `smartSession.ts` strips the query and the
 * fragment on purpose, so a redirect target cannot smuggle either back into the exchange, and
 * `redirect_uri` must in any case match what is registered with the authorisation server exactly. So
 * the path travels out of band, in storage this tab already owns.
 */

/**
 * `sessionStorage`, matching the token's lifetime rather than the reply keys'.
 *
 * The same split `smartSession.ts` documents: an intended route belongs to one launch in one tab, and
 * outliving that is not a feature. `localStorage` holds channel-C reply keys, which must survive a tab
 * closing — the opposite lifetime.
 */
const RETURN_PATH_KEY = 'SHL_LAUNCH_RETURN';

/**
 * A stored value narrowed to somewhere this app may actually navigate, or `/` when it is not.
 *
 * Free of `window` so `check:roundtrip` can reach it, which is the same reason `scopes.ts` is kept
 * clear of `fhirclient`: the validation is the part worth asserting, and the storage around it is four
 * lines of wrapper.
 *
 * The `//` case is the one worth naming. `//evil.example/x` is a valid *protocol-relative URL*, so
 * handing it to `navigate` leaves the site entirely. Nothing writes this key but
 * {@link rememberReturnPath} and it is validated anyway — the cost is one comparison, and the
 * alternative is that some future writer of this key turns a convenience into an open redirect.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }

  return value;
}

/** Remember where to come back to. A path only — `/request/abc?x=1`, never an absolute URL. */
export function rememberReturnPath(path: string): void {
  if (safeReturnPath(path) !== path) {
    return;
  }

  try {
    window.sessionStorage.setItem(RETURN_PATH_KEY, path);
  } catch {
    // Storage can be full or blocked. Losing the return path costs one extra click, which is not
    // worth failing a launch over.
  }
}

/**
 * The remembered path, consumed. Defaults to `/`, which is where the callback always used to go.
 *
 * Read-and-clear rather than read: a stale target left behind would send the *next* launch in this tab
 * to wherever the last one happened to start from.
 */
export function takeReturnPath(): string {
  try {
    const stored = window.sessionStorage.getItem(RETURN_PATH_KEY);
    window.sessionStorage.removeItem(RETURN_PATH_KEY);
    return safeReturnPath(stored);
  } catch {
    return '/';
  }
}
