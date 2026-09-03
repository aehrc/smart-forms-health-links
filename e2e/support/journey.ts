/**
 * The two windows of the demo, expressed as functions.
 *
 * `quickstart.md` describes the loop as two browser windows: a signed-in requester who mints an
 * invitation, and a filler who holds nothing but the link. Every spec needs some part of that,
 * so the steps live here and the specs stay a list of assertions.
 *
 * Two decisions are worth stating.
 *
 * **The requester's session is injected, not typed.** {@link signedInContext} obtains a cookie
 * through `e2e/support/launch.ts`, which walks the launch over plain HTTP, and hands it to a
 * browser context. Driving Aidbox's login and consent pages through a browser would make every
 * spec depend on the markup of two pages this project does not own, and would add about ten
 * seconds to each of them.
 *
 * **The filler's context is created empty and stays empty.** No cookie, no storage state, no
 * shared context with the requester. That is the claim SC-005 makes - zero authentication, zero
 * configuration - so the specs must not be able to accidentally satisfy it by inheriting a
 * session.
 * @author John Grimes
 */

import { expect } from "@playwright/test";

import { launchSession, type LaunchEnvironment } from "./launch";
import { SESSION_COOKIE_NAME } from "../../server/sessionCookie";

import type { Browser, BrowserContext, Page } from "@playwright/test";

/** The demo patient every spec addresses its request to (`ops/aidboxSetup.ts`). */
export const DEMO_PATIENT_ID = "pt-demo";

/** That patient's name, as the demo data records it. */
export const DEMO_PATIENT_NAME = "Jane Citizen";

/**
 * The one name token the picker searches on.
 *
 * A single token, not the full name: the picker passes its text through to the FHIR `name`
 * search parameter, and Aidbox matches that against the individual parts of a `HumanName`, so
 * "Jane Citizen" matches nothing at all.
 */
export const DEMO_PATIENT_SEARCH_TERM = "Citizen";

/** The questionnaire the specs request: the smaller of the two demo forms. */
export const DEMO_QUESTIONNAIRE_ID = "AdultSepsisScreening";

/** Its title, which is how it is listed and how the request names it. */
export const DEMO_QUESTIONNAIRE_TITLE =
  "Adult Sepsis Primary Healthcare Screening Tool";

/** A minted invitation, as the requester's screen reports it. */
export interface MintedInvitation {
  /** Viewer URL carrying the encrypted link in its fragment: what the QR code encodes. */
  readonly link: string;
  /** The `urn:uuid:` identifier correlating the request with the answers that come back. */
  readonly requestIdentifier: string;
}

/**
 * A browser context carrying a freshly launched requester session.
 * @param browser the Playwright browser
 * @param environment the resolved launch environment
 * @param options which patient, if any, the launch puts in context
 * @param options.patientId patient id for an EHR launch; omit for a standalone launch
 * @returns the context, and where the launch callback landed
 * @throws {Error} when the launch does not establish a session
 * @example
 * const { context } = await signedInContext(browser, environment);
 */
export async function signedInContext(
  browser: Browser,
  environment: LaunchEnvironment,
  options: { patientId?: string } = {},
): Promise<{ context: BrowserContext; landedAt: string }> {
  const { sessionCookie, landedAt } = await launchSession({
    environment,
    patientId: options.patientId,
  });
  const context = await browser.newContext({ baseURL: environment.appOrigin });
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: sessionCookie,
      url: environment.appOrigin,
    },
  ]);
  return { context, landedAt };
}

/**
 * A browser context with nothing in it: the filler's window.
 * @param browser the Playwright browser
 * @param environment the resolved launch environment
 * @returns an empty context pointed at the app origin
 * @example
 * const filler = await anonymousContext(browser, environment);
 */
export async function anonymousContext(
  browser: Browser,
  environment: LaunchEnvironment,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL: environment.appOrigin });
}

/**
 * Walk the requester from the form list to the mint screen.
 *
 * Through the list rather than straight to `/request/<id>`, because "the questionnaire list shows
 * the Aidbox-held forms" is itself part of scenario 1: a form list read from the launched server
 * with the session's authority is what makes the rest of the journey possible.
 * @param page a page in a signed-in context
 * @param title the questionnaire's title, as the list shows it
 * @returns nothing; the page is left on the mint screen
 * @example
 * await openMintScreen(page, DEMO_QUESTIONNAIRE_TITLE);
 */
export async function openMintScreen(
  page: Page,
  title: string = DEMO_QUESTIONNAIRE_TITLE,
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Search forms by title").fill(title);
  const listed = page.getByRole("listitem").filter({ hasText: title });
  await expect(listed).toBeVisible();
  await listed.getByRole("link", { name: "Request" }).click();
  await expect(
    page.getByRole("heading", { name: `Request: ${title}` }),
  ).toBeVisible();
}

/**
 * Address the request to a patient held by the launched server.
 *
 * The demo instance holds more than one patient named "Jane Citizen", so the choice is made by
 * reference rather than by name: a spec that picked the first match would pass or fail on the
 * order Aidbox happened to return.
 * @param page a page on the mint screen
 * @param patientId the patient to address the request to
 * @returns nothing
 * @example
 * await chooseSubject(page, DEMO_PATIENT_ID);
 */
export async function chooseSubject(
  page: Page,
  patientId: string = DEMO_PATIENT_ID,
): Promise<void> {
  await page
    .getByLabel("Search patients to address this request to")
    .fill(DEMO_PATIENT_SEARCH_TERM);
  await page
    .getByRole("button", {
      name: new RegExp(String.raw`Patient/${patientId}\b`),
    })
    .click();
  await expect(page.getByLabel("Subject reference")).toHaveValue(
    `Patient/${patientId}`,
  );
}

/**
 * Mint the invitation and read what the screen reports about it.
 *
 * The request identifier is read out of the page text by shape rather than by CSS class: it is
 * the one `urn:uuid:` on the screen, and matching on a Tailwind class would make the spec fail
 * the next time somebody restyles an alert.
 * @param page a page on the mint screen, with the subject already chosen
 * @returns the viewer URL and the request identifier
 * @throws {Error} when the confirmation names no request identifier
 * @example
 * const invitation = await mintInvitation(page);
 */
export async function mintInvitation(page: Page): Promise<MintedInvitation> {
  await page.getByRole("button", { name: "Create request link" }).click();
  await expect(page.getByText("Published to the server")).toBeVisible();

  const link = await page.locator("#share-link").inputValue();
  const reported = (await page.locator("main").textContent()) ?? "";
  const requestIdentifier =
    /urn:uuid:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/.exec(reported)?.[0];
  if (requestIdentifier === undefined) {
    throw new Error(
      "the mint confirmation named no urn:uuid: request identifier",
    );
  }
  return { link, requestIdentifier };
}

/**
 * The one free-text answer the specs type, keyed by the element the renderer gives it.
 *
 * The renderer derives each field's element id from the item's own type and `linkId`
 * (`integer-patient-age` for `patient-age`), which is stable across builds - unlike the
 * React-generated `name` its radio inputs carry.
 *
 * Only `patient-age` is here because it is the only free-text item on this form a filler may
 * touch: the six vital signs carry `readOnly: true` in the fixture, since they come from the
 * patient record rather than from whoever is answering, and the renderer disables them.
 */
export const SEPSIS_TYPED_ANSWERS = {
  "integer-patient-age": "52",
} as const;

/**
 * The boolean items the specs answer "Yes" to, keyed by `linkId`.
 *
 * All three are chosen for the same two reasons. They carry no `initialExpression`, so what the
 * stored response holds against them is what the spec chose and nothing else - answering a
 * prepopulated item would leave the assertion unable to tell a filler's answer from the form's own
 * default. And they sit in `pi-group`, which is the one question group on this form that is not
 * gated by an `enableWhenExpression`: the red-flag and amber-flag groups appear only once the
 * presumed-infection answers imply them, so an item inside either is genuinely absent from the
 * page until it is not, and choosing one would make the spec's own earlier answers decide whether
 * its later ones are reachable.
 */
export const SEPSIS_YES_ANSWERS = [
  "pi-lookssick",
  "pi-fever",
  "pi-representation",
] as const;

/**
 * How long the renderer waits before committing a typed answer to its store.
 *
 * `DEBOUNCE_DURATION` in `@aehrc/smart-forms-renderer` is 300ms. Doubled here so that a slow
 * machine does not make the difference between an answer that is stored and one that is not, and
 * because there is nothing else to wait on: the store is internal to the library, so a typed
 * answer's arrival is not observable from the page.
 */
const TYPED_ANSWER_COMMIT_MS = 600;

/**
 * Fill the sepsis screening form in the filler's window.
 *
 * Both kinds of control are exercised deliberately. A form filled only through text inputs would
 * not show that a choice made by clicking survives the encryption, the manifest and the
 * transaction, and the boolean items are most of this questionnaire.
 *
 * Two details are the difference between this working and silently dropping answers.
 *
 * **The radios are clicked through a retry.** Answering one of these items re-evaluates the form's
 * calculated expressions - the red-flag and amber-flag outcomes are derived from exactly these
 * answers - and the renderer plays a fade on whatever changed, so a radio can be detached and
 * remounted underneath a click already in flight. Retrying until the radio reads as checked waits
 * out the re-render without asserting anything weaker: a radio that never takes the answer still
 * fails.
 *
 * **The typed answers go last, and are given time to land.** The renderer debounces a typed answer
 * before committing it, and a re-render caused by a *later* answer discards the pending commit -
 * which showed up as an age that the field displayed, and that the send then did not carry. Typing
 * after the clicking, and waiting out the debounce before returning, removes both halves of that.
 * @param page a page showing an opened request invitation
 * @returns nothing
 * @throws {Error} by assertion when a field does not accept the answer
 * @example
 * await answerSepsisScreening(page);
 */
export async function answerSepsisScreening(page: Page): Promise<void> {
  for (const linkId of SEPSIS_YES_ANSWERS) {
    // The renderer ids the radio group; "true" is the value its Yes radio carries.
    const yes = page.locator(`#boolean-${linkId} input[value="true"]`);
    await expect(async () => {
      await yes.check({ timeout: 5000 });
      await expect(yes).toBeChecked({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
  }
  for (const [id, value] of Object.entries(SEPSIS_TYPED_ANSWERS)) {
    const field = page.locator(`#${id}`);
    await expect(field).toBeVisible();
    await field.fill(value);
    await expect(field).toHaveValue(value);
  }
  await page.waitForTimeout(TYPED_ANSWER_COMMIT_MS);
}

/**
 * Wait until an opened request invitation is ready to be answered and sent.
 *
 * `.first()` on the heading is not laziness. Once the renderer has mounted, two `h1` elements
 * carry the questionnaire title: the request's own header, which names who asked and who for, and
 * the renderer's form title. Which one appears first is a race, and either proves what this is
 * waiting for - that the form is on screen.
 * @param page a page that has navigated to a request invitation
 * @param host the destination host the send panel names
 * @returns nothing
 * @example
 * await awaitOpenedRequest(filler, new URL(environment.issuer).host);
 */
export async function awaitOpenedRequest(
  page: Page,
  host: string,
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: DEMO_QUESTIONNAIRE_TITLE }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: `Send answers to ${host}` }),
  ).toBeVisible();
}

/**
 * Send the answers straight to the destination, through the disclosure and the confirmation.
 *
 * Both steps are pressed deliberately rather than collapsed into one helper call, because the
 * confirmation step exists precisely so that a send is never one click (FR-021): a helper that
 * skipped it would leave that requirement unexercised.
 * @param page a page showing a filled request invitation
 * @param host the destination host named on the panel
 * @returns nothing; the page is left in the terminal accepted state
 * @example
 * await sendAnswersDirectly(page, new URL(environment.issuer).host);
 */
export async function sendAnswersDirectly(
  page: Page,
  host: string,
): Promise<void> {
  await page.getByRole("button", { name: `Send answers to ${host}` }).click();
  await expect(page.getByText(`Send these answers to ${host}?`)).toBeVisible();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText(`Accepted by ${host}`)).toBeVisible({
    timeout: 60_000,
  });
}
