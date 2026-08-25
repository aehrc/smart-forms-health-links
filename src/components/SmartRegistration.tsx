import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useConfig } from '@/lib/ConfigContext';
import { CALLBACK_PATH, LAUNCH_PATH } from '@/auth/routes';
import { isWriteBackScope, registrationScopes } from '@/auth/scopes';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * What a deployer has to register with their authorisation server, generated from this build.
 *
 * Every value here is derived from the running config rather than written down, which is the entire
 * point. A scope list in a document drifts the first time the code asks for something new — that has
 * already happened once in this repo — and a deployment overriding `smartScopes` makes any fixed list
 * wrong regardless of how carefully it is maintained. What this renders is what this deployment will
 * actually send.
 *
 * The URLs come from `window.location.origin` for the same reason: `redirect_uri` must match what is
 * registered *exactly*, and reading it off the page the deployer is looking at removes the one
 * transcription step where a trailing slash or a wrong host gets introduced.
 */

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100">
      {copied ? (
        <Check className="h-3 w-3 text-green-600" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-start gap-2 border-b border-slate-100 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-800">{label}</p>
        <p className="font-mono text-xs break-all text-slate-600">{value}</p>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

export default function SmartRegistration() {
  const config = useConfig();

  /*
   * `window.location.origin` rather than `linkBaseUrl`. That field exists so a *health link* can name a
   * host the filler's phone can reach, which is a different question from where this app is being
   * served — and the redirect URI has to be the latter or the flow will not come back.
   */
  const origin = window.location.origin;
  const scopes = registrationScopes(config);
  const scopeString = scopes.join(' ');
  const writeBackScopes = scopes.filter(isWriteBackScope);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Register these with your authorisation server</CardTitle>
        <CardDescription>
          Generated from this deployment&rsquo;s own configuration, so it is accurate for this build
          and this host. A launch fails with an opaque error if any of it is registered differently.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <Row
            label="Launch URL"
            value={`${origin}${LAUNCH_PATH}`}
            hint="Where the EHR sends the user to start a launch."
          />
          <Row
            label="Redirect URI"
            value={`${origin}${CALLBACK_PATH}`}
            hint="Must match exactly — a trailing slash is a different URI."
          />
          <Row
            label="Client id"
            value={config.smartClientId ?? 'not configured'}
            hint="A public client: a static site holds no secret, so PKCE does the binding."
          />
          <Row
            label="Issuer"
            value={config.smartIssuerUrl ?? 'not configured'}
            hint="Also the allowlist for the iss a launch may arrive with."
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-slate-800">
              Scopes &mdash; all {scopes.length} must be allowed
            </p>
            <CopyButton value={scopeString} label="Copy all scopes" />
          </div>

          <ul className="flex flex-wrap gap-1">
            {scopes.map((scope) => (
              <li
                key={scope}
                className={
                  isWriteBackScope(scope)
                    ? 'rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs text-amber-900'
                    : 'rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700'
                }>
                {scope}
              </li>
            ))}
          </ul>

          {/*
            * Called out because it is the one that looks like a mistake in the list and is not. No
            * single request ever names both `launch` and `launch/patient` — `buildScopes` swaps one
            * for the other — so a registration copied from an observed EHR launch is missing the
            * standalone half, and fails only when somebody opens /launch directly.
            */}
          <Alert title="Both launch and launch/patient are needed">
            An EHR launch sends <span className="font-mono text-xs">launch</span>; a standalone launch
            sends <span className="font-mono text-xs">launch/patient</span> instead, because there is
            no EHR context to inherit. Neither request names both, but this app serves both patterns
            from one route, so the registration has to permit both.
          </Alert>

          {writeBackScopes.length > 0 ? (
            <Alert title="The amber scopes are only for writing into the record">
              <p>
                Form data extraction emits <span className="font-mono text-xs">PUT</span> and{' '}
                <span className="font-mono text-xs">PATCH</span> entries, which is the only reason this
                app asks to update anything. Nothing is ever deleted, and the resources it authors —
                responses, Tasks, Provenances — stay create-only.
              </p>
              <p className="mt-1">
                A deployment whose forms declare no extraction can refuse them: set{' '}
                <span className="font-mono text-xs">enableWriteBack: false</span>, or narrow{' '}
                <span className="font-mono text-xs">smartScopes</span>, and the rest of the app is
                unaffected.
              </p>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
