/**
 * Quickstart scenario 6: a launch from an unregistered issuer is refused, and refused honestly.
 *
 * SC-006 asks for three things at once, and each is a separate way this could go wrong: the
 * issuer is named (so the refusal is diagnosable), no redirect is issued (so the app never talks
 * to a server it does not know), and no session comes into existence (so a refused launch leaves
 * nothing behind).
 *
 * The last one is checked against the session table rather than against the absence of a
 * `Set-Cookie` header alone. A `pending` row without a cookie would be invisible to the browser
 * and still be state the refusal was supposed not to create, so the row count is what the spec
 * counts. `better-sqlite3` opens the same file the server has open; SQLite's write-ahead log
 * makes a concurrent read safe, and the suite runs one worker so nothing else is launching
 * meanwhile.
 *
 * The second test is the other half of "refused honestly": a refusal that left the app unusable
 * would satisfy every assertion above and still be a failure.
 * @author John Grimes
 */

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { readLaunchEnvironment, requiredEnvironment } from "./support/launch";

/** An issuer that is deliberately absent from `config/issuers.json`. */
const UNREGISTERED_ISSUER = "https://example.org/fhir";

/**
 * How many session rows the app currently holds, pending and active alike.
 * @param sqlitePath path of the app's SQLite database
 * @returns the row count
 * @throws {Error} when the database is absent, which means the app never started, or when the
 *   count query answers with something other than a number
 * @example
 * const before = countSessions(requiredEnvironment("SQLITE_PATH"));
 */
function countSessions(sqlitePath: string): number {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const row: unknown = db
      .prepare("SELECT count(*) AS sessionCount FROM sessions")
      .get();
    if (
      typeof row !== "object" ||
      row === null ||
      !("sessionCount" in row) ||
      typeof row.sessionCount !== "number"
    ) {
      throw new Error(`counting sessions in ${sqlitePath} answered no count`);
    }
    return row.sessionCount;
  } finally {
    db.close();
  }
}

test("an unregistered issuer is refused by name, with no redirect and no session", async ({
  request,
}) => {
  const environment = readLaunchEnvironment();
  const sqlitePath = requiredEnvironment("SQLITE_PATH");
  const sessionsBefore = countSessions(sqlitePath);

  const refused = await request.get(
    `${environment.appOrigin}/launch?iss=${encodeURIComponent(UNREGISTERED_ISSUER)}`,
    { maxRedirects: 0 },
  );

  // Refused, not redirected: 403 and no `Location` at all.
  expect(refused.status()).toBe(403);
  expect(refused.headers().location).toBeUndefined();

  // Named, so whoever hits this can tell an administrator which server to register.
  const body = await refused.text();
  expect(body).toContain(UNREGISTERED_ISSUER);
  expect(body).toContain("This launch was refused");

  /*
   * Nothing handed to the browser, and nothing recorded on the server.
   *
   * "No more rows than before", not "the same rows": the app reaps expired sessions, so the count
   * can legitimately fall between the two reads - it did, 32 to 31, on a run of this spec. The
   * claim SC-006 makes is that a refused launch creates nothing, and an increase is the only
   * observation that would contradict it.
   */
  expect(refused.headers()["set-cookie"]).toBeUndefined();
  expect(countSessions(sqlitePath)).toBeLessThanOrEqual(sessionsBefore);
});

test("after a refusal the app still offers a registered server to launch from", async ({
  browser,
}) => {
  const environment = readLaunchEnvironment();
  const context = await browser.newContext({ baseURL: environment.appOrigin });
  const page = await context.newPage();

  await page.goto(`/launch?iss=${encodeURIComponent(UNREGISTERED_ISSUER)}`);
  await expect(
    page.getByRole("heading", { name: "This launch was refused" }),
  ).toBeVisible();
  await expect(page.getByText(UNREGISTERED_ISSUER)).toBeVisible();

  // Not a dead end: a requester surface still asks to be launched, and names the server that
  // is registered.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to a clinical system" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(environment.issuer)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  // With no session the header offers nothing a signed-out visitor cannot use: the brand link
  // home, and no clinician navigation.
  const headerLinks = page.locator("header a");
  await expect(headerLinks).toHaveCount(1);
  await expect(headerLinks.first()).toHaveAttribute("href", "/");
  for (const name of ["Patients", "Responses", "Sent requests", "Scan"]) {
    await expect(
      page.locator("header").getByRole("link", { name }),
    ).toHaveCount(0);
  }
});
