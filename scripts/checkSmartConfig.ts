/**
 * Check that a SMART issuer can actually serve the launch this app performs.
 *
 * A full OAuth round trip needs a browser, a consent screen and a human, so it is not checkable from
 * a script — but almost everything that makes a launch fail *before* that point is. This asserts the
 * discovery document exists, is well-formed, and advertises the specific capabilities this app relies
 * on rather than merely being present.
 *
 * The single most common way to get this wrong is pointing at the plain FHIR base instead of the
 * SMART-enabled one. `proxy.smartforms.io/fhir` answers `.well-known/smart-configuration` with
 * `HAPI-0302: Unknown resource type '.well-known'` — a 404-shaped failure that reads like a network
 * problem — while its smart-launcher-v2 sibling `proxy.smartforms.io/v/r4/fhir` serves a real one.
 *
 *   npm run check:smart
 *   SMART_ISSUER=https://launch.smarthealthit.org/v/r4/fhir npm run check:smart
 *
 * With no `SMART_ISSUER`, the issuer is read from `public/config.json`.
 */
import { readFileSync } from "node:fs";

import { DEFAULT_SMART_SCOPES } from "../src/lib/config";

let failures = 0;
let total = 0;

function check(name: string, condition: boolean, detail = "") {
  total++;
  if (!condition) {
    failures++;
  }
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function configuredIssuer(): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync("public/config.json", "utf8"),
    );
    const issuer = (parsed as { smartIssuerUrl?: unknown }).smartIssuerUrl;
    return typeof issuer === "string" ? issuer : null;
  } catch {
    return null;
  }
}

const issuer = process.env.SMART_ISSUER ?? configuredIssuer();

if (!issuer) {
  console.error(
    "No issuer to check. Set `smartIssuerUrl` in public/config.json, or pass SMART_ISSUER=…\n" +
      "This is not a failure: a deployment that does not offer SMART App Launch has nothing here to check.",
  );
  process.exit(0);
}

console.log(`issuer: ${issuer}\n`);
console.log("--- discovery ---");

const wellKnown = `${issuer.replace(/\/+$/, "")}/.well-known/smart-configuration`;

let document: Record<string, unknown> = {};
try {
  const response = await fetch(wellKnown, {
    headers: { Accept: "application/json" },
  });
  check(
    "discovery/reachable",
    response.ok,
    `${response.status} ${response.statusText}`,
  );

  const body: unknown = await response.json();
  const isOperationOutcome =
    typeof body === "object" &&
    body !== null &&
    (body as { resourceType?: string }).resourceType === "OperationOutcome";

  /*
   * Called out separately because it is the failure everyone hits. A FHIR server with no SMART support
   * does not 404 the path — it parses `.well-known` as a resource type and returns a 200-shaped
   * OperationOutcome, which a naive check reads as success.
   */
  check(
    "discovery/notAFhirError",
    !isOperationOutcome,
    isOperationOutcome
      ? "the server returned an OperationOutcome — this is a plain FHIR base, not a SMART issuer"
      : "",
  );

  if (response.ok && !isOperationOutcome) {
    document = body as Record<string, unknown>;
  }
} catch (error) {
  check(
    "discovery/reachable",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

console.log("\n--- endpoints ---");
for (const field of ["authorization_endpoint", "token_endpoint", "issuer"]) {
  check(
    `endpoints/${field}`,
    typeof document[field] === "string",
    String(document[field] ?? "—"),
  );
}

console.log("\n--- capabilities this app needs ---");

const methods =
  (document.code_challenge_methods_supported as string[] | undefined) ?? [];
check(
  "pkce/S256",
  methods.includes("S256"),
  // Not negotiable: `smartSession.ts` sets `pkceMode: 'required'`, because a public client has no
  // secret and PKCE is the only thing binding the authorisation code to this app.
  methods.length > 0 ? methods.join(", ") : "none advertised",
);

const capabilities = (document.capabilities as string[] | undefined) ?? [];
for (const capability of ["launch-ehr", "launch-standalone", "client-public"]) {
  check(`capabilities/${capability}`, capabilities.includes(capability));
}

/*
 * Reported, not asserted. `scopes_supported` is optional, and servers that grant `user/*.*` routinely
 * do not enumerate every scope an app might ask for — so a missing entry here is a prompt to look, not
 * evidence of a problem.
 */
console.log("\n--- scopes (advisory) ---");
const supported = (document.scopes_supported as string[] | undefined) ?? [];
if (supported.length === 0) {
  console.log(
    "  --    the issuer does not advertise scopes_supported; nothing to compare against",
  );
} else {
  for (const scope of DEFAULT_SMART_SCOPES.split(" ")) {
    const wildcard = scope.replace(/\/.*$/, "/*.*");
    const known = supported.includes(scope) || supported.includes(wildcard);
    console.log(
      `  ${known ? "ok  " : "--  "}  scopes/${scope}${known ? "" : " — not advertised"}`,
    );
  }
}

console.log(
  failures === 0
    ? `\nAll ${total} checks passed.`
    : `\n${failures} of ${total} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
