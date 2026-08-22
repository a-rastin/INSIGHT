import {
  lintGutter,
  setDiagnostics as setEditorDiagnostics,
} from "@codemirror/lint";
import { xml } from "@codemirror/lang-xml";
import CodeMirror, {
  type ReactCodeMirrorRef,
  type EditorView,
} from "@uiw/react-codemirror";
import { useEffect, useRef } from "react";
import type { Diagnostic } from "../domain/diagnostics";
import { useDocumentStore } from "../store/documentStore";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

const EDITOR_EXTENSIONS = [xml(), lintGutter()];
const DIAGNOSTIC_DELAY_MS = 300;

function positionFor(
  view: EditorView,
  lineNumber: number,
  columnNumber: number,
): number | null {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return null;
  const line = view.state.doc.line(lineNumber);
  return Math.min(line.from + Math.max(columnNumber - 1, 0), line.to);
}

function updateEditorMarkers(
  view: EditorView,
  diagnostics: readonly Diagnostic[],
): void {
  const markers = diagnostics.flatMap((diagnostic) => {
    if (diagnostic.line === undefined || diagnostic.column === undefined) {
      return [];
    }
    const from = positionFor(view, diagnostic.line, diagnostic.column);
    if (from === null) return [];
    return [
      {
        from,
        to: Math.min(from + 1, view.state.doc.length),
        severity: diagnostic.severity,
        message: diagnostic.message,
      },
    ];
  });
  view.dispatch(setEditorDiagnostics(view.state, markers));
}

export function XmlCodeView(): JSX.Element {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const sourceText = useDocumentStore(({ sourceText }) => sourceText);
  const diagnostics = useDocumentStore(({ diagnostics }) => diagnostics);
  const sync = useDocumentStore(({ sync }) => sync);
  const setCodeDraft = useDocumentStore(({ setCodeDraft }) => setCodeDraft);
  const codeEditVersion = useDocumentStore(
    ({ codeEditVersion }) => codeEditVersion,
  );
  const synchronizeCodeDraft = useDocumentStore(
    ({ synchronizeCodeDraft }) => synchronizeCodeDraft,
  );

  useEffect(() => {
    if (sync !== "code-invalid") return;
    const timer = window.setTimeout(
      () => synchronizeCodeDraft(codeEditVersion),
      DIAGNOSTIC_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [codeEditVersion, sourceText, sync, synchronizeCodeDraft]);

  useEffect(() => {
    if (editor.current?.view) {
      updateEditorMarkers(editor.current.view, diagnostics);
    }
  }, [diagnostics]);

  const focusLocation = (line: number, column: number) => {
    const view = editor.current?.view;
    if (!view) return;
    const position = positionFor(view, line, column);
    if (position === null) return;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    view.focus();
  };

  return (
    <div className="xml-code-workspace">
      <div className="code-status">
        {sync === "code-invalid"
          ? "Graph not synchronized with XML code"
          : "Synchronized"}
      </div>
      <div className="xml-editor" aria-label="XML Code editor">
        <CodeMirror
          ref={editor}
          value={sourceText}
          height="100%"
          extensions={EDITOR_EXTENSIONS}
          onChange={setCodeDraft}
          basicSetup={{ foldGutter: true, lineNumbers: true }}
        />
      </div>
      <DiagnosticsPanel
        diagnostics={diagnostics}
        onSelectLocation={focusLocation}
      />
    </div>
  );
}
