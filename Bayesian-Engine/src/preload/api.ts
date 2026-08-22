import { ipcRenderer } from "electron";

export type OpenFileResult =
  | { canceled: true }
  | { canceled: false; path: string; text: string }
  | { canceled: false; error: string };

export type SaveFileResult =
  | { canceled: true }
  | { canceled: false; path: string }
  | { canceled: false; error: string };

export interface SaveFileArgs {
  path?: string;
  text: string;
  saveAs?: boolean;
}

export type EditorCommand =
  | "new"
  | "open"
  | "save"
  | "save-as"
  | "undo"
  | "redo"
  | "delete"
  | "select-mode"
  | "add-node-mode"
  | "add-arc-mode"
  | "fit"
  | "graph-tab"
  | "code-tab";

export interface BayesEngineApi {
  openXmlBifFile(): Promise<OpenFileResult>;
  saveXmlBifFile(args: SaveFileArgs): Promise<SaveFileResult>;
  confirmDiscardChanges(): Promise<"save" | "discard" | "cancel">;
  onCommand(listener: (command: EditorCommand) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  closeWindow(): void;
}

export const bayesEngineApi: BayesEngineApi = Object.freeze({
  openXmlBifFile: () =>
    ipcRenderer.invoke("document:open") as Promise<OpenFileResult>,
  saveXmlBifFile: (args: SaveFileArgs) =>
    ipcRenderer.invoke("document:save", args) as Promise<SaveFileResult>,
  confirmDiscardChanges: () =>
    ipcRenderer.invoke("document:confirm-discard") as Promise<
      "save" | "discard" | "cancel"
    >,
  onCommand: (listener: (command: EditorCommand) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: EditorCommand,
    ) => listener(command);
    ipcRenderer.on("editor:command", handler);
    return () => ipcRenderer.removeListener("editor:command", handler);
  },
  onCloseRequested: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("window:close-requested", handler);
    return () => ipcRenderer.removeListener("window:close-requested", handler);
  },
  closeWindow: () => ipcRenderer.send("window:close-approved"),
});
