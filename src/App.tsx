import { Navigate, Link as RouterLink, Route, Routes, useLocation } from 'react-router-dom';
import { ClipboardList, Inbox, QrCode, ScanLine, Users } from 'lucide-react';
import FormList from './routes/FormList';
import FillForm from './routes/FillForm';
import RequestForm from './routes/RequestForm';
import Requests from './routes/Requests';
import ResponseList from './routes/ResponseList';
import PatientList from './routes/PatientList';
import ViewLink from './routes/ViewLink';
import Scan from './routes/Scan';
import { LINK_CODECS } from './link/registry';

/** Does the current fragment look like a link payload from any registered codec? */
function fragmentHasLink(hash: string): boolean {
  return hash !== '' && LINK_CODECS.some((codec) => codec.canDecode(hash));
}

function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
        <RouterLink to="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <QrCode className="h-5 w-5" aria-hidden />
          Smart Forms Health Links
        </RouterLink>
        <nav className="ml-auto flex items-center gap-1">
          <RouterLink
            to="/patients"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <Users className="h-4 w-4" aria-hidden />
            Patients
          </RouterLink>
          <RouterLink
            to="/responses"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <ClipboardList className="h-4 w-4" aria-hidden />
            Responses
          </RouterLink>
          <RouterLink
            to="/requests"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <Inbox className="h-4 w-4" aria-hidden />
            Sent requests
          </RouterLink>
          <RouterLink
            to="/scan"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <ScanLine className="h-4 w-4" aria-hidden />
            Scan
          </RouterLink>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  const location = useLocation();

  /*
   * SMART Health Links are conventionally presented as `https://viewer.example.org#shlink:/...`,
   * i.e. a payload in the fragment at the site root. Honour that shape by forwarding any root-level
   * link fragment to the viewer, preserving the hash.
   */
  if (location.pathname === '/' && fragmentHasLink(location.hash)) {
    return <Navigate to={{ pathname: '/view', hash: location.hash }} replace />;
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<FormList />} />
          <Route path="/fill/:questionnaireId" element={<FillForm />} />
          <Route path="/request/:questionnaireId" element={<RequestForm />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/responses" element={<ResponseList />} />
          <Route path="/patients" element={<PatientList />} />
          <Route path="/view" element={<ViewLink />} />
          <Route path="/scan" element={<Scan />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
