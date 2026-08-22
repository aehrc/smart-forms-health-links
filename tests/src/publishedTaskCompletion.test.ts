/**
 * Closing the request when the answers come back as a link.
 *
 * `/requests` derives entirely from the request Tasks published on the launched server (FR-011),
 * so a request whose answers have landed has to read as completed there - by whichever channel
 * they landed. The direct send does that inside its transaction. The scan-back return, which is
 * the fallback FR-028 keeps alive, has to do the same thing with the requester's own session
 * authority: read the *published* Task the returned Bundle names, and `PUT` it completed,
 * conditional on the version just read.
 *
 * What is being pinned down here, case by case:
 *
 *  - the published Task is completed, conditionally, when the returned Task names one on the
 *    server this session is signed in to;
 *  - nothing is written when it names one somewhere else, or names none at all, because a link
 *    this deployment did not mint is still perfectly acceptable;
 *  - a Task the clinic has already decided is left exactly as it was, and the reviewer is told so
 *    rather than told it was completed;
 *  - and the answers are stored in every one of those cases, because the clinical content is the
 *    response and the request's state is bookkeeping around it.
 *
 * Exercised through {@link submitResponse} rather than through the private completion helper: what
 * matters is which requests reach the server and what they carry, which is the same thing a
 * reviewer's click produces.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LaunchedServer } from "@/fhir/submit";
import type { QuestionnaireResponse, Task } from "fhir/r4";
import type { Mock } from "vitest";

import { submitResponse } from "@/fhir/submit";
import {
  completedTask,
  isFinishedTaskStatus,
  taskIfMatch,
} from "@/fhir/taskCompletion";
import { FHIR_PROXY_BASE } from "@/lib/session";
import { buildResponseBundle } from "@/link/exchange";
import {
  PLATYPUS_SERVER_TASK_URL_EXTENSION,
  buildServerTaskUrlExtension,
  parseServerTaskUrl,
} from "@/link/replyDescriptor";

/** The launched server, as `GET /api/session` describes it. */
const LAUNCHED: LaunchedServer = {
  issuer: "https://ehr.test/fhir",
  label: "Demo Aidbox",
};

/** Where the request's Task actually lives. */
const PUBLISHED_TASK_URL = `${LAUNCHED.issuer}/Task/t-1`;

const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/q-715|1.0.0",
  item: [{ linkId: "q1", answer: [{ valueBoolean: true }] }],
};

/**
 * The Task as it comes back inside the response link: the request's Task, completed, naming the
 * published copy it is a completion of.
 * @param overrides members to change
 * @returns the returned Task
 */
function returnedTask(overrides: Partial<Task> = {}): Task {
  return {
    resourceType: "Task",
    status: "completed",
    intent: "order",
    identifier: [{ system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" }],
    for: { reference: "Patient/pt-demo", display: "Jane Citizen" },
    requester: { display: "Dr Alex Fielding" },
    extension: [buildServerTaskUrlExtension(PUBLISHED_TASK_URL)],
    ...overrides,
  };
}

/**
 * The Task as the launched server holds it: still awaiting answers, with a version.
 * @param overrides members to change
 * @returns the published Task
 */
function publishedTask(overrides: Partial<Task> = {}): Task {
  return {
    resourceType: "Task",
    id: "t-1",
    meta: { versionId: "3", tag: [{ code: "shl-form-request" }] },
    status: "requested",
    intent: "order",
    identifier: [{ system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" }],
    for: { reference: "Patient/pt-demo", display: "Jane Citizen" },
    requester: { reference: "Practitioner/prac-demo", display: "Dr Fielding" },
    ...overrides,
  };
}

describe("the returned link carries the published Task's address", () => {
  /*
   * The regression this whole fix rests on. `buildResponseBundle` used to drop every extension,
   * which took the reply descriptor's capability out of an unencrypted QR - right - and the
   * request's own Task address with it - wrong, because that address is the only way back to the
   * Task that has to be completed.
   */
  it("keeps invitation-server-task-url on the way back", () => {
    const { task } = buildResponseBundle(ANSWERS, returnedTask());

    expect(parseServerTaskUrl(task)).toBe(PUBLISHED_TASK_URL);
  });

  // The other half of the same decision: a write capability must not travel back.
  it("still drops the reply descriptor's capability", () => {
    const request = returnedTask({
      extension: [
        {
          url: "http://smartforms.csiro.au/StructureDefinition/shl-reply-descriptor",
          extension: [
            {
              url: "replyUrl",
              valueUrl: "https://slot.test/reply/1",
            },
            { url: "replyToken", valueString: "secret-token" },
          ],
        },
        buildServerTaskUrlExtension(PUBLISHED_TASK_URL),
      ],
    });

    const { bundle, task } = buildResponseBundle(ANSWERS, request);

    expect(task?.extension).toEqual([
      {
        url: PLATYPUS_SERVER_TASK_URL_EXTENSION,
        valueUrl: PUBLISHED_TASK_URL,
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain("secret-token");
  });

  // A request that named no Task on a server leaves no extension behind at all.
  it("carries no extension when the request named no Task", () => {
    const { task } = buildResponseBundle(
      ANSWERS,
      returnedTask({ extension: undefined }),
    );

    expect(task?.extension).toBeUndefined();
  });
});

describe("the shared completion shape", () => {
  it("treats every decided state as one to leave alone", () => {
    const finished: Task["status"][] = [
      "completed",
      "cancelled",
      "rejected",
      "failed",
      "entered-in-error",
    ];

    expect(finished.map((status) => isFinishedTaskStatus(status))).toEqual(
      finished.map(() => true),
    );

    const open: Task["status"][] = [
      "requested",
      "accepted",
      "in-progress",
      "on-hold",
    ];
    expect(open.map((status) => isFinishedTaskStatus(status))).toEqual(
      open.map(() => false),
    );
  });

  /*
   * The ETag is the server's own statement of what it just returned, so it wins. `meta.versionId`
   * is the same fact from inside the resource, for a server that sent no header.
   */
  it("prefers the ETag over the resource's own version", () => {
    expect(taskIfMatch(publishedTask(), 'W/"7"')).toBe('W/"7"');
    expect(taskIfMatch(publishedTask(), null)).toBe('W/"3"');
    expect(taskIfMatch(publishedTask(), "not-a-weak-etag")).toBe('W/"3"');
    expect(taskIfMatch(publishedTask({ meta: undefined }))).toBeUndefined();
  });

  /*
   * A whole-resource PUT of what was read, changed in exactly the two members a completion is
   * about. A minimal Task would erase the requester's own identifier, `for` and `requester`.
   */
  it("changes only the status and the output", () => {
    const read = publishedTask({
      output: [{ type: { text: "note" }, valueString: "earlier" }],
    });

    const written = completedTask(read, "QuestionnaireResponse/qr-1");

    expect(written.status).toBe("completed");
    expect(written.identifier).toEqual(read.identifier);
    expect(written.for).toEqual(read.for);
    expect(written.requester).toEqual(read.requester);
    expect(written.meta).toEqual(read.meta);
    expect(written.output).toEqual([
      { type: { text: "note" }, valueString: "earlier" },
      {
        type: { text: "questionnaire-response" },
        valueReference: { reference: "QuestionnaireResponse/qr-1" },
      },
    ]);
  });
});

/**
 * The URL of a fetch call, however the caller spelled it.
 * @param input the first argument the call was made with
 * @returns the URL as a string
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

describe("accepting scanned-back answers", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Every request made, as method and URL.
   * @returns one `[method, url]` pair per call, in order
   */
  function requested(): [string, string][] {
    return fetchMock.mock.calls.map(([input, init]) => [
      init?.method ?? "GET",
      urlOf(input),
    ]);
  }

  /** The one PUT made, if any. */
  function putCall(): RequestInit | undefined {
    return fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1];
  }

  /**
   * The body of the one PUT made, parsed.
   * @returns the Task that was sent back
   */
  function putBody(): Task {
    return JSON.parse((putCall()?.body ?? "{}") as string) as Task;
  }

  /**
   * The `If-Match` sent on the one PUT made.
   * @returns the header value, or undefined when no PUT was made
   */
  function putIfMatch(): string | undefined {
    return (putCall()?.headers as Record<string, string> | undefined)?.[
      "If-Match"
    ];
  }

  /**
   * Stand in for the launched server: creates succeed, the Task reads as given, the PUT succeeds.
   * @param options what the Task read should return
   * @param options.task the Task the server holds, or undefined for a 404
   * @param options.etag the ETag to return with it
   * @param options.putStatus the status the conditional update answers with
   */
  function serving(options: {
    task?: Task;
    etag?: string;
    putStatus?: number;
  }): void {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";

      if (method === "POST") {
        return Promise.resolve(
          Response.json(
            { resourceType: url.split("/").pop(), id: "created-1" },
            { status: 201 },
          ),
        );
      }
      if (method === "PUT") {
        const status = options.putStatus ?? 200;
        return Promise.resolve(
          status === 200
            ? Response.json(JSON.parse((init?.body ?? "{}") as string), {
                status,
              })
            : Response.json(
                { resourceType: "OperationOutcome", issue: [] },
                { status },
              ),
        );
      }
      if (options.task === undefined) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      return Promise.resolve(
        Response.json(options.task, {
          status: 200,
          headers: options.etag ? { ETag: options.etag } : {},
        }),
      );
    });
  }

  /*
   * The fix. The published Task is read through the session proxy and put back completed,
   * conditional on the version read - not copied with a POST, which left the published Task
   * reading "awaiting answers" forever while a second row appeared beside it.
   */
  it("completes the published Task named on the session's issuer", async () => {
    serving({ task: publishedTask(), etag: 'W/"3"' });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("completed");
    expect(outcome.task.taskId).toBe("t-1");
    expect(outcome.task.detail).toMatch(/Demo Aidbox/);
    expect(outcome.task.detail).toMatch(/completed/i);

    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
      ["GET", `${FHIR_PROXY_BASE}/Task/t-1`],
      ["PUT", `${FHIR_PROXY_BASE}/Task/t-1`],
    ]);
    expect(putIfMatch()).toBe('W/"3"');

    /*
     * The `If-Match` is only honest if it came from a read that actually happened. A cached body
     * revalidated behind the app's back would describe a version the server has moved past - and
     * Aidbox answers a conditional GET with a 500 rather than a 304, so the read would not even
     * survive it.
     */
    const readInit = fetchMock.mock.calls.find(
      ([, init]) => (init?.method ?? "GET") === "GET",
    )?.[1];
    expect(readInit?.cache).toBe("no-store");

    // The identity the requester gave their own Task survives the completion.
    const written = putBody();
    expect(written.id).toBe("t-1");
    expect(written.status).toBe("completed");
    expect(written.identifier).toEqual(publishedTask().identifier);
    expect(written.requester).toEqual(publishedTask().requester);
    expect(written.output).toEqual([
      {
        type: { text: "questionnaire-response" },
        valueReference: { reference: "QuestionnaireResponse/created-1" },
      },
    ]);
  });

  // No ETag header is not a reason to refuse: the resource states its own version.
  it("falls back to the read Task's own version for If-Match", async () => {
    serving({ task: publishedTask() });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.task.kind).toBe("completed");
    expect(putIfMatch()).toBe('W/"3"');
  });

  /*
   * A link somebody else's deployment minted. Its Task lives on their server, which this session
   * has no business writing to - and the answers are still worth storing.
   */
  it("writes no Task when the address is on another origin", async () => {
    serving({ task: publishedTask() });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask({
        extension: [
          buildServerTaskUrlExtension("https://elsewhere.test/fhir/Task/t-9"),
        ],
      }),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("skipped");
    expect(outcome.task.detail).toMatch(/elsewhere\.test/);
    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
    ]);
  });

  /*
   * The third-party case the review asked to keep working: a returned link whose Task names no
   * server-side URL at all still stores the answers, and says plainly that nothing was closed.
   */
  it("writes no Task when the returned Task names none", async () => {
    serving({ task: publishedTask() });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask({ extension: undefined }),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("skipped");
    expect(outcome.task.detail).toMatch(/no request on any server/i);
    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
    ]);
  });

  // And answers with no Task at all - a bare QuestionnaireResponse link.
  it("writes no Task when no Task came back at all", async () => {
    serving({ task: publishedTask() });

    const outcome = await submitResponse({
      response: ANSWERS,
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("skipped");
    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
    ]);
  });

  /*
   * FR-022, from the requester's side this time. The clinic cancelled the request while it was
   * out; overwriting that would erase a decision made with more context than this screen has.
   */
  it("leaves a cancelled request exactly as it is", async () => {
    serving({ task: publishedTask({ status: "cancelled" }), etag: 'W/"4"' });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("unchanged");
    expect(outcome.task.detail).toMatch(/already cancelled/i);
    // Nothing may claim it was completed.
    expect(outcome.task.detail).not.toMatch(/now marked completed/i);
    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
      ["GET", `${FHIR_PROXY_BASE}/Task/t-1`],
    ]);
  });

  // The same rule for a request somebody has already answered.
  it("leaves an already completed request exactly as it is", async () => {
    serving({ task: publishedTask({ status: "completed" }), etag: 'W/"4"' });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("unchanged");
    expect(outcome.task.detail).toMatch(/already completed/i);
    expect(requested().some(([method]) => method === "PUT")).toBe(false);
  });

  /*
   * The conditional losing is the same situation arriving a moment later: somebody changed the
   * Task between the read and the write. Reported as unchanged, because that is what it is.
   */
  it("reports a lost conditional update as unchanged", async () => {
    serving({ task: publishedTask(), etag: 'W/"3"', putStatus: 412 });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("unchanged");
    expect(outcome.task.detail).toMatch(/changed while these answers/i);
  });

  /*
   * A refused update is a failure rather than a silent skip, and the report has to leave the
   * reviewer in no doubt that the answers themselves are safe.
   */
  it("reports a refused update as a failure, with the answers still stored", async () => {
    serving({ task: publishedTask(), etag: 'W/"3"', putStatus: 403 });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("failed");
    expect(outcome.task.detail).toMatch(/answers are stored/i);
  });

  // A Task that is not there any more cannot be completed, and the answers are still stored.
  it("reports a missing Task as a failure", async () => {
    serving({});

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
      launchedServer: LAUNCHED,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("failed");
    expect(requested().some(([method]) => method === "PUT")).toBe(false);
  });

  /*
   * Without a session there is no authority to write with, and the answers went somewhere the
   * caller nominated. Reported rather than attempted.
   */
  it("writes no Task when the session names no launched server", async () => {
    serving({ task: publishedTask() });

    const outcome = await submitResponse({
      response: ANSWERS,
      task: returnedTask(),
      responseServerUrl: FHIR_PROXY_BASE,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.task.kind).toBe("skipped");
    expect(requested()).toEqual([
      ["POST", `${FHIR_PROXY_BASE}/QuestionnaireResponse`],
    ]);
  });
});
