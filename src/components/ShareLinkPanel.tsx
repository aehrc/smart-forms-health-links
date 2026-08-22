import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { decodingCodec } from "@/link/codec";
import {
  MAX_QR_BYTES,
  linkByteLength,
  renderQr,
  type QrResult,
} from "@/link/qr";
import { LINK_CODECS } from "@/link/registry";

export interface ShareLinkPanelProps {
  link: string;
  /** Shapes the wording only; the security note is derived from the link itself. */
  kind?: "request" | "response";
}

/** Which codec produced this link, so the security note can tell the truth about it. */
function codecIdOf(link: string): "bespoke" | "shl" | "unknown" {
  try {
    return decodingCodec(link, LINK_CODECS).id;
  } catch {
    return "unknown";
  }
}

export default function ShareLinkPanel(props: ShareLinkPanelProps) {
  const { link, kind = "response" } = props;

  const [qrState, setQrState] = useState<{
    link: string;
    qr: QrResult | null;
    error: string | null;
  }>({ link, qr: null, error: null });
  const [copied, setCopied] = useState(false);

  /*
   * Derived during render rather than reset inside the effect: a QR belonging to the previous link
   * must never be shown against this one, and state discarded here never reaches the screen. The
   * alternative - clearing it in the effect body - paints the old QR once first.
   */
  const current =
    qrState.link === link ? qrState : { link, qr: null, error: null };
  const qr = current.qr;
  const qrError = current.error;

  useEffect(() => {
    let cancelled = false;

    renderQr(link)
      .then((result) => {
        if (!cancelled) {
          setQrState({ link, qr: result, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQrState({
            link,
            qr: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [link]);

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const byteLength = linkByteLength(link);
  const codecId = codecIdOf(link);

  // What stands in for the QR: the reason it could not be built, or that it is still building.
  const qrFallback = qrError ? (
    <div className="w-full sm:w-80">
      <Alert tone="warning" title="Too large to scan">
        {qrError}
        <p className="mt-1">
          {byteLength} bytes, {MAX_QR_BYTES} maximum.
        </p>
      </Alert>
    </div>
  ) : (
    <p className="flex h-80 w-80 items-center justify-center gap-2 rounded-md border border-slate-200 dark:border-slate-800 text-sm text-slate-500 dark:text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Building QR…
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {kind === "request" ? "Request link" : "Shareable link"}
        </CardTitle>
        <CardDescription>
          {kind === "request"
            ? "Scan this to open the form on another device. The whole questionnaire travels inside it."
            : "Scan this to hand the answers back, or copy the link."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {codecId === "shl" ? (
          <Alert title="Encrypted SMART Health Link">
            The contents are encrypted (A256GCM) and hosted by this app; the
            link carries only a pointer and the decryption key, so nothing
            clinical travels in the QR code itself. Anyone holding the link can
            open it and can fetch it more than once (there is no passcode),
            which is also what lets whoever fills the form return the answers
            directly.
          </Alert>
        ) : (
          <Alert tone="warning" title="This link is not encrypted">
            The answers are compressed into the link, not protected. Anyone who
            photographs the QR code or sees the URL can read them.
          </Alert>
        )}

        <div className="flex flex-col items-start gap-4 sm:flex-row">
          <div className="shrink-0">
            {qr ? (
              <>
                <img
                  src={qr.dataUrl}
                  alt="QR code containing the link"
                  className="rounded-md border border-slate-200 dark:border-slate-800"
                  width={320}
                  height={320}
                />
                <p className="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">
                  {qr.byteLength} / {MAX_QR_BYTES} bytes · error correction{" "}
                  {qr.level}
                </p>
              </>
            ) : (
              qrFallback
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <label
              className="text-sm font-medium text-slate-700 dark:text-slate-300"
              htmlFor="share-link"
            >
              Link
            </label>
            <textarea
              id="share-link"
              readOnly
              value={link}
              rows={6}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-none rounded-md border border-slate-300 bg-slate-50 p-2 font-mono text-xs break-all dark:border-slate-700 dark:bg-slate-950"
            />
            <Button
              onClick={() => {
                void copyLink();
              }}
              variant="outline"
              size="sm"
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
