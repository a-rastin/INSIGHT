import { create } from "zustand";
import type { Diagnostic } from "../domain/diagnostics";
import type { XmlFidelityRisk } from "../domain/fidelity";
import { detectXmlFidelityRisks } from "../domain/fidelity";
import type { MutationResult } from "../domain/mutations";
import type { NetworkEdge, XmlBifFile, XmlBifNetwork } from "../domain/model";
import { parseXmlBif } from "../domain/parser";
import { serializeXmlBif } from "../domain/serializer";
import { hasBlockingStructuralErrors, validateFile } from "../domain/validator";

export type SyncState = "synced" | "code-invalid" | "dirty-domain";

interface HistoryEntry {
  sourceText: string;
  model: XmlBifFile;
  activeNetworkIndex: number;
  selectedNode?: string;
  selectedEdge?: NetworkEdge;
  fidelityRisks: XmlFidelityRisk[];
  canonicalizationAcknowledged: boolean;
}

export interface DocumentState {
  sourceText: string;
  savedSourceText: string;
  model: XmlBifFile | null;
  diagnostics: Diagnostic[];
  sync: SyncState;
  path?: string;
  dirty: boolean;
  activeNetworkIndex: number;
  selectedNode?: string;
  selectedEdge?: NetworkEdge;
  codeEditVersion: number;
  historyPast: HistoryEntry[];
  historyFuture: HistoryEntry[];
  fidelityRisks: XmlFidelityRisk[];
  canonicalizationAcknowledged: boolean;
}

export type DomainMutator = (
  network: XmlBifNetwork,
) => MutationResult<XmlBifNetwork>;

export type DocumentActionResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };

export interface DocumentStore extends DocumentState {
  newDocument: () => void;
  loadSource: (sourceText: string, path?: string) => DocumentActionResult;
  applyDomainMutation: (mutator: DomainMutator) => DocumentActionResult;
  addNetwork: () => DocumentActionResult;
  deleteActiveNetwork: () => DocumentActionResult;
  setCodeDraft: (sourceText: string) => number;
  synchronizeCodeDraft: (version: number) => void;
  setActiveNetworkIndex: (index: number) => DocumentActionResult;
  setSelectedNode: (name?: string) => void;
  setSelectedEdge: (edge?: NetworkEdge) => void;
  markSaved: (path?: string) => void;
  undo: () => boolean;
  redo: () => boolean;
  acknowledgeCanonicalization: () => void;
  resetDocument: () => void;
}

const defaultFile = (): XmlBifFile => ({
  version: "0.3",
  networks: [
    {
      name: "NewNetwork",
      properties: [],
      variables: [],
      definitions: [],
    },
  ],
});

const HISTORY_LIMIT = 50;

function initialState(): DocumentState {
  const model = defaultFile();
  const sourceText = serializeXmlBif(model);
  return {
    sourceText,
    savedSourceText: sourceText,
    model,
    diagnostics: validateFile(model),
    sync: "synced",
    path: undefined,
    dirty: false,
    activeNetworkIndex: 0,
    selectedNode: undefined,
    selectedEdge: undefined,
    codeEditVersion: 0,
    historyPast: [],
    historyFuture: [],
    fidelityRisks: [],
    canonicalizationAcknowledged: false,
  };
}

function snapshot(state: DocumentState): HistoryEntry | null {
  return state.model
    ? {
        sourceText: state.sourceText,
        model: state.model,
        activeNetworkIndex: state.activeNetworkIndex,
        selectedNode: state.selectedNode,
        selectedEdge: state.selectedEdge,
        fidelityRisks: state.fidelityRisks,
        canonicalizationAcknowledged: state.canonicalizationAcknowledged,
      }
    : null;
}

function withHistory(
  state: DocumentState,
): Pick<DocumentState, "historyPast" | "historyFuture"> {
  const entry = snapshot(state);
  return {
    historyPast: entry
      ? [...state.historyPast, entry].slice(-HISTORY_LIMIT)
      : state.historyPast,
    historyFuture: [],
  };
}

function storeDiagnostic(code: string, message: string): Diagnostic {
  return {
    code,
    severity: "error",
    category: "structure",
    message,
  };
}

function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fidelityGuard(state: DocumentState): DocumentActionResult | null {
  return state.fidelityRisks.length > 0 && !state.canonicalizationAcknowledged
    ? {
        ok: false,
        diagnostics: [
          {
            code: "CANONICALIZATION_CONFIRMATION_REQUIRED",
            severity: "warning",
            category: "compatibility",
            message:
              "Graphical editing will rewrite XML in Bayes Engine's canonical XMLBIF format and may remove comments/unknown XML formatting.",
          },
        ],
      }
    : null;
}

function nextNetworkName(networks: readonly XmlBifNetwork[]): string {
  const names = new Set(networks.map(({ name }) => name));
  for (let index = 1; ; index += 1) {
    const name = `Network${index}`;
    if (!names.has(name)) return name;
  }
}

export const useDocumentStore = create<DocumentStore>()((set, get) => ({
  ...initialState(),

  newDocument: () => set(initialState()),

  loadSource: (sourceText, path) => {
    const parsed = parseXmlBif(sourceText);
    if (!parsed.ok) return parsed;

    const diagnostics = uniqueDiagnostics([
      ...parsed.warnings,
      ...validateFile(parsed.file),
    ]);
    if (hasBlockingStructuralErrors(diagnostics)) {
      return { ok: false, diagnostics };
    }

    set({
      sourceText,
      savedSourceText: sourceText,
      model: parsed.file,
      diagnostics,
      sync: "synced",
      path,
      dirty: false,
      activeNetworkIndex: 0,
      selectedNode: undefined,
      selectedEdge: undefined,
      codeEditVersion: get().codeEditVersion + 1,
      historyPast: [],
      historyFuture: [],
      fidelityRisks: detectXmlFidelityRisks(sourceText),
      canonicalizationAcknowledged: false,
    });
    return { ok: true };
  },

  applyDomainMutation: (mutator) => {
    const { model, activeNetworkIndex, sync } = get();
    if (sync === "code-invalid") {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "CODE_NOT_SYNCHRONIZED",
            "Fix XML code or discard code changes first",
          ),
        ],
      };
    }

    const fidelityFailure = fidelityGuard(get());
    if (fidelityFailure) return fidelityFailure;

    const network = model?.networks[activeNetworkIndex];
    if (!model || !network) {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "NO_ACTIVE_NETWORK",
            "Document has no active network to edit",
          ),
        ],
      };
    }

    const mutation = mutator(network);
    if (!mutation.ok) return mutation;

    const nextModel: XmlBifFile = {
      ...model,
      networks: model.networks.map((current, index) =>
        index === activeNetworkIndex ? mutation.value : current,
      ),
    };
    const validation = validateFile(nextModel);
    const errors = validation.filter(({ severity }) => severity === "error");
    if (errors.length > 0) return { ok: false, diagnostics: errors };

    let sourceText: string;
    try {
      sourceText = serializeXmlBif(nextModel);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "SERIALIZATION_FAILED",
            error instanceof Error ? error.message : "XML serialization failed",
          ),
        ],
      };
    }

    const state = get();
    set({
      ...withHistory(state),
      model: nextModel,
      sourceText,
      diagnostics: uniqueDiagnostics([...validation, ...mutation.warnings]),
      sync: "synced",
      dirty: sourceText !== state.savedSourceText,
      fidelityRisks: [],
      canonicalizationAcknowledged: false,
    });
    return { ok: true };
  },

  addNetwork: () => {
    const { model, sync } = get();
    if (sync === "code-invalid") {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "CODE_NOT_SYNCHRONIZED",
            "Fix XML code or discard code changes first",
          ),
        ],
      };
    }
    const fidelityFailure = fidelityGuard(get());
    if (fidelityFailure) return fidelityFailure;

    if (!model) {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic("NO_DOCUMENT_MODEL", "Document has no model to edit"),
        ],
      };
    }

    const network: XmlBifNetwork = {
      name: nextNetworkName(model.networks),
      properties: [],
      variables: [],
      definitions: [],
    };
    const nextModel = { ...model, networks: [...model.networks, network] };
    const diagnostics = validateFile(nextModel);
    const sourceText = serializeXmlBif(nextModel);
    const state = get();
    set({
      ...withHistory(state),
      model: nextModel,
      sourceText,
      diagnostics,
      sync: "synced",
      dirty: sourceText !== state.savedSourceText,
      activeNetworkIndex: nextModel.networks.length - 1,
      fidelityRisks: [],
      canonicalizationAcknowledged: false,
    });
    return { ok: true };
  },

  deleteActiveNetwork: () => {
    const { model, activeNetworkIndex, sync } = get();
    if (sync === "code-invalid") {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "CODE_NOT_SYNCHRONIZED",
            "Fix XML code or discard code changes first",
          ),
        ],
      };
    }
    const fidelityFailure = fidelityGuard(get());
    if (fidelityFailure) return fidelityFailure;

    if (!model || model.networks.length <= 1) {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "LAST_NETWORK_REQUIRED",
            "Bayes Engine documents must keep at least one network",
          ),
        ],
      };
    }

    const nextModel = {
      ...model,
      networks: model.networks.filter(
        (_, index) => index !== activeNetworkIndex,
      ),
    };
    const diagnostics = validateFile(nextModel);
    const sourceText = serializeXmlBif(nextModel);
    const state = get();
    set({
      ...withHistory(state),
      model: nextModel,
      sourceText,
      diagnostics,
      sync: "synced",
      dirty: sourceText !== state.savedSourceText,
      activeNetworkIndex: Math.min(
        activeNetworkIndex,
        nextModel.networks.length - 1,
      ),
      fidelityRisks: [],
      canonicalizationAcknowledged: false,
    });
    return { ok: true };
  },

  setCodeDraft: (sourceText) => {
    const version = get().codeEditVersion + 1;
    set((state) => ({
      sourceText,
      sync: "code-invalid",
      dirty: sourceText !== state.savedSourceText,
      codeEditVersion: version,
      canonicalizationAcknowledged: false,
    }));
    return version;
  },

  synchronizeCodeDraft: (version) => {
    const state = get();
    if (version !== state.codeEditVersion || state.sync !== "code-invalid")
      return;

    const parsed = parseXmlBif(state.sourceText);
    if (!parsed.ok) {
      set({ diagnostics: uniqueDiagnostics(parsed.diagnostics) });
      return;
    }

    const diagnostics = uniqueDiagnostics([
      ...parsed.warnings,
      ...validateFile(parsed.file),
    ]);
    if (hasBlockingStructuralErrors(diagnostics)) {
      set({ diagnostics });
      return;
    }

    set({
      model: parsed.file,
      diagnostics,
      sync: "synced",
      activeNetworkIndex: Math.min(
        state.activeNetworkIndex,
        Math.max(0, parsed.file.networks.length - 1),
      ),
      historyPast: [],
      historyFuture: [],
      fidelityRisks: detectXmlFidelityRisks(state.sourceText),
      canonicalizationAcknowledged: false,
    });
  },

  setActiveNetworkIndex: (index) => {
    const networkCount = get().model?.networks.length ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= networkCount) {
      return {
        ok: false,
        diagnostics: [
          storeDiagnostic(
            "ACTIVE_NETWORK_OUT_OF_BOUNDS",
            `Active network index is out of bounds: ${index}`,
          ),
        ],
      };
    }

    set({
      activeNetworkIndex: index,
      selectedNode: undefined,
      selectedEdge: undefined,
    });
    return { ok: true };
  },

  setSelectedNode: (selectedNode) =>
    set((state) =>
      state.selectedNode === selectedNode ? state : { selectedNode },
    ),
  setSelectedEdge: (selectedEdge) =>
    set((state) =>
      state.selectedEdge?.source === selectedEdge?.source &&
      state.selectedEdge?.target === selectedEdge?.target
        ? state
        : { selectedEdge },
    ),

  markSaved: (path) =>
    set((state) => ({
      path: path ?? state.path,
      savedSourceText: state.sourceText,
      dirty: false,
    })),

  undo: () => {
    const state = get();
    const previous = state.historyPast.at(-1);
    const current = snapshot(state);
    if (!previous || !current || state.sync === "code-invalid") return false;
    set({
      ...previous,
      diagnostics: validateFile(previous.model),
      sync: "synced",
      dirty: previous.sourceText !== state.savedSourceText,
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [current, ...state.historyFuture].slice(0, HISTORY_LIMIT),
    });
    return true;
  },

  redo: () => {
    const state = get();
    const next = state.historyFuture[0];
    const current = snapshot(state);
    if (!next || !current || state.sync === "code-invalid") return false;
    set({
      ...next,
      diagnostics: validateFile(next.model),
      sync: "synced",
      dirty: next.sourceText !== state.savedSourceText,
      historyPast: [...state.historyPast, current].slice(-HISTORY_LIMIT),
      historyFuture: state.historyFuture.slice(1),
    });
    return true;
  },

  acknowledgeCanonicalization: () =>
    set({ canonicalizationAcknowledged: true }),

  resetDocument: () => set(initialState()),
}));
