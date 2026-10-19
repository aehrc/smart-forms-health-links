/**
 * The browser's half of the walk-in codes: create one, list them, withdraw one.
 *
 * A thin client over `/api/standing-invitations`, matching `src/link/createLink.ts` in shape and
 * in manners. Every call carries the session cookie, a `401` is raised as a session-ended error so
 * the surface offers a re-launch rather than an error, and nothing here knows how a link is
 * built - the server mints it, because minting publishes a Task under the session's authority.
 *
 * The one addition is {@link viewerLinkFor}. The server answers with a bare `shlink:/`, and what
 * goes on a poster is a viewer URL carrying that link in its fragment. A scanner that has never
 * heard of the `shlink:` scheme still opens something, and the fragment never leaves the device.
 * @author John Grimes
 */

import type { AppConfig } from "@/lib/config";

import { resolveLinkBaseUrl } from "@/lib/config";
import { sessionEndedError } from "@/lib/session";

/** Where the walk-in code routes live. */
export const STANDING_INVITATIONS_ENDPOINT = "/api/standing-invitations";

/** One walk-in code, as the server describes it. */
export interface StandingInvitation {
  /** The row id, also the last segment of its manifest URL. */
  readonly id: string;
  /** The `shlink:/` link, so the QR can be printed again without minting a second code. */
  readonly shlink: string;
  /** Where the link's manifest is served from. */
  readonly manifestUrl: string;
  /** The label, normally the questionnaire title. */
  readonly label: string;
  /** Canonical URL of the questionnaire, or null when it declared none. */
  readonly questionnaireCanonical: string | null;
  /** When the code stops working, in epoch seconds, or null when it never does. */
  readonly expiresAt: number | null;
  /** When staff withdrew it, in epoch seconds, or null while it is live. */
  readonly revokedAt: number | null;
  /** When it was created, in epoch seconds. */
  readonly createdAt: number;
  /** Absolute URL of the standing Task published on the issuer. */
  readonly taskUrl: string;
  /** How many scans have minted an invitation from it. */
  readonly scans: number;
  /** How many of those produced answers the practice accepted. */
  readonly answered: number;
}

/**
 * Whether a code is still worth printing.
 *
 * Three states, and a person reading the list needs to tell them apart: live, withdrawn by staff,
 * and quietly past its date. The last is the one a printed poster is most likely to be in.
 * @param link the code
 * @param now current time in epoch seconds, injectable for tests
 * @returns what state it is in
 * @example
 * const state = standingState(link); // "live" | "revoked" | "expired"
 */
export function standingState(
  link: StandingInvitation,
  now: number = Math.floor(Date.now() / 1000),
): "live" | "revoked" | "expired" {
  if (link.revokedAt !== null) {
    return "revoked";
  }
  if (link.expiresAt !== null && link.expiresAt <= now) {
    return "expired";
  }
  return "live";
}

/**
 * The URL to put on a poster, for a code the server has minted.
 * @param link the code
 * @param config the app configuration, for the link origin
 * @returns the viewer URL carrying the link in its fragment
 * @example
 * <ShareLinkPanel link={viewerLinkFor(link, config)} kind="request" />
 */
export function viewerLinkFor(
  link: StandingInvitation,
  config: AppConfig,
): string {
  return `${resolveLinkBaseUrl(config).replace(/\/+$/, "")}/view#${link.shlink}`;
}

/**
 * Read the body of a response, tolerating one that has none.
 * @param response the response
 * @returns the parsed body, or undefined
 */
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Raise the right kind of error for a refused call.
 * @param response the refused response
 * @param body its parsed body, when it had one
 * @param fallback what to say when the server named no reason this app recognises
 * @throws {Error} always
 */
function refuse(response: Response, body: unknown, fallback: string): never {
  if (response.status === 401) {
    throw sessionEndedError(
      "The session has ended, so nothing was changed. Sign in again to manage walk-in codes.",
    );
  }
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as Record<string, unknown>).error)
      : undefined;
  switch (error) {
    case "task-publish-failed": {
      throw new Error(
        "The walk-in request could not be recorded on the server you are signed in to, so no " +
          "code was created. Nothing is hosted.",
      );
    }
    case "questionnaire-unreadable": {
      throw new Error(
        "This form could not be read from the server you are signed in to, so no code was created.",
      );
    }
    case "questionnaire-not-invitable": {
      throw new Error(
        "This form has no canonical URL, so a code for it could not say which form to fill in. " +
          "Nothing was created.",
      );
    }
    default: {
      throw new Error(`${fallback} (${String(response.status)}).`);
    }
  }
}

/**
 * Whether a parsed body is one walk-in code.
 * @param body the parsed body
 * @returns true when it carries the fields a code needs
 */
function isStandingInvitation(body: unknown): body is StandingInvitation {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const value = body as Record<string, unknown>;
  return (
    typeof value.id === "string" &&
    typeof value.shlink === "string" &&
    typeof value.label === "string"
  );
}

/**
 * Create a walk-in code for one form.
 *
 * The server reads the Questionnaire, publishes the one standing Task and seals the payload, all
 * under the session's authority. What comes back is a code many unrelated people may scan.
 * @param questionnaireId id of the Questionnaire on the launched server
 * @param options an expiry override, in epoch seconds
 * @param options.expiresAt when the printed code should stop working
 * @param options.senderName the deployment's sender name, used only when the launch named no user
 * @returns the created code
 * @throws {Error} when the mint is refused; marked as session-ended when the session has gone
 * @example
 * const created = await createStandingInvitation("q-715", { expiresAt });
 */
export async function createStandingInvitation(
  questionnaireId: string,
  options: { expiresAt?: number; senderName?: string | null } = {},
): Promise<StandingInvitation> {
  const response = await fetch(STANDING_INVITATIONS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      questionnaireId,
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
      ...(options.senderName ? { senderName: options.senderName } : {}),
    }),
  });
  const body = await readBody(response);
  if (!response.ok || !isStandingInvitation(body)) {
    refuse(response, body, "The walk-in code could not be created");
  }
  return body;
}

/**
 * List this practice's walk-in codes, newest first.
 *
 * Withdrawn and expired codes are included: somebody looking at this list needs to be told that a
 * poster on the wall has stopped working, which is exactly what a list of only live codes would
 * hide.
 * @param signal aborts the request when the caller goes away
 * @returns the codes
 * @throws {Error} when the read is refused; marked as session-ended when the session has gone
 * @example
 * const codes = await listStandingInvitations(signal);
 */
export async function listStandingInvitations(
  signal?: AbortSignal,
): Promise<StandingInvitation[]> {
  const response = await fetch(STANDING_INVITATIONS_ENDPOINT, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  const body = await readBody(response);
  if (!response.ok) {
    refuse(response, body, "The walk-in codes could not be read");
  }
  const listed = (body as { standingInvitations?: unknown } | undefined)
    ?.standingInvitations;
  return Array.isArray(listed) ? listed.filter(isStandingInvitation) : [];
}

/**
 * Withdraw a walk-in code, so the printed QR stops resolving.
 *
 * It takes effect on the next scan rather than on the phones that already have the form open: a
 * grant minted a minute ago is good for its hour, because it names an invitation that was minted
 * before the withdrawal. That window is the price of minting grants per fetch and storing none.
 * @param id the code to withdraw
 * @throws {Error} when the call is refused; marked as session-ended when the session has gone
 * @example
 * await revokeStandingInvitation(link.id);
 */
export async function revokeStandingInvitation(id: string): Promise<void> {
  const response = await fetch(
    `${STANDING_INVITATIONS_ENDPOINT}/${encodeURIComponent(id)}/revoke`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    refuse(
      response,
      await readBody(response),
      "The code could not be withdrawn",
    );
  }
}

/**
 * Seal the current copy of a code's form into it, keeping the printed QR.
 *
 * A code serves the copy of its form taken when it was created. This reads the form again and
 * re-seals the code's payload under the same id and key, so the QR already on the wall stays valid
 * and its next scan gets the new copy. Phones that already have the form open keep the old one.
 * @param id the code to refresh
 * @returns true when the form had changed and was re-sealed, false when it was already current
 * @throws {Error} when the call is refused; marked as session-ended when the session has gone
 * @example
 * const changed = await refreshStandingInvitation(link.id);
 */
export async function refreshStandingInvitation(id: string): Promise<boolean> {
  const response = await fetch(
    `${STANDING_INVITATIONS_ENDPOINT}/${encodeURIComponent(id)}/refresh`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  const body = await readBody(response);
  if (response.ok) {
    return (body as { refreshed?: unknown } | undefined)?.refreshed === true;
  }
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as Record<string, unknown>).error)
      : undefined;
  switch (error) {
    case "questionnaire-identity-changed": {
      throw new Error(
        "The form's URL or version has changed since this code was created, so it cannot be " +
          "refreshed in place. Create a new code for the new version. Nothing was changed.",
      );
    }
    case "questionnaire-unreadable": {
      throw new Error(
        "The form could not be read from the server you are signed in to. Nothing was changed.",
      );
    }
    case "not-found": {
      throw new Error(
        "This code has been withdrawn or has expired, so there is nothing to refresh.",
      );
    }
    case "changed-meanwhile": {
      throw new Error(
        "The code changed while it was being refreshed. Nothing was changed; try again.",
      );
    }
    default: {
      refuse(response, body, "The code could not be refreshed");
    }
  }
}
