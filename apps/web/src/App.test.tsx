import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App, ErrorBoundary } from "./App";

function BrokenPage(): never {
  throw new Error("test failure");
}

describe("application shell", () => {
  it("routes without losing semantic shell landmarks", () => {
    window.history.replaceState({}, "", "/");
    render(<App />);

    fireEvent.click(screen.getByRole("link", { name: "Patients" }));

    expect(window.location.pathname).toBe("/patients");
    expect(screen.getByRole("heading", { level: 1, name: "Patients" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Application navigation" })).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
  });

  it("has no detectable WCAG A or AA violations on the shell", async () => {
    window.history.replaceState({}, "", "/");
    const { container } = render(<App />);
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations).toEqual([]);
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
