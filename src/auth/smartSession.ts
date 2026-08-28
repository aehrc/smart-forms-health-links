import FHIR from 'fhirclient';
import type Client from 'fhirclient/lib/Client';
import type { AppConfig } from '@/lib/config';
import { nominatedWriteSlotFrom, type NominatedWriteSlot } from './nominatedSlot';
import { buildScopes } from './scopes';

/**
 * SMART App Launch — the OAuth half, and the only module that knows `fhirclient` exists.
 *
 * The library runs the flow and holds the launch context. It deliberately does **not** carry the FHIR
 * traffic: `client.request()` would replace the five hand-written `fetchFhir` helpers, each of which
 * carries behaviour that is load-bearing and easy to lose — `Cache-Control: no-cache` revalidation
 * against the caching proxy (`src/fhir/ehrServer.ts`), `If-Match` on a one-shot slot
 * (`src/link/writeSlot.ts`), and reading created ids from the response *body* because the servers
 * report unusable `Location` headers (`src/fhir/blobStore.ts`). So this file yields a bearer token and
 * a server URL, and `src/fhir/authedFetch.ts` decides where they may be sent.
 *
 * A session is optional at this layer, and stays so on purpose. Reading the EHR works without one, and
 * the filler's half of the app has no account to log into at all — someone holding nothing but a link
 * never will. So every consumer here takes `SmartSession | null` and has to mean something sensible for
 * `null`; the refusal to *write* without one lives a layer up, at the requester's own call sites. See
 * `canWriteToRecord` in `src/lib/config.ts` for why it is there and not here.
 */

export type { NominatedWriteSlot } from './nominatedSlot';

/**
 * What the rest of the app is allowed to know about a launch.
 *
 * Narrow on purpose. Nothing outside this file should import `fhirclient`, so that replacing it stays
 * a one-file change and so that no caller can reach past this into `client.request()`.
 */
export interface SmartSession {
  /** The launched FHIR server. Both the EHR base *and* the allowlist for the token — see `authedFetch`. */
  readonly serverUrl: string;

  /** Patient in context, when the launch supplied one. Null on a standalone launch that declined to. */
  readonly patientId: string | null;

  /** The user, as a FHIR reference such as `Practitioner/123`. Null when `fhirUser` was not granted. */
  readonly fhirUser: string | null;

  /** Scopes the server actually granted, which may be narrower than those asked for. */
  readonly grantedScopes: string;

  /**
   * Scopes this launch asked for, so the two can be compared.
   *
   * Read from the client's own state rather than recomputed, because `buildScopes` produces a
   * different string for the two launch patterns and nothing else here records which one happened. It
   * also survives a session restored from `sessionStorage`, where the config in memory may since have
   * changed.
   */
  readonly requestedScopes: string;

  /**
   * A write slot the launching EHR nominated for this request, if it did.
   *
   * The EHR allocates the slot on its own server, and passes its address and a bearer capability for
   * it through the launch context. When present, a request link built in this session names *this*
   * slot as the one-shot write target instead of one allocated on our blob store, so the answers land
   * on the record system that asked for them rather than somewhere it then has to poll and reconcile.
   *
   * Null when the launch supplied none, which is every launch from an EHR that does not implement this
   * and remains the normal case.
   */
  readonly nominatedWriteSlot: NominatedWriteSlot | null;

  /**
   * The identifier the EHR wants this request known by, if it supplied one.
   *
   * Used verbatim as the request's business identifier so that the Task published back to the EHR and
   * the answers written to its slot carry the *same* value it already recorded. Minting our own here
   * instead is what makes a returned response unmatchable against the request that asked for it.
   */
  readonly nominatedRequestId: string | null;

  /**
   * The `Authorization` header value, refreshing the token first if it is close to expiry.
   *
   * Async because the refresh is. Returns null if the session has no usable token, which callers must
   * treat as "send this request unauthenticated" rather than as an error — an anonymous read against a
   * public server is exactly what this app did before launches existed.
   */
  authorizationHeader(): Promise<string | null>;

  /** Discard the session. The token is forgotten locally; no revocation is attempted. */
  signOut(): void;
}

/**
 * `sessionStorage`, not `localStorage`, and the distinction matters twice over.
 *
 * It is per-tab, so two tabs launched from different patients do not silently share a context. And it
 * keeps tokens out of `localStorage`, which already holds channel-C reply keys
 * (`src/lib/requestStore.ts`) that must survive a tab closing — precisely the opposite lifetime to
 * what an access token should have.
 *
 * This is `fhirclient`'s own default; it is set explicitly because relying on it silently would make a
 * future default change a security regression rather than a visible one.
 */
FHIR.oauth2.settings.fullSessionStorageSupport = true;

/** Strip the fragment and query so a redirect target cannot smuggle either back into the flow. */
function redirectUri(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/**
 * Begin a launch by redirecting to the authorisation server. Does not return on success.
 *
 * `iss` is the server that initiated an EHR launch, and it arrives in a query string a stranger can
 * write. It is checked against the configured issuer rather than trusted, because following an
 * arbitrary `iss` would send this app's client id — and the user's consent — to a server of the
 * attacker's choosing. `issMatch` makes `fhirclient` do that check; passing `smartIssuerUrl` as `iss`
 * when none was supplied is what makes the same function serve a standalone launch.
 *
 * PKCE is `required`, not the library default of `ifSupported`. A public client has no secret, so PKCE
 * is the only thing binding the authorisation code to this app; silently proceeding without it against
 * a server that does not advertise S256 would leave the code interceptable.
 */
export async function startLaunch(
  config: AppConfig,
  options: { iss?: string | null; launch?: string | null; callbackPath: string }
): Promise<void> {
  if (config.smartIssuerUrl === null || config.smartClientId === null) {
    throw new Error(
      'SMART App Launch is not configured. Set `smartIssuerUrl` and `smartClientId` in config.json.'
    );
  }

  const standalone = !options.launch;

  await FHIR.oauth2.authorize({
    iss: options.iss ?? config.smartIssuerUrl,
    issMatch: config.smartIssuerUrl,
    launch: options.launch ?? undefined,
    clientId: config.smartClientId,
    scope: buildScopes(config, standalone),
    redirectUri: redirectUri(options.callbackPath),
    pkceMode: 'required'
  });
}

/** Wrap a live `fhirclient` client in the narrow interface the rest of the app sees. */
function toSession(client: Client): SmartSession {
  return {
    serverUrl: client.getState('serverUrl') as string,
    patientId: client.getPatientId(),
    fhirUser: client.getFhirUser(),
    grantedScopes: (client.getState('tokenResponse.scope') as string | undefined) ?? '',
    requestedScopes: (client.getState('scope') as string | undefined) ?? '',
    nominatedWriteSlot: nominatedWriteSlotFrom(
      client.getState('tokenResponse.write_slot_url') as string | undefined,
      client.getState('tokenResponse.write_slot_token') as string | undefined
    ),
    nominatedRequestId:
      (client.getState('tokenResponse.request_id') as string | undefined) ?? null,

    async authorizationHeader() {
      /*
       * Refresh before reading the header rather than retrying on a 401. The app's write path creates
       * several resources in sequence (`submitResponse` posts a QuestionnaireResponse, then a Task,
       * then a Provenance), and a token expiring midway would half-write the set. A no-op when the
       * token is still good.
       */
      try {
        await client.refreshIfNeeded();
      } catch {
        // An expired session that cannot refresh is not fatal here: the caller falls back to an
        // unauthenticated request, which either succeeds on an open server or fails with the
        // server's own message. Throwing would turn a read into a crash.
      }

      return client.getAuthorizationHeader();
    },

    signOut() {
      /*
       * `fhirclient` offers no teardown, so the session key it wrote is cleared directly. Clearing all
       * of `sessionStorage` would be wrong — it is not ours alone.
       */
      const key = window.sessionStorage.getItem('SMART_KEY');
      if (key) {
        window.sessionStorage.removeItem(JSON.parse(key) as string);
        window.sessionStorage.removeItem('SMART_KEY');
      }
    }
  };
}

/**
 * Complete a launch on the callback page, exchanging the authorisation code for a token.
 *
 * Throws if the URL carries no completable flow, which is the normal outcome of someone opening
 * `/callback` directly and should be reported as such rather than as a failure of the launch.
 */
export async function completeLaunch(): Promise<SmartSession> {
  return toSession(await FHIR.oauth2.ready());
}

/**
 * Recover a session already established in this tab, or null if there is none.
 *
 * Called on every page load. Returning null is the overwhelmingly common case — the app is usable
 * without a launch — so this must stay quiet rather than warn.
 */
export async function restoreSession(): Promise<SmartSession | null> {
  const key = window.sessionStorage.getItem('SMART_KEY');
  if (!key) {
    return null;
  }

  try {
    return toSession(await FHIR.oauth2.ready());
  } catch {
    return null;
  }
}
