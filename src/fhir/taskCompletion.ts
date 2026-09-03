/**
 * Completing a request Task, shared by the two channels that do it.
 *
 * A request is a `Task` published on the launched server, and there are two ways its answers get
 * back: the filler posts them with a grant (`src/fill/directSend.ts`), or the filler hands the
 * requester a link and the requester accepts it (`src/fhir/submit.ts`). Both then have to say the
 * same thing about the same Task, because `/requests` derives entirely from those Tasks (FR-011) -
 * a request whose answers have landed by either route has to read as completed.
 *
 * So the shape lives here rather than in either caller. What goes back is the version just read,
 * changed in exactly the two members a completion is about, conditional on that version. Nothing
 * in this module performs a request or knows how one is authorised: the direct send presents a
 * grant to the destination and the requester goes through the session proxy, and those are the
 * only two differences between them.
 *
 * Deliberately free of imports beyond FHIR types. `src/fhir/submit.ts` is bundled into
 * `scripts/roundtrip.ts` and `src/fill/directSend.ts` into the SPA, so anything reachable from
 * here is reachable from both.
 * @author John Grimes
 */

import type { Task } from "fhir/r4";

/**
 * `Task.output` slot naming the answers.
 *
 * The same three words `src/link/exchange.ts` writes into the returned Bundle's Task, so a
 * completion made here is indistinguishable from one made there.
 */
export const RESPONSE_OUTPUT_TYPE = { text: "questionnaire-response" } as const;

/**
 * Task states a completion must leave alone.
 *
 * FR-022: neither channel may overwrite a Task the clinic has since moved to another state. A
 * Task already completed, cancelled, rejected, failed or marked in error has been decided by
 * someone with more context than a filler or a reviewer of one set of answers has, and a `PUT`
 * would erase that decision.
 */
const FINISHED_TASK_STATUSES: Partial<Record<Task["status"], true>> = {
  completed: true,
  cancelled: true,
  rejected: true,
  failed: true,
  "entered-in-error": true,
};

/**
 * Whether a Task has already been decided, and so must not be written to.
 * @param status the status as the server holds it
 * @returns true when the state is final and the Task must be left exactly as it is
 * @example
 * if (isFinishedTaskStatus(task.status)) return;
 */
export function isFinishedTaskStatus(status: Task["status"]): boolean {
  return FINISHED_TASK_STATUSES[status] === true;
}

/**
 * The `If-Match` value naming the version just read.
 *
 * The ETag is the server's own statement of which version it just returned, which is exactly what
 * `If-Match` needs; `meta.versionId` is the same fact from inside the resource, for a server that
 * did not send one. Without either there is no way to make the completion conditional, and an
 * unconditional `PUT` is the blind overwrite FR-022 forbids - so the answer is `undefined` and the
 * caller must not write.
 * @param task the Task as read
 * @param etag the `ETag` response header, when the server sent one
 * @returns the weak ETag to send as `If-Match`, or undefined when the version is unknown
 * @example
 * const ifMatch = taskIfMatch(task, response.headers.get("ETag"));
 */
export function taskIfMatch(
  task: Task,
  etag?: string | null,
): string | undefined {
  if (etag?.startsWith("W/")) {
    return etag;
  }

  const versionId = task.meta?.versionId;
  return versionId === undefined ? undefined : `W/"${versionId}"`;
}

/**
 * The Task as it goes back: the version read, completed, with the answers appended as an output.
 *
 * A whole-resource `PUT` of the version read, rather than a minimal Task, because the alternative
 * erases the requester's own identifier, `for` and `requester` from their own Task - the opposite
 * of completing it.
 * @param task the Task exactly as the server holds it
 * @param responseReference reference to the answers, absolute, relative or `urn:uuid:`
 * @returns the Task to `PUT`
 * @example
 * completedTask(read, "QuestionnaireResponse/qr-1");
 */
export function completedTask(task: Task, responseReference: string): Task {
  return {
    ...task,
    status: "completed",
    output: [
      ...(task.output ?? []),
      {
        type: RESPONSE_OUTPUT_TYPE,
        valueReference: { reference: responseReference },
      },
    ],
  };
}
