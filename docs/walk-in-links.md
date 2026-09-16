# Walk-in codes

The design record for the printed QR a practice puts on its counter, built for
[issue #21](https://github.com/aehrc/smart-forms-health-links/issues/21). The user-facing account is
in the README under [Walk-in codes](../README.md#walk-in-codes); this is the reasoning, the rejected
alternatives, and the parts that are load-bearing in ways the code does not announce.

## The problem

Every link this app minted before now was minted for one person. `POST /api/invitations` takes a
patient, publishes a `Task` addressed to them, seals one payload and expects one answer. A new
patient walking in has none of that: the practice has never heard of them, nobody has typed anything,
and the only thing on the counter is a poster that has been there for a month.

## Four decisions

These were settled before any code was written, and each of them closed an option that was genuinely
open.

### A fresh invitation per scan

The alternative was one reusable invitation row that many people answer.

It was rejected because `respondedAt`, `responseReference` and `claimInvitationResponse` in
`server/shl/invitationStore.ts` encode "one invitation, one response", and the facade is built on
them. Reusing one row means relaxing that rule and then inventing something else to tell one filler's
answers from another's.

Minting a child on every manifest fetch keeps the rule exactly as it is, because no child is ever
used by more than one person. `server/shl/manifest.ts#resolveInvitation` is the whole of it: an
ordinary id resolves to itself, a standing id resolves to a row minted on the spot.

Two fields are deliberately _not_ inherited from the standing row.

- **`requestIdentifier` is minted fresh.** It is the conditional-create key upstream. Two walk-ins
  sharing one would mean the second person's answers were absorbed as a replay of the first
  person's - silently, and with no error anywhere.
- **`patientId` stays null.** At the moment of the scan the practice holds no record of whoever is
  holding the phone.

The filler needs no change at all. `directSendTarget` reads the destination out of the grant's `aud`,
which it already did, and the manifest already mints a grant per fetch.

### Answers forward immediately, with no subject

The alternative was a holding table in this app's SQLite, with nothing reaching the practice until
staff accepted it.

It was rejected because a second store is a second thing to back up, to migrate and to lose, and
because a QuestionnaireResponse belongs on the record server once it exists. The cost is real and is
written up in the README as a known limitation: an anonymous scan does write to the practice's
server.

What makes it survivable is that none of it lands on a patient. The facade stamps `SHL_WALK_IN_TAG`
on the forwarded response, and it stamps it **from the invitation row**, never from the request -
the same rule that stops a filler choosing its own patient or its own idempotency key. A filler
cannot put answers in the queue by claiming to be a walk-in, and cannot keep them out by claiming not
to be.

### One Task for the code, not one per scan

The alternative was a `Task` per scan, which would track each filler properly.

It was rejected because publishing it is a write to the practice's server caused by an anonymous
camera. The whole point of the previous decision is that an unvouched-for scan touches no record; a
Task per scan would put that back.

So one Task is published when staff create the code, addressed to nobody, tagged
`shl-form-request` **and** `shl-standing-request`. Two things then have to be true, and both are easy
to undo by accident:

- **The sealed payload must carry no `publishedTaskUrl`.** `server/api/standingInvitations.ts` builds
  the Bundle without it, so the Task inside the invitation has no
  `invitation-server-task-url` extension and neither return channel can complete anything.
- **The facade must decline the Task leg.** `publishedTaskId` in `server/shl/facade.ts` returns
  `undefined` when `standingId` is set. The row does carry the standing Task's URL - truthfully; it
  _is_ the request these answers answer - so without this guard the first walk-in would flip the
  poster's Task to `completed` and retire it for everybody behind them.

`tests/server/facade.test.ts` asserts this with a filler that _offers_ a Task version, because a
transaction with no Task entry would pass whether the guard existed or not.

### Expiry, withdrawal and a scan ceiling

A code carries its own `expiresAt`, independent of the one-hour grant. That separation already
existed and is the reason a poster can outlive by a month the credential handed to anyone scanning
it.

Withdrawal (`revokedAt`) takes effect on the next scan, not on the phones that already have the form
open: a grant minted a minute ago names a child invitation that was minted before the withdrawal, and
it stays good for its hour. That window is the price of minting grants per fetch and storing none.

The ceiling is 60 scans an hour per code (`SCAN_CAP`, `SCAN_WINDOW_SECONDS` in
`server/shl/manifest.ts`), answered with `429`. It is not a 404, and that is deliberate: you had to
hold a working code to reach it, so the refusal discloses nothing, and telling a practice its own
poster has vanished would be worse.

## The queue is a tag, and the tag is the state

`/walk-ins` is one search:

```text
GET /QuestionnaireResponse?_tag=http://smartforms.csiro.au/CodeSystem/shl-request|shl-walk-in
```

A tag search rather than `subject:missing=true`, although every item in the queue does lack a
subject. Three reasons: the tag search is the same mechanism `/requests` is already built on and
therefore already known to work against this deployment's server; `:missing` support varies; and the
tag keeps saying the right thing in the moment between a subject being chosen and the item being
filed.

Filing an item **updates it where it lies** and removes the tag. That is the whole of "it has left
the queue" - there is no second piece of state to keep in step. `attachSubject` in
`src/fhir/submit.ts` is the write, and it is a `PUT` with `If-Match` on the version read, so two
receptionists with the same item open cannot silently overwrite each other.

This is the one place in the app where accepting a review is an update. Everywhere else the answers
arrived on a link and this app has never stored them, so accepting creates. Getting it wrong here
fails nothing and errors nowhere - it just leaves two QuestionnaireResponses for every walk-in, one
belonging to nobody and one belonging to a patient. `tests/src/walkInIntake.test.tsx` asserts the
verb on the request the browser actually makes, for exactly that reason.

## What review gained

`ReviewResponse` already treated a missing subject as needing reconciliation, and already had
`PatientPicker` wired to choose one. Two props were added:

- **`savedAs`** - "these answers are already here", which switches the save from create to update and
  pins the patient search to the server holding the response rather than to whatever endpoint the
  form declares.
- **`allowPatientCreation`** - off by default, because the usual review is of answers a practice
  asked a patient it already knows for, and offering to create a second record for them is a way to
  end up with one. A walk-in turns it on, because registering somebody nobody has met is the expected
  outcome.

## Where this leaves `/requests`

A standing request is never completed, so its Task status stays `requested` for the life of the
poster. `describeSentRequests` reads the `shl-standing-request` tag into a `standing` flag and the
row renders as **Walk-in code**, linking to `/walk-ins`. Without that, every poster a practice ever
printed would sit in the sent list as permanently unanswered.

The flag is read from the tag and never inferred from the absence of a `for`: a per-patient request
may legitimately name nobody, and guessing would report those as posters.

## What is still open

- **Nothing prunes child invitations.** A code scanned at its ceiling for a year accumulates rows.
  They are small and they expire with the code, but `deleteExpiredStandingInvitations` deliberately
  leaves children alone, because a child holds the reference to answers that did reach the practice.
- **The scan ceiling is per code, not per caller.** A distributed script still gets 60 an hour, and a
  genuinely busy clinic sharing one code would too. Per-caller limiting needs something this app does
  not have.
- **Discarding junk from the queue is not built.** A receptionist can attach an item to somebody but
  not mark it as rubbish; that would want a second tag and a deliberate decision about whether a
  practice may delete a resource a stranger created.
