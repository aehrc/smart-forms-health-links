import { authedFetch } from "./authedFetch";
import { describeFailure } from "./submit";

import type { SmartSession } from "@/auth/smartSession";
import type { Bundle, BundleEntry } from "fhir/r4";

/**
 * Write an extracted transaction Bundle to the EHR.
 *
 * A new write shape for this app, and deliberately a *separate* one. Every other write goes through
 * `createResource` in `src/fhir/submit.ts`, whose narrow union type carries an instruction to widen it
 * deliberately rather than make it generic. Extraction produces resources this app never authored and
 * cannot enumerate ahead of time — whatever a form's templates say — so the honest move is a different
 * primitive with a different contract, not a wider version of the careful one.
 *
 * The two differ in a way that matters clinically as well as structurally:
 *
 *  - `createResource` POSTs one resource to `/{ResourceType}` and the caller decides what a partial
 *    failure means. `submitResponse` uses that to let a Task fail without losing the answers.
 *  - This POSTs a whole Bundle to the **server base**, and the server applies it atomically. There is
 *    no partial success to interpret, which is what makes it the right shape for a set of resources a
 *    reviewer ticked as a group.
 */

const FHIR_JSON = "application/fhir+json";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface WrittenEntry {
  /** Index into the *submitted* bundle, which is the filtered one, not the extraction. */
  index: number;
  /** e.g. `201 Created`. Straight from the transaction-response entry. */
  status: string;
  /** Where the server put it, when it said. Relative, as FHIR returns it. */
  location?: string;
  /** Set when this entry's own status was not 2xx. */
  error?: string;
}

export interface BundleWriteResult {
  serverUrl: string;
  /** Per-entry outcomes. Empty when the whole POST failed — see {@link error}. */
  entries: WrittenEntry[];
  /**
   * The transaction as a whole was refused, so **nothing was written**.
   *
   * Distinct from an entry carrying an error. A FHIR transaction is all-or-nothing, so a per-entry
   * failure inside a response the server nonetheless returned still means nothing landed — callers
   * must not report the successful-looking entries as saved.
   */
  error?: string;
}

export interface SubmitBundleOptions {
  serverUrl: string;
  bundle: Bundle;
  /** Authorises the write when the destination is the launched server. Null writes anonymously. */
  session?: SmartSession | null;
}

export const EMPTY_BUNDLE_MESSAGE =
  "Nothing was selected to write back, so there is nothing to send.";

/**
 * Whether every entry the server reported came back 2xx.
 * @param result
 */
export function bundleWriteSucceeded(result: BundleWriteResult): boolean {
  return (
    !result.error &&
    result.entries.length > 0 &&
    result.entries.every((entry) => !entry.error)
  );
}

/**
 * `201 Created` → true; `422 Unprocessable Entity` → false.
 * @param status
 */
function statusIsOk(status: string | undefined): boolean {
  const code = Number.parseInt((status ?? "").trim().slice(0, 3), 10);
  return Number.isFinite(code) && code >= 200 && code < 300;
}

function readEntry(entry: BundleEntry, index: number): WrittenEntry {
  const status = entry.response?.status ?? "no status";
  const outcome = entry.response?.outcome;

  if (statusIsOk(status)) {
    return { index, status, location: entry.response?.location };
  }

  /*
   * The per-entry OperationOutcome is where a server explains itself — a subject that does not resolve,
   * a code the server will not accept. Falling back to the bare status would throw away the only part
   * a reviewer can act on.
   */
  const diagnostics =
    outcome?.resourceType === "OperationOutcome"
      ? (outcome.issue ?? [])
          .map((issue) => issue.diagnostics ?? issue.details?.text)
          .filter((text): text is string => !!text)
          .join("; ")
      : "";

  return {
    index,
    status,
    error: diagnostics === "" ? status : `${status}: ${diagnostics}`,
  };
}

/**
 * POST the bundle and report what the server did with each entry.
 *
 * Never throws for a server-side refusal — a rejected write-back is an outcome the reviewer needs
 * described, not an exception that loses the detail on the way up. The answers themselves are already
 * safely stored by the time this runs, so there is nothing here worth aborting for.
 * @param options
 */
export async function submitExtractedBundle(
  options: SubmitBundleOptions,
): Promise<BundleWriteResult> {
  const { serverUrl, bundle, session } = options;

  if ((bundle.entry ?? []).length === 0) {
    return { serverUrl, entries: [], error: EMPTY_BUNDLE_MESSAGE };
  }

  try {
    /*
     * The trailing slash is load-bearing. A transaction is addressed to the server base itself, and
     * some servers 404 a POST to a base written without it. `trimTrailingSlash` then `/` normalises a
     * configured URL given either way.
     */
    const response = await authedFetch(
      `${trimTrailingSlash(serverUrl)}/`,
      {
        method: "POST",
        headers: { "Content-Type": FHIR_JSON, Accept: FHIR_JSON },
        body: JSON.stringify(bundle),
      },
      session ?? null,
    );

    if (!response.ok) {
      return {
        serverUrl,
        entries: [],
        error: `The server rejected the write-back — ${await describeFailure(response)}`,
      };
    }

    const body = (await response.json()) as Bundle;

    if (body.resourceType !== "Bundle") {
      return {
        serverUrl,
        entries: [],
        error:
          "The server accepted the request but did not return a transaction response.",
      };
    }

    return {
      serverUrl,
      entries: (body.entry ?? []).map((entry, index) =>
        readEntry(entry, index),
      ),
    };
  } catch (error) {
    return {
      serverUrl,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
