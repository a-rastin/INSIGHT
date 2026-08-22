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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(session())),
  );
});

describe("application shell", () => {
  it("routes without losing semantic shell landmarks", async () => {
    window.history.replaceState({}, "", "/");
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Patients" }));

    expect(window.location.pathname).toBe("/patients");
    expect(screen.getByRole("heading", { level: 1, name: "Patients" })).toBeTruthy();
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
    expect(screen.queryByRole("link", { name: "Patients" })).toBeNull();
  });

  it("gives Administrators user management without clinical navigation", async () => {
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

    expect(await screen.findByRole("heading", { level: 1, name: "User management" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create user" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Patients" })).toBeNull();
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
