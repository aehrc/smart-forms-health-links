import type { SmartSession } from '@/auth/smartSession';

/**
 * The one place a SMART access token is allowed to leave the browser.
 *
 * This app is two halves with opposite trust postures, and the whole design rests on keeping them
 * apart. The requester half talks to an EHR and may hold credentials. The filler half — someone on
 * another device holding nothing but a link — has none by construction, which is the second claim the
 * README makes for the design. So authentication is opt-in per call site, not ambient: the forms
 * catalogue, the blob host and the one-shot write slot each keep their own plain `fetch`, and must.
 *
 * See `docs/smart-app-launch.md` for the boundary in full.
 */

/**
 * Whether a URL belongs to the launched server, and may therefore be shown the token.
 *
 * Origin, not prefix. A prefix test on the base URL would accept
 * `https://ehr.example.org.attacker.test/fhir`, and comparing whole base paths would reject the
 * server's own absolute `Location` and pagination links, which are legitimate and common. Origin is
 * the boundary the token is actually scoped to.
 *
 * Both sides must be absolute. A relative URL is not resolved against the page origin, and is treated
 * as no match: everything reaching this function is built as `${serverUrl}/…`, so a relative one is
 * either a bug or a call that was never meant for the EHR. The cost of being wrong is an
 * unauthenticated request the caller already handles; the cost of resolving it optimistically would be
 * the token. Not touching `window` also keeps this testable outside a browser, which is where the
 * check that proves the negative cases actually runs.
 */
export function isLaunchedServer(url: string, serverUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/**
 * `fetch`, with the session's bearer token attached **only** when the target is the launched server.
 *
 * The gate is origin, not "is there a session", and the difference is a real vulnerability rather than
 * tidiness. `resolveDestinations` in `src/fhir/submit.ts` reads write targets from a downloaded
 * Questionnaire's `sdc-questionnaire-endpoint` extension, and those outrank configuration — so a
 * Questionnaire fetched from a public catalogue can name any server on the internet as the place its
 * responses go. Attaching the token to whatever that returns would hand an EHR access token to a host
 * chosen by whoever authored the form.
 *
 * With no session, or a target that is not the launched server, this is exactly `fetch`. That is the
 * app's original behaviour and it stays the default: a launch is optional here.
 *
 * An explicit `Authorization` in `init` is never overwritten. `src/link/writeSlot.ts` sets its own
 * one-shot write token, which is a different capability with a different meaning, and silently
 * replacing it would break the channel-D contract.
 */
export async function authedFetch(
  url: string,
  init: RequestInit | undefined,
  session: SmartSession | null
): Promise<Response> {
  if (!session || !isLaunchedServer(url, session.serverUrl)) {
    return fetch(url, init);
  }

  const headers = new Headers(init?.headers);
  if (headers.has('Authorization')) {
    return fetch(url, init);
  }

  const authorization = await session.authorizationHeader();
  if (!authorization) {
    return fetch(url, init);
  }

  headers.set('Authorization', authorization);
  return fetch(url, { ...init, headers });
}
