import {
  Component,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";

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

type Route = {
  path: string;
  label: string;
  title: string;
  description: string;
};

const routes: Route[] = [
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

function WorkspacePage() {
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
      <Banner title="Research use only" tone="info">
        INSIGHT supports clinician review and does not replace professional judgment.
      </Banner>

      <section className="card" aria-labelledby="system-status-title">
        <div className="section-heading">
          <div>
            <p className="kicker">System overview</p>
            <h2 id="system-status-title">Workspace status</h2>
          </div>
          <Button>Start new work</Button>
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

function Shell() {
  const pathname = usePathname();
  const route = routes.find((candidate) => candidate.path === pathname);

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
          <span>Research workspace</span>
          <Badge tone="info">Light theme</Badge>
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
        {pathname === "/" ? <WorkspacePage /> : null}
        {pathname === "/patients" ? <PatientsPage /> : null}
        {pathname === "/plans" ? <PlansPage /> : null}
        {!route ? <NotFoundPage /> : null}
      </main>
    </div>
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
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}
