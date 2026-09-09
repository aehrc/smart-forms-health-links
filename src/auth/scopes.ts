/**
 * Reading a SMART scope string, for the one surface that has to explain a narrowed grant.
 *
 * This file used to *build* the scope string as well. That half is gone: the launch happens in the
 * BFF now, and what it asks for comes from the deployment's issuer registry
 * (`config/issuers.json`), not from anything the browser could influence. Which is the right place
 * for it - a scope string assembled in a page is a scope string an attacker can rewrite.
 *
 * What is left is comparison. The authorisation server may grant less than was asked for, legally
 * and silently, and somebody has to notice. See `src/components/ScopeWarning.tsx` for why that
 * matters at sign-in rather than mid-consultation.
 * @author John Grimes
 */

/** Matches `user/Condition.crus`, capturing the level, the resource type and the permissions. */
const RESOURCE_SCOPE = /^(user|patient|system)\/([A-Za-z*]+)\.([a-z]+)$/;

/**
 * The same shape, but tolerating the two spellings a wire contract cannot pin down.
 *
 * {@link RESOURCE_SCOPE} is deliberately strict because it reads scopes *this deployment*
 * asked for, which are written in one style. A scope read off a grant file was written by
 * somebody else, so it may be SMART v1 (`.read`, `.write`) or use `*` as the permission.
 */
const ANY_RESOURCE_SCOPE = /^(user|patient|system)\/([A-Za-z*]+)\.([a-z]+|\*)$/;

/** SMART v1 permission words, expanded into the v2 letters they stand for. */
const V1_PERMISSIONS: Readonly<Record<string, string>> = {
  read: "rs",
  write: "cud",
};

/** Every v2 permission letter, which is what `*` grants. */
const ALL_PERMISSIONS = "cruds";

/** One parsed resource scope. */
export interface ResourceScope {
  /** `user`, `patient` or `system`. */
  readonly level: string;
  /** The resource type, or `*` for all of them. */
  readonly type: string;
  /**
   * Permissions as v2 letters, whatever spelling arrived.
   *
   * `read` becomes `rs`, `write` becomes `cud` and `*` becomes all of them, so a caller can
   * ask "does this permit an update" without knowing which SMART version wrote it.
   */
  readonly permissions: string;
}

/**
 * Read one SMART resource scope, in either SMART version's spelling.
 *
 * Exported so that anything comparing scopes shares this parser rather than growing its own.
 * A second regex for the same grammar is how two places quietly come to disagree about what
 * `system/*.*` permits.
 * @param scope one whitespace-free scope token
 * @returns the parsed scope, or undefined when it is not a resource scope at all
 * @example
 * parseResourceScope("system/Task.write"); // { level: "system", type: "Task", permissions: "cud" }
 */
export function parseResourceScope(scope: string): ResourceScope | undefined {
  const match = ANY_RESOURCE_SCOPE.exec(scope.trim());
  if (match === null) {
    return undefined;
  }

  const [, level, type, raw] = match;
  const permissions =
    raw === "*" ? ALL_PERMISSIONS : (V1_PERMISSIONS[raw] ?? raw);

  return { level, type, permissions };
}

/**
 * Whether a set of granted scopes permits everything one required scope asks for.
 *
 * Wildcards widen on both axes: a granted `system/*.*` covers every resource type and every
 * permission, and a granted `system/Task.cruds` covers `system/Task.u`. The level must match
 * exactly - a `user/` grant is not a `system/` one, whatever it permits.
 * @param granted the scopes a grant stated
 * @param required the single scope to test for
 * @returns true when some granted scope covers the required one
 * @example
 * coversScope(["system/Task.cruds"], "system/Task.u"); // true
 */
export function coversScope(
  granted: readonly string[],
  required: string,
): boolean {
  const want = parseResourceScope(required);
  if (want === undefined) {
    return false;
  }

  return granted.some((candidate) => {
    const have = parseResourceScope(candidate);
    if (have === undefined || have.level !== want.level) {
      return false;
    }
    if (have.type !== "*" && have.type !== want.type) {
      return false;
    }
    return [...want.permissions].every((permission) =>
      have.permissions.includes(permission),
    );
  });
}

/**
 * Resource types pre-population reads from the record.
 *
 * Population resolves each item's `x-fhir-query` against these, so a grant that omits read or
 * search on one of them does not fail - it silently returns empty answers, which is the failure
 * mode this list exists to make visible.
 */
const PRE_POPULATE_TYPES = new Set([
  "Patient",
  "Condition",
  "Observation",
  "MedicationStatement",
  "AllergyIntolerance",
  "Immunization",
  "Procedure",
  "*",
]);

/**
 * Scopes that were asked for and not granted.
 *
 * An empty `granted` yields nothing rather than everything. A server that declines to report what
 * it granted is not a server that granted nothing, and warning about every scope in that case would
 * make the banner meaningless exactly where it is least reliable.
 * @param requested the scope string this deployment asks for
 * @param granted the scope string the server reported back
 * @returns the scopes present in `requested` and absent from `granted`
 * @example
 * missingScopes("user/Patient.crs user/Condition.cu", "user/Patient.crs"); // ["user/Condition.cu"]
 */
export function missingScopes(requested: string, granted: string): string[] {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));

  if (grantedSet.size === 0) {
    return [];
  }

  return requested
    .split(/\s+/)
    .filter((scope) => scope !== "" && !grantedSet.has(scope));
}

/**
 * Whether a scope is one that write-back needs.
 *
 * Update permission on a clinical type. Extraction creates resources, but an amendment updates one,
 * so losing `u` costs the feature just as surely as losing `c`.
 * @param scope the scope to test
 * @returns true when write-back depends on it
 * @example
 * isWriteBackScope("user/Condition.cu"); // true
 */
export function isWriteBackScope(scope: string): boolean {
  return /^user\/[A-Za-z]+\.[a-z]*u/.test(scope);
}

/**
 * Whether a scope is one that pre-population needs.
 *
 * Read or search on a type population queries. The two buckets overlap rather than partition - one
 * scope on `Condition` can carry both `u` and `r` - so a scope refused may be named under both,
 * which is correct: refusing it broke both.
 * @param scope the scope to test
 * @returns true when pre-population depends on it
 * @example
 * isPrePopulateScope("user/Condition.crs"); // true
 */
export function isPrePopulateScope(scope: string): boolean {
  const match = RESOURCE_SCOPE.exec(scope);

  return (
    match !== null && PRE_POPULATE_TYPES.has(match[2]) && /[rs]/.test(match[3])
  );
}
