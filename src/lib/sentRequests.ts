import type { Task } from "fhir/r4";

import { RESPONSE_OUTPUT_TYPE } from "@/fhir/taskCompletion";
import { taskCorrelationId } from "@/link/exchange";

/**
 * What "what have I sent?" is answered from: the request Tasks on the launched server.
 *
 * One source, and that is the whole design. Minting is a server operation (FR-011), answers land on
 * the launched server by both return routes - a direct send with a grant, or a scanned link the
 * requester accepts - and each route completes the request's own Task through
 * `src/fhir/taskCompletion.ts`. So the Task *is* the state of the request, and everybody signed in
 * to that server sees the same thing.
 *
 * This used to be a union of those Tasks with a browser-local store, because the requester once
 * held a channel C reply key that was generated at mint time and existed nowhere else. That made a
 * request sent from a colleague's machine visible but not collectable, and the list had to say so.
 * The reply channel is no longer minted here, so the key, the store, the export/import between
 * browsers and the polling all went with it. What remains of channel C is the *filler* half - this
 * app still honours a reply descriptor another producer offers, see
 * `docs/shl-form-reply-channel.md`.
 *
 * Pure, so the derivation can be asserted without a server or a browser.
 */

/** What state a sent request is in, as its Task reports it. */
export type SentRequestState =
  /** Nobody has answered yet, and the request is still open. */
  | "awaiting"
  /** Answers have landed and the Task names them. */
  | "answered"
  /** Somebody closed the request without answers: cancelled, rejected, failed, in error. */
  | "closed";

/** One row of `/requests`, derived entirely from one published Task. */
export interface SentRequest {
  /** Correlation id - `Task.identifier` - the key that survives the round trip. */
  id: string;
  /** Server-assigned id of the Task, for naming the resource a row came from. */
  taskId?: string;
  label: string;
  state: SentRequestState;
  /** The Task's own status, shown for the states that need naming rather than paraphrasing. */
  status: Task["status"];
  createdAt?: string;
  subjectDisplay?: string;
  subjectReference?: string;
  requesterDisplay?: string;
  /** Reference to the answers, present once the Task has been completed with them. */
  responseReference?: string;
}

/**
 * Best label for a published Task, which has no `label` field of its own.
 * @param task the published Task
 * @returns the form's title where it can be recovered, else something true about the request
 */
export function labelFromTask(task: Task): string {
  const description = task.description;
  if (description) {
    // `buildRequestBundle` writes `Complete "<title>"`; recover the title rather than showing the
    // instruction as though it were a form name.
    const quoted = /"([^"]+)"/.exec(description);
    return quoted?.[1] ?? description;
  }

  const canonical =
    task.input?.find((input) => input.valueCanonical)?.valueCanonical ??
    task.focus?.reference;
  if (canonical) {
    return canonical.split("|", 1)[0].split("/").findLast(Boolean) ?? canonical;
  }

  return "Requested form";
}

/**
 * Statuses that end a request without answers.
 *
 * `src/fhir/taskCompletion.ts` treats these as final alongside `completed`, and for a *writer*
 * that is the right grouping: none of them may be overwritten. For a reader it is not, because
 * `completed` is the only one that means answers arrived - so these four are named separately here
 * rather than borrowing `isFinishedTaskStatus`, which would report a cancelled request as answered.
 */
const CLOSED_WITHOUT_ANSWERS: Partial<Record<Task["status"], true>> = {
  cancelled: true,
  rejected: true,
  failed: true,
  "entered-in-error": true,
};

/**
 * Which of the three states a Task's status means for a requester.
 *
 * Three rather than eleven, because the eleven FHIR statuses collapse to the only three questions a
 * requester asks of a sent request: is it answered, is it still open, or is it over.
 * @param status the Task's status as the server holds it
 * @returns the state to show
 */
export function requestState(status: Task["status"]): SentRequestState {
  if (status === "completed") {
    return "answered";
  }

  return CLOSED_WITHOUT_ANSWERS[status] === true ? "closed" : "awaiting";
}

/**
 * The reference to the answers a completed Task carries.
 *
 * Matched on the output type both completion paths write, then falling back to the first output
 * that references anything: a Task completed by some other client is still a request of ours that
 * has been answered, and refusing to show its answers because the slot was typed differently would
 * be a worse answer than showing them.
 * @param task the published Task
 * @returns the reference, or undefined when the Task names no answers
 */
function responseReferenceOf(task: Task): string | undefined {
  const outputs = task.output ?? [];
  const typed = outputs.find(
    (output) => output.type?.text === RESPONSE_OUTPUT_TYPE.text,
  );

  return (
    (typed ?? outputs.find((output) => output.valueReference?.reference))
      ?.valueReference?.reference ?? undefined
  );
}

/**
 * Turn the published Tasks into rows, newest first.
 *
 * A Task with no `identifier` is dropped rather than shown: the identifier is what a returning
 * filler names, so a Task without one can never be matched to answers and there is nothing useful
 * to say about it in a list of sent requests.
 * @param tasks the Tasks as the server returned them
 * @returns one row per identifiable Task, newest first
 */
export function describeSentRequests(tasks: Task[]): SentRequest[] {
  return tasks
    .flatMap((task) => {
      const id = taskCorrelationId(task);
      if (!id) {
        return [];
      }

      return [
        {
          id,
          taskId: task.id,
          label: labelFromTask(task),
          state: requestState(task.status),
          status: task.status,
          createdAt: task.authoredOn,
          subjectDisplay: task.for?.display,
          subjectReference: task.for?.reference,
          requesterDisplay: task.requester?.display,
          responseReference: responseReferenceOf(task),
        },
      ];
    })
    .toSorted((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
    );
}
