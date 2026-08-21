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

  const [qr, setQr] = useState<QrResult | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setQr(null);
    setQrError(null);

    renderQr(link)
      .then((result) => {
        if (!cancelled) {
          setQr(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQrError(error instanceof Error ? error.message : String(error));
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
            The contents are encrypted (A256GCM) and hosted separately; this
            link carries only a pointer and the decryption key. Anyone holding
            the link can decrypt it — there is no passcode, because the
            single-file <span className="font-mono text-xs">U</span> flag cannot
            be combined with one.
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
                  className="rounded-md border border-slate-200"
                  width={320}
                  height={320}
                />
                <p className="mt-1 text-center text-xs text-slate-500">
                  {qr.byteLength} / {MAX_QR_BYTES} bytes · error correction{" "}
                  {qr.level}
                </p>
              </>
            ) : qrError ? (
              <div className="w-full sm:w-80">
                <Alert tone="warning" title="Too large to scan">
                  {qrError}
                  <p className="mt-1">
                    {byteLength} bytes, {MAX_QR_BYTES} maximum.
                  </p>
                </Alert>
              </div>
            ) : (
              <p className="flex h-80 w-80 items-center justify-center gap-2 rounded-md border border-slate-200 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Building QR…
              </p>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <label
              className="text-sm font-medium text-slate-700"
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
              className="w-full resize-none rounded-md border border-slate-300 bg-slate-50 p-2 font-mono text-xs break-all"
            />
            <Button onClick={copyLink} variant="outline" size="sm">
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
