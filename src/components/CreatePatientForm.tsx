import { useState } from 'react';
import { Loader2, UserPlus, X } from 'lucide-react';
import type { Patient } from 'fhir/r4';
import { createPatient, type CreatedPatient } from '@/fhir/submit';
import { describePatient, patientDisplay, searchPatients } from '@/fhir/ehrServer';
import { useSmartSession } from '@/auth/SmartContext';
import { canWriteToRecord } from '@/lib/config';
import { splitName } from '@/fhir/newPatient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LaunchRequiredNote } from '@/components/LaunchRequired';
import { cn } from '@/lib/utils';

/**
 * Register a patient the destination server does not hold.
 *
 * Reached only from {@link PatientPicker}, and only after a search — which is the whole safety story.
 * A duplicate patient record is the classic harm of making this easy, and nothing here detects one:
 * there is no master patient index and no fuzzy matching. What there is, is ordering. Searching comes
 * first, creating is the way out of an empty result, and before the write this re-searches the family
 * name alone, because the reviewer probably searched a full name and the server may spell the rest of
 * it differently.
 *
 * Every field is typed by hand, and that is forced by the wire format rather than chosen: no channel
 * carries demographics, so the only thing available to seed from is a free-text name.
 */

const GENDERS: { value: NonNullable<Patient['gender']>; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' }
];

export interface CreatePatientFormProps {
  /** FHIR base to create on. The returned reference is only meaningful against this server. */
  serverUrl: string;
  /** Name to split into the initial given/family values — the search text, or what the filler called them. */
  seedName?: string;
  onCreated: (created: CreatedPatient) => void;
  onCancel: () => void;
  /** Existing patient chosen from the near-match warning instead of creating a duplicate. */
  onChooseExisting?: (patient: Patient) => void;
}

export default function CreatePatientForm(props: CreatePatientFormProps) {
  const { serverUrl, seedName = '', onCreated, onCancel, onChooseExisting } = props;

  const seeded = splitName(seedName);
  const [family, setFamily] = useState(seeded.family);
  const [given, setGiven] = useState(seeded.given);
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<Patient['gender'] | ''>('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Existing patients sharing the family name. A warning, never a block. */
  const [nearMatches, setNearMatches] = useState<Patient[] | null>(null);
  const session = useSmartSession();

  /*
   * Registering a person is the least reversible thing this app does — nothing here deletes a patient,
   * and a duplicate created anonymously carries no author to ask about it. So a launch, on top of the
   * family name and the ordering the doc comment above describes.
   */
  const mayWrite = canWriteToRecord(session, serverUrl);
  const canCreate = mayWrite && family.trim() !== '' && !isSaving;

  /**
   * Look for anyone already on the server with this family name.
   *
   * Non-blocking by design, in both directions: a hit is shown as a warning rather than a barrier,
   * because two people really can share a surname, and a failed search does not stop the create,
   * because it is a safety net rather than a precondition.
   */
  async function checkForDuplicates() {
    try {
      const { resources } = await searchPatients(serverUrl, family.trim(), 5, undefined, session);
      // `resources.length`, not `total` — `_total=accurate` is a request, not a guarantee.
      setNearMatches(resources);
      return resources.length > 0;
    } catch {
      setNearMatches(null);
      return false;
    }
  }

  async function handleCreate() {
    setError(null);
    setIsSaving(true);
    try {
      if (nearMatches === null && (await checkForDuplicates())) {
        setIsSaving(false);
        return;
      }

      onCreated(
        await createPatient(
          serverUrl,
          { family, given, birthDate, gender: gender === '' ? undefined : gender },
          session
        )
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        // A blocked preflight arrives as a bare TypeError with no OperationOutcome to explain it.
        /failed to fetch|networkerror/i.test(message)
          ? `${message} — the server may not accept writes from this origin.`
          : message
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-300 bg-white p-3">
      <p className="text-xs text-slate-600">
        Creates a new patient record on <span className="font-mono">{serverUrl}</span>. Nothing about
        this person travelled with the answers, so everything here is what you type.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-800" htmlFor="new-patient-given">
            Given name(s)
          </label>
          <Input
            id="new-patient-given"
            value={given}
            onChange={(event) => setGiven(event.target.value)}
            placeholder="Jane"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-800" htmlFor="new-patient-family">
            Family name
          </label>
          <Input
            id="new-patient-family"
            value={family}
            onChange={(event) => {
              setFamily(event.target.value);
              // The warning belongs to the name it was raised for.
              setNearMatches(null);
            }}
            placeholder="Citizen"
            autoFocus
          />
        </div>
      </div>

      {seedName.trim() !== '' ? (
        <p className="text-xs text-slate-500">
          Split from “{seedName.trim()}”. The split is a guess — check it before saving.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-800" htmlFor="new-patient-dob">
            Date of birth
          </label>
          <Input
            id="new-patient-dob"
            type="date"
            value={birthDate}
            onChange={(event) => setBirthDate(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-800" htmlFor="new-patient-gender">
            Administrative gender
          </label>
          {/* Native select: there is no Select in components/ui, and one usage does not earn one. */}
          <select
            id="new-patient-gender"
            value={gender}
            onChange={(event) => setGender(event.target.value as Patient['gender'] | '')}
            className={cn(
              'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm',
              'focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none'
            )}>
            <option value="">Not stated</option>
            {GENDERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Both optional, and both worth filling in: they are what makes this person findable, and
        distinguishable from a namesake, the next time somebody searches. Administrative gender is a
        record-keeping field, not a clinical statement.
      </p>

      {nearMatches && nearMatches.length > 0 ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2">
          <p className="text-xs font-medium text-amber-900">
            {nearMatches.length === 1 ? 'Somebody' : `${nearMatches.length} people`} on this server
            already {nearMatches.length === 1 ? 'has' : 'have'} that family name
          </p>
          <ul className="space-y-1">
            {nearMatches.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => onChooseExisting?.(patient)}
                  disabled={!onChooseExisting}
                  className="text-left text-xs text-amber-900 underline underline-offset-2 disabled:no-underline">
                  {patientDisplay(patient)} — Patient/{patient.id}
                  {describePatient(patient) ? ` · ${describePatient(patient)}` : ''}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-amber-900">
            Use one of those if it is the same person. Creating a second record for somebody the
            server already holds splits their history in two, and nothing here will notice.
          </p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-red-700">{error}</p> : null}

      {mayWrite ? null : (
        <LaunchRequiredNote>
          Creating a patient needs a launch. Searching for one already on the server does not — try the
          name again, or a shorter part of it, before adding somebody new.
        </LaunchRequiredNote>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleCreate} disabled={!canCreate}>
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
          )}
          {isSaving
            ? 'Creating…'
            : nearMatches && nearMatches.length > 0
              ? 'Create anyway'
              : 'Create patient'}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isSaving}>
          <X className="h-3.5 w-3.5" aria-hidden />
          Cancel
        </Button>
      </div>
    </div>
  );
}
