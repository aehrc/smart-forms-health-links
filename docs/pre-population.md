# Filling a form in before you send it

A patient who is asked to complete a chronic disease management plan already exists in the record that
asked them. Their name is on file, so is their date of birth, so is their Medicare number, and so is
the problem list the plan is about. Asking them to type it again is asking them to re-enter data the
requester is holding, and to get it wrong in ways nobody can check.

SDC solves this with [`$populate`](https://hl7.org/fhir/uv/sdc/populate.html). This app can use it,
but not where SDC puts it.

## Why it runs at request time

`$populate` normally runs at **fill** time, inside a launched app. The person filling the form has a
SMART session, and the renderer resolves each item's `x-fhir-query` against the EHR just before the
form is drawn. That is what smart-forms does.

It is unavailable here by construction. The person filling one of these forms holds no credential and
has no network path to the requester's servers — [claim 2](../README.md#what-this-demonstrates), and
the reason the whole thing works over a QR code across an air gap.

So population moves to the **requesting** side, which is the only side that has a launch context, a
token and a route to the record:

```
  ordinary SDC          requester ──── link ────▶ filler ──$populate──▶ EHR
                                                     └── needs an EHR the filler cannot reach

  here                  requester ──$populate──▶ EHR
                            └── seals the answers into the link ────▶ filler
                                                                        └── needs nothing
```

Nothing about the filler's position changes. They still hold only a link, still reach no server of
ours, and still own every answer on the form the moment they open it. Populating once on the
requesting side is not a workaround for an offline filler — it is what lets pre-population and an
offline filler exist at the same time.

## What it is worth

Measured against the default catalogue and the default sandbox record.

| | |
| --- | --- |
| Forms declaring population machinery | **112 of 138** |
| …declaring only item-level machinery, invisible at the root | 5 |
| Forms declaring template-based extraction, for comparison | 25 |
| GP Chronic Condition Management Plan, populated | 12 answers, 15 reads, ~250 ms |
| Payload growth | **+2.2%** — 2.4 KB of seed on 109 KB of Questionnaire |
| Link size | unchanged, ~260 bytes |

Pre-population is the broadest SDC capability in that catalogue, and until now the app used none of it.

`npm run check:populate` asserts all of this against the live servers.

## What travels

The request Bundle gains a third entry:

```
Bundle{ Questionnaire, QuestionnaireResponse{status: in-progress}, Task }
```

The seed is normalised before sealing, and everything removed would otherwise mean the wrong thing on
the far side. No `id` — identity on a server the filler cannot see. **No `author` and no `authored`** —
an author naming the practitioner survives the round trip and lands on the answers the *patient*
returns. No `meta.security` — a seed is nobody's assertion yet. `subject` mirrors `Task.for`, and
`Task.input` gains a `questionnaire-response` slot pointing at it, so the seed is *declared* rather
than merely present.

The tracking `Task` published to the EHR carries none of it: `asPublishedTask` drops `urn:uuid` inputs
along with `focus` and `extension`, because they name siblings inside the encrypted payload.

### The discriminator had to change

`isRequestBundle` used to mean *a Questionnaire is present and a QuestionnaireResponse is **not***.
Both legs can now carry a QuestionnaireResponse, so the test is its **status**:

```
a Questionnaire is present
  && every QuestionnaireResponse in the bundle is in-progress
```

`QuestionnaireResponse.status` is `1..1` in R4, so there is always something to read, and `completed`,
`amended` and `entered-in-error` are exactly the statuses that mean somebody answered. Absence was
never much of a test anyway: it gave a cautious reader nothing to check, only something to fail to
find. A payload carrying a form and an unfinished response is an invitation with a head start; one
carrying a finished response is answers, whether or not the form came along too.

Every case the old rule got right, this one still gets right, and `check:roundtrip` holds it to that —
including the case the old rule caught by accident, a filler that echoes the form back alongside its
answers.

## Scopes, and the trap in them

`DEFAULT_SMART_SCOPES` already names most of the types a form wants to read:

```
user/Condition.cu   user/Observation.cu   user/AllergyIntolerance.cu   …
```

Those letters are the whole permission. In SMART v2, `c` is create, `r` read, `u` update, `d` delete
and `s` search — so `.cu` is **create and update, with no read and no search**. The app writes those
resources during form data extraction and has never needed to look at them.

Pre-population does nothing but look at them. A form's `x-fhir-query` is a search, so every type in
that group needs `r` and `s` added, and every one of them reads as already covered.

**The failure is silent.** A refused write fails loudly, when a clinician presses Accept. A refused
read produces an empty answer — indistinguishable from a record that holds nothing — and the form goes
out saying the patient has no recorded conditions. It stays hidden on the default sandbox, which
grants `user/*.*` and never exercises the gap.

`PRE_POPULATE_SCOPES` closes it, requested only when the feature is on. The list was derived by reading
every `x-fhir-query` in all 138 catalogue Questionnaires and counting the types they name:

| type | forms | before |
| --- | --- | --- |
| `Observation` | 31 | `.cu` only |
| `Condition` | 25 | `.cu` only |
| `AllergyIntolerance` | 12 | `.cu` only |
| `PractitionerRole` | 9 | not granted |
| `MedicationStatement` | 9 | `.cu` only |
| `QuestionnaireResponse` | 9 | already `.crs` |
| `Immunization` | 7 | `.cu` only |
| `Encounter` | 6 | `.cu` only |
| `MedicationRequest` | 5 | not granted |
| `Procedure` | 4 | `.cu` only |
| `ServiceRequest` | 2 | not granted |
| `Device`, `Organization` | 1 each | not granted |

`Patient` is absent because it arrives through `launchContext`, not through a query.

`mergePermissions` then collapses each pair into one scope, so a launch asks `user/Condition.crus`
once rather than `.cu` and `.rs` separately — two alternative statements of one permission that a
server is free to answer inconsistently.

This is a list about *this catalogue*. Another deployment's forms will want other types; that is what
`smartScopes` is for, and setting it takes over the list wholesale.

## Choosing what goes

Population produces a proposal, not a decision. The clinician sees every answer it found, grouped by
section with repeating instances numbered, and unticks anything the patient should answer themselves
or the record has wrong. Only what is still ticked is sealed.

This is the same posture as the write-back panel at the other end of the round trip, and deliberately
the same shape: everything is ticked on arrival, because the values are what the record holds and the
default should be to honour it. Removing what does not belong is a smaller question than assembling
the set from nothing.

Untick everything and the form goes out blank, exactly as it would without the feature.

There is also a preview that renders the seeded form read-only, as the patient will receive it. The
tick list says what will be sent; the preview says what it will look like.

## What it costs

Two things, and neither is solved.

### The payload stops being harmless

A request used to carry a public Questionnaire — downloadable by anyone — plus a name. Its most
sensitive fact was *that this person was asked to fill this in*. A pre-filled request carries an
extract from a chart.

The cryptography does not change: a JWE on an untrusted `Binary`, with the key in the link fragment.
What changes is what a leaked link costs. Links leak in ordinary ways — photographed over a shoulder,
printed, texted, left in a browser history — and SHL's model is that the link *is* the credential.
That was an easy trade for a blank form and is a real decision for a chart extract.

Note also that nothing deletes the `Binary` when a request is collected. `linkLifetimeDays` sets `exp`,
which *readers* enforce; the host does not. An expired pre-filled request is still sitting there.

`enablePrePopulate` is therefore off in the fallback config, and on in the shipped one only because
that points at a sandbox of synthetic patients where this is the demo. Two deliberate acts are still
needed with it on: a SMART launch, and ticking the box on the request itself.

### `PATAST` becomes less true

Answers come back stamped `PATIENT_ASSERTED` — every answer, including ones the patient scrolled past
without reading. The claim is not baseless: the values did pass in front of them, and they could have
changed or cleared any of them. On a 700-item form that is thinner than it sounds.

This is the mirror image of what [`amend.ts`](../src/fhir/amend.ts) exists to prevent. That file
refuses to let a reviewer's edits be filed as a patient's words, and goes to the length of creating a
second resource joined by `Provenance` rather than blur the two. Pre-population blurs them in the
other direction, and does not currently pay the same price to avoid it.

What is done instead: the outstanding request records that it went out pre-filled, and both
`/requests` and the review screen say so. That is a record made by the requester, at the time, and it
is not the same thing as knowing which particular answers the patient touched.

Options that were considered and not built:

- **A population `Provenance` in the request.** Truthful and cheap, and it does not survive the return
  leg by itself.
- **Per-item `questionnaireresponse-author`.** The standard R4 extension for exactly this, and it
  depends on the *filler* preserving it. Nothing obliges a third-party app to, and this app could not
  verify that it had.
- **Keeping the seed and diffing on return.** The only option producing a *verified* claim rather than
  a reported one, since the requester already holds what it sent. It needs nothing from the filler,
  and it would hand `templateExtract.ts` the baseline it currently declines to use.

The third is the one to build next.

## Files

| | |
| --- | --- |
| `src/fhir/populate.ts` | the operation, and the callback that keeps the token off foreign hosts |
| `src/lib/answerRows.ts` | `populatedRows` / `pruneAnswers` — the tickable rows and the pruning |
| `src/components/PrePopulatePanel.tsx` | the tick list |
| `src/routes/RequestForm.tsx` | the toggle, the preview, the mint |
| `src/link/exchange.ts` | the seed on the wire, and `isRequestBundle` |
| `src/components/FillFromRequest.tsx` | the filler's side, and the notice |
| `scripts/e2ePopulate.ts` | `npm run check:populate` |
