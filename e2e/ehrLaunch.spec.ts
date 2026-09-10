/**
 * Quickstart scenario 2: an EHR launch carries the patient through to the mint screen.
 *
 * The patient context is minted through Aidbox's own `aidbox.smart/get-launch-uri` RPC, which is
 * this suite standing in for an EHR: it is the only way to obtain a real opaque `launch` token,
 * and using it means the spec exercises the same `launch/patient` path a clinical system would
 * drive rather than a test-only shortcut.
 *
 * Two assertions, and the second is the point. A pre-fill that cannot be changed would be worse
 * than none: a request is not always for the patient on screen, and a clinician who cannot say so
 * will send the answers to the wrong record.
 * @author John Grimes
 */

import { expect, test } from "@playwright/test";

import {
  DEMO_PATIENT_ID,
  DEMO_PATIENT_NAME,
  openMintScreen,
  signedInContext,
} from "./support/journey";
import { readLaunchEnvironment } from "./support/launch";

// An RPC call, a full launch and a questionnaire read against a hosted instance.
test.describe.configure({ timeout: 120_000 });

test("an EHR launch pre-fills the launch patient as the subject, and it stays editable", async ({
  browser,
}) => {
  const environment = readLaunchEnvironment();

  const { context, landedAt } = await signedInContext(browser, environment, {
    patientId: DEMO_PATIENT_ID,
  });
  // The callback lands on the app itself, not back on the authorisation server.
  expect(
    landedAt.startsWith("/") || landedAt.startsWith(environment.appOrigin),
  ).toBe(true);

  const page = await context.newPage();
  await openMintScreen(page);

  // Pre-filled from the launch context: the reference the EHR named, and the name resolved
  // through the proxy so that a filler has something readable.
  await expect(page.getByLabel("Subject reference")).toHaveValue(
    `Patient/${DEMO_PATIENT_ID}`,
  );
  await expect(page.getByLabel("Subject name")).toHaveValue(DEMO_PATIENT_NAME);
  await expect(
    page.getByText("Pre-filled from the patient you launched with"),
  ).toBeVisible();

  // Still a default, not a decision: both fields take an edit and keep it.
  await page.getByLabel("Subject reference").fill("Patient/someone-else");
  await page.getByLabel("Subject name").fill("Someone Else");
  await expect(page.getByLabel("Subject reference")).toHaveValue(
    "Patient/someone-else",
  );
  await expect(page.getByLabel("Subject name")).toHaveValue("Someone Else");

  // Nothing was minted, so nothing was published: the edit is local until the button is pressed.
  await expect(page.getByText("Published to the server")).toHaveCount(0);
});
