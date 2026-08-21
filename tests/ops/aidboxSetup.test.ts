/**
 * Tests for `ops/aidboxSetup.ts`.
 *
 * The setup script is the only thing in the repository that mints long-lived credentials, so
 * the tests are organised around three separable concerns:
 *
 *   1. **Shape.** Every resource body must match `contracts/aidbox-setup.md` exactly, because a
 *      wrong `access_token_expiration` or a missing `pkce` flag is a silent security regression
 *      rather than a visible failure.
 *   2. **Idempotence.** Re-running setup must be a no-op. The tests pin the change-detection
 *      rule (a desired body already contained in the stored resource means no `PUT`) because
 *      that rule, not the server, is what keeps `meta.versionId` stable.
 *   3. **Secret hygiene.** A generated secret leaves the process exactly once, through the
 *      operator report. The tests drive a full apply with a spying logger and assert that
 *      neither the secret nor the private key material appears in anything the script emits.
 *
 * Everything here runs without network access: the builders are pure and the applier takes an
 * injected `fetch`.
 * @author John Grimes
 */

import { describe, expect, it, vi } from "vitest";

import {
  BACKEND_CLIENT_ID,
  BACKEND_POLICY_ID,
  DEMO_PATIENT_ID,
  LAUNCH_CLIENT_ID,
  LAUNCH_POLICY_ID,
  applyToServer,
  buildBackendClient,
  buildBackendPolicy,
  buildDemoPatient,
  buildE2eUser,
  buildLaunchClient,
  buildLaunchPolicy,
  checkCors,
  describeCorsFinding,
  formatOperatorSecrets,
  generateBackendKeyPair,
  generateClientSecret,
  isUpToDate,
  planSetup,
} from "../../ops/aidboxSetup";

import type { PlannedResource } from "../../ops/aidboxSetup";
import type { Questionnaire } from "fhir/r4";
import type { JWK } from "jose";

const APP_ORIGIN = "https://links.example.org";

const GRANT_TTL_SECONDS = 3600;

const SECRET = "test-launch-secret-0123456789abcdef";

const PUBLIC_JWK: JWK = {
  kty: "RSA",
  alg: "RS384",
  use: "sig",
  kid: "test-kid",
  n: "b".repeat(342),
  e: "AQAB",
};

const QUESTIONNAIRES: Questionnaire[] = [
  {
    resourceType: "Questionnaire",
    id: "AdultSepsisScreening",
    status: "active",
    title: "Adult Sepsis Primary Healthcare Screening Tool",
  },
  {
    resourceType: "Questionnaire",
    id: "GPChronicConditionManagementPlan",
    status: "active",
    title: "GP Chronic Condition Management Plan",
  },
];

/**
 * Build the options every planning test shares.
 * @returns setup options pointing at a public app origin
 */
function setupOptions() {
  return {
    appOrigin: APP_ORIGIN,
    grantTtlSeconds: GRANT_TTL_SECONDS,
    launchClientSecret: SECRET,
    backendPublicJwk: PUBLIC_JWK,
    e2eUser: {
      id: "e2e-demo",
      email: "e2e-demo@example.org",
      password: "e2e-password-never-logged",
    },
    questionnaires: QUESTIONNAIRES,
  };
}

/**
 * Build a `Response` carrying a JSON body, as the injected fetch must return.
 * @param status the HTTP status code
 * @param body the JSON body
 * @param headers extra response headers
 * @returns a `Response` the module can consume
 */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Build a preflight response carrying the given CORS headers.
 * @param headers the `access-control-*` headers to return
 * @returns a 200 response with those headers
 */
function preflight(headers: Record<string, string>): Response {
  return new Response(null, { status: 200, headers });
}

describe("launch client body", () => {
  // Contract section 1. Every field is pinned: the redirect and launch URIs are what Aidbox
  // matches the app against, and the auth block is what makes the client confidential.
  it("matches the contract, with the TTL carried in seconds", () => {
    const client = buildLaunchClient({
      appOrigin: APP_ORIGIN,
      secret: SECRET,
      grantTtlSeconds: GRANT_TTL_SECONDS,
    });

    expect(client).toEqual({
      resourceType: "Client",
      id: LAUNCH_CLIENT_ID,
      type: "smart-app",
      grant_types: ["code"],
      secret: SECRET,
      smart: { launch_uri: `${APP_ORIGIN}/launch` },
      auth: {
        authorization_code: {
          redirect_uri: `${APP_ORIGIN}/auth/callback`,
          token_format: "jwt",
          secret_required: true,
          pkce: true,
          refresh_token: true,
          access_token_expiration: 3600,
        },
      },
      scope: [
        "openid",
        "fhirUser",
        "launch",
        "launch/patient",
        "online_access",
        "user/*.cruds",
      ],
    });
  });

  // `access_token_expiration` mirrors the registry's `grantTtlSeconds` one for one, in
  // seconds. Measured 2026-08-22 against the target instance: registering 120 mints a token
  // with `exp - iat = 120`. The contract's original "milliseconds" reading would have made
  // quickstart scenario 4's 60-second window a 60,000-second one.
  it("mirrors a non-default grant TTL", () => {
    const client = buildLaunchClient({
      appOrigin: APP_ORIGIN,
      secret: SECRET,
      grantTtlSeconds: 60,
    });

    expect(client.auth).toEqual({
      authorization_code: expect.objectContaining({
        access_token_expiration: 60,
      }) as unknown,
    });
  });

  // A trailing slash on the origin would otherwise produce `https://host//launch`, which
  // Aidbox compares literally against the browser's redirect.
  it("tolerates a trailing slash on the app origin", () => {
    const client = buildLaunchClient({
      appOrigin: `${APP_ORIGIN}/`,
      secret: SECRET,
      grantTtlSeconds: GRANT_TTL_SECONDS,
    });

    expect(client.smart).toEqual({ launch_uri: `${APP_ORIGIN}/launch` });
  });
});

describe("backend services client body", () => {
  // Contract section 2. The scope is deliberately three operations wide: create a response,
  // read and update the Task. Anything more widens the accepted token blast radius.
  it("matches the contract for a publicly reachable app origin", () => {
    const client = buildBackendClient({
      appOrigin: APP_ORIGIN,
      grantTtlSeconds: GRANT_TTL_SECONDS,
      publicJwk: PUBLIC_JWK,
    });

    expect(client).toEqual({
      resourceType: "Client",
      id: BACKEND_CLIENT_ID,
      type: "bulk-api-client",
      grant_types: ["client_credentials"],
      jwks_uri: `${APP_ORIGIN}/.well-known/jwks.json`,
      auth: {
        client_credentials: {
          client_assertion_types: [
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          ],
          token_format: "jwt",
          access_token_expiration: 3600,
        },
      },
      scope: [
        "system/QuestionnaireResponse.c",
        "system/Task.r",
        "system/Task.u",
      ],
    });
  });

  // A hosted Aidbox cannot resolve `http://localhost:3000/.well-known/jwks.json`, so for a
  // loopback origin the public key is registered inline instead. Aidbox's `Client.jwks` is a
  // bare array of JWKs, not a JWKS document (verified 2026-08-22 against the target
  // instance, which rejects `{ keys: [...] }` with `expected-array`).
  it("inlines the public key when the app origin is loopback", () => {
    const client = buildBackendClient({
      appOrigin: "http://localhost:3000",
      grantTtlSeconds: GRANT_TTL_SECONDS,
      publicJwk: PUBLIC_JWK,
    });

    expect(client.jwks_uri).toBeUndefined();
    expect(client.jwks).toEqual([PUBLIC_JWK]);
  });

  // Only the public half is ever registered. A private member reaching Aidbox would put the
  // signing key in a resource any operator can read.
  it("never carries private key material", () => {
    const client = buildBackendClient({
      appOrigin: "http://127.0.0.1:3000",
      grantTtlSeconds: GRANT_TTL_SECONDS,
      publicJwk: { ...PUBLIC_JWK, d: "private" },
    });

    expect(JSON.stringify(client)).not.toContain("private");
  });
});

describe("access policies", () => {
  // Contract section 3. `engine: allow` is prohibited by the research decision, and the
  // policy must be linked so it is only evaluated for its own client.
  it("scopes the launch policy to the launch client's authenticated user", () => {
    const policy = buildLaunchPolicy();

    expect(policy.id).toBe(LAUNCH_POLICY_ID);
    expect(policy.engine).toBe("matcho");
    expect(policy.link).toEqual([
      { resourceType: "Client", id: LAUNCH_CLIENT_ID },
    ]);
    expect(policy.matcho).toEqual({
      client: { id: LAUNCH_CLIENT_ID },
      user: "present?",
      uri: "#^/fhir(/.*)?$",
    });
  });

  // The backend client may run a transaction, create the response the transaction carries,
  // and read or update a Task. Nothing else. Aidbox authorises each transaction entry as its
  // own request, which is why the response create needs an alternative of its own.
  it("limits the backend policy to the transaction, the response and Task instances", () => {
    const policy = buildBackendPolicy();

    expect(policy.id).toBe(BACKEND_POLICY_ID);
    expect(policy.engine).toBe("matcho");
    expect(policy.link).toEqual([
      { resourceType: "Client", id: BACKEND_CLIENT_ID },
    ]);
    expect(policy.matcho).toEqual({
      "$one-of": [
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": "post",
          uri: "/fhir",
        },
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": "post",
          uri: "/fhir/QuestionnaireResponse",
        },
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": { $enum: ["get", "put"] },
          uri: "#^/fhir/Task/[^/]+$",
        },
      ],
    });
  });

  // Anything the policy does not name must stay refused: a Patient read, an Observation
  // write and a Task delete are all outside it (proven against the live instance).
  it("names no rule that would admit a Patient, an Observation or a delete", () => {
    const alternatives = JSON.stringify(buildBackendPolicy().matcho);

    expect(alternatives).not.toContain("Patient");
    expect(alternatives).not.toContain("Observation");
    expect(alternatives).not.toContain("delete");
  });

  it("never uses the allow engine", () => {
    expect(buildLaunchPolicy().engine).not.toBe("allow");
    expect(buildBackendPolicy().engine).not.toBe("allow");
  });
});

describe("demo data and e2e prerequisites", () => {
  // Contract section 5: the scenario scripts name this patient, so the id and the name are
  // both load bearing.
  it("builds Jane Citizen at the fixed demo id", () => {
    const patient = buildDemoPatient();

    expect(patient.resourceType).toBe("Patient");
    expect(patient.id).toBe(DEMO_PATIENT_ID);
    expect(patient.name).toEqual([{ family: "Citizen", given: ["Jane"] }]);
  });

  // Contract section 6. The password comes from the environment; the resource carries it so
  // Aidbox can hash it, but nothing else may.
  it("builds the e2e user from supplied credentials", () => {
    const user = buildE2eUser({
      id: "e2e-demo",
      email: "e2e-demo@example.org",
      password: "s3cret",
    });

    expect(user).toEqual({
      resourceType: "User",
      id: "e2e-demo",
      email: "e2e-demo@example.org",
      password: "s3cret",
    });
  });
});

describe("setup plan", () => {
  // The plan is what the applier walks. Ordering matters: a policy that links to a client
  // Aidbox has not seen yet is a dangling reference.
  it("puts every resource at its fixed id, clients before policies", () => {
    const planned = planSetup(setupOptions());
    const paths = planned.map((entry) => entry.path);

    expect(paths).toEqual([
      `/Client/${LAUNCH_CLIENT_ID}`,
      `/Client/${BACKEND_CLIENT_ID}`,
      `/AccessPolicy/${LAUNCH_POLICY_ID}`,
      `/AccessPolicy/${BACKEND_POLICY_ID}`,
      "/fhir/Questionnaire/AdultSepsisScreening",
      "/fhir/Questionnaire/GPChronicConditionManagementPlan",
      `/fhir/Patient/${DEMO_PATIENT_ID}`,
      "/User/e2e-demo",
    ]);
  });

  // Aidbox does not echo these back, so change detection has to skip them or every run would
  // look like a change and bump `meta.versionId`.
  it("marks the write-only fields the server will not echo back", () => {
    const planned = planSetup(setupOptions());
    const byPath = new Map(planned.map((entry) => [entry.path, entry]));

    expect(byPath.get(`/Client/${LAUNCH_CLIENT_ID}`)?.opaqueFields).toEqual([
      "secret",
    ]);
    expect(byPath.get("/User/e2e-demo")?.opaqueFields).toEqual(["password"]);
    expect(byPath.get(`/Client/${BACKEND_CLIENT_ID}`)?.opaqueFields).toEqual(
      [],
    );
  });

  // The Questionnaires are repo fixtures, so setup needs no third party at run time. They are
  // PUT under their own ids with any inherited server metadata stripped.
  it("carries the questionnaire fixtures through unchanged apart from meta", () => {
    const planned = planSetup(setupOptions());
    const sepsis = planned.find(
      (entry) => entry.path === "/fhir/Questionnaire/AdultSepsisScreening",
    );

    expect(sepsis?.body).toEqual({
      resourceType: "Questionnaire",
      id: "AdultSepsisScreening",
      status: "active",
      title: "Adult Sepsis Primary Healthcare Screening Tool",
    });
  });
});

describe("change detection", () => {
  // Aidbox adds `meta` and may add defaults. A stored resource that already contains every
  // desired field is up to date, however much else it carries.
  it("treats a superset as up to date", () => {
    expect(
      isUpToDate(
        {
          resourceType: "Client",
          id: "x",
          type: "smart-app",
          meta: { versionId: "7" },
          active: true,
        },
        { resourceType: "Client", id: "x", type: "smart-app" },
        [],
      ),
    ).toBe(true);
  });

  it("detects a changed scalar", () => {
    expect(
      isUpToDate(
        { resourceType: "Client", id: "x", type: "smart-app" },
        { resourceType: "Client", id: "x", type: "bulk-api-client" },
        [],
      ),
    ).toBe(false);
  });

  // Arrays are compared element for element, not as a subset: dropping a scope must count as
  // a change even though the stored array still contains the remaining ones.
  it("compares arrays exactly", () => {
    expect(isUpToDate({ scope: ["a", "b"] }, { scope: ["a"] }, [])).toBe(false);
    expect(isUpToDate({ scope: ["a"] }, { scope: ["a"] }, [])).toBe(true);
  });

  it("recurses into nested objects", () => {
    expect(
      isUpToDate(
        { auth: { authorization_code: { pkce: true, extra: 1 } } },
        { auth: { authorization_code: { pkce: true } } },
        [],
      ),
    ).toBe(true);
    expect(
      isUpToDate(
        { auth: { authorization_code: { pkce: false } } },
        { auth: { authorization_code: { pkce: true } } },
        [],
      ),
    ).toBe(false);
  });

  // The whole point of `opaqueFields`: a secret we cannot read back must not make the
  // resource look perpetually stale.
  it("ignores fields the server will not echo back", () => {
    expect(
      isUpToDate(
        { resourceType: "Client", id: "x" },
        { resourceType: "Client", id: "x", secret: "s" },
        ["secret"],
      ),
    ).toBe(true);
  });

  it("reports a missing resource as not up to date", () => {
    expect(isUpToDate(undefined, { resourceType: "Client", id: "x" }, [])).toBe(
      false,
    );
  });
});

describe("applying the plan", () => {
  const planned: PlannedResource[] = [
    {
      label: "launch client",
      path: "/Client/example",
      body: { resourceType: "Client", id: "example", secret: SECRET },
      opaqueFields: ["secret"],
    },
  ];

  // First run: nothing is there, so the resource is created and the new version recorded.
  it("creates a resource that does not exist", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, { issue: [] }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          resourceType: "Client",
          id: "example",
          meta: { versionId: "1" },
        }),
      );

    const outcomes = await applyToServer({
      baseUrl: "https://aidbox.example",
      authorization: "Basic redacted",
      planned,
      fetchImpl,
      log: () => {},
    });

    expect(outcomes).toEqual([
      {
        label: "launch client",
        path: "/Client/example",
        action: "created",
        status: 201,
        versionId: "1",
      },
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("PUT");
  });

  // Second run: the stored resource already contains every desired field, so no `PUT` is
  // issued at all. This is what keeps `meta.versionId` identical across runs.
  it("issues no write when the stored resource is already up to date", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        resourceType: "Client",
        id: "example",
        meta: { versionId: "1" },
      }),
    );

    const outcomes = await applyToServer({
      baseUrl: "https://aidbox.example",
      authorization: "Basic redacted",
      planned,
      fetchImpl,
      log: () => {},
    });

    expect(outcomes[0]).toMatchObject({ action: "unchanged", versionId: "1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("updates a resource whose stored copy differs", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          resourceType: "Client",
          id: "example",
          type: "stale",
          meta: { versionId: "1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          resourceType: "Client",
          id: "example",
          meta: { versionId: "2" },
        }),
      );

    const outcomes = await applyToServer({
      baseUrl: "https://aidbox.example",
      authorization: "Basic redacted",
      planned: [
        {
          ...planned[0],
          body: { resourceType: "Client", id: "example", type: "smart-app" },
          opaqueFields: [],
        },
      ],
      fetchImpl,
      log: () => {},
    });

    expect(outcomes[0]).toMatchObject({ action: "updated", versionId: "2" });
  });

  // `force` exists for credential rotation: the operator asks for a new secret, and the
  // write must happen even though every readable field already matches.
  it("writes regardless when forced", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          resourceType: "Client",
          id: "example",
          meta: { versionId: "1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          resourceType: "Client",
          id: "example",
          meta: { versionId: "2" },
        }),
      );

    const outcomes = await applyToServer({
      baseUrl: "https://aidbox.example",
      authorization: "Basic redacted",
      planned,
      fetchImpl,
      force: true,
      log: () => {},
    });

    expect(outcomes[0]).toMatchObject({ action: "updated" });
  });

  // A refusal must stop the run rather than leave a half-configured instance behind, and the
  // message must name the resource so the operator knows where it stopped.
  it("throws when the server refuses a write", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(403, { issue: [] }));

    await expect(
      applyToServer({
        baseUrl: "https://aidbox.example",
        authorization: "Basic redacted",
        planned,
        fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/\/Client\/example/);
  });

  // Aidbox quotes the offending value in some validation failures, so a refusal that names
  // the secret must not carry it into the operator's terminal or a CI log.
  it("scrubs secret values out of a refusal message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(
        jsonResponse(422, {
          issue: [{ diagnostics: `unexpected value ${SECRET}` }],
        }),
      );

    await expect(
      applyToServer({
        baseUrl: "https://aidbox.example",
        authorization: "Basic redacted",
        planned,
        fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/\[redacted]/);

    await expect(
      applyToServer({
        baseUrl: "https://aidbox.example",
        authorization: "Basic redacted",
        planned,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse(404, {}))
          .mockResolvedValueOnce(
            jsonResponse(422, {
              issue: [{ diagnostics: `unexpected value ${SECRET}` }],
            }),
          ),
        log: () => {},
      }),
    ).rejects.not.toThrow(SECRET);
  });
});

describe("secret hygiene", () => {
  // The single most important property in this file: applying a plan whose body carries a
  // generated secret must not put that secret anywhere the operator's terminal scrollback,
  // CI log or shell history can keep it.
  it("never logs a secret while applying", async () => {
    const log = vi.fn<(line: string) => void>();
    const secret = generateClientSecret();
    const keys = await generateBackendKeyPair();
    const password = "e2e-password-never-logged";

    // A fresh `Response` per call: a body may only be read once.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) =>
        Promise.resolve(
          (init?.method ?? "GET") === "GET"
            ? jsonResponse(404, {})
            : jsonResponse(201, { meta: { versionId: "1" } }),
        ),
      );

    const outcomes = await applyToServer({
      baseUrl: "https://aidbox.example",
      authorization: "Basic redacted",
      planned: planSetup({
        appOrigin: APP_ORIGIN,
        grantTtlSeconds: GRANT_TTL_SECONDS,
        launchClientSecret: secret,
        backendPublicJwk: keys.publicJwk,
        e2eUser: {
          id: "e2e-demo",
          email: "e2e-demo@example.org",
          password,
        },
        questionnaires: QUESTIONNAIRES,
      }),
      fetchImpl,
      log,
    });

    const emitted = [
      ...log.mock.calls.map(([line]) => line),
      JSON.stringify(outcomes),
    ].join("\n");

    expect(emitted).not.toContain(secret);
    expect(emitted).not.toContain(password);
    expect(emitted).not.toContain(keys.privateJwk.d);
  });

  // The operator report is the one authorised exit. Each value appears once, so a copy and
  // paste into 1Password cannot silently take the wrong occurrence.
  it("prints each secret exactly once in the operator report", async () => {
    const secret = generateClientSecret();
    const keys = await generateBackendKeyPair();

    const report = formatOperatorSecrets({
      launchClientSecret: secret,
      backendPrivateJwk: keys.privateJwk,
    });

    expect(report.split(secret)).toHaveLength(2);
    expect(report.split(JSON.stringify(keys.privateJwk))).toHaveLength(2);
  });
});

describe("generated credentials", () => {
  // 32 random bytes, base64url encoded. Length and alphabet are asserted rather than
  // "looks random", and two calls must differ.
  it("generates a high-entropy client secret", () => {
    const first = generateClientSecret();
    const second = generateClientSecret();

    expect(first).toMatch(/^[\w-]{43}$/);
    expect(first).not.toBe(second);
  });

  // SMART Backend Services requires RS384 or ES384; the registry and `publicJwks()` in the
  // BFF both assume RSA, so the pair must be RSA with a usable modulus.
  it("generates an RS384 signing key pair", async () => {
    const { privateJwk, publicJwk } = await generateBackendKeyPair();

    expect(privateJwk.kty).toBe("RSA");
    expect(privateJwk.alg).toBe("RS384");
    expect(privateJwk.use).toBe("sig");
    expect(privateJwk.kid).toMatch(/\S/);
    expect(privateJwk.d).toMatch(/\S/);

    // A 2048-bit modulus is 256 bytes, which is 342 base64url characters.
    expect((publicJwk.n ?? "").length).toBeGreaterThanOrEqual(342);
  });

  // The public half is what gets registered or served at `/.well-known/jwks.json`. Any
  // private member surviving the split would publish the signing key.
  it("strips private members from the public half", async () => {
    const { publicJwk } = await generateBackendKeyPair();

    const { d, p, q, dp, dq, qi } = publicJwk;
    expect([d, p, q, dp, dq, qi]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(publicJwk.kid).toMatch(/\S/);
  });

  it("uses a different key on every run", async () => {
    const first = await generateBackendKeyPair();
    const second = await generateBackendKeyPair();

    expect(first.privateJwk.n).not.toBe(second.privateJwk.n);
  });
});

describe("CORS verification", () => {
  // The direct send in `src/fill/directSend.ts` is a cross-origin POST carrying a Bearer
  // token, so all three of origin, header and method have to be allowed.
  it("reports direct send as supported when the preflight allows it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      preflight({
        "access-control-allow-origin": APP_ORIGIN,
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "POST",
      }),
    );

    const finding = await checkCors({
      baseUrl: "https://aidbox.example",
      appOrigin: APP_ORIGIN,
      fetchImpl,
    });

    expect(finding.directSendSupported).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("OPTIONS");
    expect(describeCorsFinding(finding)).toContain("direct browser POST");
  });

  it("accepts a wildcard origin", async () => {
    const finding = await checkCors({
      baseUrl: "https://aidbox.example",
      appOrigin: APP_ORIGIN,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        preflight({
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-allow-methods": "GET, POST, PUT",
        }),
      ),
    });

    expect(finding.directSendSupported).toBe(true);
  });

  // Without the `Authorization` header the browser will not send the token, which is exactly
  // the case the BFF relay fallback exists for.
  it("reports the relay fallback when the Authorization header is refused", async () => {
    const finding = await checkCors({
      baseUrl: "https://aidbox.example",
      appOrigin: APP_ORIGIN,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        preflight({
          "access-control-allow-origin": APP_ORIGIN,
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST",
        }),
      ),
    });

    expect(finding.directSendSupported).toBe(false);
    expect(describeCorsFinding(finding)).toContain("relay");
  });

  it("reports the relay fallback when the origin is not reflected", async () => {
    const finding = await checkCors({
      baseUrl: "https://aidbox.example",
      appOrigin: APP_ORIGIN,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        preflight({
          "access-control-allow-origin": "https://elsewhere.example",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "POST",
        }),
      ),
    });

    expect(finding.directSendSupported).toBe(false);
  });

  it("reports the relay fallback when POST is not allowed", async () => {
    const finding = await checkCors({
      baseUrl: "https://aidbox.example",
      appOrigin: APP_ORIGIN,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        preflight({
          "access-control-allow-origin": APP_ORIGIN,
          "access-control-allow-headers": "authorization",
          "access-control-allow-methods": "GET",
        }),
      ),
    });

    expect(finding.directSendSupported).toBe(false);
  });
});
