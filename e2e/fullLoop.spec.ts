/**
 * Quickstart scenarios 1 and 3: the whole loop, then the same send again.
 *
 * This is the acceptance spec for US1 to US3 and for SC-001, SC-002 and SC-005. It runs two
 * browser contexts against the live instance - a signed-in requester and a filler holding
 * nothing but a link - and then checks the outcome with operator credentials, which the app
 * never has. The browser saying "accepted" and the server holding one labelled response are
 * different claims, and only the second one is the feature.
 *
 * ## What the re-send proves, and what it does not
 *
 * Scenario 3 replays the send by reopening the same link and sending again. Only the response
 * count is asserted afterwards, because that is the whole of SC-002: the response entry carries a
 * conditional-create key on the request identifier, so the second transaction resolves to the
 * response already stored. The Provenance entry carries no such key in
 * `contracts/shl-wire.md`, so a replay does leave a second Provenance. That is a documented
 * limitation, written up in `docs/aidbox-validation.md`; asserting one Provenance after the
 * replay would be asserting behaviour the wire contract does not specify, and changing the
 * transaction shape to get it would break the Platypus interop contract (FR-027, SC-008).
 * @author John Grimes
 */

import { expect, test } from "@playwright/test";

import {
  answersByLinkId,
  byRequestIdentifier,
  PATIENT_ASSERTED_CODE,
  PATIENT_ASSERTED_SYSTEM,
  RESPONSE_OUTPUT_TEXT,
  searchFhir,
  resourcesOf,
} from "./support/aidbox";
import {
  answerSepsisScreening,
  anonymousContext,
  awaitOpenedRequest,
  chooseSubject,
  DEMO_PATIENT_ID,
  DEMO_PATIENT_NAME,
  mintInvitation,
  openMintScreen,
  SEPSIS_TYPED_ANSWERS,
  SEPSIS_YES_ANSWERS,
  sendAnswersDirectly,
  signedInContext,
} from "./support/journey";
import { readLaunchEnvironment } from "./support/launch";

import type { Provenance, QuestionnaireResponse, Task } from "fhir/r4";

// A launch, a mint, two manifest fetches and two transactions against a hosted instance.
test.describe.configure({ timeout: 240_000 });

test("the full loop lands one labelled response, one provenance and a completed task", async ({
  browser,
}) => {
  const environment = readLaunchEnvironment();
  const host = new URL(environment.issuer).host;

  // Window A: the requester, signed in to the launched server.
  const { context: requesterContext } = await signedInContext(
    browser,
    environment,
  );
  const requester = await requesterContext.newPage();

  await openMintScreen(requester);
  await chooseSubject(requester, DEMO_PATIENT_ID);
  const invitation = await mintInvitation(requester);
  expect(invitation.link).toContain("shlink:/");

  // The request is a Task on the launched server before any filler has seen the link (FR-010).
  const publishedBeforeSend = await byRequestIdentifier<Task>(
    environment,
    "Task",
    invitation.requestIdentifier,
  );
  expect(publishedBeforeSend).toHaveLength(1);
  expect(publishedBeforeSend[0].status).toBe("requested");

  // Window B: the filler, with no cookie, no storage and no configuration (SC-005).
  const fillerContext = await anonymousContext(browser, environment);
  const filler = await fillerContext.newPage();
  await filler.goto(invitation.link);

  // The disclosure names the sender, the subject and the destination host, and never asks
  // the filler to sign in.
  await awaitOpenedRequest(filler, host);
  await expect(
    filler.getByText(`Answers go straight to ${host}`),
  ).toBeVisible();
  await expect(filler.getByText(DEMO_PATIENT_NAME)).toBeVisible();
  expect(await fillerContext.cookies()).toHaveLength(0);

  // Nor does it show the filler navigation it cannot use: the requester's Patients, Responses,
  // Sent requests and Scan links all lead to a launch prompt when there is no session.
  await expect(filler.locator("header a")).toHaveCount(1);
  for (const name of ["Patients", "Responses", "Sent requests", "Scan"]) {
    await expect(
      filler.locator("header").getByRole("link", { name }),
    ).toHaveCount(0);
  }

  // The scan-back offer is present before the send: both channels exist while both are honest.
  await expect(
    filler.getByRole("button", { name: "Return answers as a link" }),
  ).toBeVisible();

  await answerSepsisScreening(filler);
  await sendAnswersDirectly(filler, host);

  // Nothing further to return: the scan-back offer is gone, not merely disabled (FR-026).
  await expect(
    filler.getByRole("button", { name: "Return answers as a link" }),
  ).toHaveCount(0);

  // ---- The end state, read with operator credentials (SC-001) ----

  const responses = await byRequestIdentifier<QuestionnaireResponse>(
    environment,
    "QuestionnaireResponse",
    invitation.requestIdentifier,
  );
  expect(responses).toHaveLength(1);
  const [response] = responses;

  expect(response.status).toBe("completed");
  // Patient-asserted, and attributed to the patient the request was addressed to.
  expect(response.meta?.security).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        system: PATIENT_ASSERTED_SYSTEM,
        code: PATIENT_ASSERTED_CODE,
      }),
    ]),
  );
  expect(response.subject?.reference).toBe(`Patient/${DEMO_PATIENT_ID}`);

  /*
   * The answers the filler gave, not an empty response that merely exists. Both kinds of control
   * are checked: the integer typed into a field, and the boolean chosen by clicking Yes.
   */
  const answered = answersByLinkId(response.item ?? []);
  expect(answered.get("patient-age")).toEqual([
    { valueInteger: Number(SEPSIS_TYPED_ANSWERS["integer-patient-age"]) },
  ]);
  for (const linkId of SEPSIS_YES_ANSWERS) {
    expect(answered.get(linkId)).toEqual([{ valueBoolean: true }]);
  }

  const provenance = resourcesOf<Provenance>(
    await searchFhir(environment, "Provenance", {
      target: `QuestionnaireResponse/${response.id ?? ""}`,
    }),
    "Provenance",
  );
  expect(provenance).toHaveLength(1);
  expect(provenance[0].agent[0].who.reference).toBe(
    `Patient/${DEMO_PATIENT_ID}`,
  );

  const tasks = await byRequestIdentifier<Task>(
    environment,
    "Task",
    invitation.requestIdentifier,
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0].status).toBe("completed");
  expect(
    tasks[0].output?.find(
      (output) => output.type?.text === RESPONSE_OUTPUT_TEXT,
    )?.valueReference?.reference,
  ).toBe(`QuestionnaireResponse/${response.id ?? ""}`);

  // ---- Scenario 3: send the same answers again (SC-002) ----

  const replay = await fillerContext.newPage();
  await replay.goto(invitation.link);
  await awaitOpenedRequest(replay, host);
  await answerSepsisScreening(replay);
  await sendAnswersDirectly(replay, host);

  const afterReplay = await byRequestIdentifier<QuestionnaireResponse>(
    environment,
    "QuestionnaireResponse",
    invitation.requestIdentifier,
  );
  expect(afterReplay).toHaveLength(1);
  expect(afterReplay[0].id).toBe(response.id);
});
