import {
  ClipboardList,
  Inbox,
  LogOut,
  QrCode,
  ScanLine,
  Users,
} from "lucide-react";
import {
  Navigate,
  Link as RouterLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { Loading } from "./components/ui/loading";
import { useLogout, useRequesterGate, useSession } from "./lib/session";
import { LINK_CODECS } from "./link/registry";
import Connect from "./routes/Connect";
import FillForm from "./routes/FillForm";
import FormList from "./routes/FormList";
import PatientList from "./routes/PatientList";
import RequestForm from "./routes/RequestForm";
import Requests from "./routes/Requests";
import ResponseList from "./routes/ResponseList";
import Scan from "./routes/Scan";
import ViewLink from "./routes/ViewLink";

import type { ReactNode } from "react";

/**
 * The shell: navigation, the signed-in identity, and which routes need a session.
 *
 * The app has two halves and they have opposite requirements. The **requester** half - forms,
 * patients, responses, sent requests - reads a clinical system through the BFF proxy, so every
 * one of its surfaces needs a launched session and offers a launch when there is not one
 * (FR-006). The **filler** half - `/view` and `/scan` - is reached by someone holding a link they
 * were sent, who has no account anywhere and must not be asked for one.
 * @author John Grimes
 */

/**
 * Does the current fragment look like a link payload from any registered codec?
 * @param hash the location hash, including its leading `#`
 * @returns true when some registered codec claims it
 */
function fragmentHasLink(hash: string): boolean {
  return hash !== "" && LINK_CODECS.some((codec) => codec.canDecode(hash));
}

/**
 * Gate a requester surface on the session.
 *
 * Renders the launch prompt in place of the surface when there is no session, so a signed-out
 * visitor lands on something that explains itself rather than on a screen full of failed reads.
 * The surfaces gate again on their own read failures, which is how a session that dies while one
 * of them is open turns into a re-launch prompt rather than an error.
 * @param root0 the component props
 * @param root0.children the surface to render once there is a session
 * @returns the surface, a launch prompt, or a loading line
 */
function RequesterRoute({ children }: Readonly<{ children: ReactNode }>) {
  const gate = useRequesterGate();

  if (gate.kind === "loading") {
    return <Loading>Checking your session…</Loading>;
  }
  if (gate.kind === "launch-required") {
    return <Connect reason={gate.reason} />;
  }
  return children;
}

/**
 * One navigation link, so the classes that style them live in one place.
 * @param root0 the component props
 * @param root0.to the in-app path to navigate to
 * @param root0.icon the Lucide icon component to show beside the label
 * @param root0.children the label
 * @returns the link
 */
function NavLink({
  to,
  icon: Icon,
  children,
}: Readonly<{
  to: string;
  icon: typeof Users;
  children: ReactNode;
}>) {
  return (
    <RouterLink
      to={to}
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </RouterLink>
  );
}

/**
 * Who is signed in, and how to stop being.
 *
 * Shown only when there is a session, because the alternative - a permanent "signed out" chip -
 * would be noise on the filler surfaces, where being signed out is the normal condition.
 * @returns the identity and sign-out control, or nothing when signed out
 */
function SessionBadge() {
  const state = useSession();
  const signOut = useLogout();

  if (state.kind !== "active") {
    return null;
  }

  const { issuerLabel, userDisplay } = state.session;

  return (
    <div className="flex items-center gap-2 border-l border-slate-200 pl-2 dark:border-slate-800">
      <div className="min-w-0 text-right">
        <p className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
          {issuerLabel}
        </p>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
          {userDisplay ?? "Signed in"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
        title={`Sign out of ${issuerLabel}`}
        aria-label={`Sign out of ${issuerLabel}`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        <LogOut className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The application header: brand, navigation and identity.
 * @returns the header
 */
function Header() {
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <RouterLink
          to="/"
          className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"
        >
          <QrCode className="h-5 w-5" aria-hidden />
          Smart Forms Health Links
        </RouterLink>
        <nav className="ml-auto flex flex-wrap items-center gap-1">
          <NavLink to="/patients" icon={Users}>
            Patients
          </NavLink>
          <NavLink to="/responses" icon={ClipboardList}>
            Responses
          </NavLink>
          <NavLink to="/requests" icon={Inbox}>
            Sent requests
          </NavLink>
          <NavLink to="/scan" icon={ScanLine}>
            Scan
          </NavLink>
          <SessionBadge />
        </nav>
      </div>
    </header>
  );
}

/**
 * The application shell.
 * @returns the header and the routed surface
 */
export default function App() {
  const location = useLocation();

  /*
   * SMART Health Links are conventionally presented as `https://viewer.example.org#shlink:/...`,
   * i.e. a payload in the fragment at the site root. Honour that shape by forwarding any root-level
   * link fragment to the viewer, preserving the hash. Ahead of the session gate on purpose: someone
   * arriving with a link is a filler, and must never be asked to sign in.
   */
  if (location.pathname === "/" && fragmentHasLink(location.hash)) {
    return <Navigate to={{ pathname: "/view", hash: location.hash }} replace />;
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route
            path="/"
            element={
              <RequesterRoute>
                <FormList />
              </RequesterRoute>
            }
          />
          <Route
            path="/fill/:questionnaireId"
            element={
              <RequesterRoute>
                <FillForm />
              </RequesterRoute>
            }
          />
          <Route
            path="/request/:questionnaireId"
            element={
              <RequesterRoute>
                <RequestForm />
              </RequesterRoute>
            }
          />
          <Route
            path="/requests"
            element={
              <RequesterRoute>
                <Requests />
              </RequesterRoute>
            }
          />
          <Route
            path="/responses"
            element={
              <RequesterRoute>
                <ResponseList />
              </RequesterRoute>
            }
          />
          <Route
            path="/patients"
            element={
              <RequesterRoute>
                <PatientList />
              </RequesterRoute>
            }
          />
          {/* The filler's half. No session, by design: whoever holds the link has no account. */}
          <Route path="/view" element={<ViewLink />} />
          <Route path="/scan" element={<Scan />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
