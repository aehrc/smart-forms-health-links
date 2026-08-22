/**
 * Byte-level helpers for link payloads.
 *
 * Compression uses the browser's native `CompressionStream`, so there is no dependency on
 * pako/fflate. `deflate-raw` is supported in Chrome 80+, Safari 16.4+ and Firefox 113+.
 *
 * Measured against the real QuestionnaireResponse fixtures in the smart-forms repo, deflate-raw
 * plus base64url lands between 780 and 1455 bytes for responses of 1.8-7 KB raw — a ratio of
 * roughly 0.20-0.5, improving as responses get larger.
 */

export function supportsCompressionStream(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined"
  );
}

async function streamThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // `Blob.stream()` avoids having to hand-feed the writable side of the transform.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (!supportsCompressionStream()) {
    throw new Error(
      "This browser does not support CompressionStream, which is required to build links.",
    );
  }

  return streamThrough(bytes, new CompressionStream("deflate-raw"));
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (!supportsCompressionStream()) {
    throw new Error(
      "This browser does not support DecompressionStream, which is required to read links.",
    );
  }

  return streamThrough(bytes, new DecompressionStream("deflate-raw"));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to stay well clear of the argument-count limit on String.fromCodePoint.
  const chunkSize = 0x80_00;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  // Every code unit `atob` produces is a byte, so reading code points index-wise is exact.
  return Uint8Array.from(
    atob(padded),
    (character) => character.codePointAt(0) ?? 0,
  );
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
