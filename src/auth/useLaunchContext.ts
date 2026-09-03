/**
 * The launch context, as the surfaces that display it need it.
 *
 * Almost nothing is left of this hook, and that is the point. It used to fetch the launch's patient
 * and its `fhirUser` from the EHR and cache them, because a client-side launch handed back bare
 * references and somebody had to resolve them. The BFF resolves the user's name during the launch
 * itself (`server/smart/requesterDisplay.ts`) and puts it in the session, so the name arrives with
 * the session and costs no request at all.
 *
 * The patient is still fetched, because it is still only a reference in the session and the surfaces
 * that show it want a name. It fails soft for the same reason it always did: a launch context
 * patient this user cannot read is a narrowed grant, not a broken page.
 * @author John Grimes
 */

import { useQuery } from "@tanstack/react-query";

import { useSmartSession } from "./SmartContext";

import type { Patient } from "fhir/r4";

import { fetchPatient } from "@/fhir/ehrServer";

/** What the launch put in context, resolved as far as it can be. */
export interface LaunchContext {
  /** The launch context patient, once read. */
  patient: Patient | null;
  /** That patient as a reference, e.g. `Patient/123`, or null when the launch carried none. */
  patientReference: string | null;
  /** The signed-in user's name, straight from the session. */
  userDisplay: string | null;
}

/**
 * Read the launch context.
 * @returns the context patient and the signed-in user's name
 * @example
 * const { patientReference, userDisplay } = useLaunchContext();
 */
export function useLaunchContext(): LaunchContext {
  const session = useSmartSession();
  const patientId = session?.patientId ?? null;

  const { data: patient } = useQuery({
    queryKey: ["launch-patient", patientId],
    queryFn: ({ signal }) =>
      fetchPatient(session!.serverUrl, patientId!, signal),
    enabled: session !== null && patientId !== null,
    retry: false,
  });

  return {
    patient: patient ?? null,
    patientReference: patientId === null ? null : `Patient/${patientId}`,
    userDisplay: session?.userDisplay ?? null,
  };
}
