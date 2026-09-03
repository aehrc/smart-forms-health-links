// @vitest-environment jsdom
/**
 * The fallback channel, end to end: the filler mints a link, the requester scans it, the answers
 * are written with the requester's own session (FR-028).
 *
 * This is a regression test rather than a feature test. Everything here worked before the
 * confidential-app feature began, and two of the feature's own changes could plausibly have
 * broken it: the third-party blob host the filler used to park its encrypted payload on went with
 * anonymous mode (FR-030), and every requester write moved onto the session proxy (FR-007). The
 * fallback is what the expired and refused states promote people towards, so it has to be intact
 * for those states to be honest rather than a dead end.
 *
 * ## Why the link is inline
 *
 * A filler holds a link and nothing else - no session, no server, no account. Hosting a payload
 * is something only the requester's half of this deployment can do, and its public surface is
 * fixed: `contracts/http-api.md` lists exactly which routes answer without a session, and none of
 * them takes a payload. So the filler's return travels the only way it can, inside the fragment.
 * That is what `sfhl:/` was built for, and the price - the answers are compressed but not
 * encrypted, so whoever sees the QR can read them - is stated on the surface that shows it.
 *
 * ## The four seams
 *
 * Minting, decoding, `/scan`'s dispatch, and the write. They are tested as seams rather than
 * through one rendered flow because the flow spans two browsers in two sessions, which is
 * Playwright's job (`e2e/`), and because a seam test says which half broke.
 * @author John Grimes
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Blob as NodeBlob } from "node:buffer";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/lib/config";
import type {
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";
import type { Root } from "react-dom/client";
import type { Mock } from "vitest";

/*
 * jsdom's `Blob` has no `stream()`, which the compression in `src/link/binary.ts` uses and every
 * browser provides. Node's does, so the DOM's is replaced here rather than the code being written
 * around a gap that only exists in the test environment.
 */
globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;

/*
 * The renderer holds the answers in a module-level store that only a mounted form populates.
 * Standing in for it keeps this test to the link layer, and keeps the renderer - which is large,
 * and needs a DOM it is not being given here - out of the module graph. Hoisted, because the
 * factory runs while `@/link/createLink` is being imported, which is before this module's own
 * top-level constants exist.
 */
const { ANSWERS } = vi.hoisted(() => ({
  ANSWERS: {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    authored: "2026-08-22T01:02:03.000Z",
    item: [
      {
        linkId: "q1",
        text: "Any chest pain?",
        answer: [{ valueBoolean: true }],
      },
    ],
  } satisfies QuestionnaireResponse,
}));

vi.mock("@aehrc/smart-forms-renderer", () => ({
  getResponse: () => ANSWERS,
  removeEmptyAnswersFromResponse: (
    _questionnaire: Questionnaire,
    response: QuestionnaireResponse,
  ) => response,
}));

import ReviewResponse from "@/components/ReviewResponse";
import { submitResponse } from "@/fhir/submit";
import { FHIR_PROXY_BASE, isSessionEnded } from "@/lib/session";
import { decodingCodec } from "@/link/codec";
import { createResponseLink } from "@/link/createLink";
import { parseResponseBundle, taskCorrelationId } from "@/link/exchange";
import { LINK_CODECS } from "@/link/registry";
import Scan from "@/routes/Scan";

const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-715",
  url: "http://example.org/Questionnaire/q-715",
  version: "1.0.0",
  status: "active",
  title: "Adult sepsis screening",
  item: [{ linkId: "q1", type: "boolean", text: "Any chest pain?" }],
};

/** The request the answers came back for. */
const REQUEST_TASK: Task = {
  resourceType: "Task",
  status: "requested",
  intent: "order",
  identifier: [{ system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" }],
  for: { reference: "Patient/pt-demo", display: "Jane Citizen" },
  requester: { display: "Dr Alex Fielding" },
};

/** A configuration with no hosting in it, because the filler has none to configure. */
const CONFIG: AppConfig = {
  terminologyServerUrl: "https://r4.ontoserver.csiro.au/fhir",
  linkCodec: "shl",
  linkBaseUrl: null,
  senderName: null,
  linkLifetimeDays: 30,
  // Every capability off: this is the filler's side, which mints nothing and writes nowhere.
  enableOneShotWrite: false,
  enableWriteBack: false,
  enablePrePopulate: false,
  publishRequestTasks: false,
};

describe("the filler mints its own link", () => {
  /*
   * The link is a viewer URL at this app's own origin with the payload in the fragment. The
   * fragment matters: it is the half of a URL a browser never sends to a server, which is what
   * makes an inline payload defensible at all.
   */
  it("mints a self-contained link at the app's own origin", async () => {
    const link = await createResponseLink(QUESTIONNAIRE, CONFIG, REQUEST_TASK);

    expect(link.startsWith(`${globalThis.location.origin}/view#sfhl:/`)).toBe(
      true,
    );
  });

  // No hosting, so nothing is fetched: a filler with no network can still hand the answers back.
  it("mints without contacting anything", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await createResponseLink(QUESTIONNAIRE, CONFIG, REQUEST_TASK);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // The whole point of the fallback: what went in comes out on the requester's side.
  it("carries the completed answers and the request they answer", async () => {
    const link = await createResponseLink(QUESTIONNAIRE, CONFIG, REQUEST_TASK);

    const codec = decodingCodec(link, LINK_CODECS);
    expect(codec.id).toBe("bespoke");

    const opened = await codec.decode(link);
    const { response, task } = parseResponseBundle(opened.bundle);

    expect(response.status).toBe("completed");
    expect(response.item?.[0]?.answer?.[0]?.valueBoolean).toBe(true);
    // The canonical is stamped on so the requester knows which form was answered.
    expect(response.questionnaire).toBe(
      "http://example.org/Questionnaire/q-715|1.0.0",
    );
    // ...and the correlation identifier survives, which is what matches these answers to the request.
    expect(taskCorrelationId(task)).toBe("urn:uuid:request-1");
    expect(task?.status).toBe("completed");
  });

  /*
   * A filler answering a form nobody asked for - `/fill/:id` rather than an invitation - has no
   * Task to correlate, and that must not stop the answers coming back.
   */
  it("mints a link with no request to correlate against", async () => {
    const link = await createResponseLink(QUESTIONNAIRE, CONFIG);

    const opened = await decodingCodec(link, LINK_CODECS).decode(link);
    const { response, task } = parseResponseBundle(opened.bundle);

    expect(response.status).toBe("completed");
    expect(task).toBeUndefined();
  });
});

describe("the requester scans it", () => {
  let container: HTMLElement;
  let root: Root;
  /** Where the app navigated to, as the viewer route would see it. */
  let landed: { pathname: string; hash: string } | null;

  /**
   * Stands in for the viewer, so the test can see where `/scan` sent the link.
   * @returns nothing; the location is recorded for the test to assert on
   */
  function Landed(): null {
    const location = useLocation();
    landed = { pathname: location.pathname, hash: location.hash };
    return null;
  }

  /**
   * Type into the paste box the way a user does, so React sees the change.
   * @param value the link being pasted
   * @throws {Error} when the surface has no paste box, which would pass every later assertion
   */
  function paste(value: string): void {
    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("The scan surface offered no paste box.");
    }

    /*
     * Through the prototype's setter, not `textarea.value = value`. React keeps its own record of
     * the last value it saw and skips an input event whose value it believes it already has, so a
     * direct assignment is silently ignored - which is what a user typing does not do.
     */
    const nativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    );
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with `textarea` as its receiver on the next line
      const setValue = nativeValue?.set;
      setValue?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Click the first button whose text contains a fragment.
   * @param text the fragment to look for, case-insensitively
   * @throws {Error} when no button matches
   */
  function click(text: string): void {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.toLowerCase().includes(text.toLowerCase()),
    );
    if (!button) {
      throw new Error(`No button matching "${text}".`);
    }

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    landed = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/scan"]}>
          <Routes>
            <Route path="/scan" element={<Scan />} />
            <Route path="/view" element={<Landed />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // The requester's entry point for the fallback: paste what the patient's screen shows.
  it("routes a pasted inline link to the viewer, fragment intact", async () => {
    const link = await createResponseLink(QUESTIONNAIRE, CONFIG, REQUEST_TASK);

    paste(link);
    click("open link");

    expect(landed?.pathname).toBe("/view");
    expect(landed?.hash.startsWith("#sfhl:/")).toBe(true);
    // Only the fragment is kept, so a link minted against another origin still opens here.
    expect(landed?.hash).toBe(`#${link.split("#", 2)[1]}`);
  });

  // Anything that is not a link this app understands is refused rather than opened blankly.
  it("refuses text that carries no link", () => {
    paste("https://example.org/not-a-link");
    click("open link");

    expect(landed).toBeNull();
    expect(container.textContent).toMatch(/not a smart forms link/i);
  });
});

/**
 * The URL a request was made to, whichever form `fetch` was handed it in.
 * @param input the first argument of a `fetch` call
 * @returns the URL as a string
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

describe("the requester accepts the answers", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PROVENANCE: Provenance = {
    resourceType: "Provenance",
    target: [{ reference: "urn:uuid:answers" }],
    recorded: "2026-08-22T01:02:03.000Z",
    agent: [{ who: { reference: "Patient/pt-demo" } }],
  };

  /**
   * Answer every create with a stored resource.
   * @param id the id the server assigns
   */
  function accepting(id = "created-1"): void {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          { resourceType: urlOf(input).split("/").pop(), id },
          { status: 201 },
        ),
      ),
    );
  }

  /*
   * FR-007: the write happens with the session's authority, which the browser does not hold. So
   * every request goes to the BFF's proxy rather than to the launched server directly, and no
   * request carries an Authorization header of its own.
   *
   * The request Task here names no server-side URL, which is the third-party case: the answers and
   * their attribution are written, and no Task is touched. Completing a published Task is covered
   * by `publishedTaskCompletion.test.ts`.
   */
  it("writes the response and its provenance through the session proxy", async () => {
    accepting();

    const outcome = await submitResponse({
      response: ANSWERS,
      task: { ...REQUEST_TASK, status: "completed" },
      provenance: PROVENANCE,
      responseServerUrl: FHIR_PROXY_BASE,
    });

    expect(outcome.results[0]?.responseId).toBe("created-1");
    expect(outcome.results[0]?.provenanceId).toBe("created-1");
    expect(outcome.task.kind).toBe("skipped");

    const requested = fetchMock.mock.calls.map(([url, init]) => [
      urlOf(url),
      init?.method,
    ]);
    expect(requested).toEqual([
      [`${FHIR_PROXY_BASE}/QuestionnaireResponse`, "POST"],
      [`${FHIR_PROXY_BASE}/Provenance`, "POST"],
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).not.toHaveProperty("Authorization");
    }
  });

  /*
   * The session dying during review is the edge case the spec calls out: a person can spend as
   * long as they like reading answers before accepting them. The write must then ask for a fresh
   * launch, not report a FHIR error the reviewer can do nothing with.
   */
  it("asks for a re-launch when the session died during the review", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "session-expired" }, { status: 401 }),
    );

    const thrown = await submitResponse({
      response: ANSWERS,
      responseServerUrl: FHIR_PROXY_BASE,
    }).then(
      () => {},
      (error: unknown) => error,
    );

    expect(isSessionEnded(thrown)).toBe(true);
  });

  /*
   * The distinction that keeps the re-launch prompt meaningful. A 401 the proxy passed through
   * from the launched server is that server refusing an intact session, and signing in again
   * would change nothing - so it is reported as a failure against that destination instead.
   */
  it("reports an upstream refusal as a failure, not as a lost session", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "forbidden",
              diagnostics: "Access denied by policy",
            },
          ],
        },
        { status: 401 },
      ),
    );

    const outcome = await submitResponse({
      response: ANSWERS,
      responseServerUrl: FHIR_PROXY_BASE,
    });

    expect(outcome.results[0]?.error).toMatch(/access denied by policy/i);
    expect(outcome.results[0]?.responseId).toBeUndefined();
  });
});

/**
 * Who the answers are about, when the answers themselves do not say.
 *
 * An anonymous filler has no patient context, so a scanned-back `QuestionnaireResponse` routinely
 * arrives with no `subject` at all - and a response filed against nobody is worse than one the
 * destination server rejects, because nothing objects to it. The returned Task is what closes that
 * gap: it is the requester's own invitation Task come back, so its `for` still names the patient
 * the request was addressed to, on the requester's own server.
 *
 * This used to be answered from a browser-local record of the mint, which no longer exists -
 * minting is a server operation now. Asserting it against the Task is what makes the shortcut work
 * for a request any colleague sent, not only one this browser sent.
 */
describe("the requester reconciles the patient", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    /*
     * No session and no patients: the review screen asks both questions on mount, and neither
     * answer changes what is under test. A 401 from `/api/session` is the "not signed in" answer
     * rather than a failure, so nothing here depends on an unhandled rejection.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          urlOf(input).includes("/api/session")
            ? Response.json({ error: "no-session" }, { status: 401 })
            : Response.json({ resourceType: "Bundle", total: 0 }),
        ),
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /**
   * Render the review screen over answers that name nobody.
   *
   * The Questionnaire is deliberately unresolved: it keeps the renderer out of the tree, and it is
   * the honest case for a form the reviewer's server does not hold anyway.
   * @param task the Task that came back with the answers, if any
   */
  function review(task?: Task): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <ReviewResponse
            response={ANSWERS}
            questionnaireError="This form could not be resolved."
            task={task}
          />
        </QueryClientProvider>,
      );
    });
  }

  /**
   * Click the first button whose text contains a fragment.
   * @param text the fragment to look for, case-insensitively
   * @throws {Error} when no button matches
   */
  function clickButton(text: string): void {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.toLowerCase().includes(text.toLowerCase()),
    );
    if (!button) {
      throw new Error(`No button matching "${text}".`);
    }

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  // The affordance itself: the request's own patient, offered as one click.
  it("offers the patient the request was addressed to", () => {
    review({ ...REQUEST_TASK, status: "completed" });

    expect(container.textContent).toContain("Patient/pt-demo");
    expect(container.textContent).toContain("Jane Citizen");

    clickButton("use that patient");

    expect(
      container.querySelector<HTMLInputElement>("#subject-override")?.value,
    ).toBe("Patient/pt-demo");
  });

  /*
   * A request addressed to nobody - legal, and what `/fill/:id` produces - has nothing to offer,
   * so the screen must not offer an empty shortcut. The search remains.
   */
  it("offers no shortcut when the request named no patient", () => {
    review({ ...REQUEST_TASK, for: undefined, status: "completed" });

    expect(container.textContent).not.toContain("Use that patient");
    expect(container.querySelector("#subject-override")).not.toBeNull();
  });

  /*
   * The copy that went with the deleted store said the answers were "not one this browser sent, so
   * there is no local record to match it against". Nothing is browser-local any more, so nothing
   * may say so: what the screen knows is the request the answers cite.
   */
  it("names the request without appealing to a browser-local record", () => {
    review({ ...REQUEST_TASK, status: "completed" });

    expect(container.textContent).toContain("urn:uuid:request-1");
    expect(container.textContent).not.toMatch(/local record|this browser/i);
  });

  // Answers with no Task at all cannot be tied to a request, and the screen says exactly that.
  it("says so when no request came back with the answers", () => {
    review();

    expect(container.textContent).toMatch(/no task accompanied these answers/i);
    expect(container.textContent).not.toMatch(/local record|this browser/i);
  });
});
