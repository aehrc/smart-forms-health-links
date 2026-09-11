/**
 * Reading a bearer token off an `Authorization` header.
 *
 * Its own module because three public routes need it and each one authorises a *capability*
 * rather than a session: the write slot's one-shot token, and the facade's two write shapes.
 * A second copy of this would be a second place for the parsing to drift, and the thing being
 * parsed decides whether a request may write to a clinical record.
 * @author John Grimes
 */

/**
 * Read a bearer token from an `Authorization` header.
 *
 * Case-insensitive on the scheme, because RFC 7235 makes it so and a client that sends `bearer`
 * is not wrong. The token itself is returned exactly as it arrived: it is compared against a
 * stored or signed value, and trimming or lowercasing it here would make a mismatch look like a
 * refusal rather than a typo.
 * @param header the raw header, if there was one
 * @returns the token, or undefined when the header is absent or not a bearer
 * @example
 * const token = bearerToken(request.headers.authorization);
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1];
}
