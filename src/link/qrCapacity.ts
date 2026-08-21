/**
 * QR capacity arithmetic, kept free of any dependency on the `qrcode` renderer so it can be
 * unit-tested in Node and imported without pulling in a canvas/fs-bound library.
 */

/**
 * Byte-mode capacity of a version-40 (largest) QR code, per error-correction level.
 * Source: ISO/IEC 18004 capacity tables.
 */
const CAPACITY_BY_LEVEL = [
  { level: "M", bytes: 2331 },
  { level: "L", bytes: 2953 },
] as const;

export type ErrorCorrectionLevel = (typeof CAPACITY_BY_LEVEL)[number]["level"];

/** The most a QR code can hold at all: the capacity of the least redundant level in the table. */
export const MAX_QR_BYTES = Math.max(
  ...CAPACITY_BY_LEVEL.map((capacity) => capacity.bytes),
);

export function linkByteLength(link: string): number {
  return new TextEncoder().encode(link).length;
}

/**
 * Choose the most robust error-correction level that still fits the link.
 *
 * 'M' (~15% recovery) is preferred because it scans far more reliably off a screen or a print-out;
 * 'L' is the fallback that buys another 622 bytes before the link stops fitting entirely.
 * Returns null when even 'L' cannot hold it.
 */
export function chooseErrorCorrectionLevel(
  link: string,
): ErrorCorrectionLevel | null {
  const byteLength = linkByteLength(link);
  return (
    CAPACITY_BY_LEVEL.find((entry) => byteLength <= entry.bytes)?.level ?? null
  );
}
