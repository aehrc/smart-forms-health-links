/**
 * Dev-only helper: mint a response SMART Health Link for a fixture, and print it.
 *
 * Not a check. It exists so the review screen — which is otherwise only reachable by completing the
 * whole two-device round trip — can be opened directly while working on it.
 *
 *   SHL_WRITE_SERVER=https://proxy.smartforms.io/fhir npx tsx scripts/mintReviewLink.ts
 */
import { fhirBinaryBlobStore } from '../src/fhir/blobStore';
import { shlCodec } from '../src/link/shlCodec';
import { buildResponseBundle } from '../src/link/exchange';
import { QRMedicalHistoryCurrentProblems } from '../../smart-forms/packages/sdc-template-extract/src/SDCExtractQuestionnaireResponseOperation/tests/resources/questionnaireResponses/QRMedicalHistoryCurrentProblems';

const server = process.env.SHL_WRITE_SERVER ?? 'https://proxy.smartforms.io/fhir';
const baseUrl = process.env.SHL_BASE_URL ?? 'http://localhost:5274';

const { bundle } = buildResponseBundle({
  ...QRMedicalHistoryCurrentProblems,
  subject: {
    reference: process.env.SHL_SUBJECT ?? 'Patient/5271',
    display: 'Review Screen Fixture'
  }
});

const link = await shlCodec.encode(
  { bundle, label: 'Medical History' },
  { baseUrl, blobStore: fhirBinaryBlobStore(server) }
);

// `shlCodec.encode` already returns a full `…/view#shlink:/…` URL.
console.log(link);
