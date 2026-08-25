import type { ReactNode } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { KeyRound, LogIn } from 'lucide-react';
import { LAUNCH_PATH, LAUNCH_SETUP_PATH } from '@/auth/routes';
import { rememberReturnPath } from '@/auth/returnTo';
import { useConfig } from '@/lib/ConfigContext';
import { canUseSmartLaunch } from '@/lib/config';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * "This needs a launch", in the two sizes the app needs it.
 *
 * Shown in place rather than redirected to. A screen that silently bounces somebody to a login has
 * hidden the reason it did so, and on a deployment whose issuer is misconfigured it bounces them into a
 * loop — which is the failure this app already has a whole page dedicated to explaining.
 *
 * Both forms offer the same two ways out, and the second is not decoration: the audience for a gate is
 * split between a clinician who needs to sign in and a deployer whose launch does not work yet, and
 * only one of them is helped by a Launch button.
 */

/**
 * Where a launch should return to: this screen, with its query string, and never its fragment.
 *
 * The fragment is left off deliberately. On this app it can hold a whole SMART Health Link payload, and
 * a link is the filler's business — carrying one through a clinician's launch would be both pointless
 * and a small leak of somebody else's invitation into storage.
 */
function useCurrentPath(): string {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
}

export function LaunchLink({
  className,
  iconClassName = 'h-4 w-4'
}: {
  className?: string;
  iconClassName?: string;
}) {
  const returnTo = useCurrentPath();

  /*
   * A plain anchor, as `SessionBadge` used to be. `/launch` redirects off-origin the moment it mounts,
   * so a client-side navigation buys nothing, and a full load is the more honest thing to hand the
   * browser.
   */
  return (
    <a href={LAUNCH_PATH} onClick={() => rememberReturnPath(returnTo)} className={className}>
      <LogIn className={iconClassName} aria-hidden />
      Launch
    </a>
  );
}

export function SetupLink({
  className,
  iconClassName = 'h-4 w-4'
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <RouterLink to={LAUNCH_SETUP_PATH} className={className}>
      <KeyRound className={iconClassName} aria-hidden />
      Launch setup
    </RouterLink>
  );
}

const BUTTON =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors';

/**
 * A whole surface that cannot be used without a launch — `/request/:id` is the only one.
 *
 * `children` says what specifically is being refused, in the vocabulary of the screen it replaces.
 */
export function LaunchRequired({ title, children }: { title: string; children?: ReactNode }) {
  const config = useConfig();
  const launchable = canUseSmartLaunch(config);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {children ?? 'This writes to a patient record, so it needs a launched session.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {launchable ? (
            <LaunchLink className={`${BUTTON} bg-slate-900 text-white hover:bg-slate-800`} />
          ) : null}
          <SetupLink
            className={`${BUTTON} border border-slate-300 bg-white text-slate-900 hover:bg-slate-100`}
          />
        </div>
        <p className="text-xs text-slate-500">
          {launchable
            ? 'You will come back to this screen once the launch completes.'
            : 'This deployment has no SMART launch configured yet. Launch setup lists everything an authorisation server needs.'}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The inline form, for a disabled button on a screen that is otherwise perfectly usable.
 *
 * Deliberately quiet — `tone="info"` rather than a warning. Nothing has gone wrong: reviewing answers
 * without a session is a legitimate thing to be doing, and only the last step of it is refused.
 */
export function LaunchRequiredNote({ children }: { children?: ReactNode }) {
  const config = useConfig();

  return (
    <Alert tone="info">
      <p>{children ?? 'A launched session is needed to write this to the record.'}</p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {canUseSmartLaunch(config) ? (
          <LaunchLink className="inline-flex items-center gap-1.5 font-medium underline" />
        ) : null}
        <SetupLink className="inline-flex items-center gap-1.5 underline" />
      </p>
    </Alert>
  );
}
