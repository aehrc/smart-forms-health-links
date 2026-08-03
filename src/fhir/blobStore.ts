/**
 * Somewhere to park an encrypted SHL payload so a link can point at it.
 *
 * This exists as an interface because the storage tier is the piece most likely to change: today a
 * FHIR `Binary` on the forms server, tomorrow an S3 bucket or a real SHL manifest server. Nothing in
 * `shlCodec.ts` should know the difference.
 */
export interface BlobStore {
  /**
   * Store bytes and return a URL that yields them back on a plain `GET`.
   *
   * The URL must serve the raw bytes, not a wrapper object, because that is what the SHL `U` flag
   * requires of a recipient doing an unadorned GET.
   */
  put(bytes: Uint8Array, contentType: string): Promise<string>;
}

/** Media type for a JWE compact serialisation (RFC 7515 §9.2.1). */
export const JOSE_CONTENT_TYPE = 'application/jose';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Store blobs as FHIR `Binary` resources.
 *
 * Verified against the forms server (HAPI FHIR 8.10.0): `GET /Binary/{id}` returns the raw bytes
 * with the stored content type for any `Accept` that is not a FHIR media type — including no
 * `Accept` header at all. Only `Accept: application/fhir+json` yields the `Binary` resource
 * wrapper. That is exactly the behaviour the SHL `U` flag needs.
 *
 * This works because SHL assumes an untrusted host: the payload is a JWE and the key travels only
 * inside the link, so a public server never sees plaintext.
 */
export function fhirBinaryBlobStore(baseUrl: string): BlobStore {
  const base = trimTrailingSlash(baseUrl);

  return {
    async put(bytes: Uint8Array, contentType: string): Promise<string> {
      const response = await fetch(`${base}/Binary`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: bytes as BodyInit
      });

      if (!response.ok) {
        throw new Error(
          `Could not store the encrypted payload (${response.status} ${response.statusText}).`
        );
      }

      /*
       * Deliberately NOT using the Location header. The forms server is misconfigured and reports
       * `http://smartforms.csiro.au/fhir/Binary/{id}` — wrong scheme (http) and wrong path (/fhir
       * rather than /api/fhir). A link built from that would be unreadable. Take the id and
       * rebuild the URL against the base we were configured with.
       */
      const id = await readCreatedId(response);

      return `${base}/Binary/${encodeURIComponent(id)}`;
    }
  };
}

/**
 * Recover the id of the created resource.
 *
 * Prefer the response body when the server echoes a resource, and otherwise fall back to parsing the
 * Location header's path — its host may be wrong but its id is not.
 */
async function readCreatedId(response: Response): Promise<string> {
  const location = response.headers.get('Location') ?? response.headers.get('Content-Location');
  if (location) {
    const match = /\/Binary\/([^/?]+)/.exec(location);
    if (match) {
      return match[1];
    }
  }

  try {
    const body: unknown = await response.clone().json();
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id !== '') {
      return id;
    }
  } catch {
    // Binary creates echo raw bytes rather than JSON, so this is an expected miss.
  }

  throw new Error('The server accepted the payload but did not report where it was stored.');
}

/**
 * In-memory store, for tests. Returns `blob:`-style URLs that only `inMemoryBlobStore` itself can
 * resolve, so it is paired with a fetch shim in the test scripts.
 */
export function inMemoryBlobStore(): BlobStore & { get(url: string): Uint8Array | undefined } {
  const blobs = new Map<string, Uint8Array>();
  let counter = 0;

  return {
    async put(bytes: Uint8Array): Promise<string> {
      counter += 1;
      const url = `https://in-memory.test/blob/${counter}`;
      blobs.set(url, bytes);
      return url;
    },

    get(url: string): Uint8Array | undefined {
      return blobs.get(url);
    }
  };
}
