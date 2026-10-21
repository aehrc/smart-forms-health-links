/**
 * Tests for `server/config.ts`: process configuration and the issuer registry.
 *
 * The registry is the security boundary for the whole BFF: it names the FHIR servers the app
 * will launch against and carries references to the credentials used with them. Every failure
 * mode here is a startup failure by design (data-model.md, "Issuer registration"), so these
 * tests assert both that bad input is rejected and that the rejection names the offending
 * entry without ever echoing a secret value back into a log line.
 * @author John Grimes
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GRANT_TTL_SECONDS,
  findIssuerRegistration,
  loadIssuerRegistry,
  loadServerConfig,
} from "../../server/config";

/** A distinctive fake private exponent, so leak assertions have something to look for. */
const FAKE_PRIVATE_EXPONENT = "fake-private-exponent-do-not-log";

/** A distinctive fake client secret, likewise. */
const FAKE_CLIENT_SECRET = "fake-client-secret-do-not-log";

const PRIVATE_JWK_JSON = JSON.stringify({
  kty: "RSA",
  kid: "backend-key-1",
  alg: "RS384",
  n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
  d: FAKE_PRIVATE_EXPONENT,
});

interface RegistryEntryShape {
  issuer?: unknown;
  label?: unknown;
  launchClient?: unknown;
  backendClient?: unknown;
  grantTtlSeconds?: unknown;
}

/**
 * Build a well-formed registry entry, optionally overridden field by field.
 * @param overrides fields to replace on the base entry
 * @returns a registry entry ready to be serialised into a registry file
 */
function entry(overrides: RegistryEntryShape = {}): RegistryEntryShape {
  return {
    issuer: "https://ehr.example.org/fhir",
    label: "Example EHR",
    launchClient: {
      clientId: "launch-client",
      clientSecret: "env:LAUNCH_CLIENT_SECRET",
      scopes: "openid fhirUser launch launch/patient online_access",
    },
    backendClient: {
      clientId: "backend-client",
      privateKeyJwk: "env:BACKEND_PRIVATE_JWK",
      scopes: "system/QuestionnaireResponse.c system/Task.r system/Task.u",
    },
    ...overrides,
  };
}

/**
 * Environment holding resolvable values for both of the entry's references.
 * @returns an environment record the registry loader can resolve against
 */
function baseEnv(): Record<string, string | undefined> {
  return {
    LAUNCH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    BACKEND_PRIVATE_JWK: PRIVATE_JWK_JSON,
  };
}

describe("server config", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "shl-config-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Write a registry file into the temp directory.
   * @param contents the raw file body
   * @param name the file name, defaulting to `issuers.json`
   * @returns the absolute path written
   */
  function writeRegistry(contents: string, name = "issuers.json"): string {
    const registryPath = path.join(directory, name);
    writeFileSync(registryPath, contents, "utf8");
    return registryPath;
  }
  /**
   * Environment for a complete, valid server configuration.
   * @param registryPath path of the registry file to point at
   * @returns a full environment record
   */
  function serverEnv(registryPath: string): Record<string, string | undefined> {
    return {
      ...baseEnv(),
      APP_ORIGIN: "https://app.example.org",
      SQLITE_PATH: path.join(directory, "app.db"),
      ISSUER_REGISTRY_PATH: registryPath,
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    };
  }

  describe("loadIssuerRegistry", () => {
    it("parses a well-formed entry and resolves both environment references", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      const registry = loadIssuerRegistry(registryPath, baseEnv());

      expect(registry).toHaveLength(1);
      expect(registry[0].issuer).toBe("https://ehr.example.org/fhir");
      expect(registry[0].label).toBe("Example EHR");
      expect(registry[0].launchClient.clientId).toBe("launch-client");
      // The env reference is replaced by the value it names, not kept verbatim.
      expect(registry[0].launchClient.clientSecret).toBe(FAKE_CLIENT_SECRET);
      expect(registry[0].launchClient.scopes).toContain("launch/patient");
      expect(registry[0].backendClient.clientId).toBe("backend-client");
      expect(registry[0].backendClient.privateKeyJwk.kid).toBe("backend-key-1");
      expect(registry[0].backendClient.privateKeyJwk.d).toBe(
        FAKE_PRIVATE_EXPONENT,
      );
      expect(registry[0].backendClient.scopes).toBe(
        "system/QuestionnaireResponse.c system/Task.r system/Task.u",
      );
    });

    it("defaults grantTtlSeconds to one hour and honours an explicit value", () => {
      const registryPath = writeRegistry(
        JSON.stringify([
          entry(),
          entry({
            issuer: "https://other.example.org/fhir",
            grantTtlSeconds: 60,
          }),
        ]),
      );

      const registry = loadIssuerRegistry(registryPath, baseEnv());

      expect(DEFAULT_GRANT_TTL_SECONDS).toBe(3600);
      expect(registry[0].grantTtlSeconds).toBe(3600);
      expect(registry[1].grantTtlSeconds).toBe(60);
    });

    it("rejects a grantTtlSeconds that is not a positive integer, naming the entry", () => {
      const registryPath = writeRegistry(
        JSON.stringify([entry({ grantTtlSeconds: -5 })]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /https:\/\/ehr\.example\.org\/fhir.*grantTtlSeconds/s,
      );
    });

    it("rejects a non-https issuer, naming the issuer", () => {
      const registryPath = writeRegistry(
        JSON.stringify([entry({ issuer: "http://insecure.example.org/fhir" })]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /http:\/\/insecure\.example\.org\/fhir/,
      );
      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /https/,
      );
    });

    it("rejects an issuer that is not a URL at all", () => {
      const registryPath = writeRegistry(
        JSON.stringify([entry({ issuer: "not a url" })]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /not a url/,
      );
    });

    it("rejects a duplicate issuer, naming it, and treats a trailing slash as the same issuer", () => {
      const registryPath = writeRegistry(
        JSON.stringify([
          entry(),
          entry({ issuer: "https://ehr.example.org/fhir/" }),
        ]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /duplicate.*https:\/\/ehr\.example\.org\/fhir/is,
      );
    });

    it("rejects a registry that is not valid JSON, naming the file", () => {
      const registryPath = writeRegistry("{ this is not json");

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        new RegExp(
          registryPath.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
        ),
      );
    });

    it("rejects a registry whose top level is not an array", () => {
      const registryPath = writeRegistry(
        JSON.stringify({ issuers: [entry()] }),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /array/i,
      );
    });

    it("rejects a missing registry file, naming the path", () => {
      const registryPath = path.join(directory, "absent.json");

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        new RegExp(
          registryPath.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
        ),
      );
    });

    it("rejects an entry missing a label", () => {
      const registryPath = writeRegistry(
        JSON.stringify([entry({ label: "" })]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /label/,
      );
    });

    it("rejects a launch client with no client id", () => {
      const registryPath = writeRegistry(
        JSON.stringify([
          entry({
            launchClient: {
              clientSecret: "env:LAUNCH_CLIENT_SECRET",
              scopes: "openid fhirUser",
            },
          }),
        ]),
      );

      expect(() => loadIssuerRegistry(registryPath, baseEnv())).toThrow(
        /launchClient\.clientId/,
      );
    });

    it("rejects an inline secret and never echoes the value it was given", () => {
      const registryPath = writeRegistry(
        JSON.stringify([
          entry({
            launchClient: {
              clientId: "launch-client",
              clientSecret: FAKE_CLIENT_SECRET,
              scopes: "openid fhirUser",
            },
          }),
        ]),
      );

      let message = "";
      try {
        loadIssuerRegistry(registryPath, baseEnv());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      // The failure must be attributable ...
      expect(message).toMatch(/launchClient\.clientSecret/);
      expect(message).toMatch(/https:\/\/ehr\.example\.org\/fhir/);
      // ... and must document the reference syntax ...
      expect(message).toMatch(/env:/);
      // ... without ever putting the offending value into the message.
      expect(message).not.toContain(FAKE_CLIENT_SECRET);
    });

    it("rejects an inline private JWK without echoing the key material", () => {
      const registryPath = writeRegistry(
        JSON.stringify([
          entry({
            backendClient: {
              clientId: "backend-client",
              privateKeyJwk: JSON.parse(PRIVATE_JWK_JSON) as unknown,
              scopes: "system/Task.r",
            },
          }),
        ]),
      );

      let message = "";
      try {
        loadIssuerRegistry(registryPath, baseEnv());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/backendClient\.privateKeyJwk/);
      expect(message).not.toContain(FAKE_PRIVATE_EXPONENT);
    });

    it("rejects an unresolvable environment reference, naming the variable but not guessing a value", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      let message = "";
      try {
        loadIssuerRegistry(registryPath, {
          BACKEND_PRIVATE_JWK: PRIVATE_JWK_JSON,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/LAUNCH_CLIENT_SECRET/);
      expect(message).toMatch(/https:\/\/ehr\.example\.org\/fhir/);
      expect(message).not.toContain(FAKE_CLIENT_SECRET);
    });

    it("rejects an environment reference that resolves to an empty value", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadIssuerRegistry(registryPath, {
          ...baseEnv(),
          LAUNCH_CLIENT_SECRET: "  ",
        }),
      ).toThrow(/LAUNCH_CLIENT_SECRET/);
    });

    it("rejects a private JWK environment value that is not JSON, without echoing it", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      let message = "";
      try {
        loadIssuerRegistry(registryPath, {
          ...baseEnv(),
          BACKEND_PRIVATE_JWK: `not-json-${FAKE_PRIVATE_EXPONENT}`,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/BACKEND_PRIVATE_JWK/);
      expect(message).not.toContain(FAKE_PRIVATE_EXPONENT);
    });

    it("rejects a private JWK with no kid, because the JWKS route needs one", () => {
      const withoutKid = JSON.stringify({
        kty: "RSA",
        n: "abc",
        e: "AQAB",
        d: FAKE_PRIVATE_EXPONENT,
      });
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadIssuerRegistry(registryPath, {
          ...baseEnv(),
          BACKEND_PRIVATE_JWK: withoutKid,
        }),
      ).toThrow(/kid/);
    });

    it("rejects a public JWK where a private one is required", () => {
      const publicOnly = JSON.stringify({
        kty: "RSA",
        kid: "backend-key-1",
        n: "abc",
        e: "AQAB",
      });
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadIssuerRegistry(registryPath, {
          ...baseEnv(),
          BACKEND_PRIVATE_JWK: publicOnly,
        }),
      ).toThrow(/private/i);
    });
  });

  describe("findIssuerRegistration", () => {
    it("matches exactly, and across a trailing-slash difference in either direction", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));
      const registry = loadIssuerRegistry(registryPath, baseEnv());

      expect(
        findIssuerRegistration(registry, "https://ehr.example.org/fhir")?.label,
      ).toBe("Example EHR");
      expect(
        findIssuerRegistration(registry, "https://ehr.example.org/fhir/")
          ?.label,
      ).toBe("Example EHR");
      expect(
        findIssuerRegistration(registry, "https://other.example.org/fhir"),
      ).toBeUndefined();
      expect(findIssuerRegistration(registry, "")).toBeUndefined();
    });
  });

  describe("loadServerConfig", () => {
    it("loads process settings and the registry together", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      const config = loadServerConfig(serverEnv(registryPath));

      expect(config.appOrigin).toBe("https://app.example.org");
      expect(config.sqlitePath).toBe(path.join(directory, "app.db"));
      expect(config.issuerRegistryPath).toBe(registryPath);
      expect(config.cookieSecret).toBe("0123456789abcdef0123456789abcdef");
      expect(config.port).toBe(3000);
      expect(config.issuers).toHaveLength(1);
    });

    it("takes the port from the environment when set", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      const config = loadServerConfig({
        ...serverEnv(registryPath),
        PORT: "8080",
      });

      expect(config.port).toBe(8080);
    });

    it("rejects a missing required variable, naming it", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));
      const environment = serverEnv(registryPath);
      delete environment.APP_ORIGIN;

      expect(() => loadServerConfig(environment)).toThrow(/APP_ORIGIN/);
    });

    it("rejects a cookie secret that is too short to be useful", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadServerConfig({
          ...serverEnv(registryPath),
          SESSION_COOKIE_SECRET: "short",
        }),
      ).toThrow(/SESSION_COOKIE_SECRET/);
    });

    // A link is meant to be opened by any receiver, so leaving the variable out means any origin.
    it.each([undefined, "", "*", " * "])(
      "allows any origin for the public routes when SHL_CORS_ORIGINS is %j",
      (value) => {
        const registryPath = writeRegistry(JSON.stringify([entry()]));

        const config = loadServerConfig({
          ...serverEnv(registryPath),
          SHL_CORS_ORIGINS: value,
        });

        expect(config.shlCorsOrigins).toBe("*");
      },
    );

    it("reads a comma-separated list of origins", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      const config = loadServerConfig({
        ...serverEnv(registryPath),
        SHL_CORS_ORIGINS:
          "https://a.example.com, http://localhost:5173/ ,https://b.example.com:8443",
      });

      expect(config.shlCorsOrigins).toEqual([
        "https://a.example.com",
        "http://localhost:5173",
        "https://b.example.com:8443",
      ]);
    });

    // A typo here would lock every browser app out without a word, so it stops startup instead.
    it.each([
      "https://a.example.com/path",
      "a.example.com",
      "ftp://a.example.com",
      "*, https://a.example.com",
    ])("rejects %j in SHL_CORS_ORIGINS, naming the variable", (value) => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadServerConfig({
          ...serverEnv(registryPath),
          SHL_CORS_ORIGINS: value,
        }),
      ).toThrow(/SHL_CORS_ORIGINS/);
    });

    it("rejects an app origin that is not an absolute URL", () => {
      const registryPath = writeRegistry(JSON.stringify([entry()]));

      expect(() =>
        loadServerConfig({
          ...serverEnv(registryPath),
          APP_ORIGIN: "/relative",
        }),
      ).toThrow(/APP_ORIGIN/);
    });
  });
});
