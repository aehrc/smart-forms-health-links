import { DEFAULT_SMART_SCOPES, type AppConfig } from '@/lib/config';

/**
 * Which scopes a launch asks for — pure policy, deliberately kept away from `smartSession.ts`.
 *
 * That module imports `fhirclient` and sets a library default at module scope, so importing anything
 * from it drags the whole library in. In a browser that costs nothing; in the Node check harness it
 * resolves `fhirclient`'s *Node* adapter and fails the bundle outright. Scope construction has no
 * dependency on any of that, so it lives here where `check:roundtrip` can assert it offline — and
 * these are assertions worth having, because a wrong scope fails at the consent screen, in a browser,
 * against someone else's server.
 */

/**
 * Scopes for the launch about to be attempted.
 *
 * A standalone launch has no EHR context to inherit, so `launch` — which means "use the context the
 * `launch` parameter refers to" — is meaningless and some servers reject it outright. `launch/patient`
 * is the standalone equivalent: it asks the authorisation server to have the user pick a patient.
 */
export function buildScopes(config: AppConfig, standalone: boolean): string {
  const scopes = (config.smartScopes ?? DEFAULT_SMART_SCOPES).split(/\s+/).filter(Boolean);

  if (!standalone) {
    return scopes.join(' ');
  }

  const rewritten = scopes.map((scope) => (scope === 'launch' ? 'launch/patient' : scope));
  return rewritten.includes('launch/patient')
    ? rewritten.join(' ')
    : [...rewritten, 'launch/patient'].join(' ');
}

/**
 * Every scope a **client registration** must allow, across both launch patterns.
 *
 * Not the same thing as what any one launch requests, and the difference is the mistake that produces
 * `invalid_scope` on a deployment that looked correctly configured. `buildScopes` swaps `launch` for
 * `launch/patient` on a standalone launch, so neither request ever names both — but a registration
 * allowing only one works from the EHR and fails the moment somebody opens `/launch` directly.
 *
 * Ordered rather than sorted: it is read by a human copying it into a registration form, and the
 * grouping — the OAuth scopes, then what the app reads, then what extraction writes — is the part that
 * makes it reviewable.
 */
export function registrationScopes(config: AppConfig): string[] {
  const ehr = buildScopes(config, false).split(' ');
  const standalone = buildScopes(config, true).split(' ');

  const seen = new Set<string>();
  return [...ehr, ...standalone].filter((scope) => {
    if (seen.has(scope)) {
      return false;
    }
    seen.add(scope);
    return true;
  });
}

/**
 * Scopes that were asked for and not granted.
 *
 * A server narrowing a grant is **legal and silent** — it returns a token, the launch succeeds, and
 * nothing goes wrong until a clinician presses Accept and the write is refused. Catching it at sign-in
 * turns that into something a deployer can fix before it reaches anyone's afternoon.
 *
 * Compared case-sensitively and as whole strings. A server that grants `user/Condition.cruds` in place
 * of `user/Condition.cu` is strictly more permissive but reports here as missing, which is the safe
 * direction to be wrong in: over-reporting prompts a look, under-reporting hides a failure until the
 * write. `grantedScopes` being empty means the server declined to enumerate, so nothing is reported.
 */
export function missingScopes(requested: string, granted: string): string[] {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));

  if (grantedSet.size === 0) {
    return [];
  }

  return requested.split(/\s+/).filter((scope) => scope !== '' && !grantedSet.has(scope));
}

/**
 * The scopes write-back needs, so a narrowed grant can say what stops working rather than only what
 * is absent.
 *
 * Derived from the requested set rather than hardcoded: `smartScopes` can name any list, and a
 * deployment that narrowed it deliberately should not be told it is missing something it chose to
 * drop. `.cu` on a clinical type is the shape only extraction asks for — see `DEFAULT_SMART_SCOPES`.
 */
export function isWriteBackScope(scope: string): boolean {
  return /^user\/[A-Za-z]+\.[a-z]*u/.test(scope);
}
