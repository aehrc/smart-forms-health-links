import type { ReplyPrivateJwk } from '@/link/replyCrypto';
import { isReplyPrivateJwk } from '@/link/replyCrypto';

/**
 * Outstanding requests, and the keys needed to open their replies.
 *
 * This exists because channel C is asynchronous in a way the rest of the app is not. A request is
 * minted now and answered whenever the patient gets round to it, and the private key that decrypts
 * that answer is generated at mint time and exists **nowhere else** — not in the link, not on the blob
 * server, not with the filler. Lose it and the reply is unreadable by anyone, permanently. So it has to
 * outlive the page that created it.
 *
 * ## Why localStorage
 *
 * The honest answer is that it is enough. Records are a few hundred bytes, and IndexedDB would buy
 * nothing here: both are origin-scoped and both are readable by anything that achieves script execution
 * on this origin, so the security posture is identical and only the amount of plumbing differs.
 *
 * What that posture actually is, stated plainly because it belongs in the README too: **clearing site
 * data destroys pending replies**, and this is browser storage rather than a secret manager. A
 * deployment handling requests it cannot afford to lose should export them (see
 * {@link exportRequests}) or hold the keys somewhere designed for keys.
 */

const STORAGE_KEY = 'smart-forms-health-links.requests.v1';

export interface StoredReplyChannel {
  /** Where the encrypted reply will appear. */
  url: string;
  /** The half of the keypair that opens it. Never leaves this browser except via export. */
  privateJwk: ReplyPrivateJwk;
}

export interface StoredWriteChannel {
  /** The pre-allocated QuestionnaireResponse the filler may write to. */
  url: string;
  /** The version the slot was minted at — what the filler must send in `If-Match`. */
  etag: string;
  /**
   * The capability handed out with the invitation.
   *
   * Kept so the requester can see what it issued and, on a host that gates writes, revoke it. It is
   * a write capability for a slot we own, so holding it here costs nothing; it is never sent to the
   * EHR, and never echoed back on a return leg.
   */
  token: string;
}

export interface OutstandingRequest {
  /** `Task.identifier` value — the correlation key shared with any published server Task. */
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
   * not resolve here — the normal case, not an edge one. Holding the reference we addressed the
   * request to turns reconciliation from a free-text field into a confirmation.
   */
  subjectReference?: string;
  /** Channel C. */
  reply?: StoredReplyChannel;
  /**
   * Channel D: the one-shot write capability handed out with this request.
   *
   * Held so the slot can be polled later. Note what it is *not*: irreplaceable. The reply key above
   * exists nowhere else, so losing it makes a reply permanently unreadable; a write slot is plaintext
   * on a server, so losing this only loses track of where the answers will turn up.
   */
  write?: StoredWriteChannel;
  /**
   * Absolute URL of the request's published `Task`, when one was written.
   *
   * Presence means **published**, not "channel B is on" — a Task is published for tracking alone
   * whenever `publishRequestTasks` is set. Whether a filler was actually invited to write to that server
   * is {@link OutstandingRequest.serverReturnOffered}, and conflating the two makes the UI claim answers
   * can arrive unreviewed when they cannot.
   */
  serverTaskUrl?: string;
  /** Whether the invitation offered channel B — the direct, unreviewed write. */
  serverReturnOffered?: boolean;
  /** Set once a reply has been collected and accepted, so the row stops asking to be checked. */
  collectedAt?: string;
}

function isOutstandingRequest(value: unknown): value is OutstandingRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.label !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.link !== 'string'
  ) {
    return false;
  }

  if (candidate.reply !== undefined) {
    const reply = candidate.reply as Record<string, unknown>;
    if (typeof reply?.url !== 'string' || !isReplyPrivateJwk(reply?.privateJwk)) {
      return false;
    }
  }

  if (candidate.write !== undefined) {
    const write = candidate.write as Record<string, unknown>;
    if (typeof write?.url !== 'string' || typeof write?.etag !== 'string') {
      return false;
    }
  }

  return true;
}

/**
 * Read every stored request.
 *
 * Individually validated and silently skipped rather than failing the read: one corrupt record — from a
 * hand-edited export, or a half-written entry — must not make the rest of someone's outstanding
 * requests inaccessible.
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
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function write(requests: OutstandingRequest[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  } catch (cause) {
    /*
     * Loud, because the consequence is not obvious: if this write fails the request has still been sent
     * and the QR may already be on someone's screen, but the key to read its reply is now gone.
     */
    throw new Error(
      'Could not save this request to browser storage, so the key needed to read its reply would be ' +
        'lost. Storage may be full or blocked.',
      { cause }
    );
  }
}

/** Add or replace a request, keyed by correlation id. */
export function saveRequest(request: OutstandingRequest): void {
  const others = listRequests().filter((candidate) => candidate.id !== request.id);
  write([request, ...others]);
}

export function updateRequest(id: string, changes: Partial<OutstandingRequest>): void {
  const requests = listRequests();
  const index = requests.findIndex((candidate) => candidate.id === id);
  if (index === -1) {
    return;
  }

  requests[index] = { ...requests[index], ...changes };
  write(requests);
}

export function getRequest(id: string): OutstandingRequest | undefined {
  return listRequests().find((candidate) => candidate.id === id);
}

/**
 * Forget a request.
 *
 * Irreversible in a way worth surfacing at the call site: it discards the private key, so any reply to
 * that request — including one already sitting in the slot — becomes permanently unreadable.
 */
export function deleteRequest(id: string): void {
  write(listRequests().filter((candidate) => candidate.id !== id));
}

export function isExpired(request: OutstandingRequest, now = Date.now()): boolean {
  return request.expiresAt !== undefined && request.expiresAt * 1000 < now;
}

/**
 * Serialise every stored request, for moving them between browsers.
 *
 * **This contains private keys.** A request minted on a desktop and collected on a laptop needs the key
 * to travel, and there is no way to make that safe by encoding — so the file is exactly as sensitive as
 * the replies it can decrypt, and callers must say so where the user can see it.
 */
export function exportRequests(): string {
  return JSON.stringify({ version: 1, requests: listRequests() }, null, 2);
}

export interface ImportOutcome {
  imported: number;
  /** Records that did not validate, and were left out rather than stored half-formed. */
  skipped: number;
}

/**
 * Merge an exported file into this browser's store.
 *
 * Merges rather than replaces, and existing records win: an import must not silently overwrite a key
 * for a request this browser minted itself, because that key is unrecoverable.
 */
export function importRequests(json: string): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error('That file is not valid JSON.', { cause });
  }

  const candidates = (parsed as { requests?: unknown })?.requests ?? parsed;
  if (!Array.isArray(candidates)) {
    throw new Error('That file does not contain a list of requests.');
  }

  const valid = candidates.filter(isOutstandingRequest);
  const existing = listRequests();
  const known = new Set(existing.map((request) => request.id));
  const fresh = valid.filter((request) => !known.has(request.id));

  if (fresh.length > 0) {
    write([...existing, ...fresh]);
  }

  return { imported: fresh.length, skipped: candidates.length - valid.length };
}
