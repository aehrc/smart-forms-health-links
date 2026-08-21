/**
 * The one canonical guard for JSON objects arriving from outside the process.
 *
 * The server parses three kinds of untrusted JSON - the issuer registry file, a SMART
 * `.well-known/smart-configuration` document and OAuth token responses - and each of those
 * modules validates the individual fields it actually uses. This guard exists so that the
 * "is it an object at all?" step is written once rather than at every call site.
 * @author John Grimes
 */

/**
 * Narrow an unknown value to a JSON object, leaving its fields `unknown`.
 * @param value the value to test
 * @returns true when the value is a non-null, non-array object
 * @example
 * if (!isJsonObject(parsed)) throw new Error("expected an object");
 * const name = typeof parsed.name === "string" ? parsed.name : undefined;
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
