import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XmlCodeView } from "../src/components/XmlCodeView";
import { serializeXmlBif } from "../src/domain/serializer";
import { useDocumentStore } from "../src/store/documentStore";
import { rainRootFile } from "./fixtures/domainFixtures";

const editorDispatch = vi.hoisted(() => vi.fn());
const editorFocus = vi.hoisted(() => vi.fn());

vi.mock("@uiw/react-codemirror", () => ({
  default: forwardRef<
    unknown,
    { value: string; onChange: (value: string) => void }
  >(function CodeMirrorMock({ value, onChange }, ref) {
    useImperativeHandle(ref, () => ({
      view: {
        state: {
          doc: {
            length: value.length,
            lines: value.split("\n").length,
            line: (number: number) => {
              const lines = value.split("\n");
              const from = lines
                .slice(0, number - 1)
                .reduce((total, line) => total + line.length + 1, 0);
              return { from, to: from + (lines[number - 1]?.length ?? 0) };
            },
          },
        },
        dispatch: editorDispatch,
        focus: editorFocus,
      },
    }));
    return (
      <textarea
        aria-label="CodeMirror"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));

vi.mock("@codemirror/lint", () => ({
  lintGutter: () => [],
  setDiagnostics: () => ({}),
}));

function TabHarness(): JSX.Element {
  const [code, setCode] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setCode(false)}>
        Graph
      </button>
      <button type="button" onClick={() => setCode(true)}>
        XML Code
      </button>
      {code ? <XmlCodeView /> : <div>Graph view</div>}
    </>
  );
}

describe("XmlCodeView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDocumentStore.getState().resetDocument();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders current XML and retains an invalid draft across tabs", () => {
    render(<TabHarness />);
    const editor = screen.getByLabelText("CodeMirror");
    expect(editor).toHaveValue(useDocumentStore.getState().sourceText);

    fireEvent.change(editor, { target: { value: "<BIF>\n<x></BIF>" } });
    expect(
      screen.getByText("Graph not synchronized with XML code"),
    ).toBeVisible();
    expect(useDocumentStore.getState().model).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    fireEvent.click(screen.getByRole("button", { name: "XML Code" }));
    expect(screen.getByLabelText("CodeMirror")).toHaveValue("<BIF>\n<x></BIF>");
  });

  it("shows a located syntax diagnostic after the debounce", () => {
    render(<XmlCodeView />);
    fireEvent.change(screen.getByLabelText("CodeMirror"), {
      target: { value: "<BIF>\n<x></BIF>" },
    });

    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText(/error: 2:9: unexpected close tag/)).toBeVisible();
    const diagnostic = screen.getByRole("button", {
      name: /line 2, column 9/,
    });
    fireEvent.click(diagnostic);
    expect(editorDispatch).toHaveBeenLastCalledWith({
      selection: { anchor: 14 },
      scrollIntoView: true,
    });
    expect(editorFocus).toHaveBeenCalled();
    expect(screen.getByLabelText("CodeMirror")).toHaveValue("<BIF>\n<x></BIF>");
  });

  it("updates semantic diagnostics for valid XML after the debounce", () => {
    const source = serializeXmlBif(rainRootFile).replace(
      "<TABLE>0.2 0.8</TABLE>",
      "<TABLE>0.2 0.7</TABLE>",
    );
    render(<XmlCodeView />);
    fireEvent.change(screen.getByLabelText("CodeMirror"), {
      target: { value: source },
    });

    act(() => vi.advanceTimersByTime(300));

    expect(
      screen.getByText(/CPT distribution for Rain sums to 0.8999999999999999/),
    ).toBeVisible();
    expect(
      useDocumentStore.getState().model?.networks[0].definitions[0].table,
    ).toEqual([0.2, 0.7]);
    expect(useDocumentStore.getState().sync).toBe("synced");
  });
});
