import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import { startLaunch } from '@/auth/smartSession';
import { CALLBACK_PATH, LAUNCH_SETUP_PATH } from '@/auth/routes';
import { Alert } from '@/components/ui/alert';
import SmartRegistration from '@/components/SmartRegistration';

/**
 * The SMART App Launch entry point — register this URL with the EHR.
 *
 * Serves both launch patterns from one route, which is what the specification intends. An EHR launch
 * arrives as `/launch?iss=…&launch=…`; a standalone launch is the same URL with no parameters, and the
 * configured issuer stands in for the missing `iss`.
 *
 * This route only ever redirects away. It renders a spinner for the moment before that happens and an
 * error if it cannot, and nothing else — the session is established on {@link Callback}.
 */
export default function Launch() {
  const config = useConfig();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  const iss = params.get('iss');
  const launch = params.get('launch');

  useEffect(() => {
    if (!canUseSmartLaunch(config)) {
      setError(
        'SMART App Launch is not enabled. Set `enableSmartLaunch`, `smartIssuerUrl` and ' +
          '`smartClientId` in config.json.'
      );
      return;
    }

    startLaunch(config, { iss, launch, callbackPath: CALLBACK_PATH }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [config, iss, launch]);

  if (error) {
    return (
      <div className="space-y-4 py-8">
        <h1 className="text-xl font-semibold text-slate-900">Launch failed</h1>
        <Alert tone="error" title="This app could not start a SMART session">
          {error}
        </Alert>

        {/* Failing before the redirect means the deployment is misconfigured, so show what it needs. */}
        <SmartRegistration />

        <p className="text-xs text-slate-500">
          This is also at{' '}
          <a href={LAUNCH_SETUP_PATH} className="underline">
            {LAUNCH_SETUP_PATH}
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {launch ? 'Connecting to your EHR…' : 'Signing in…'}
    </p>
  );
}
