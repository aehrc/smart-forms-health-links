/**
 * The one place a request is decided to be *the session's* rather than anonymous.
 *
 * This file used to be the one place a SMART access token was allowed to leave the browser. It no
 * longer is, because there is no longer a token in the browser to guard: the launch happens in the
 * BFF, the access token stays there, and the SPA holds an opaque `HttpOnly` cookie it cannot read
 * (FR-005). What survives is the *decision* the old file existed to make, and it still has to be
 * made per call site rather than ambiently.
 *
 * The app is still two halves with opposite trust postures, and that is still what the design
 * rests on. The requester half acts with a session's authority. The filler half - someone on
 * another device holding nothing but a link - has none by construction. So authentication stays
 * opt-in: the terminology server, a foreign write slot and a third party's manifest each keep
 * their own plain `fetch`, and must.
 *
 * What changed is where the boundary sits. It used to be *origin of the target server*, because
 * the risk was handing an EHR token to a host named by a downloaded Questionnaire. Now it is
 * whether the request is addressed to our own proxy*, because that is the only address the
 * session's authority can be spent at. A Questionnaire's `sdc-questionnaire-endpoint` extension
 * can still name any server on the internet, and that server is still reached by plain `fetch`
 * with no credentials - the same attack, refused for the same reason, one layer in.
 *
 * See `docs/smart-app-launch.md` for the boundary in full.
 */

import type { SmartSession } from "@/auth/smartSession";

import { FHIR_PROXY_BASE } from "@/lib/session";

/**
 * Whether a URL addresses this app's own FHIR proxy, and may therefore be sent with the session
 * cookie.
 *
 * Path *and* origin, which is a change from the origin-only test this replaces. Origin alone was
 * the right boundary when the credential was a bearer token scoped to one FHIR server; it is the
 * wrong one now, because the proxy shares an origin with the whole SPA and with `/config.json`.
 * Under the old test every same-origin request would have qualified.
 *
 * A relative URL is resolved against the page origin here, unlike the old absolute-only rule. That
 * is safe now and was not before: the resolved target must still sit under the proxy's own path
 * prefix, and the consequence of a match is a same-origin cookie the browser would have attached
 * to that URL anyway.
 * @param url the request target, absolute or relative
 * @param proxyBase the absolute URL of the FHIR proxy base
 * @returns true when the URL is inside the proxy
 * @example
 * isProxiedRequest("/api/fhir/Patient/123", "https://app.example.org/api/fhir"); // true
 */
export function isProxiedRequest(url: string, proxyBase: string): boolean {
  let target: URL;
  let base: URL;
  try {
    base = new URL(proxyBase);
    target = new URL(url, base);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) {
    return false;
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

/**
 * The absolute URL of this app's FHIR proxy base.
 *
 * Absolute because {@link SmartSession.serverUrl} is compared by origin in places that predate the
 * proxy, and because a caller building `${serverUrl}/Patient` must produce something `fetch` can
 * use from a worker as well as a document.
 * @returns the proxy base, resolved against the current origin
 */
export function proxyBaseUrl(): string {
  return new URL(FHIR_PROXY_BASE, globalThis.location.origin).href;
}

/**
 * `fetch`, sending the session cookie **only** when the target is this app's own proxy.
 *
 * With no session, or a target outside the proxy, this is exactly `fetch` with credentials
 * suppressed. That is the app's original anonymous behaviour and it stays the default for
 * everything the filler does.
 *
 * The `session` argument is still taken, and is still what makes this a decision rather than a
 * default, but it is now only consulted for *whether* there is a session - there is nothing in it
 * to attach. An explicit `Authorization` in `init` is passed through untouched:
 * `src/link/writeSlot.ts` sets a one-shot write token, which is a different capability with a
 * different meaning, and the proxy strips its own inbound `Authorization` regardless.
 * @param url the request target
 * @param init the request options, if any
 * @param session the launched session, or null when nobody is signed in
 * @returns the response, whatever it is; this function does not interpret status
 * @example
 * const response = await authedFetch(`${session.serverUrl}/Patient/123`, undefined, session);
 */
export async function authedFetch(
  url: string,
  init: RequestInit | undefined,
  session: SmartSession | null,
): Promise<Response> {
  if (session === null || !isProxiedRequest(url, session.serverUrl)) {
    // `omit` rather than the default, so a same-origin request that is *not* the proxy - the
    // config file, a manifest this deployment happens to host - does not carry the session cookie
    // to a route that has no business seeing it.
    return fetch(url, { ...init, credentials: "omit" });
  }

  return fetch(url, { ...init, credentials: "same-origin" });
}
