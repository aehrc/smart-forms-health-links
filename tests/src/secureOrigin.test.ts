/**
 * Tests for `src/link/secureOrigin.ts`: where a bearer token may be presented.
 *
 * The rule decides whether a credential that can write to a clinical record travels, so it is
 * worth being exact about both halves. `https` is accepted because the token is protected in
 * transit. Loopback `http` is accepted because the traffic never reaches a network, which is the
 * same reason browsers treat it as a secure context and OAuth permits it as a redirect URI.
 * Everything else is refused, and the case that matters most is the one that looks like loopback
 * without being it.
 * @author John Grimes
 */

import { describe, expect, it } from "vitest";

import { isSecureUrl, secureUrl } from "@/link/secureOrigin";

describe("where a bearer token may be presented", () => {
  describe("accepted", () => {
    it.for([
      "https://links.example.org/shl/inv-1/fhir",
      "https://ehr.example.org/fhir",
      "https://localhost:3000/shl/inv-1/fhir",
      "http://localhost:3000/shl/inv-1/fhir",
      "http://localhost/shl/inv-1/fhir",
      "http://127.0.0.1:3000/shl/inv-1/fhir",
      "http://[::1]:3000/shl/inv-1/fhir",
      "  https://links.example.org/fhir  ",
    ])("accepts %s", (value) => {
      expect(isSecureUrl(value)).toBe(true);
    });
  });

  describe("refused", () => {
    /*
     * The important half. A host that merely *contains* a loopback name is a different machine,
     * and reading it as loopback is how a rule like this gets defeated.
     */
    it.for([
      "http://localhost.example.org/fhir",
      "http://notlocalhost/fhir",
      "http://localhost.attacker.test/fhir",
      "http://127.0.0.1.example.org/fhir",
      "http://127.0.0.2:3000/fhir",
      "http://10.0.0.1/fhir",
      "http://links.example.org/shl/inv-1/fhir",
    ])("refuses %s", (value) => {
      expect(isSecureUrl(value)).toBe(false);
    });

    // Nothing usable is not a destination either, and must never throw.
    it.for([
      ["nothing", undefined],
      ["null", null],
      ["a number", 3000],
      ["empty", ""],
      ["whitespace", " ".repeat(3)],
      ["a bare host", "links.example.org"],
      ["a relative path", "/shl/inv-1/fhir"],
      ["another scheme", "ftp://links.example.org/fhir"],
      ["a file URL", "file:///etc/passwd"],
      ["javascript", "javascript:alert(1)"],
    ] as const)("refuses %s", ([, value]) => {
      expect(isSecureUrl(value)).toBe(false);
    });
  });

  it("returns the parsed URL, so a caller can read its host", () => {
    expect(secureUrl("https://links.example.org/shl/inv-1/fhir")?.host).toBe(
      "links.example.org",
    );
    expect(secureUrl("http://localhost:3000/shl/inv-1/fhir")?.host).toBe(
      "localhost:3000",
    );
  });
});
