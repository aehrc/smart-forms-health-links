import { useState } from 'react';
import { Link2, Loader2, WifiOff } from 'lucide-react';
import type { Questionnaire, Task } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import { createOfflineResponseLink, createResponseLink } from '@/link/createLink';
import { taskCorrelationId } from '@/link/exchange';
import FormRenderer from '@/components/FormRenderer';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

export interface FillFromRequestProps {
  questionnaire: Questionnaire;
  task: Task;
  label?: string;
}

/**
 * The filler's side: a request arrived, so render its embedded Questionnaire and hand the answers
 * back.
 *
 * Two return paths, because they have genuinely different trade-offs:
 *
 * - **Offline** — answers compressed into the link itself. Nothing is hosted anywhere, which is the
 *   only option open to an app with no server of its own, but it is unencrypted and caps out around
 *   14 KB of raw response JSON.
 * - **SMART Health Link** — encrypted and hosted, so no size limit, but it needs somewhere to put
 *   the payload. In production that would be the filling app's own storage.
 *
 * Offline is the default here: it is what a genuinely server-less mobile app can do.
 */
export default function FillFromRequest(props: FillFromRequestProps) {
  const { questionnaire, task, label } = props;
  const config = useConfig();

  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'offline' | 'shl' | null>(null);

  async function handleReturn(mode: 'offline' | 'shl') {
    setError(null);
    setPending(mode);
    try {
      const created =
        mode === 'offline'
          ? await createOfflineResponseLink(questionnaire, config, task)
          : await createResponseLink(questionnaire, config, task);
      setLink(created);
    } catch (cause) {
      setLink(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  const correlationId = taskCorrelationId(task);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {label ?? questionnaire.title ?? questionnaire.id}
          </h1>
          <p className="text-sm text-slate-500">
            Someone has asked for this form to be completed.
            {correlationId ? (
              <>
                {' '}
                Request <span className="font-mono text-xs">{correlationId}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => handleReturn('offline')} disabled={pending !== null}>
            {pending === 'offline' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <WifiOff className="h-4 w-4" aria-hidden />
            )}
            Return answers offline
          </Button>
          <Button
            variant="outline"
            onClick={() => handleReturn('shl')}
            disabled={pending !== null}
            title="Encrypted and hosted — no size limit, but requires storage">
            {pending === 'shl' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Link2 className="h-4 w-4" aria-hidden />
            )}
            Return as Health Link
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="error" title="Could not build the return link">
          {error}
        </Alert>
      ) : null}

      {link ? <ShareLinkPanel link={link} kind="response" /> : null}

      <div className="form-surface">
        <FormRenderer
          questionnaire={questionnaire}
          terminologyServerUrl={config.terminologyServerUrl}
        />
      </div>
    </div>
  );
}
