import { DEFAULT_SMART_SCOPES, PRE_POPULATE_SCOPES, type AppConfig } from '@/lib/config';

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
  /*
   * `smartScopes` takes over the list wholesale, pre-population included. A deployment that wrote its
   * own list said what it wants asked for, and quietly appending to it would make the setting a
   * suggestion rather than a statement.
   */
  const base =
    config.smartScopes ??
    (config.enablePrePopulate
      ? `${DEFAULT_SMART_SCOPES} ${PRE_POPULATE_SCOPES}`
      : DEFAULT_SMART_SCOPES);

  const scopes = mergePermissions(base.split(/\s+/).filter(Boolean));

  if (!standalone) {
    return scopes.join(' ');
  }

  const rewritten = scopes.map((scope) => (scope === 'launch' ? 'launch/patient' : scope));
  return rewritten.includes('launch/patient')
    ? rewritten.join(' ')
    : [...rewritten, 'launch/patient'].join(' ');
}

/** SMART v2 writes the permission letters in this order, and so must we. */
const PERMISSION_ORDER = ['c', 'r', 'u', 'd', 's'] as const;

/** `user/Condition.cu` — a v2 resource scope, which is the only kind with letters to merge. */
const RESOURCE_SCOPE = /^(user|patient|system)\/([A-Za-z]+|\*)\.([crudsa*]+)$/;

/**
 * Collapse two grants of the same resource into one, unioning their permission letters.
 *
 * Needed because pre-population and form data extraction want the same types for opposite reasons —
 * extraction writes `Condition`, population searches it — and asking for `user/Condition.cu` and
 * `user/Condition.rs` in the same breath is not wrong so much as *unanswerable*: the two are
 * alternative statements of one permission, and a server is free to grant either, both, or a
 * normalised third thing. `user/Condition.crus` asks the question once.
 *
 * It also keeps {@link missingScopes} honest, which compares granted scopes as whole strings: a
 * server echoing back the merged form would otherwise be reported as having refused both halves.
 *
 * Order is preserved by first appearance, because {@link registrationScopes} is read by a human
 * copying it into a form and its grouping is the part that makes it reviewable. Anything that is not
 * a v2 resource scope — `launch`, `openid`, `fhirUser` — passes through untouched.
 */
export function mergePermissions(scopes: string[]): string[] {
  const merged: string[] = [];
  const at = new Map<string, number>();

  for (const scope of scopes) {
    const match = RESOURCE_SCOPE.exec(scope);
    if (!match) {
      if (!merged.includes(scope)) {
        merged.push(scope);
      }
      continue;
    }

    const [, level, resource, letters] = match;
    const key = `${level}/${resource}`;
    const index = at.get(key);

    if (index === undefined) {
      at.set(key, merged.length);
      merged.push(scope);
      continue;
    }

    const existing = RESOURCE_SCOPE.exec(merged[index])![3];
    const union = new Set([...existing, ...letters]);
    /*
     * `*` and `a` each mean "everything", so a union with one of them is that one. Spelling it out as
     * `cruds` would be a different string from what was asked for, and `missingScopes` compares
     * strings.
     */
    const wildcard = [...union].find((letter) => letter === '*' || letter === 'a');
    merged[index] = wildcard
      ? `${key}.${wildcard}`
      : `${key}.${PERMISSION_ORDER.filter((letter) => union.has(letter)).join('')}`;
  }

  return merged;
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

/** Resource types {@link PRE_POPULATE_SCOPES} asks to read, derived from the list itself. */
const PRE_POPULATE_TYPES = new Set(
  PRE_POPULATE_SCOPES.split(/\s+/)
    .map((scope) => RESOURCE_SCOPE.exec(scope)?.[2])
    .filter((resource): resource is string => resource !== undefined)
);

/**
 * The scopes pre-population needs, so a narrowed grant can say what stops working.
 *
 * This matters more than its write-back counterpart, and the asymmetry is the reason it exists. A
 * refused write scope fails **loudly**, at the moment a clinician presses Accept. A refused read
 * scope fails **silently**: the search comes back 403, the item gets no answer, and the form is sent
 * saying the patient has no recorded conditions. Nobody finds out.
 *
 * Overlaps {@link isWriteBackScope} on purpose. `mergePermissions` collapses extraction's
 * `user/Condition.cu` and population's `user/Condition.rs` into one `user/Condition.crus`, and a
 * server refusing that has refused both features — so both predicates return true for it and the
 * warning names both. Forcing the buckets apart would mean picking one feature to lie about.
 */
export function isPrePopulateScope(scope: string): boolean {
  const match = RESOURCE_SCOPE.exec(scope);

  return (
    match !== null && PRE_POPULATE_TYPES.has(match[2]) && /[rs]/.test(match[3])
  );
}
