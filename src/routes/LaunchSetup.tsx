import { Link as RouterLink } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import SmartRegistration from '@/components/SmartRegistration';
import { Alert } from '@/components/ui/alert';

/**
 * What to register with an authorisation server, for whoever is standing this app up.
 *
 * A separate route from `/launch` because that one redirects the instant it renders and can therefore
 * never explain anything. Somebody whose launch is failing needs a page that is not the failing thing,
 * and one they can send to whoever administers the OAuth client — which is often not them.
 *
 * Deliberately reachable without a session, and without a working launch. It is the only route in the
 * app that is *most* useful when nothing works yet.
 */
export default function LaunchSetup() {
  const config = useConfig();

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">SMART App Launch setup</h1>
        <p className="text-sm text-slate-500">
          Everything an authorisation server needs to know about this deployment.
        </p>
      </div>

      {!canUseSmartLaunch(config) ? (
        <Alert tone="warning" title="Launches are not enabled on this deployment">
          <p>
            Set <span className="font-mono text-xs">enableSmartLaunch</span>,{' '}
            <span className="font-mono text-xs">smartIssuerUrl</span> and{' '}
            <span className="font-mono text-xs">smartClientId</span> in{' '}
            <span className="font-mono text-xs">config.json</span>. The app works fully without a
            launch, so this is optional — see the README.
          </p>
          <p className="mt-1">
            The scopes below are still what it would ask for, so they can be registered ahead of time.
          </p>
        </Alert>
      ) : null}

      <SmartRegistration />

      <Alert title="Check the issuer before trying a real launch">
        <p>
          <span className="font-mono text-xs">npm run check:smart</span> probes the configured issuer
          and reports, scope by scope, what it advertises. It catches the failure everyone hits first:
          an issuer that is a plain FHIR base rather than one serving{' '}
          <span className="font-mono text-xs">.well-known/smart-configuration</span>, which returns a
          200-shaped <span className="font-mono text-xs">OperationOutcome</span> that reads like
          success.
        </p>
      </Alert>
    </div>
  );
}
