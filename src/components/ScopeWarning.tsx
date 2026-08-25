import { Link as RouterLink } from 'react-router-dom';
import { useSmartSession } from '@/auth/SmartContext';
import { LAUNCH_SETUP_PATH } from '@/auth/routes';
import { isPrePopulateScope, isWriteBackScope, missingScopes } from '@/auth/scopes';
import { useConfig } from '@/lib/ConfigContext';
import { Alert } from '@/components/ui/alert';

/**
 * Says so when the server granted less than was asked for.
 *
 * A narrowed grant is **legal, and silent**. The server returns a token, the launch succeeds, the
 * badge goes green, and nothing appears wrong until a clinician presses Accept and the write comes
 * back refused — at which point the failure looks like a bug in this app rather than a decision made
 * at the authorisation server. Surfacing it at the top of the screen moves that discovery from the
 * middle of somebody's consultation to the moment they sign in.
 *
 * Rendered only when there is something to say. An app that nags about a correctly configured launch
 * teaches people to ignore the banner that matters.
 */
export default function ScopeWarning() {
  const session = useSmartSession();
  const config = useConfig();

  if (!session) {
    return null;
  }

  const missing = missingScopes(session.requestedScopes, session.grantedScopes);

  if (missing.length === 0) {
    return null;
  }

  /*
   * Split because the halves have very different consequences. Losing a feature scope costs that
   * feature and nothing else; losing `user/Patient.crs` breaks the patient picker, and saying which is
   * which is the difference between a warning somebody can act on and one they can only worry about.
   *
   * The two feature buckets overlap rather than partition, because `mergePermissions` collapses
   * extraction's `user/Condition.cu` and population's `user/Condition.rs` into one scope. A server
   * refusing that refused both, so it is named under both.
   */
  const writeBack = missing.filter(isWriteBackScope);
  const prePopulate = missing.filter(isPrePopulateScope);
  const other = missing.filter(
    (scope) => !isWriteBackScope(scope) && !isPrePopulateScope(scope)
  );
  const featureOnly = other.length === 0;

  /*
   * Named as the capability a clinician would recognise, not as the scope. "user/Condition.crus was
   * refused" is true and useless; "filling a form from the record is not permitted here" is the same
   * fact in terms of what they were about to try to do.
   */
  const affected = [
    prePopulate.length > 0 ? 'Filling a form from the record' : null,
    writeBack.length > 0 ? 'writing into the patient record' : null
  ].filter((phrase): phrase is string => phrase !== null);

  return (
    <Alert
      tone="warning"
      title={
        featureOnly
          ? `${affected.join(' and ')} ${affected.length > 1 ? 'are' : 'is'} not permitted on this server`
          : 'Your server granted fewer permissions than this app asked for'
      }>
      <ul className="space-y-0.5">
        {missing.map((scope) => (
          <li key={scope} className="font-mono text-xs">
            {scope}
          </li>
        ))}
      </ul>

      {prePopulate.length > 0 ? (
        <p className="mt-1">
          A form can still be requested; it will go out blank rather than pre-filled. Worth knowing
          that this failure is <strong>silent</strong> if it is ignored — a search the server refuses
          produces an empty answer, which looks exactly like a record holding nothing.
          {config.enablePrePopulate ? (
            <>
              {' '}
              Set <span className="font-mono text-xs">enablePrePopulate: false</span> to remove the
              option rather than have it quietly return nothing.
            </>
          ) : null}
        </p>
      ) : null}

      {writeBack.length > 0 ? (
        <p className="mt-1">
          Answers can still be reviewed and saved. What will fail is the last step — writing the
          resources extracted from them into the record — and it will fail at the point of accepting,
          not before.
          {config.enableWriteBack ? (
            <>
              {' '}
              Set <span className="font-mono text-xs">enableWriteBack: false</span> to remove the
              option rather than have it refused.
            </>
          ) : null}
        </p>
      ) : null}

      {other.length > 0 ? (
        <p className="mt-1">
          Parts of the app that need these will come back empty or refuse. This is the authorisation
          server&rsquo;s decision, not a configuration error here.
        </p>
      ) : null}

      <p className="mt-1">
        <RouterLink to={LAUNCH_SETUP_PATH} className="underline underline-offset-2">
          What this deployment asks for, and why
        </RouterLink>
      </p>
    </Alert>
  );
}
