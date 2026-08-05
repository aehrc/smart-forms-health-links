import type { Task } from 'fhir/r4';
import { taskCorrelationId } from '@/link/exchange';
import { isExpired, type OutstandingRequest } from '@/lib/requestStore';

/**
 * One view over two half-answers to "what have I sent?".
 *
 * Neither source is sufficient alone, and the reason is structural rather than incidental:
 *
 *  - **The EHR knows every request**, because each one publishes a `Task` — but deliberately not the
 *    reply slot or the key, so a listed Task cannot be collected from.
 *  - **This browser knows the keys**, because a reply key is generated at mint time and stored nowhere
 *    else — but only for requests *it* created.
 *
 * So a request sent from a colleague's machine is visible here and not collectable here, and saying so
 * plainly is better than either hiding it or offering a Check button that could never work.
 *
 * `Task.identifier` is the join. It is the one correlation key that survives everywhere: `urn:uuid`
 * references inside a Bundle do not, and the two copies of the Task have different server ids.
 */

export type SentRequestOrigin =
  /** Local record and published Task agree — the normal case. */
  | 'tracked'
  /** Created here but never published, so it is invisible to any other browser. */
  | 'local-only'
  /** Published, but this browser has no key for it. Visible, not collectable. */
  | 'server-only';

export interface SentRequest {
  /** Correlation id — `Task.identifier` value, shared by both copies. */
  id: string;
  label: string;
  origin: SentRequestOrigin;
  /** ISO instant, from whichever source has one. */
  createdAt?: string;
  subjectDisplay?: string;
  requesterDisplay?: string;
  expiresAt?: number;
  /** Present when this browser holds the request, and therefore possibly its reply key. */
  local?: OutstandingRequest;
  /** Present when the request was published to the EHR. */
  serverTask?: Task;
  /** Whether a reply can actually be collected here. */
  collectable: boolean;
}

/** Best label for a published Task, which has no `label` field of its own. */
function labelFromTask(task: Task): string {
  const description = task.description;
  if (description) {
    // `buildRequestBundle` writes `Complete "<title>"`; recover the title rather than showing the
    // instruction as though it were a form name.
    const quoted = /"([^"]+)"/.exec(description);
    return quoted?.[1] ?? description;
  }

  const canonical =
    task.input?.find((input) => input.valueCanonical)?.valueCanonical ?? task.focus?.reference;
  if (canonical) {
    return canonical.split('|')[0].split('/').filter(Boolean).pop() ?? canonical;
  }

  return 'Requested form';
}

/**
 * Merge local records with published Tasks into one list, newest first.
 *
 * Pure, so `check:roundtrip` can assert the join without a server or a browser.
 */
export function mergeSentRequests(
  local: OutstandingRequest[],
  serverTasks: Task[]
): SentRequest[] {
  const byId = new Map<string, SentRequest>();

  for (const request of local) {
    byId.set(request.id, {
      id: request.id,
      label: request.label,
      origin: 'local-only',
      createdAt: request.createdAt,
      subjectDisplay: request.subjectDisplay,
      expiresAt: request.expiresAt,
      local: request,
      collectable: request.reply !== undefined && !isExpired(request)
    });
  }

  for (const task of serverTasks) {
    const id = taskCorrelationId(task);
    if (!id) {
      // Without an identifier there is nothing to join on, and nothing useful to say about it.
      continue;
    }

    const existing = byId.get(id);
    if (existing) {
      byId.set(id, {
        ...existing,
        origin: 'tracked',
        serverTask: task,
        // Prefer what the server recorded for display fields the local copy may not have.
        subjectDisplay: existing.subjectDisplay ?? task.for?.display,
        requesterDisplay: task.requester?.display
      });
      continue;
    }

    byId.set(id, {
      id,
      label: labelFromTask(task),
      origin: 'server-only',
      createdAt: task.authoredOn,
      subjectDisplay: task.for?.display,
      requesterDisplay: task.requester?.display,
      serverTask: task,
      collectable: false
    });
  }

  return [...byId.values()].sort((left, right) =>
    (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
  );
}

/** One-line explanation of why a row cannot be collected from, or undefined when it can. */
export function whyNotCollectable(request: SentRequest): string | undefined {
  if (request.collectable) {
    return undefined;
  }

  if (request.origin === 'server-only') {
    return 'Sent from another browser. Its reply key is held there — import it to collect the answers here.';
  }

  if (!request.local?.reply) {
    // Not a fault: with the encrypted channel off, this is what every request looks like, and the
    // answers come back as a link to scan rather than into a slot to poll.
    return 'Answers to this request come back as a link. Scan or paste it to review them.';
  }

  return 'This request has expired, so its reply slot no longer accepts answers.';
}

/**
 * Find the local record a returned Task belongs to, so scanned answers can be tied to the request
 * that asked for them.
 *
 * The join is `Task.identifier`, the same key {@link mergeSentRequests} uses and the only one that
 * survives the round trip — `urn:uuid` references are relative to a Bundle that no longer exists by
 * the time answers come back, and the two copies of the Task have different server ids.
 *
 * No match is an ordinary outcome, not an error: a link from someone this browser never wrote to is
 * still perfectly reviewable. Pure, so `check:roundtrip` can assert it without a browser.
 */
export function findRequestForTask(
  requests: OutstandingRequest[],
  task: Task | undefined
): OutstandingRequest | undefined {
  const id = taskCorrelationId(task);
  if (!id) {
    return undefined;
  }

  return requests.find((request) => request.id === id);
}
