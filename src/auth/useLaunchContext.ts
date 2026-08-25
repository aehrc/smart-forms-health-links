import { useQuery } from '@tanstack/react-query';
import type { Patient, Practitioner } from 'fhir/r4';
import { useEhrServerUrl, useSmartSession } from './SmartContext';
import { fetchPatient, fetchUser, personDisplay } from '@/fhir/ehrServer';

/**
 * What a launch put in context, resolved into resources.
 *
 * A session carries references — `Patient/123`, `Practitioner/456` — and a reference is a database key.
 * Turning those into a name a clinician recognises is a read, not a decode, so it lives in a hook
 * rather than in the session.
 *
 * Shared rather than per-route on purpose. The same two resources were being fetched from two places
 * under two different query keys: the header badge wanted the user's *name* while `RequestForm` wanted
 * the user's *resource* for SDC's `user` launch context, so react-query cached them separately and
 * fetched one resource twice. One query for the resource, with the name derived, serves both.
 */
export interface LaunchContext {
  /** The patient the launch supplied, once fetched. Undefined while loading or when there is none. */
  patient: Patient | undefined;

  /** `Patient/123`, or null when the launch supplied no patient — a standalone launch may not. */
  patientReference: string | null;

  /**
   * The launched user's own resource.
   *
   * `Practitioner` in every realistic case, but `fhirUser` is allowed to name a `Patient`, and a
   * patient-facing launch would. Callers that need a practitioner must narrow on `resourceType` rather
   * than assume — pre-population does exactly that.
   *
   * Null means the read failed or was refused, which is not a broken session: the token still
   * authorises and the reference is still recorded on `Provenance`.
   */
  user: Practitioner | Patient | null | undefined;

  /** The user's name, or null when the resource carries nothing usable. Never a bare reference. */
  userDisplay: string | null;
}

export function useLaunchContext(): LaunchContext {
  const session = useSmartSession();
  const ehrServerUrl = useEhrServerUrl();

  const patientReference = session?.patientId ? `Patient/${session.patientId}` : null;

  const { data: patient } = useQuery({
    queryKey: ['patient', ehrServerUrl, session?.patientId],
    queryFn: ({ signal }) => fetchPatient(ehrServerUrl!, session!.patientId!, signal, session),
    enabled: !!patientReference && !!ehrServerUrl
  });

  /*
   * Keyed on the session's own server rather than the resolved EHR base. `fhirUser` is a reference
   * issued by the authorisation server and it resolves against the server that issued it; the resolved
   * base can be configuration, which has nothing to say about who is signed in.
   */
  const { data: user } = useQuery({
    queryKey: ['fhirUser-resource', session?.serverUrl, session?.fhirUser],
    queryFn: ({ signal }) => fetchUser(session!.serverUrl, session!.fhirUser!, signal, session),
    enabled: !!session?.fhirUser
  });

  return { patient, patientReference, user, userDisplay: personDisplay(user) };
}
