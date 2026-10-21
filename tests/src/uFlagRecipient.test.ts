/**
 * Reading somebody else's `U`-flag link sends `recipient`, and reading a manifest `location`
 * does not.
 *
 * The SHL spec makes `recipient` a required query parameter on the `U`-flag `GET`. This app
 * omitted it for as long as it read `U`-flag links, which worked only because the hosts it met did
 * not insist - the inbound half of `docs/u-flag-hosting.md`. A patient app that hosts its links
 * through a relay and logs each access does insist, and the link it hands back is exactly what the
 * scan-back path reads. So the host here refuses a request without the parameter, the way a
 * conformant one may.
 *
 * A host that refuses the parameter instead - a FHIR `Binary`, which is where this app used to
 * park its own payloads - gets one retry without it, the same tolerance Platypus applies.
 *
 * The last half is a guard against fixing too much. A manifest file's `location` is fetched with
 * nothing added: the spec asks for no parameters there, and a location is usually a signed URL
 * whose signature a stray query parameter would break.
 * @author John Grimes
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeUtf8, toBase64Url } from "@/link/binary";
import { encryptJwe, generateKey, keyToBase64Url } from "@/link/jwe";
import { shlCodec } from "@/link/shlCodec";

/** What the patient app hands back: a bare response, the fallback channel's shape. */
const RESPONSE = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
};

/**
 * Build a `shlink:/` fragment.
 * @param payload the SHL payload
 * @returns the fragment
 */
function fragmentFor(payload: Record<string, unknown>): string {
  return `#shlink:/${toBase64Url(encodeUtf8(JSON.stringify(payload)))}`;
}

/**
 * Read the request URL out of a `fetch` call's arguments.
 * @param input the first argument `fetch` was called with
 * @returns the URL as a string
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * Stub `fetch` with a host that serves one JWE, and only to a request naming its reader.
 * @param jwe the encrypted file to serve
 * @returns the mock, for reading back what was requested
 */
function strictHost(jwe: string) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(urlOf(input));
    return Promise.resolve(
      url.searchParams.has("recipient")
        ? new Response(jwe, { status: 200 })
        : Response.json({ error: "recipient required" }, { status: 400 }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The URL of the one request `fetch` was called with.
 * @param fetchMock the stubbed fetch
 * @returns the requested URL, parsed
 */
function requestedUrl(fetchMock: ReturnType<typeof strictHost>): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL(urlOf(fetchMock.mock.calls[0][0]));
}

/**
 * Stub `fetch` with a FHIR `Binary` host: the bare URL answers, a URL with a query does not.
 * @param jwe the encrypted file to serve
 * @param bareStatus what the bare URL answers with
 * @returns the mock, for reading back what was requested
 */
function fhirBinaryHost(jwe: string, bareStatus = 200) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(urlOf(input));
    if (url.search !== "") {
      return Promise.resolve(
        Response.json({ resourceType: "OperationOutcome" }, { status: 400 }),
      );
    }
    return Promise.resolve(
      bareStatus === 200
        ? new Response(jwe, { status: 200 })
        : new Response(null, { status: bareStatus }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("reading a U-flag link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens against a host that requires recipient", async () => {
    const key = generateKey();
    const fetchMock = strictHost(
      await encryptJwe(encodeUtf8(JSON.stringify(RESPONSE)), key),
    );

    const content = await shlCodec.decode(
      fragmentFor({
        url: "https://relay.example.com/shl/abc",
        key: keyToBase64Url(key),
        flag: "U",
      }),
    );

    expect(content.bundle.entry?.[0]?.resource?.resourceType).toBe(
      "QuestionnaireResponse",
    );
    expect(requestedUrl(fetchMock).searchParams.get("recipient")).toBe(
      "Smart Forms Health Links",
    );
  });

  it("names the caller's recipient when one is given", async () => {
    const key = generateKey();
    const fetchMock = strictHost(
      await encryptJwe(encodeUtf8(JSON.stringify(RESPONSE)), key),
    );

    await shlCodec.decode(
      fragmentFor({
        url: "https://relay.example.com/shl/abc",
        key: keyToBase64Url(key),
        flag: "U",
      }),
      { recipient: "Example Practice" },
    );

    expect(requestedUrl(fetchMock).searchParams.get("recipient")).toBe(
      "Example Practice",
    );
  });

  // The host's own query string is part of its address, not something to replace.
  it("keeps a query string the host already put on the URL", async () => {
    const key = generateKey();
    const fetchMock = strictHost(
      await encryptJwe(encodeUtf8(JSON.stringify(RESPONSE)), key),
    );

    await shlCodec.decode(
      fragmentFor({
        url: "https://relay.example.com/shl?ticket=t-123",
        key: keyToBase64Url(key),
        flag: "U",
      }),
    );

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/shl");
    expect(url.searchParams.get("ticket")).toBe("t-123");
    expect(url.searchParams.get("recipient")).toBe("Smart Forms Health Links");
  });
});

/*
 * The other kind of host. A general-purpose FHIR server refuses a `Binary` read carrying a
 * parameter it does not know, and that is where this app itself used to park payloads. Sending
 * `recipient` must not cost those links, so a `400` is retried once without it - and only a `400`.
 */
describe("reading a U-flag link from a host that refuses recipient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once without recipient after a 400, and opens", async () => {
    const key = generateKey();
    const fetchMock = fhirBinaryHost(
      await encryptJwe(encodeUtf8(JSON.stringify(RESPONSE)), key),
    );

    const content = await shlCodec.decode(
      fragmentFor({
        url: "https://fhir.example.com/Binary/4343",
        key: keyToBase64Url(key),
        flag: "U",
      }),
    );

    expect(content.bundle.entry?.[0]?.resource?.resourceType).toBe(
      "QuestionnaireResponse",
    );
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual([
      "https://fhir.example.com/Binary/4343?recipient=Smart+Forms+Health+Links",
      "https://fhir.example.com/Binary/4343",
    ]);
  });

  it("reports the retry's failure, not the 400 that caused it", async () => {
    fhirBinaryHost("", 404);

    await expect(
      shlCodec.decode(
        fragmentFor({
          url: "https://fhir.example.com/Binary/gone",
          key: keyToBase64Url(generateKey()),
          flag: "U",
        }),
      ),
    ).rejects.toThrow("404");
  });

  // A link that is gone is gone. Retrying it would double every request for a revoked link.
  it("does not retry a 404", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      shlCodec.decode(
        fragmentFor({
          url: "https://relay.example.com/shl/revoked",
          key: keyToBase64Url(generateKey()),
          flag: "U",
        }),
      ),
    ).rejects.toThrow("404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reading a manifest file by location", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the location exactly as given", async () => {
    const key = generateKey();
    const jwe = await encryptJwe(encodeUtf8(JSON.stringify(RESPONSE)), key, {
      contentType: "application/fhir+json",
    });
    const LOCATION =
      "https://files.example.com/abc?X-Amz-Signature=sig&X-Amz-Expires=60";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json({
              files: [
                { contentType: "application/fhir+json", location: LOCATION },
              ],
            })
          : new Response(jwe, { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await shlCodec.decode(
      fragmentFor({
        url: "https://relay.example.com/shl/manifest",
        key: keyToBase64Url(key),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock.mock.calls[1][0])).toBe(LOCATION);
  });
});
