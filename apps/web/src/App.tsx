import {
  Component,
  type ErrorInfo,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";

import { AdminUsersPage } from "./AdminUsersPage";
import {
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type Route = {
  path: string;
  label: string;
  title: string;
  description: string;
};

type Session = operations["getSession"]["responses"][200]["content"]["application/json"];

const clinicianRoutes: Route[] = [
  {
    path: "/",
    label: "Workspace",
    title: "Decision support workspace",
    description: "Review current work and continue research workflows.",
  },
  {
    path: "/patients",
    label: "Patients",
    title: "Patients",
    description: "Find or create a patient record.",
  },
  {
    path: "/plans",
    label: "Treatment plans",
    title: "Treatment plans",
    description: "Review draft and finalized treatment plans.",
  },
];

const administratorRoutes: Route[] = [
  {
    path: "/",
    label: "Workspace",
    title: "Administration workspace",
    description: "Manage accounts and research-system operations.",
  },
  {
    path: "/administration/users",
    label: "User management",
    title: "User management",
    description: "Create accounts, manage credentials, account access, and active sessions.",
  },
];

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  return pathname;
}

function navigate(event: MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function WorkspacePage({ administrator = false }: { administrator?: boolean }) {
  const columns = [
    { key: "area", header: "Area" },
    { key: "status", header: "Status" },
  ];
  const rows = [
    {
      id: "shell",
      area: "Application shell",
      status: <Badge tone="normal">Available</Badge>,
    },
    {
      id: "services",
      area: "Clinical services",
      status: <Badge tone="warning">Not connected</Badge>,
    },
  ];

  return (
    <div className="page-stack">
      <Banner title={administrator ? "Administrator workspace" : "Research use only"} tone="info">
        {administrator
          ? "Patient and clinical content is not available to Administrators."
          : "INSIGHT supports clinician review and does not replace professional judgment."}
      </Banner>

      <section className="card" aria-labelledby="system-status-title">
        <div className="section-heading">
          <div>
            <p className="kicker">System overview</p>
            <h2 id="system-status-title">Workspace status</h2>
          </div>
          {administrator ? null : <Button>Start new work</Button>}
        </div>
        <DataTable
          ariaLabel="Workspace services"
          caption="Current workspace service availability"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      </section>
    </div>
  );
}

function PatientsPage() {
  return (
    <div className="page-stack">
      <section className="card" aria-labelledby="patient-search-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Patient registry</p>
            <h2 id="patient-search-title">Find a patient</h2>
          </div>
        </div>
        <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
          <FormField label="Patient identifier" hint="Enter an exact or partial identifier.">
            {(fieldProps) => <TextInput {...fieldProps} name="patient-identifier" />}
          </FormField>
          <Button type="submit">Search</Button>
        </form>
      </section>
      <EmptyState
        title="No patient selected"
        description="Search for a patient to open their research case."
        action={<Button variant="secondary">Add patient</Button>}
      />
    </div>
  );
}

function PlansPage() {
  return (
    <div className="page-stack">
      <LoadingState label="Loading treatment plans" />
    </div>
  );
}

function NotFoundPage() {
  return (
    <ErrorState
      title="Page not found"
      description="The requested INSIGHT page does not exist."
      action={
        <Button variant="secondary" onClick={() => window.history.back()}>
          Go back
        </Button>
      }
    />
  );
}

function Shell({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const pathname = usePathname();
  const routes = session.user.role === "ADMINISTRATOR" ? administratorRoutes : clinicianRoutes;
  const route = routes.find((candidate) => candidate.path === pathname);

  async function signOut() {
    await apiClient.POST("/api/v1/logout", {
      headers: { "x-csrf-token": session.csrfToken },
    });
    onSignedOut();
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <a className="wordmark" href="/" onClick={(event) => navigate(event, "/")}>
          INSIGHT
        </a>
        <div className="app-context">
          <span>{session.user.username}</span>
          <Badge tone="info">
            {session.user.role === "ADMINISTRATOR" ? "Administrator" : "Psychiatrist"}
          </Badge>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <aside className="app-sidebar">
        <nav aria-label="Application navigation">
          <ul className="nav-list">
            {routes.map((item) => (
              <li key={item.path}>
                <a
                  aria-current={item.path === pathname ? "page" : undefined}
                  className="nav-link"
                  href={item.path}
                  onClick={(event) => navigate(event, item.path)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="app-main" id="main-content" tabIndex={-1}>
        <header className="page-heading">
          <p className="kicker">INSIGHT</p>
          <h1>{route?.title ?? "Page not found"}</h1>
          {route ? <p>{route.description}</p> : null}
        </header>
        {pathname === "/" ? (
          <WorkspacePage administrator={session.user.role === "ADMINISTRATOR"} />
        ) : null}
        {pathname === "/patients" ? <PatientsPage /> : null}
        {pathname === "/plans" ? <PlansPage /> : null}
        {pathname === "/administration/users" && session.user.role === "ADMINISTRATOR" ? (
          <AdminUsersPage csrfToken={session.csrfToken} />
        ) : null}
        {!route ? <NotFoundPage /> : null}
      </main>
    </div>
  );
}

function AuthenticationPage({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const result = await apiClient.POST("/api/v1/login", {
      body: {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
      },
    });
    if (result.data) onAuthenticated(result.data);
    else setError("Sign-in failed. Check your credentials and try again.");
    setLoading(false);
  }

  return (
    <main className="authentication-page">
      <section className="authentication-card" aria-labelledby="sign-in-title">
        <p className="wordmark">INSIGHT</p>
        <h1 id="sign-in-title">Sign in</h1>
        <p>Use your locally managed INSIGHT account.</p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <form className="page-stack" onSubmit={submit}>
          <FormField label="Username" required>
            {(props) => <TextInput {...props} name="username" required autoComplete="username" />}
          </FormField>
          <FormField label="Password" required>
            {(props) => (
              <TextInput
                {...props}
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            )}
          </FormField>
          <Button type="submit" loading={loading}>
            Sign in
          </Button>
        </form>
        <p className="authentication-note">No public signup or email recovery is available.</p>
      </section>
    </main>
  );
}

function PasswordReplacementPage({
  session,
  onReplaced,
}: {
  session: Session;
  onReplaced: (session: Session) => void;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    const result = await apiClient.POST("/api/v1/session/password", {
      headers: { "x-csrf-token": session.csrfToken },
      body: { password },
    });
    if (result.data) onReplaced(result.data);
    else setError("Password replacement failed. Try again.");
    setLoading(false);
  }

  return (
    <main className="authentication-page">
      <section className="authentication-card" aria-labelledby="replace-password-title">
        <p className="wordmark">INSIGHT</p>
        <h1 id="replace-password-title">Replace temporary password</h1>
        <Banner title="Password change required" tone="warning">
          Replace the temporary password before accessing any other INSIGHT function.
        </Banner>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <form className="page-stack" onSubmit={submit}>
          <FormField label="New password" hint="Use at least 12 characters." required>
            {(props) => (
              <TextInput
                {...props}
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
              />
            )}
          </FormField>
          <Button type="submit" loading={loading}>
            Replace password
          </Button>
        </form>
      </section>
    </main>
  );
}

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught application error", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error">
          <ErrorState
            title="INSIGHT could not open"
            description="An unexpected application error occurred. Reload to try again."
            action={<Button onClick={() => window.location.reload()}>Reload</Button>}
          />
        </main>
      );
    }

    return this.props.children;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void apiClient.GET("/api/v1/session").then((result) => {
      if (active) setSession(result.data ?? null);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ErrorBoundary>
      {session === undefined ? (
        <main className="authentication-page">
          <LoadingState label="Loading INSIGHT" />
        </main>
      ) : null}
      {session === null ? <AuthenticationPage onAuthenticated={setSession} /> : null}
      {session?.user.status === "PASSWORD_CHANGE_REQUIRED" ? (
        <PasswordReplacementPage session={session} onReplaced={setSession} />
      ) : null}
      {session?.user.status === "ENABLED" ? (
        <Shell session={session} onSignedOut={() => setSession(null)} />
      ) : null}
    </ErrorBoundary>
  );
}
