import type { BayesEngineApi, EditorCommand } from "../preload/api";
import { useDocumentStore } from "../store/documentStore";

export type CommandResult =
  | { ok: true; canceled?: boolean }
  | { ok: false; message: string };

async function saveBeforeDestructiveAction(
  api: BayesEngineApi,
): Promise<CommandResult> {
  if (!useDocumentStore.getState().dirty) return { ok: true };

  const choice = await api.confirmDiscardChanges();
  if (choice === "cancel") return { ok: true, canceled: true };
  if (choice === "discard") return { ok: true };
  return saveDocument(api);
}

export async function newDocument(api: BayesEngineApi): Promise<CommandResult> {
  const confirmed = await saveBeforeDestructiveAction(api);
  if (!confirmed.ok || confirmed.canceled) return confirmed;
  useDocumentStore.getState().newDocument();
  return { ok: true };
}

export async function openDocument(
  api: BayesEngineApi,
): Promise<CommandResult> {
  const confirmed = await saveBeforeDestructiveAction(api);
  if (!confirmed.ok || confirmed.canceled) return confirmed;

  try {
    const opened = await api.openXmlBifFile();
    if (opened.canceled) return { ok: true, canceled: true };
    if ("error" in opened) return { ok: false, message: opened.error };

    const loaded = useDocumentStore
      .getState()
      .loadSource(opened.text, opened.path);
    if (loaded.ok) return { ok: true };
    return {
      ok: false,
      message: loaded.diagnostics.map(({ message }) => message).join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to open file",
    };
  }
}

export async function saveDocument(
  api: BayesEngineApi,
  saveAs = false,
): Promise<CommandResult> {
  const { path, sourceText } = useDocumentStore.getState();
  try {
    const saved = await api.saveXmlBifFile({
      path: saveAs ? undefined : path,
      text: sourceText,
      saveAs,
    });
    if (saved.canceled) return { ok: true, canceled: true };
    if ("error" in saved) return { ok: false, message: saved.error };

    useDocumentStore.getState().markSaved(saved.path);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save file",
    };
  }
}

export async function closeDocumentWindow(
  api: BayesEngineApi,
): Promise<CommandResult> {
  const confirmed = await saveBeforeDestructiveAction(api);
  if (!confirmed.ok || confirmed.canceled) return confirmed;
  api.closeWindow();
  return { ok: true };
}

export interface EditorCommandActions {
  deleteSelected(): void;
  setMode(mode: "select" | "add-node" | "add-arc"): void;
  fitGraph(): void;
  setTab(tab: "graph" | "code"): void;
}

export interface CommandController {
  execute(command: EditorCommand): Promise<CommandResult>;
  handleKeyDown(event: KeyboardEvent): void;
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest(".cm-editor") !== null))
  );
}

export function createCommandController(
  api: BayesEngineApi,
  actions: EditorCommandActions,
): CommandController {
  const execute = async (command: EditorCommand): Promise<CommandResult> => {
    switch (command) {
      case "new":
        return newDocument(api);
      case "open":
        return openDocument(api);
      case "save":
        return saveDocument(api);
      case "save-as":
        return saveDocument(api, true);
      case "undo":
        useDocumentStore.getState().undo();
        return { ok: true };
      case "redo":
        useDocumentStore.getState().redo();
        return { ok: true };
      case "delete":
        actions.deleteSelected();
        return { ok: true };
      case "select-mode":
        actions.setMode("select");
        return { ok: true };
      case "add-node-mode":
        actions.setMode("add-node");
        return { ok: true };
      case "add-arc-mode":
        actions.setMode("add-arc");
        return { ok: true };
      case "fit":
        actions.fitGraph();
        return { ok: true };
      case "graph-tab":
        actions.setTab("graph");
        return { ok: true };
      case "code-tab":
        actions.setTab("code");
        return { ok: true };
    }
  };

  return {
    execute,
    handleKeyDown(event) {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let command: EditorCommand | undefined;

      if (modifier && key === "n") command = "new";
      else if (modifier && key === "o") command = "open";
      else if (modifier && key === "s")
        command = event.shiftKey ? "save-as" : "save";
      else if (modifier && key === "z" && !isTextEditingTarget(event.target))
        command = event.shiftKey ? "redo" : "undo";
      else if (modifier && key === "y" && !isTextEditingTarget(event.target))
        command = "redo";
      else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !isTextEditingTarget(event.target)
      )
        command = "delete";
      else if (event.key === "F12") command = "fit";

      if (!command) return;
      event.preventDefault();
      void execute(command);
    },
  };
}
