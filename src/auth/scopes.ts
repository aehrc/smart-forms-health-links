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
