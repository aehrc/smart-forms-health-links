/**
 * What counts as somewhere a bearer token may be presented.
 *
 * A grant's `aud` is where a credential that can write to a clinical record gets sent, so the rule
 * has always been `https` and nothing else: `http` would put the token on the wire in the clear for
 * whoever is on the path.
 *
 * **Loopback is the one exception, and it is not a concession.** `http://localhost` never leaves the
 * machine, so there is no path to be on. The web platform already says so - browsers treat loopback
 * as a [potentially trustworthy
 * origin](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy), which is why a
 * page served from `http://localhost` gets the secure-context APIs that `http://example.org` does
 * not - and OAuth says the same thing for the same reason (RFC 8252 section 8.3, on loopback
 * redirect URIs).
 *
 * The exception exists because the facade made `aud` point at *this app* rather than at the
 * practice. Before that, `aud` was the practice's `https` FHIR base and a developer running over
 * `http://localhost:3000` never noticed the rule. Now the app's own origin is the destination, so
 * the rule applies to the development origin too - and refusing it would mean the direct-send
 * channel silently degrades to a scan-back on every developer's machine, which is precisely where
 * it most needs to be exercised.
 *
 * This is deliberately *not* used for the practice's own URLs. A remote FHIR server on `http` is
 * exactly the case the rule is for.
 * @author John Grimes
 */

/**
 * Hosts that resolve to the loopback interface, so traffic to them never reaches a network.
 *
 * Names rather than a range: `127.0.0.0/8` is entirely loopback, but a URL naming
 * `http://127.1.2.3` in a grant is far more likely to be a mistake or a probe than a development
 * server, and there is nothing to gain from accepting it.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parse a URL that a bearer token may be presented to.
 * @param value the candidate, from configuration or straight off the wire
 * @returns the parsed URL when it is `https` or loopback `http`, otherwise undefined
 * @example
 * secureUrl("https://links.example.org/shl/inv-1/fhir"); // a URL
 * secureUrl("http://localhost:3000/shl/inv-1/fhir"); // a URL
 * secureUrl("http://links.example.org/shl/inv-1/fhir"); // undefined
 */
export function secureUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }

  if (url.protocol === "https:") {
    return url;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
    ? url
    : undefined;
}

/**
 * Whether a URL is somewhere a bearer token may be presented.
 * @param value the candidate
 * @returns true for an `https` URL, or an `http` one on the loopback interface
 * @example
 * if (!isSecureUrl(aud)) return undefined;
 */
export function isSecureUrl(value: unknown): boolean {
  return secureUrl(value) !== undefined;
}
