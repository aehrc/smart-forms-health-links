import QRCode from "qrcode";

import {
  chooseErrorCorrectionLevel,
  linkByteLength,
  MAX_QR_BYTES,
  type ErrorCorrectionLevel,
} from "./qrCapacity";

export interface QrResult {
  dataUrl: string;
  level: ErrorCorrectionLevel;
  byteLength: number;
}

/**
 * Render a link as a QR data URL.
 *
 * Throws when the link is too long to be encoded. Note that a link too big for a QR code is still
 * a perfectly valid link - it just has to be shared as a URL rather than scanned, which is the
 * fallback the UI offers.
 */
export async function renderQr(link: string): Promise<QrResult> {
  const byteLength = linkByteLength(link);
  const level = chooseErrorCorrectionLevel(link);

  if (level === null) {
    throw new Error(
      `This response is too large for a QR code (${byteLength} bytes, maximum ${MAX_QR_BYTES}). ` +
        "The link itself still works - copy it instead.",
    );
  }

  const dataUrl = await QRCode.toDataURL(link, {
    errorCorrectionLevel: level,
    margin: 2,
    width: 320,
  });

  return { dataUrl, level, byteLength };
}

export {
  MAX_QR_BYTES,
  chooseErrorCorrectionLevel,
  linkByteLength,
  type ErrorCorrectionLevel,
} from "./qrCapacity";
