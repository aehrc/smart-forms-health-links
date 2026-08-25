# Writing extracted answers into the record

A completed form is a document. `Q: Do you have asthma? A: Yes` is stored faithfully, is auditable,
and is almost useless to the next clinician, who will not read a questionnaire to find out whether
their patient has asthma. They will look at the problem list.

Form data extraction closes that gap. It is defined by
[SDC](https://build.fhir.org/ig/HL7/sdc/extraction.html), and this app implements the two mechanisms
that need no server to do it.

## Where it happens

Only on the review screen, at the moment the reviewer accepts — `ReviewResponse.tsx`, reached from
`/view` and from `/requests`.

Not on `/responses`. That screen lists responses already stored and is read-only throughout, and the
reason is not squeamishness: extraction has to know **who the answers are about**, and `/responses`
has no reconciliation step. Accept-time is where the app already asks that question, so it is the only
place it can answer this one.

## The two mechanisms

| | Extension | Engine | Forms on the default server |
| --- | --- | --- | --- |
| Template-based | `sdc-questionnaire-templateExtract` | `@aehrc/sdc-template-extract` | 26 of 138 |
| Observation-based | `sdc-questionnaire-observationExtract` | `@aehrc/smart-forms-renderer` | 5 of 138 |

Both run **entirely in the browser**. There is no `$extract` endpoint, no StructureMap transform
server, and nothing added to the deployment — which matters here, because this app is a static site
and [claim 6](../README.md#what-this-demonstrates) says so.

The remaining 107 forms declare no extraction, and for those the panel does not appear. That is
deliberate and worth stating: an empty write-back box reads as *"this form found nothing clinically
relevant"*, which is a far stronger claim than *"this form has no templates"*.

### The two that are absent

- **Definition-based** (`sdc-questionnaire-itemExtractionContext`) — smart-forms has never implemented
  it, and its `Conformance.md` says so.
- **StructureMap-based** (`sdc-questionnaire-targetStructureMap`) — CSIRO decommissioned its demo
  `$extract` engine on 1 July 2025. Six forms on the default server still declare it and none of them
  can be extracted by anyone. Reviving it would need `services/extract-express` deployed plus a
  `$transform`-capable server, and would cost this app its no-backend property.

## The order of operations, which is the whole feature

```
reviewer picks the patient        ← reconciliation, already in ReviewResponse
        ↓
extract from the RECONCILED copy  ← src/fhir/extract.ts
        ↓
retargetSubject, as a safety net  ← src/fhir/templateExtract.ts
        ↓
reviewer ticks what belongs       ← WriteBackPanel
        ↓
POST QuestionnaireResponse        ← submit.ts, unchanged
        ↓
POST the transaction Bundle       ← writeBundle.ts
```

**Extraction runs on the reconciled response, never on the answers as they arrived.** This has no
counterpart in smart-forms, which extracts from a response it populated itself and therefore always
has the right subject. Here the answers come from a stranger's phone naming the patient in *that*
app's terms — Platypus sends its own local vault key — and a `Condition` filed against that key is
either rejected outright or, worse, filed against nobody.

`retargetSubject` is the belt to that pair of braces. A well-written template reads the subject through
`%resource.subject` and the pass finds nothing to do; one that hardcodes a reference gets caught. It is
deliberately narrow — it rewrites `subject` and `patient` only, only where the value still equals the
original, and it never invents a subject where the template left none. A resource with no subject is a
template bug, and filling it in silently would hide that behind a plausible answer.

## Why the response is written first

The `QuestionnaireResponse` goes first, and a failed write-back is a **warning**, not an error.

The response is the clinical content and the thing the reviewer actually accepted; the extracted
resources are derived from it. If the second half fails, the answers are still on record and the
extraction can be redone. If the order were reversed, a failure would leave Conditions on a chart with
no document explaining where they came from. smart-forms makes the same call in
`RendererSaveAsFinalWriteBackDialog`.

## `modifiedOnly` does not apply here

smart-forms passes `inAppExtract` a comparison response, built by re-populating the questionnaire from
the EHR, so that only answers the clinician *changed* get extracted.

That baseline used not to exist here. The person who filled the form had no access to the EHR and no
launch context — [claim 2](../README.md#what-this-demonstrates), not an oversight — so there was
nothing to diff against.

[Pre-population](pre-population.md) changed that. A request can now go out with answers filled in from
the record, and where one did, the requester holds exactly the baseline smart-forms would build.
`comparisonSourceResponse` is still `null`, and now by choice rather than by necessity: the baseline is
the *requester's* while the answers are a *stranger's*, comparable only if the filler preserved the
`linkId` structure; a request sent blank still has no baseline at all, so diffing would give the app
two extraction modes producing different resources from identical answers. `templateExtract.ts` carries
the argument in full. Extracting only what the patient actually changed is worth doing and is not done
yet.

## One transaction, all or nothing

The chosen entries are POSTed to the **server base** as a single `transaction` Bundle, so the server
applies them atomically. That is the right shape for a set of resources a human ticked as a group: a
partial write would leave the reviewer with no way to know which half of their decision took effect.

It is also a different write shape from everything else in the app. `createResource` in `submit.ts`
POSTs one resource to `/{ResourceType}` and carries an explicit instruction to widen its union type
deliberately rather than make it generic. Extraction produces resources this app never authored and
cannot enumerate ahead of time, so `writeBundle.ts` is a separate primitive rather than a loosened
version of the careful one.

When a transaction is refused, **nothing was written** — including the entries whose own status looks
successful. `submitExtractedBundle` reports that distinction, and the panel says it out loud.

## FHIRPatch entries are all-or-nothing rows

Template extraction can emit FHIRPatch `Parameters` entries, which change a resource that already
exists. Six forms on the default server do — all of the Aboriginal and Torres Strait Islander Health
Check family.

smart-forms lets a reviewer tick individual patch operations. This app does not, and shows one row
saying how many changes it bundles. Choosing between JSON Patch operations against a resource the
screen cannot display is not a decision a clinician can make well, and offering it would imply
otherwise. The formatters for operation-level display exist upstream in
`extractedBundleSelector.ts` if this is ever revisited.

## Scopes

Write-back is the only reason this app asks for `u` on anything:

```
user/Condition.cu  user/Observation.cu  user/AllergyIntolerance.cu
user/MedicationStatement.cu  user/Immunization.cu  user/Procedure.cu  user/Encounter.cu
```

`u` because template extraction emits `PUT` and `PATCH` entries — a form recording a resolved allergy
is amending something that already exists, and there is no create-only way to express that.

What still holds, and is asserted by `check:roundtrip`: nothing is ever deleted, and the resources the
app *authors* — the response, its Task, its Provenance, any Patient it registers — remain create-only.
[Amendments are new resources](../README.md#amendments-are-new-resources) exists precisely so a stored
response never has to be updated in place.

If your deployment's forms declare no extraction, these scopes are requested and never exercised;
narrow them with `smartScopes`.

## Turning it off

`enableWriteBack` in `config.json`. On in the shipped config, off in the fallback — the same posture as
every other write capability, because a config that failed to load should not start creating clinical
resources on a server it cannot name properly.
