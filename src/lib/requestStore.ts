import type { ReplyPrivateJwk } from "@/link/replyCrypto";

import { isReplyPrivateJwk } from "@/link/replyCrypto";

/**
 * Requests minted by an earlier release of this app, and the keys that opened their replies.
 *
 * Nothing writes a new record here any more. A request is now minted by the BFF
 * (`POST /api/invitations`), and its authoritative record is a row in the server's store plus a
 * published `Task` on the launched server, so every browser signed in to that server sees the same
 * list. What survives in this module is the read side: whatever this origin's `localStorage` still
 * holds from the release that minted in the browser, which `/view` matches a scanned reply against
 * so an answer arriving by QR can still be tied back to the request that asked for it.
 *
 * ## Why localStorage
 *
 * It was enough. Records are a few hundred bytes, and IndexedDB would have bought nothing here:
 * both are origin-scoped and both are readable by anything that achieves script execution on this
 * origin, so the security posture is identical and only the amount of plumbing differs.
 *
 * What that posture is, stated plainly: **clearing site data destroys these records**, and any
 * reply key among them goes with them, permanently. That was the price of minting reply channels
 * in a browser, and it is part of why minting moved to the server.
 * @author John Grimes
 */

const STORAGE_KEY = "smart-forms-health-links.requests.v1";

export interface StoredReplyChannel {
  /** Where the encrypted reply will appear. */
  url: string;
  /** The half of the keypair that opens it. Never left this browser. */
  privateJwk: ReplyPrivateJwk;
}

export interface OutstandingRequest {
  /** `Task.identifier` value - the correlation key shared with any published server Task. */
  id: string;
  /** Form title, for display. */
  label: string;
  /** Canonical of the Questionnaire, so the reply can be rendered against the right form. */
  questionnaireCanonical?: string;
  /** ISO instant the request was created. */
  createdAt: string;
  /** Unix seconds, matching the link's `exp`. */
  expiresAt?: number;
  /** The link itself, so it can be re-shown or re-scanned without minting a new one. */
  link: string;
  /** Who it was addressed to, as displayed on the request. */
  subjectDisplay?: string;
  /**
   * Who it was addressed to, as a reference on *our* server, e.g. `Patient/123`.
   *
   * Kept because answers from a third-party filler name the patient in that app's terms and will
   * not resolve here - the normal case, not an edge one. Holding the reference we addressed the
   * request to turns reconciliation from a free-text field into a confirmation.
   */
  subjectReference?: string;
  /**
   * The encrypted reply channel the request offered, when it offered one. Only ever set on a
   * record from the release that minted reply slots in the browser.
   */
  reply?: StoredReplyChannel;
  /**
   * Absolute URL of the request's published `Task`, when one was written.
   *
   * Presence means **published**, not "channel B is on" - a Task is published for tracking alone,
   * so it does not follow that a filler was invited to write to that server. That is
   * {@link OutstandingRequest.serverReturnOffered}, and conflating the two made the UI claim
   * answers could arrive unreviewed when they could not.
   */
  serverTaskUrl?: string;
  /** Whether the invitation offered channel B - the direct, unreviewed write. */
  serverReturnOffered?: boolean;
  /** Set once a reply has been collected and accepted, so the row stops asking to be checked. */
  collectedAt?: string;
}

function isOutstandingRequest(value: unknown): value is OutstandingRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.link !== "string"
  ) {
    return false;
  }

  if (candidate.reply !== undefined) {
    const reply = candidate.reply as Record<string, unknown>;
    if (
      typeof reply?.url !== "string" ||
      !isReplyPrivateJwk(reply?.privateJwk)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Read every stored request.
 *
 * Individually validated and silently skipped rather than failing the read: one corrupt record
 * must not make the rest of someone's outstanding requests inaccessible.
 */
export function listRequests(): OutstandingRequest[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing modes and blocked-storage settings throw on access rather than returning null.
    return [];
  }

  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter(isOutstandingRequest)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function write(requests: OutstandingRequest[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  } catch (error) {
    throw new Error(
      "Could not update this request in browser storage. Storage may be full or blocked.",
      { cause: error },
    );
  }
}

/**
 * Patch a stored request in place, leaving every other field alone.
 *
 * A no-op when no record has that id, which is the normal case now that minting is server-side:
 * only a browser holding a record from the earlier release has anything to patch.
 * @param id the correlation id, matching `Task.identifier`
 * @param changes the fields to overwrite
 * @throws {Error} when browser storage refuses the write
 * @example
 * updateRequest(matched.id, { collectedAt: new Date().toISOString() });
 */
export function updateRequest(
  id: string,
  changes: Partial<OutstandingRequest>,
): void {
  const requests = listRequests();
  const index = requests.findIndex((candidate) => candidate.id === id);
  if (index === -1) {
    return;
  }

  requests[index] = { ...requests[index], ...changes };
  write(requests);
}

/**
 * Whether a request has passed the expiry its link declared.
 * @param request the stored request
 * @param now the current time in milliseconds, injectable for tests
 * @returns true when the request had an expiry and it has passed
 */
export function isExpired(
  request: OutstandingRequest,
  now = Date.now(),
): boolean {
  return request.expiresAt !== undefined && request.expiresAt * 1000 < now;
}
