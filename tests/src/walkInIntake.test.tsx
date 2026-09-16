// @vitest-environment jsdom
/**
 * The walk-in queue, from the tag on the server to the write that files an item.
 *
 * Issue #21 asks for a printed code whose answers "arrive somewhere a human sees them before they
 * touch a patient record", and then for staff to attach those answers to a patient. Everything
 * about the first half is a tag search, and everything about the second half is one HTTP verb - so
 * those are what this file asserts, and it asserts them at the seams where getting them wrong
 * would be invisible.
 *
 * ## Why the verb is the test
 *
 * Every other review in this app *creates*: answers arrive on a link, this app has never stored
 * them, and accepting them writes a new resource. A walk-in is the one case where the answers are
 * already on the server before anybody looks at them, so accepting must **update what is there**.
 * Get that wrong and nothing fails, nothing errors, and the practice quietly accumulates two
 * QuestionnaireResponses for every walk-in: one belonging to nobody and one belonging to a patient.
 * A test at the payload would pass either way, which is exactly the gap issue #18 shipped through.
 * So the assertion is on the request the browser actually made.
 *
 * ## Why `ReviewResponse` is stood in for, once
 *
 * The first two cases mount the whole `/walk-ins` route with a fake server and read what the queue
 * handed the review component. That is the wiring - the tag it searched for, and whether the item
 * was declared as already stored - and it is the part a refactor can silently drop. The remaining
 * cases mount the real `ReviewResponse`, because the verb is its decision and nobody else's.
 * @author John Grimes
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Blob as NodeBlob } from "node:buffer";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Questionnaire, QuestionnaireResponse } from "fhir/r4";
import type { Root } from "react-dom/client";

/* jsdom's `Blob` has no `stream()`, which the compression in `src/link/binary.ts` uses. */
globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;

/*
 * The renderer stands in for itself. It is large, it wants a DOM jsdom does not provide, and its
 * internals are not what these cases are about.
 */
vi.mock("@aehrc/smart-forms-renderer", () => ({
  useBuildForm: () => false,
  useRendererQueryClient: () => new QueryClient(),
  destroyForm: () => {
    // Nothing to tear down: the store this would clear is not the real one.
  },
  RendererThemeProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  BaseRenderer: () => null,
  getResponse: () => ({
    resourceType: "QuestionnaireResponse",
    status: "completed",
  }),
  removeEmptyAnswersFromResponse: (
    _questionnaire: Questionnaire,
    response: QuestionnaireResponse,
  ) => response,
}));

/*
 * `ReviewResponse` records the props it was given, for the two wiring cases. The real component is
 * kept as the default import elsewhere in this file, so the mock is opt-in per case: `useReal` is
 * flipped by the cases that want the genuine save path.
 */
const { reviewProps, useReal } = vi.hoisted(() => ({
  reviewProps: [] as Record<string, unknown>[],
  useReal: { value: false },
}));

vi.mock("@/components/ReviewResponse", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ReviewResponse")>();
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      reviewProps.push(props);
      return useReal.value ? actual.default(props as never) : null;
    },
  };
});

import ReviewResponse from "@/components/ReviewResponse";
import { SHL_WALK_IN_TAG } from "@/link/invitationBundle";
import WalkIns from "@/routes/WalkIns";

/** The form the walk-in answered. */
const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-new-patient",
  url: "http://example.org/Questionnaire/new-patient",
  version: "1.0.0",
  status: "active",
  title: "New patient registration",
  item: [{ linkId: "name", type: "string", text: "Name" }],
};

/**
 * Answers as the facade left them: tagged, patient-asserted, belonging to nobody.
 *
 * All three of those are the point. The tag is how the queue found them, the security label is how
 * a reviewer knows nobody vouched for them, and the missing subject is the question the review
 * exists to answer.
 */
const WALK_IN: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  id: "qr-walk-in-1",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/new-patient",
  authored: "2026-09-16T09:15:00.000Z",
  meta: {
    versionId: "1",
    lastUpdated: "2026-09-16T09:15:01.000Z",
    security: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "PATAST",
      },
    ],
    tag: [{ ...SHL_WALK_IN_TAG }],
  },
  item: [{ linkId: "name", answer: [{ valueString: "Sam Rivers" }] }],
};

/** One request the browser made. */
interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/**
 * The URL a fetch is addressing, whichever of the three shapes it arrived in.
 * @param input what was passed to `fetch`
 * @returns the URL as a string
 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * A JSON response, as the fake server answers with.
 * @param body what to answer
 * @param status the status code
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/fhir+json" },
  });
}

/**
 * Let every pending query resolve.
 *
 * Ticked rather than awaited once: an open is a chain of queries, and the count that happened to
 * be enough on one run was not stable across runs. A test that fails on scheduling says nothing
 * about the code.
 */
async function settled(): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

describe("the walk-in queue", () => {
  let container: HTMLElement;
  let root: Root;
  let requests: Recorded[];

  beforeEach(() => {
    reviewProps.length = 0;
    useReal.value = false;
    requests = [];
    /* React needs telling that `act` is legitimate here, or every update warns. */
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
        });

        /* A launched session, so the requester gate lets the surface render. */
        if (url.endsWith("/api/session")) {
          return Promise.resolve(
            jsonResponse({
              issuer: "https://ehr.example.org/fhir",
              issuerLabel: "Demo Practice",
              patientId: null,
              userDisplay: "Dr Alex Fielding",
              fhirUser: "Practitioner/pr-1",
              grantedScopes: null,
              requestedScopes: null,
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        }
        if (url.includes("/api/standing-invitations")) {
          return Promise.resolve(jsonResponse({ standingInvitations: [] }));
        }
        if (url.includes("/QuestionnaireResponse?")) {
          return Promise.resolve(
            jsonResponse({
              resourceType: "Bundle",
              total: 1,
              entry: [{ resource: WALK_IN }],
            }),
          );
        }
        if (
          url.includes("/Questionnaire?") ||
          url.includes("/Questionnaire/")
        ) {
          return Promise.resolve(
            jsonResponse({
              resourceType: "Bundle",
              total: 1,
              entry: [{ resource: QUESTIONNAIRE }],
            }),
          );
        }
        /* The subject probe, and any read the review makes while reconciling. */
        if (url.includes("/Patient/")) {
          return Promise.resolve(
            jsonResponse({ resourceType: "Patient", id: "pt-new" }),
          );
        }
        if (url.includes("/QuestionnaireResponse/")) {
          return Promise.resolve(jsonResponse({ ...WALK_IN, meta: undefined }));
        }
        return Promise.resolve(jsonResponse({ resourceType: "Bundle" }));
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  /**
   * Render a tree and let its queries settle.
   * @param tree what to render
   */
  async function render(tree: React.ReactNode): Promise<void> {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/walk-ins"]}>
            <Routes>
              <Route path="/walk-ins" element={tree} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settled();
  }

  /**
   * Click the first button whose label contains this text.
   * @param text the text to look for
   * @throws {Error} when no such button is on screen
   */
  async function click(text: string): Promise<void> {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(
        `No button matching "${text}". On screen: ${[
          ...container.querySelectorAll("button"),
        ]
          .map((candidate) => candidate.textContent)
          .join(" | ")}`,
      );
    }
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await settled();
  }

  // The queue is one tag search, and that tag is the whole of "nobody has dealt with this yet".
  // A search by anything else - a missing subject, say - would also collect responses a clinician
  // recorded without one.
  it("finds the queue by the walk-in tag", async () => {
    await render(<WalkIns />);

    const search = requests.find((request) =>
      request.url.includes("/QuestionnaireResponse?"),
    );
    expect(search).toBeDefined();
    expect(decodeURIComponent(search!.url)).toContain(
      `_tag=${SHL_WALK_IN_TAG.system}|${SHL_WALK_IN_TAG.code}`,
    );
  });

  // The wiring that makes the save an update rather than a create, and the wiring that lets a
  // receptionist register somebody the practice has never met. Both are props, and a refactor
  // that drops either leaves a screen that still looks right.
  it("opens an item as already stored, and lets a new patient be registered", async () => {
    await render(<WalkIns />);
    await click("Review and attach");

    const props = reviewProps.at(-1);
    expect(props).toBeDefined();
    expect(props!.savedAs).toEqual({
      serverUrl: "/api/fhir",
      responseId: "qr-walk-in-1",
    });
    expect(props!.allowPatientCreation).toBe(true);
  });

  // The verb. These answers are already on the server, so filing them must replace what is there.
  // A `POST` would leave the practice with two records of one person filling in one form, and
  // nothing anywhere would report it.
  it("files an item by updating it where it already is", async () => {
    useReal.value = true;

    await render(
      <ReviewResponse
        response={WALK_IN}
        questionnaire={QUESTIONNAIRE}
        savedAs={{ serverUrl: "/api/fhir", responseId: "qr-walk-in-1" }}
        allowPatientCreation
      />,
    );
    requests.length = 0;
    await click("Attach and file");

    const written = requests.filter((request) =>
      request.url.includes("QuestionnaireResponse"),
    );
    expect(written).not.toHaveLength(0);
    expect(written[0].method).toBe("PUT");
    expect(written[0].url).toContain("/QuestionnaireResponse/qr-walk-in-1");
    expect(written.some((request) => request.method === "POST")).toBe(false);
  });

  // Filing an item is what takes it out of the queue, and the tag is the only thing that says so.
  // Leaving it on would mean a response that has been attached to a patient still appearing as
  // waiting for somebody to attach it.
  it("removes the walk-in tag when an item is filed", async () => {
    useReal.value = true;

    await render(
      <ReviewResponse
        response={WALK_IN}
        questionnaire={QUESTIONNAIRE}
        savedAs={{ serverUrl: "/api/fhir", responseId: "qr-walk-in-1" }}
        allowPatientCreation
      />,
    );
    requests.length = 0;
    await click("Attach and file");

    const written = requests.find((request) => request.method === "PUT");
    const sent = written?.body as QuestionnaireResponse | undefined;
    expect(sent).toBeDefined();
    expect(
      (sent!.meta?.tag ?? []).some((tag) => tag.code === SHL_WALK_IN_TAG.code),
    ).toBe(false);
    /*
     * The security label survives. Who asserted these answers did not change when a receptionist
     * worked out whose they were, and dropping it would file a stranger's typing as though a
     * clinician had recorded it.
     */
    expect(
      (sent!.meta?.security ?? []).some((coding) => coding.code === "PATAST"),
    ).toBe(true);
  });
});
