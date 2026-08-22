import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, ErrorBoundary } from "./App";

function BrokenPage(): never {
  throw new Error("test failure");
}

const session = (
  role: "ADMINISTRATOR" | "PSYCHIATRIST" = "PSYCHIATRIST",
  status: "ENABLED" | "PASSWORD_CHANGE_REQUIRED" = "ENABLED",
) => ({
  schemaVersion: "1",
  user: { id: "10000000-0000-4000-8000-000000000001", username: "tester", role, status },
  csrfToken: "csrf-token",
  expiresAt: "2026-08-22T12:00:00.000Z",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  const stored = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return stored.size;
      },
      clear: () => stored.clear(),
      getItem: (key: string) => stored.get(key) ?? null,
      key: (index: number) => [...stored.keys()][index] ?? null,
      removeItem: (key: string) => stored.delete(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    } satisfies Storage,
  });
  window.localStorage.clear();
  window.localStorage.setItem(
    "insight.research-use.10000000-0000-4000-8000-000000000001.v1",
    "acknowledged",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(session())),
  );
});

describe("application shell", () => {
  it("routes without losing semantic shell landmarks", async () => {
    window.history.replaceState({}, "", "/");
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Patient Registry" }));

    expect(window.location.pathname).toBe("/patients");
    expect(await screen.findByRole("heading", { level: 1, name: "Patient Registry" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Application navigation" })).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
  });

  it("has no detectable WCAG A or AA violations on the shell", async () => {
    window.history.replaceState({}, "", "/");
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Decision support workspace" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations).toEqual([]);
  });

  it("shows only password replacement while temporary credentials are active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(session("PSYCHIATRIST", "PASSWORD_CHANGE_REQUIRED"))),
    );
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Replace temporary password" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("link", { name: "Patient Registry" })).toBeNull();
  });

  it("gives Administrators complete operational navigation without patient content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/admin/users")) return json({ schemaVersion: "1", users: [] });
        return json(session("ADMINISTRATOR"));
      }),
    );
    window.history.replaceState({}, "", "/administration/users");
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create user" })).toBeTruthy();
    for (const name of [
      "Users",
      "Model Endpoint",
      "Medication and Comorbidity Knowledge",
      "DDI Sources",
      "Adverse-Effect Catalog",
      "BN Manager",
      "Operational Audit",
      "Backup and Restore",
    ]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "Patient Registry" })).toBeNull();
    expect(screen.queryByText("No patient selected")).toBeNull();
  });

  it("guards patient routes with the backend-restored Administrator role", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(session("ADMINISTRATOR"))),
    );
    window.history.replaceState({}, "", "/patients");
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Find a patient" })).toBeNull();
    expect(screen.queryByText("No patient selected")).toBeNull();
  });

  it("shows Psychiatrist registry and selected-case navigation without administration", async () => {
    window.history.replaceState({}, "", "/");
    render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Decision support workspace" });
    for (const name of [
      "Patient Registry",
      "Create Patient",
      "Research Case Workflow",
      "Final Plan History",
      "Clinical Audit History",
    ]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("requires the research-use notice once before Psychiatrist workspace entry", async () => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const first = render(<App />);

    expect(await screen.findByRole("heading", { name: "Research use notice" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge and enter workspace" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Decision support workspace" }),
    ).toBeTruthy();

    first.unmount();
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Decision support workspace" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Research use notice" })).toBeNull();
  });

  it("uses one generic error for every failed sign-in response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/session") && (init?.method ?? "GET") === "GET") {
          return json({ error: { message: "No session" } }, 401);
        }
        return json({ error: { message: "Account admin exists but password is wrong" } }, 401);
      }),
    );
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/^Username/), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in failed. Check your credentials and try again.",
    );
    expect(screen.queryByText(/account admin exists/i)).toBeNull();
  });

  it("replaces uncaught page failures with an accessible recovery state", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenPage />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert", { name: "INSIGHT could not open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    consoleError.mockRestore();
  });
});
