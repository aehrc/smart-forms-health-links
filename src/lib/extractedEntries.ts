import { parametersIsFhirPatch } from "@aehrc/sdc-template-extract";

import type {
  Bundle,
  BundleEntry,
  CodeableConcept,
  FhirResource,
  HumanName,
  Quantity,
} from "fhir/r4";

/**
 * Describing an extracted Bundle so a clinician can decide what belongs in the record.
 *
 * The display formatters are transcribed from smart-forms
 * (`apps/smart-forms-app/src/features/writeBack/utils/extractedBundleSelector.ts`, Apache-2.0, CSIRO),
 * so that the same resource reads the same way in both apps. What is *not* carried across is that
 * file's FHIRPatch operation-level machinery — roughly half of it. This app presents a patch entry as
 * one all-or-nothing row, because a reviewer choosing individual JSON Patch operations against a
 * resource they cannot see is being asked a question they have no way to answer well.
 */

export interface EntryRow {
  /** Index into the original bundle's `entry` array. The selection key. */
  index: number;
  resourceType: string;
  /** What this resource is *about*, in clinical terms. Never a JSON blob. */
  display: string;
  /** POST creates; PUT and PATCH change something already there. Worth distinguishing loudly. */
  method: "new" | "update";
  /** The request URL, for an update — a reviewer should see which resource is being changed. */
  target?: string;
  /** Set only for FHIRPatch entries, to say how much is bundled into the one checkbox. */
  patchOperationCount?: number;
}

/**
 * `given family`, the way a person would say it.
 * @param names
 */
function constructName(names: HumanName[] | undefined): string {
  const name =
    names?.find((candidate) => candidate.use === "official") ?? names?.[0];

  if (!name) {
    return "Unnamed";
  }

  if (name.text) {
    return name.text;
  }

  return (
    [name.given?.join(" "), name.family].filter(Boolean).join(" ") || "Unnamed"
  );
}

/**
 * A coded concept's display, its text, or nothing useful.
 * @param concept
 */
function codeText(concept: CodeableConcept | undefined): string | undefined {
  return (
    concept?.coding?.find((coding) => coding.display)?.display ?? concept?.text
  );
}

function quantityText(quantity: Quantity | undefined): string | undefined {
  if (quantity?.value === undefined) {
    return undefined;
  }

  return [quantity.value, quantity.unit ?? quantity.code]
    .filter(Boolean)
    .join(" ");
}

/**
 * An Observation's value, appended to its name.
 *
 * A departure from upstream, which shows the code alone. "Temperature" tells a reviewer which box was
 * ticked; "Temperature 38.4 °C" tells them whether to tick it — and deciding is the entire purpose of
 * the screen this feeds.
 * @param resource
 */
/**
 * A boolean answer in words.
 * @param value the boolean, when the Observation carries one
 * @returns "yes", "no", or undefined when there is no boolean to describe
 */
function booleanText(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? "yes" : "no";
}

function observationValue(
  resource: Extract<FhirResource, { resourceType: "Observation" }>,
): string | undefined {
  return (
    quantityText(resource.valueQuantity) ??
    codeText(resource.valueCodeableConcept) ??
    resource.valueString ??
    booleanText(resource.valueBoolean) ??
    (resource.valueInteger === undefined
      ? undefined
      : String(resource.valueInteger))
  );
}

/**
 * What a resource is, in words. Not exhaustive; the fallback is the resource type, which is honest.
 * @param resource
 */
export function describeResource(resource: FhirResource | undefined): string {
  if (!resource?.resourceType) {
    return "Unknown resource";
  }

  switch (resource.resourceType) {
    case "Patient": {
      return constructName(resource.name);
    }
    case "Encounter": {
      return `${resource.class?.display ?? "Encounter"} (${resource.status})`;
    }
    case "Condition": {
      return codeText(resource.code) ?? "Unspecified condition";
    }
    case "MedicationStatement": {
      return (
        codeText(resource.medicationCodeableConcept) ?? "Unspecified medication"
      );
    }
    case "AllergyIntolerance": {
      return codeText(resource.code) ?? "Unspecified allergy";
    }
    case "Procedure": {
      return codeText(resource.code) ?? "Unspecified procedure";
    }
    case "Immunization": {
      return codeText(resource.vaccineCode) ?? "Unspecified vaccine";
    }
    case "Observation": {
      const name = codeText(resource.code) ?? "Observation";
      const value = observationValue(resource);
      return value ? `${name} — ${value}` : name;
    }
    case "ServiceRequest": {
      return codeText(resource.code) ?? "Unspecified request";
    }
    case "Parameters": {
      return parametersIsFhirPatch(resource)
        ? "Changes to an existing record"
        : "Parameters";
    }
    default: {
      /*
       * A last attempt before falling back to the bare type. Extraction writes whatever a form's
       * templates say, so the enumeration above will always be behind some questionnaire somewhere —
       * the Sepsis form on the default server emits `ServiceRequest`s, which is how this was noticed.
       * Most clinical resources carry a `code` or a `type`, and either says far more than the type
       * name alone, which is what a reviewer would otherwise be asked to tick blind.
       */
      return (
        codeText((resource as { code?: CodeableConcept }).code) ??
        codeText((resource as { type?: CodeableConcept }).type) ??
        resource.resourceType
      );
    }
  }
}

/**
 * How many operations a FHIRPatch entry bundles up, when it is one.
 * @param resource
 */
function patchOperationCount(
  resource: FhirResource | undefined,
): number | undefined {
  if (
    resource?.resourceType !== "Parameters" ||
    !parametersIsFhirPatch(resource)
  ) {
    return undefined;
  }

  return resource.parameter.length;
}

/**
 * One row per bundle entry, in bundle order.
 *
 * Entries with no `request` are skipped rather than shown: a transaction entry without one cannot be
 * submitted, so offering it as a tickbox would promise something the write cannot keep.
 * @param bundle
 */
export function describeEntries(bundle: Bundle): EntryRow[] {
  return (bundle.entry ?? []).flatMap((entry, index) => {
    const method = entry.request?.method;

    if (!method) {
      return [];
    }

    const row: EntryRow = {
      index,
      resourceType: entry.resource?.resourceType ?? "Unknown",
      display: describeResource(entry.resource),
      method: method === "POST" ? "new" : "update",
      target: method === "POST" ? undefined : entry.request?.url,
      patchOperationCount: patchOperationCount(entry.resource),
    };

    return [row];
  });
}

/**
 * A transaction Bundle holding only the chosen entries.
 *
 * `type` and `meta` are preserved — the engine tags what it generated
 * (`urn:aehrc:sdc-template-extract`), and a server or an auditor reading that tag back should still
 * see it on what was actually written. A new `id` is not minted: this is the same extraction, narrowed.
 *
 * Returns entries in bundle order regardless of the order the reviewer ticked them, because template
 * extraction can emit entries whose order matters — a POST that a later PATCH targets, for instance.
 * @param bundle
 * @param selected
 */
export function filterBundle(
  bundle: Bundle,
  selected: ReadonlySet<number>,
): Bundle {
  const entries: BundleEntry[] = (bundle.entry ?? []).filter((_entry, index) =>
    selected.has(index),
  );

  return { ...bundle, entry: entries };
}
