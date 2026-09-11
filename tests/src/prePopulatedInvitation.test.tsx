// @vitest-environment jsdom
/**
 * A pre-populated invitation, from the sealed payload to the fields on the filler's screen.
 *
 * Issue #18: a request minted with "Fill this in from the record first" arrived with its answers
 * intact and rendered a blank form. The Bundle was never wrong. `ViewLink` opened it with
 * `const { questionnaire, task } = parseRequestBundle(...)`, and the third field - the seed - was
 * dropped on the floor by the destructure, so the renderer was handed a form and no answers.
 *
 * The feature's own end-to-end check could not have caught that, and it is worth being precise
 * about why, because the same shape of gap is easy to leave again. `scripts/e2ePopulate.ts`
 * populates from a real record, seals a request, decodes it, and asserts the seed survives - and
 * it stops there, at `parseRequestBundle`, which is the last point at which everything was still
 * correct. Nothing downstream of the payload was covered by anything.
 *
 * So the assertion here is deliberately made at the renderer's door rather than at the payload's:
 * what matters is that the answers reach `useBuildForm`, because that is the call that decides
 * whether a field opens filled in or empty. The renderer itself is stood in for - it is large, it
 * wants a DOM it is not being given, and its internals are not what broke.
 *
 * ## Why the link is inline
 *
 * A real invitation is a hosted `shlink:/` manifest, which would mean a server and a fetch. The
 * defect sits downstream of the decode, where both transports have already converged on the same
 * Bundle, so the inline `sfhl:/` codec exercises the same path with none of the hosting. The
 * manifest leg has its own coverage in `scripts/e2eShl.ts`.
 * @author John Grimes
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Blob as NodeBlob } from "node:buffer";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bundle, Questionnaire, QuestionnaireResponse } from "fhir/r4";
import type { Root } from "react-dom/client";

/* jsdom's `Blob` has no `stream()`, which the compression in `src/link/binary.ts` uses. */
globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;

/*
 * The renderer stands in for itself, recording what it was asked to build. `buildCalls` is the
 * whole point of the mock: the question this file asks is "what did the form get built from",
 * and that argument is the answer. Hoisted, because the factory runs while the component under
 * test is being imported.
 */
const { buildCalls } = vi.hoisted(() => ({
  buildCalls: [] as { questionnaireResponse?: QuestionnaireResponse }[],
}));

vi.mock("@aehrc/smart-forms-renderer", () => ({
  useBuildForm: (args: { questionnaireResponse?: QuestionnaireResponse }) => {
    buildCalls.push(args);
    return false;
  },
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

import { bespokeCodec } from "@/link/bespokeCodec";
import { parseRequestBundle } from "@/link/exchange";
import { buildInvitationBundle } from "@/link/invitationBundle";
import ViewLink from "@/routes/ViewLink";

const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-gpccmp",
  url: "http://example.org/Questionnaire/q-gpccmp",
  version: "1.0.0",
  status: "active",
  title: "GP Chronic Condition Management Plan",
  item: [
    { linkId: "name", type: "string", text: "Name" },
    { linkId: "dob", type: "date", text: "Date of birth" },
    { linkId: "age", type: "integer", text: "Age" },
  ],
};

/**
 * The answers the requester read off the record and kept, as `prePopulate` leaves them.
 *
 * Jane Citizen and these three fields because they are the ones in the issue: the request page
 * said they would be sent, and the opened form showed all three empty.
 */
const SEED: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "in-progress",
  questionnaire: "http://example.org/Questionnaire/q-gpccmp|1.0.0",
  item: [
    { linkId: "name", text: "Name", answer: [{ valueString: "Jane Citizen" }] },
    {
      linkId: "dob",
      text: "Date of birth",
      answer: [{ valueDate: "1985-03-14" }],
    },
    { linkId: "age", text: "Age", answer: [{ valueInteger: 41 }] },
  ],
};

/**
 * Seal an invitation into a link the way a filler receives one.
 * @param prePopulated the answers to seed it with, or nothing for a blank request
 * @param tamper applied to the built Bundle before it is sealed, to stand in for a payload this
 *   app did not write
 * @returns the link's fragment
 */
async function sealedInvitation(
  prePopulated?: QuestionnaireResponse,
  tamper?: (bundle: Bundle) => void,
): Promise<string> {
  const { bundle } = buildInvitationBundle(QUESTIONNAIRE, {
    requestId: "11111111-1111-4111-8111-111111111111",
    requesterDisplay: "Dr Alex Fielding",
    subjectReference: "Patient/pt-demo",
    subjectDisplay: "Jane Citizen",
    prePopulated,
  });
  tamper?.(bundle);

  const link = await bespokeCodec.encode(
    { bundle, label: QUESTIONNAIRE.title },
    { baseUrl: "https://formlinks.example.org" },
  );
  return link.slice(link.indexOf("#"));
}

describe("an invitation filled in from the record", () => {
  let container: HTMLElement;
  let root: Root;

  /**
   * Open a link at `/view` and let its queries settle.
   * @param fragment the link's fragment, including the leading '#'
   */
  async function open(fragment: string): Promise<void> {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/view${fragment}`]}>
            <Routes>
              <Route path="/view" element={<ViewLink />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    /*
     * The open is a query over an async decode - decompression included - so the render above
     * returns while the page still says "Opening link…". Polled to a settled state rather than
     * given a fixed number of ticks: the tick count that happened to be enough was not stable
     * between runs, and a test that fails on scheduling says nothing about the code.
     */
    await settled();
  }

  /**
   * Let the open finish.
   * @throws {Error} when the page is still opening after the allowance, since every assertion
   *   after this point would otherwise report on a page that never loaded
   */
  async function settled(): Promise<void> {
    for (let tick = 0; tick < 100; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
      if (!container.textContent?.includes("Opening link…")) {
        return;
      }
    }
    throw new Error("The link never finished opening.");
  }

  /**
   * What the form was built from, on the last build.
   * @returns the arguments the renderer was handed
   */
  function lastBuild(): { questionnaireResponse?: QuestionnaireResponse } {
    const call = buildCalls.at(-1);
    if (!call) {
      throw new Error(
        "The form was never built, so there is nothing to assert about what it was built from. " +
          `Page text: ${container.textContent ?? "(empty)"}`,
      );
    }
    return call;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    buildCalls.length = 0;
    // No session: a filler holds a link and nothing else.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 401 }))),
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

  // Issue #18: the answers were in the link and never reached the screen.
  it("builds the form from the answers the invitation carried", async () => {
    await open(await sealedInvitation(SEED));

    const { questionnaireResponse } = lastBuild();

    expect(questionnaireResponse).toBeDefined();
    expect(questionnaireResponse?.item).toHaveLength(3);
  });

  // Named individually, because a seed that arrives half-applied is its own bug.
  it("carries every answer through to the form, values intact", async () => {
    await open(await sealedInvitation(SEED));

    const answers = Object.fromEntries(
      (lastBuild().questionnaireResponse?.item ?? []).map((item) => [
        item.linkId,
        item.answer?.[0],
      ]),
    );

    expect(answers.name).toEqual({ valueString: "Jane Citizen" });
    expect(answers.dob).toEqual({ valueDate: "1985-03-14" });
    expect(answers.age).toEqual({ valueInteger: 41 });
  });

  /*
   * The status is load bearing twice over: `isRequestBundle` reads it to tell a seeded invitation
   * from somebody's finished answers, so a seed that arrived as anything else would have opened
   * the review screen instead of the form.
   */
  it("opens the form to fill in rather than the review screen", async () => {
    await open(await sealedInvitation(SEED));

    expect(lastBuild().questionnaireResponse?.status).toBe("in-progress");
    expect(container.textContent).toContain(
      "GP Chronic Condition Management Plan",
    );
  });

  // An unticked request still opens, and opens blank rather than half-seeded.
  it("builds a blank form when the invitation carried no answers", async () => {
    await open(await sealedInvitation());

    expect(lastBuild().questionnaireResponse).toBeUndefined();
  });

  /*
   * A seed citing another form is dropped by `parseRequestBundle` rather than rendered, because
   * seeding a form with another form's answers puts values against `linkId`s that happen to
   * collide. Asserted at the renderer as well as at the parse, because the drop is only worth
   * anything if the form is what ends up empty.
   *
   * The mismatch has to be introduced after the build: `seedResponse` stamps the requested form's
   * canonical onto whatever it is given, so this app cannot mint one. That is the point - the
   * guard exists for payloads somebody else wrote, and this is the only honest way to write one.
   */
  it("builds a blank form when the answers cite a different questionnaire", async () => {
    await open(
      await sealedInvitation(SEED, (bundle) => {
        const seed = bundle.entry?.find(
          (entry) => entry.resource?.resourceType === "QuestionnaireResponse",
        )?.resource as QuestionnaireResponse;
        seed.questionnaire =
          "http://example.org/Questionnaire/something-else|1.0.0";
      }),
    );

    expect(lastBuild().questionnaireResponse).toBeUndefined();
  });
});

/*
 * The payload half, kept because it is what makes the tests above meaningful: if the seed were
 * missing from the Bundle, "the renderer got nothing" would be the right behaviour rather than a
 * regression, and every assertion above would be testing the wrong thing.
 */
describe("the sealed invitation itself", () => {
  it("carries the answers, stripped of the requester's authorship", () => {
    const { bundle } = buildInvitationBundle(QUESTIONNAIRE, {
      prePopulated: {
        ...SEED,
        id: "on-the-requesters-server",
        author: { reference: "Practitioner/dr-fielding" },
        authored: "2026-09-10T01:02:03.000Z",
      },
    });

    const { prePopulated } = parseRequestBundle(bundle);

    expect(prePopulated?.item).toHaveLength(3);
    expect(prePopulated?.id).toBeUndefined();
    expect(prePopulated?.author).toBeUndefined();
    expect(prePopulated?.authored).toBeUndefined();
  });
});
