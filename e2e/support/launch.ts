/**
 * Driving a complete SMART launch over plain HTTP, without a browser.
 *
 * The acceptance suite needs a signed-in requester session for almost everything it asserts,
 * and getting one means walking the whole EHR-launch chain: an Aidbox RPC to mint the launch
 * token, the app's own `/launch` redirect, the authorisation server's login form, its consent
 * form, and the redirect back to `/auth/callback` that finally sets the cookie. Doing that
 * through a browser is slow and makes every spec depend on the exact markup of two pages this
 * project does not own. Doing it with `fetch` takes about a second and yields a cookie a
 * Playwright context can simply be given.
 *
 * Three details make it work.
 *
 * **Redirects are followed manually, all the way to the app.** `redirect: "manual"` is used
 * everywhere, because the cookie the app sets on `/auth/callback` has to be read off a response
 * rather than swallowed by a redirect chain, and because Aidbox bounces through
 * `/auth/authorize` more than once. {@link launchSession} keeps following `Location` headers -
 * and submitting whatever form it is handed - until it lands on the app's callback.
 *
 * **Forms are submitted the way a browser would.** Hidden fields are echoed back, unchecked
 * checkboxes are omitted, and exactly one submit button is chosen. That last point matters: the
 * Aidbox consent form carries a `deny` button before its `allow` button, so a naive "post every
 * named control" submission denies the grant and the launch fails with `access_denied`.
 *
 * **Nothing here imports a test framework.** The helper is a plain module so it can be used
 * from a Playwright spec, from a `globalSetup`, or from a one-off script while developing.
 * @author John Grimes
 */

import { resolveClientIds } from "../../ops/aidboxSetup";
import { SESSION_COOKIE_NAME } from "../../server/sessionCookie";

/** How many redirects and form submissions one launch may take before it is called broken. */
const MAX_HOPS = 16;

/** The Aidbox RPC that mints an EHR launch token (contract section 6). */
const LAUNCH_URI_RPC = "aidbox.smart/get-launch-uri";

/** Everything a launch needs from the environment. */
export interface LaunchEnvironment {
  /** Origin the app under test is served from, for example `http://localhost:3000`. */
  readonly appOrigin: string;
  /** The registered SMART issuer, which is the FHIR base URL. */
  readonly issuer: string;
  /** The Aidbox root, which is where `/rpc` and the authorisation endpoints live. */
  readonly aidboxBaseUrl: string;
  /**
   * The confidential launch client registered for `appOrigin`.
   *
   * Derived from the origin rather than fixed, because one Aidbox instance now carries a client
   * per environment: pointing the suite at a different `APP_ORIGIN` has to drive that origin's
   * client, or the RPC mints a launch URI aimed at somebody else's app.
   */
  readonly launchClientId: string;
  /** Operator API credentials, used for the RPC and for asserting server-side end state. */
  readonly operator: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** The Aidbox `User` the launch signs in as. */
  readonly user: {
    /** Resource id, which is what the RPC names the user by. */
    readonly id: string;
    /** Login email. */
    readonly username: string;
    /** Login password. */
    readonly password: string;
  };
}

/** What an EHR launch URI consists of. */
export interface EhrLaunchUri {
  /** The complete launch URI Aidbox minted, pointing at the client's registered `launch_uri`. */
  readonly uri: string;
  /** The opaque launch token alone, for composing a launch against another origin. */
  readonly launch: string;
  /** The issuer Aidbox named itself by. */
  readonly issuer: string;
}

/** A signed-in session. */
export interface LaunchResult {
  /** The opaque session id from the `shl_session` cookie. */
  readonly sessionCookie: string;
  /** The same value as a ready-made `Cookie` request header. */
  readonly cookieHeader: string;
  /** The URL the callback redirected to once the session was established. */
  readonly landedAt: string;
}

/**
 * Read a required environment variable.
 *
 * Exported because "fail naming the variable" is the suite's rule for every input it needs, not
 * only the ones a launch needs: a spec that reads `process.env.X` directly and gets `undefined`
 * reports a confusing downstream failure instead.
 * @param name the variable name
 * @param env the environment to read, defaulting to the process environment
 * @returns the value
 * @throws {Error} naming the variable when it is absent or empty
 * @example
 * const sqlitePath = requiredEnvironment("SQLITE_PATH");
 */
export function requiredEnvironment(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`environment variable ${name} is required`);
  }
  return value;
}

/**
 * Collect everything a launch needs from the environment.
 *
 * The variables are the ones `.env` already carries, so one `op run --env-file .env` drives
 * the app, the Aidbox setup and this suite. `E2E_ISSUER` is the single optional value: without
 * it the issuer is assumed to be the Aidbox instance's `/fhir` base, which is what
 * `ops/aidboxSetup.ts` registers.
 * @param env the environment to read, defaulting to the process environment
 * @returns the resolved environment
 * @throws {Error} naming the first variable that is missing
 * @example
 * const environment = readLaunchEnvironment();
 */
export function readLaunchEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LaunchEnvironment {
  const aidboxBaseUrl = requiredEnvironment("AIDBOX_BASE_URL", env).replace(
    /\/+$/,
    "",
  );
  const appOrigin = requiredEnvironment("APP_ORIGIN", env).replace(/\/+$/, "");

  return {
    appOrigin,
    issuer: (env.E2E_ISSUER ?? `${aidboxBaseUrl}/fhir`).replace(/\/+$/, ""),
    aidboxBaseUrl,
    launchClientId: resolveClientIds({ appOrigin, env }).launchClient,
    operator: {
      clientId: requiredEnvironment("AIDBOX_CLIENT_ID", env),
      clientSecret: requiredEnvironment("AIDBOX_CLIENT_SECRET", env),
    },
    user: {
      id: requiredEnvironment("AIDBOX_E2E_USER_ID", env),
      username: requiredEnvironment("AIDBOX_E2E_USER_EMAIL", env),
      password: requiredEnvironment("AIDBOX_E2E_USER_PASSWORD", env),
    },
  };
}

/**
 * Mint an EHR launch URI through the Aidbox RPC.
 *
 * This stands in for the EHR: it is how the launch acquires an opaque `launch` token carrying a
 * patient context, which is the only difference between an EHR launch and a standalone one.
 * @param options the environment, the patient to put in context, and the client to launch
 * @param options.environment the resolved launch environment
 * @param options.patientId the patient id to place in the launch context
 * @param options.clientId the SMART client to mint for, defaulting to this app's launch client
 * @returns the minted URI, its launch token and the issuer Aidbox reported
 * @throws {Error} when the RPC is refused or answers without a launch token
 * @example
 * const launch = await mintEhrLaunchUri({ environment, patientId: "pt-demo" });
 */
export async function mintEhrLaunchUri(options: {
  environment: LaunchEnvironment;
  patientId: string;
  clientId?: string;
}): Promise<EhrLaunchUri> {
  const { environment } = options;
  const credentials = Buffer.from(
    `${environment.operator.clientId}:${environment.operator.clientSecret}`,
    "utf8",
  ).toString("base64");
  const response = await fetch(`${environment.aidboxBaseUrl}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      method: LAUNCH_URI_RPC,
      params: {
        user: environment.user.id,
        iss: environment.issuer,
        client: options.clientId ?? environment.launchClientId,
        ctx: { patient: options.patientId },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`${LAUNCH_URI_RPC} was refused: HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const result =
    typeof payload === "object" && payload !== null && "result" in payload
      ? payload.result
      : undefined;
  if (result === undefined || typeof result !== "object" || result === null) {
    throw new Error(`${LAUNCH_URI_RPC} answered without a result`);
  }
  const uri =
    "uri" in result && typeof result.uri === "string" ? result.uri : undefined;
  const launch =
    "launch" in result && typeof result.launch === "string"
      ? result.launch
      : undefined;
  const issuer =
    "iss" in result && typeof result.iss === "string" ? result.iss : undefined;
  if (uri === undefined || launch === undefined) {
    throw new Error(`${LAUNCH_URI_RPC} answered without a launch URI`);
  }
  return { uri, launch, issuer: issuer ?? environment.issuer };
}

/**
 * A cookie jar: the minimum a launch needs, which is name to value with no scoping.
 *
 * Scoping is unnecessary here because only one host ever sets cookies during a launch - the
 * authorisation server - and the app's own cookie is read directly off the callback response
 * rather than sent anywhere.
 * @returns functions to record `Set-Cookie` headers and to render a `Cookie` header
 */
function createCookieJar(): {
  record: (response: Response) => void;
  header: () => string;
} {
  const jar = new Map<string, string>();
  return {
    record(response) {
      // `getSetCookie` keeps the headers separate, which splitting on commas cannot do
      // reliably: an `Expires` attribute contains one.
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const separator = pair.indexOf("=");
        if (separator > 0) {
          jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
        }
      }
    },
    header() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

/** One HTML form, reduced to what submitting it requires. */
interface ParsedForm {
  /** Absolute URL to post to. */
  readonly action: string;
  /** The method the form declares, upper-cased. */
  readonly method: string;
  /** The form's controls, in document order. */
  readonly controls: readonly {
    readonly tag: string;
    readonly name: string;
    readonly value: string | undefined;
    readonly type: string | undefined;
    readonly checked: boolean;
  }[];
}

/**
 * Read an HTML attribute off a start tag.
 * @param tag the start tag, including its angle brackets
 * @param name the attribute name
 * @returns the attribute value with entities decoded, or undefined when absent
 */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(String.raw`\b${name}="([^"]*)"`, "i").exec(tag);
  return match?.[1]
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/**
 * Parse the first form on a page.
 *
 * Deliberately a regular expression rather than a DOM: the two pages this walks are simple
 * server-rendered forms, and adding a parser dependency to reach them would be out of
 * proportion.
 * @param html the page source
 * @param pageUrl the URL the page was served from, for resolving a relative action
 * @returns the parsed form, or undefined when the page carries none
 */
function parseFirstForm(html: string, pageUrl: string): ParsedForm | undefined {
  const form = /<form[\s\S]*?<\/form>/i.exec(html)?.[0];
  if (form === undefined) {
    return undefined;
  }
  const startTag = /<form[^>]*>/i.exec(form)?.[0] ?? "";
  const controls = [
    ...form.matchAll(/<(input|button|textarea)\b[^>]*>/gi),
  ].flatMap((match) => {
    const name = attribute(match[0], "name");
    return name === undefined
      ? []
      : [
          {
            tag: match[1].toLowerCase(),
            name,
            value: attribute(match[0], "value"),
            type: attribute(match[0], "type")?.toLowerCase(),
            checked: /\bchecked\b/i.test(match[0]),
          },
        ];
  });
  return {
    action: new URL(attribute(startTag, "action") ?? pageUrl, pageUrl).href,
    method: (attribute(startTag, "method") ?? "GET").toUpperCase(),
    controls,
  };
}

/**
 * Fill a parsed form the way a browser would when the user types the credentials and clicks
 * one button.
 *
 * Hidden and text controls are echoed back, checkboxes and radios only when already checked,
 * and buttons never - except the one whose value is `submitValue`, which is what clicking it
 * would contribute. That single-button rule is what keeps the Aidbox consent form from being
 * submitted with its `deny` button as well as its `allow` one.
 * @param form the parsed form
 * @param credentials the username and password to type into the fields that ask for them
 * @param credentials.username the login name
 * @param credentials.password the login password
 * @param submitValue the value of the one submit button to press, when the form has buttons
 * @returns the body to post
 */
function fillForm(
  form: ParsedForm,
  credentials: { username: string; password: string },
  submitValue: string,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const control of form.controls) {
    if (control.tag === "button" || control.type === "submit") {
      if (control.value === submitValue) {
        body.set(control.name, control.value);
      }
      continue;
    }
    if (control.name === "username") {
      body.set(control.name, credentials.username);
      continue;
    }
    if (control.name === "password") {
      body.set(control.name, credentials.password);
      continue;
    }
    if (
      (control.type === "checkbox" || control.type === "radio") &&
      !control.checked
    ) {
      continue;
    }
    if (control.value !== undefined) {
      body.append(control.name, control.value);
    }
  }
  return body;
}

/**
 * Perform a complete launch and return the session cookie it establishes.
 *
 * An EHR launch is driven when `patientId` is given: a launch token is minted through
 * {@link mintEhrLaunchUri} and passed to the app's `/launch`, which is what puts a patient in
 * context. Without it the same walk is a standalone launch. Either way the login and consent
 * forms are submitted as they are encountered, redirects are followed until the app's
 * `/auth/callback` answers, and the cookie is read off that response.
 *
 * The launch is composed against `environment.appOrigin` rather than the URI Aidbox minted,
 * because the minted URI carries the origin from the *client registration*: pointing the suite
 * at a second deployment would otherwise silently drive the registered one.
 * @param options the environment, the patient to launch with, and the client to launch as
 * @param options.environment the resolved environment, defaulting to
 *   {@link readLaunchEnvironment}
 * @param options.patientId the patient to place in launch context; omit for a standalone launch
 * @param options.clientId the SMART client to launch, defaulting to this app's launch client
 * @returns the session cookie, a ready-made `Cookie` header and where the callback landed
 * @throws {Error} describing where the walk stopped when no session is established
 * @example
 * const { cookieHeader } = await launchSession({ patientId: "pt-demo" });
 * const session = await fetch(`${appOrigin}/api/session`, {
 *   headers: { cookie: cookieHeader },
 * });
 */
export async function launchSession(
  options: {
    environment?: LaunchEnvironment;
    patientId?: string;
    clientId?: string;
  } = {},
): Promise<LaunchResult> {
  const environment = options.environment ?? readLaunchEnvironment();
  const start = new URL(`${environment.appOrigin}/launch`);
  start.searchParams.set("iss", environment.issuer);
  if (options.patientId !== undefined) {
    const minted = await mintEhrLaunchUri({
      environment,
      patientId: options.patientId,
      clientId: options.clientId,
    });
    start.searchParams.set("launch", minted.launch);
  }

  const jar = createCookieJar();
  let target = start.href;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const onApp = target.startsWith(environment.appOrigin);
    const response = await fetch(target, {
      headers: onApp ? {} : { cookie: jar.header() },
      redirect: "manual",
    });
    jar.record(response);

    if (onApp && new URL(target).pathname === "/auth/callback") {
      const cookie = response.headers
        .getSetCookie()
        .flatMap((header) => {
          const match = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`).exec(
            header,
          );
          return match === null ? [] : [match[1]];
        })
        .at(0);
      if (cookie === undefined) {
        throw new Error(
          `the callback set no ${SESSION_COOKIE_NAME} cookie (HTTP ${response.status})`,
        );
      }
      return {
        sessionCookie: cookie,
        cookieHeader: `${SESSION_COOKIE_NAME}=${cookie}`,
        landedAt: response.headers.get("location") ?? "/",
      };
    }

    const location = response.headers.get("location");
    if (location !== null) {
      target = new URL(location, target).href;
      continue;
    }

    const form = parseFirstForm(await response.text(), target);
    if (form === undefined) {
      throw new Error(
        `launch stopped at ${target} with HTTP ${response.status} and no form to submit`,
      );
    }
    const submitted = await fetch(form.action, {
      method: form.method,
      headers: {
        cookie: jar.header(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: fillForm(form, environment.user, "allow"),
      redirect: "manual",
    });
    jar.record(submitted);
    const next = submitted.headers.get("location");
    if (next === null) {
      throw new Error(
        `submitting the form at ${form.action} answered HTTP ${submitted.status} without a redirect`,
      );
    }
    target = new URL(next, form.action).href;
  }
  throw new Error(`launch did not reach the callback within ${MAX_HOPS} hops`);
}
