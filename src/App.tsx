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
import Launch from './routes/Launch';
import LaunchSetup from './routes/LaunchSetup';
import Callback from './routes/Callback';
import { LINK_CODECS } from './link/registry';
import { CALLBACK_PATH, LAUNCH_PATH, LAUNCH_SETUP_PATH } from './auth/routes';
import LaunchContextBar from './components/LaunchContextBar';
import ScopeWarning from './components/ScopeWarning';

/** Does the current fragment look like a link payload from any registered codec? */
function fragmentHasLink(hash: string): boolean {
  return hash !== '' && LINK_CODECS.some((codec) => codec.canDecode(hash));
}

function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      {/*
        * Destinations only, now that the session and the launch-setup link live in the strip below.
        * That is what got this row back inside a 1024-wide viewport: the badge carrying a name and a
        * host was the widest thing in it, and it was never a destination in the first place.
        *
        * `flex-wrap` stays for genuinely narrow viewports, where the honest options are a second row or
        * cryptic unlabelled icons. A few pixels of height is the cheaper of the two.
        */}
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <RouterLink
          to="/"
          className="flex items-center gap-2 whitespace-nowrap font-semibold text-slate-900">
          <QrCode className="h-5 w-5" aria-hidden />
          Smart Forms Health Links
        </RouterLink>
        <nav className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <RouterLink
            to="/patients"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <Users className="h-4 w-4" aria-hidden />
            Patients
          </RouterLink>
          <RouterLink
            to="/responses"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <ClipboardList className="h-4 w-4" aria-hidden />
            Responses
          </RouterLink>
          <RouterLink
            to="/requests"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            <Inbox className="h-4 w-4" aria-hidden />
            Sent requests
          </RouterLink>
          <RouterLink
            to="/scan"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
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
      {/*
        * Between the nav and the content, on every route, for the same reason `ScopeWarning` sits above
        * the routes rather than inside them: what this says applies to whichever screen the user
        * happens to reach. Unlike `ScopeWarning` it renders in every state, including no session —
        * see the component.
        */}
      <LaunchContextBar />
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {/*
          * Above the routes rather than inside them. A narrowed grant affects whichever screen the
          * user happens to reach, and it renders nothing at all when there is nothing to report.
          */}
        <ScopeWarning />
        <Routes>
          <Route path="/" element={<FormList />} />
          <Route path="/fill/:questionnaireId" element={<FillForm />} />
          <Route path="/request/:questionnaireId" element={<RequestForm />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/responses" element={<ResponseList />} />
          <Route path="/patients" element={<PatientList />} />
          <Route path="/view" element={<ViewLink />} />
          <Route path="/scan" element={<Scan />} />
          {/* Before /launch only for readability; both are exact paths and cannot shadow each other. */}
          <Route path={LAUNCH_SETUP_PATH} element={<LaunchSetup />} />
          <Route path={LAUNCH_PATH} element={<Launch />} />
          <Route path={CALLBACK_PATH} element={<Callback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
