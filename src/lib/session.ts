/**
 * The browser's side of the BFF contract: who am I, where do I sign in, and how do I read FHIR.
 *
 * Every route named here is same-origin, which is the whole design. The session lives in an
 * `HttpOnly` cookie this code cannot read and does not need to: the browser attaches it to a
 * same-origin `fetch` automatically, and the access token it stands for never leaves the server
 * (FR-005). So there is no token to store, no expiry to track and no `Authorization` header to
 * build anywhere in the SPA.
 *
 * Three ideas carry the rest of the app.
 *
 * **The session query has three ordinary states.** Loading, none, active. A fourth -
 * `unavailable` - exists for the case where `/api/session` cannot be reached at all, because
 * "we do not know" is not the same claim as "you are signed out", and neither may be rendered as
 * a blank screen.
 *
 * **One function decides whether a requester surface may render.** {@link requesterGate} is
 * where "signed in?" is answered, so `/`, `/requests`, `/responses` and `/patients` cannot drift
 * apart in how they answer it. It also takes the surface's *own* error, which is what makes the
 * expired-session case work: the cached session answer can say active while a read made a moment
 * later is told the session is gone, and the fresher evidence has to win.
 *
 * **A dead session is not an error.** {@link classifyProxyResponse} separates the BFF's
 * `401 { "error": "session-expired" }` from an upstream 401 the proxy passed through verbatim.
 * The first means offer a re-launch (spec US1 acceptance scenario 4); the second means explain
 * the failure, because signing in again would not change it.
 * @author John Grimes
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

/** `GET` for the current session, or `401` when there is not one. */
export const SESSION_ENDPOINT = "/api/session";

/** `POST` to discard the session and its cookie. */
export const LOGOUT_ENDPOINT = "/api/logout";

/** `GET` for the registry entries a standalone launch may choose between. Public. */
export const ISSUERS_ENDPOINT = "/api/issuers";

/** The launch route. A server navigation, never a client-side route. */
const LAUNCH_PATH = "/launch";

/**
 * FHIR base the SPA addresses. Everything the requester reads or writes on the launched server
 * goes through here, which is what keeps the launch token on the server (FR-004, FR-005).
 */
export const FHIR_PROXY_BASE = "/api/fhir";

/** Cache key of the session query, shared by every surface that gates on it. */
const SESSION_QUERY_KEY = ["session"] as const;

const FHIR_JSON = "application/fhir+json";

/**
 * Marker for an error raised because the session has gone.
 *
 * A symbol rather than a property name, so an arbitrary object cannot be mistaken for one: the
 * distinction drives a re-launch prompt, and nothing outside this module can set it.
 */
const SESSION_ENDED = Symbol("session-ended");

/** An error thrown because the session behind a request no longer exists. */
export type SessionEndedError = Error & { readonly [SESSION_ENDED]: true };

/** What `GET /api/session` answers with. Nothing here is a secret. */
export interface Session {
  /** FHIR base URL of the launched server. */
  readonly issuer: string;
  /** Its human-readable name, from the server's registry. */
  readonly issuerLabel: string;
  /** Launch context patient, when the launch carried one. */
  readonly patientId: string | null;
  /** Display name for the signed-in user, when the launch disclosed one. */
  readonly userDisplay: string | null;
  /**
   * The signed-in user as a FHIR reference, such as `Practitioner/123`.
   *
   * Distinct from {@link userDisplay}: this one is what attribution is written *with*, so a
   * `Provenance` or a `Task.requester` names a resource on the launched server rather than a
   * string that happens to read like a name. Null when `fhirUser` was not granted, which is legal
   * and means attribution falls back to the display name.
   */
  readonly fhirUser: string | null;
  /**
   * Scopes the authorisation server granted, space separated, or null when it did not say.
   *
   * Advisory in the same sense as {@link expiresAt}: the server enforces it either way. It is here
   * so a surface can explain a missing capability before offering it, rather than letting a write
   * fail halfway.
   */
  readonly grantedScopes: string | null;
  /** Scopes this deployment asks for, so a narrowed grant can be spotted and explained. */
  readonly requestedScopes: string | null;
  /** Access token expiry in epoch seconds. Advisory: the server enforces it. */
  readonly expiresAt: number;
}

/** One entry of `GET /api/issuers`: a server this deployment may launch against. */
export interface IssuerOption {
  /** FHIR base URL to launch against. */
  readonly issuer: string;
  /** Human-readable name. */
  readonly label: string;
}

/** What is known about the session right now. */
export type SessionState =
  /** The first read has not come back yet. */
  | { readonly kind: "loading" }
  /** The server says there is no session. */
  | { readonly kind: "none" }
  /** There is a session, and this is it. */
  | { readonly kind: "active"; readonly session: Session }
  /** The session could not be read at all, so nothing is known either way. */
  | { readonly kind: "unavailable"; readonly message: string };

/** Why a launch is being asked for. Determines what the prompt says, not what it offers. */
export type LaunchReason =
  /** Nobody is signed in. The ordinary first-visit case. */
  | "no-session"
  /** There was a session and it has gone. */
  | "session-expired"
  /** Whether there is a session could not be established. */
  | "session-unavailable";

/** What a requester surface should render. */
export type RequesterGate =
  | { readonly kind: "loading" }
  | { readonly kind: "launch-required"; readonly reason: LaunchReason }
  | { readonly kind: "ready"; readonly session: Session };

/** What a response from the FHIR proxy means. */
export type ProxyOutcome =
  /** A response to pass to the caller. */
  | "ok"
  /** The session is gone: offer a re-launch. */
  | "session-ended"
  /** Anything else: report it as the failure it is. */
  | "failed";

/**
 * Build the URL that starts a standalone launch against an issuer.
 *
 * `/launch` is a BFF route that answers a redirect to the issuer's authorization endpoint, so
 * this URL is navigated to rather than routed to. The issuer is encoded because it is going into
 * a query string: an issuer carrying `?` or `&` must not be able to end the parameter early.
 * @param issuer the FHIR base URL of the server to launch against
 * @returns the same-origin URL to navigate to
 * @example
 * globalThis.location.assign(standaloneLaunchUrl("https://ehr.example.org/fhir"));
 */
export function standaloneLaunchUrl(issuer: string): string {
  return `${LAUNCH_PATH}?iss=${encodeURIComponent(issuer)}`;
}

/**
 * Whether a value is an error raised because the session has gone.
 * @param value the thrown value to examine
 * @returns true when the value carries this module's session-ended marker
 */
export function isSessionEnded(value: unknown): value is SessionEndedError {
  return value instanceof Error && SESSION_ENDED in value;
}

/**
 * Raise an error that means "the session has gone", not "that failed".
 *
 * The marker, not the message, is what surfaces branch on: {@link requesterGate} turns a marked
 * error into a re-launch prompt rather than a red box, so every route that acts with the
 * session's authority - reading through the proxy, minting an invitation - has to raise the same
 * kind of error for the same cause.
 * @param message what to say if the error is displayed rather than acted on
 * @returns the marked error, for the caller to throw
 * @example
 * throw sessionEndedError("The session has ended, so nothing was minted.");
 */
export function sessionEndedError(message: string): SessionEndedError {
  return Object.assign(new Error(message), {
    [SESSION_ENDED]: true as const,
  });
}

/**
 * Decide what a response from `/api/fhir/*` means.
 *
 * Only the BFF's own `401` bodies mean the session is gone. The proxy passes upstream responses
 * through verbatim, so a `401` carrying an `OperationOutcome` is the *launched server* refusing
 * the request with an intact session, and a `403` is a permissions answer. Neither is fixed by
 * signing in again, so neither may be presented as though it were.
 * @param status the HTTP status of the response
 * @param body the parsed response body, or undefined when there was none
 * @returns what the caller should do about it
 * @example
 * if (classifyProxyResponse(response.status, body) === "session-ended") promptRelaunch();
 */
export function classifyProxyResponse(
  status: number,
  body?: unknown,
): ProxyOutcome {
  if (status >= 200 && status < 300) {
    return "ok";
  }
  if (status !== 401) {
    return "failed";
  }
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined;
  return error === "session-expired" || error === "no-session"
    ? "session-ended"
    : "failed";
}

/**
 * Whether a parsed body is the session response.
 * @param value the parsed body
 * @returns true when every field of {@link Session} is present and of the right type
 */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.issuer === "string" &&
    typeof candidate.issuerLabel === "string" &&
    (candidate.patientId === null || typeof candidate.patientId === "string") &&
    (candidate.userDisplay === null ||
      typeof candidate.userDisplay === "string") &&
    (candidate.fhirUser === null || typeof candidate.fhirUser === "string") &&
    (candidate.grantedScopes === null ||
      typeof candidate.grantedScopes === "string") &&
    (candidate.requestedScopes === null ||
      typeof candidate.requestedScopes === "string") &&
    typeof candidate.expiresAt === "number"
  );
}

/**
 * Parse a JSON body without letting a non-JSON one throw.
 *
 * An error body is read to be classified, not to be trusted, and a proxy failure may well answer
 * with HTML. Failing to parse it is an answer in itself.
 * @param response the response to read
 * @returns the parsed body, or undefined when there was not one to parse
 */
async function parseJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read the current session.
 *
 * A `401` resolves to `null` rather than rejecting, because "you are not signed in" is an answer
 * to the question asked. Anything else rejects, so that a server that cannot be reached is
 * reported as unknown rather than as signed out.
 * @param signal aborts the request when the caller goes away
 * @returns the session, or null when there is none
 * @throws {Error} when the endpoint fails, or answers with something that is not a session
 * @example
 * const session = await fetchSession();
 */
export async function fetchSession(
  signal?: AbortSignal,
): Promise<Session | null> {
  const response = await fetch(SESSION_ENDPOINT, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `The session could not be read (${response.status} ${response.statusText}).`,
    );
  }

  const body = await parseJsonBody(response);
  if (!isSession(body)) {
    throw new Error(
      "The server answered without a usable session, so it is not clear who is signed in.",
    );
  }
  return body;
}

/**
 * Read the servers this deployment may launch against.
 *
 * An empty list is a legitimate answer - a deployment with an empty registry - and is rendered
 * as an empty state rather than as a failure.
 * @param signal aborts the request when the caller goes away
 * @returns the registry entries, possibly none
 * @throws {Error} when the endpoint fails or answers with something other than a list
 * @example
 * const issuers = await fetchIssuers();
 */
export async function fetchIssuers(
  signal?: AbortSignal,
): Promise<IssuerOption[]> {
  const response = await fetch(ISSUERS_ENDPOINT, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `The list of servers could not be read (${response.status} ${response.statusText}).`,
    );
  }

  const body = await parseJsonBody(response);
  const isRegistry =
    Array.isArray(body) &&
    body.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).issuer === "string" &&
        typeof (entry as Record<string, unknown>).label === "string",
    );
  if (!isRegistry) {
    throw new Error(
      "The server answered without an issuer list, so there is nothing to choose between.",
    );
  }
  return body as IssuerOption[];
}

/**
 * Discard the session.
 *
 * Rejects on failure, so the UI can say the session may still stand rather than claim a sign-out
 * that did not happen.
 * @returns nothing; resolves once the server has cleared the session
 * @throws {Error} when the server did not accept the request
 * @example
 * await logout();
 */
export async function logout(): Promise<void> {
  const response = await fetch(LOGOUT_ENDPOINT, { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `Signing out failed (${response.status} ${response.statusText}), so the session may still be open.`,
    );
  }
}

/**
 * Read FHIR JSON through the proxy.
 *
 * The one place in the SPA that turns a lost session into something a surface can act on. Errors
 * raised for that reason carry a marker {@link isSessionEnded} recognises; every other failure is
 * an ordinary `Error` naming the status and the URL.
 * @param url an absolute-path URL under {@link FHIR_PROXY_BASE}
 * @param signal aborts the request when the caller goes away
 * @returns the parsed resource or Bundle
 * @throws {Error} on any non-success response; marked as session-ended when the session has gone
 * @example
 * const bundle = await fetchProxiedFhir<Bundle>(`${FHIR_PROXY_BASE}/Questionnaire?_count=50`);
 */
export async function fetchProxiedFhir<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: FHIR_JSON },
    signal,
  });
  const body = await parseJsonBody(response);

  switch (classifyProxyResponse(response.status, body)) {
    case "ok": {
      return body as T;
    }
    case "session-ended": {
      throw sessionEndedError(
        "The session has ended, so this could not be read.",
      );
    }
    case "failed": {
      throw new Error(
        `FHIR request failed (${response.status} ${response.statusText}): ${url}`,
      );
    }
  }
}

/**
 * Reduce a query's raw fields to what is actually known about the session.
 *
 * Pure, and the reason `useSession` needs no test of its own. The error is examined before the
 * pending flag because a query that has failed is no longer loading, and reporting it as loading
 * would leave a spinner up for good.
 * @param query the session query's `isPending`, `data` and `error`
 * @param query.isPending whether the first read is still outstanding
 * @param query.data the resolved session, `null` for no session, `undefined` before resolution
 * @param query.error the query's error, if it has one
 * @returns the session state
 * @example
 * const state = sessionState({ isPending, data, error });
 */
export function sessionState(query: {
  isPending: boolean;
  data: Session | null | undefined;
  error: unknown;
}): SessionState {
  if (query.error !== null && query.error !== undefined) {
    return {
      kind: "unavailable",
      message:
        query.error instanceof Error
          ? query.error.message
          : "The session could not be read.",
    };
  }
  if (query.isPending || query.data === undefined) {
    return { kind: "loading" };
  }
  return query.data === null
    ? { kind: "none" }
    : { kind: "active", session: query.data };
}

/**
 * Decide whether a requester surface may render, or must offer a launch instead.
 *
 * `dataError` is the surface's own read failure, and it outranks the session state on purpose:
 * the session query's answer is cached and may have been true when it was fetched, while a
 * proxied read that has just been told the session is gone is the fresher evidence. Any other
 * failure is left to the surface, which knows what it was trying to do and can say so - swapping
 * a FHIR error for a sign-in prompt would send the user to fix the wrong thing.
 * @param state what is known about the session
 * @param dataError the error from the surface's own data query, if it has one
 * @returns what the surface should render
 * @example
 * const gate = requesterGate(useSession(), error);
 * if (gate.kind === "launch-required") return <Connect reason={gate.reason} />;
 */
export function requesterGate(
  state: SessionState,
  dataError?: unknown,
): RequesterGate {
  if (isSessionEnded(dataError)) {
    return { kind: "launch-required", reason: "session-expired" };
  }

  switch (state.kind) {
    case "loading": {
      return { kind: "loading" };
    }
    case "active": {
      return { kind: "ready", session: state.session };
    }
    case "none": {
      return { kind: "launch-required", reason: "no-session" };
    }
    case "unavailable": {
      return { kind: "launch-required", reason: "session-unavailable" };
    }
  }
}

/**
 * The current session, as a state every surface can branch on.
 *
 * A thin composition of `useQuery` and {@link sessionState}. Retries are off: a failure here is
 * reported as unavailable straight away, because the user's next move is the same either way and
 * a silent retry loop would just delay saying so.
 * @returns what is known about the session right now
 * @example
 * const state = useSession();
 */
export function useSession(): SessionState {
  const { isPending, data, error } = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    retry: false,
  });

  return sessionState({ isPending, data, error });
}

/**
 * What this requester surface should render.
 *
 * The one call every gated surface makes. Two places need it and they need different arguments:
 * the route wrapper asks with nothing, because it is deciding whether the surface may mount at
 * all, and the surface itself asks with its own query error, because a session can die between
 * mounting and reading. Both share one session query, so asking twice costs one fetch.
 * @param dataError the error from this surface's own data query, if it has one
 * @returns whether to wait, prompt for a launch, or render
 * @example
 * const gate = useRequesterGate(error);
 * if (gate.kind === "launch-required") return <Connect reason={gate.reason} />;
 */
export function useRequesterGate(dataError?: unknown): RequesterGate {
  return requesterGate(useSession(), dataError);
}

/**
 * Sign out.
 *
 * Two cache operations, and both are load bearing. The session query is set to `null` rather
 * than invalidated, so the gate stops claiming a session on the very next render - `clear()`
 * empties the cache without notifying the observers whose queries it removed, which leaves the
 * signed-in surface on screen until something else happens to re-render it. Everything else is
 * removed instead, because it was read with the authority of a session that no longer exists and there
 * is now nothing to refetch it with.
 * @returns the mutation, whose `mutate` signs out and whose `error` explains a failure
 * @example
 * const signOut = useLogout();
 * <button onClick={() => signOut.mutate()}>Sign out</button>
 */
export function useLogout(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, void>({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0],
      });
    },
  });
}
