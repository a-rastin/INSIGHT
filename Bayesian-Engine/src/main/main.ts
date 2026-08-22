import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { MAX_XMLBIF_SOURCE_BYTES } from "../domain/inputLimits";
import type {
  EditorCommand,
  SaveFileArgs,
  SaveFileResult,
} from "../preload/api";

const xmlBifFilters = [
  { name: "XMLBIF files", extensions: ["xml", "xmlbif", "bifxml"] },
];
const authorizedPaths = new Map<number, Set<string>>();
const closeApproved = new WeakSet<BrowserWindow>();
let applicationQuitting = false;

function pathsFor(senderId: number): Set<string> {
  const existing = authorizedPaths.get(senderId);
  if (existing) return existing;
  const paths = new Set<string>();
  authorizedPaths.set(senderId, paths);
  return paths;
}

ipcMain.handle("document:open", async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: xmlBifFilters,
  });
  if (result.canceled || result.filePaths.length === 0)
    return { canceled: true };

  const path = result.filePaths[0];
  try {
    if ((await stat(path)).size > MAX_XMLBIF_SOURCE_BYTES) {
      return {
        canceled: false,
        error: `File exceeds the ${MAX_XMLBIF_SOURCE_BYTES / 1024 / 1024} MB safety limit`,
      };
    }
    const text = await readFile(path, "utf8");
    pathsFor(event.sender.id).add(path);
    return { canceled: false, path, text };
  } catch (error) {
    return {
      canceled: false,
      error: error instanceof Error ? error.message : "Unable to read file",
    };
  }
});

ipcMain.handle(
  "document:save",
  async (event, args: SaveFileArgs): Promise<SaveFileResult> => {
    if (!args || typeof args.text !== "string") {
      return { canceled: false, error: "Invalid save request" };
    }

    let path = args.saveAs ? undefined : args.path;
    if (path && !pathsFor(event.sender.id).has(path)) {
      return {
        canceled: false,
        error: "File path was not selected by this window",
      };
    }
    if (!path) {
      const result = await dialog.showSaveDialog({ filters: xmlBifFilters });
      if (result.canceled || !result.filePath) return { canceled: true };
      path = result.filePath;
    }

    try {
      await writeFile(path, args.text, "utf8");
      pathsFor(event.sender.id).add(path);
      return { canceled: false, path };
    } catch (error) {
      return {
        canceled: false,
        error: error instanceof Error ? error.message : "Unable to write file",
      };
    }
  },
);

ipcMain.handle("document:confirm-discard", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) return "cancel";
  const result = await dialog.showMessageBox(owner, {
    type: "warning",
    message: "Save changes before continuing?",
    buttons: ["Save", "Discard", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return (["save", "discard", "cancel"] as const)[result.response] ?? "cancel";
});

ipcMain.on("window:close-approved", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  closeApproved.add(window);
  window.close();
});

function sendCommand(window: BrowserWindow, command: EditorCommand): void {
  window.webContents.send("editor:command", command);
}

function installMenu(window: BrowserWindow): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "New",
          accelerator: "CmdOrCtrl+N",
          click: () => sendCommand(window, "new"),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => sendCommand(window, "open"),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => sendCommand(window, "save"),
        },
        {
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendCommand(window, "save-as"),
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: "CmdOrCtrl+Q",
          click: () => window.close(),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo Visual Edit", click: () => sendCommand(window, "undo") },
        { label: "Redo Visual Edit", click: () => sendCommand(window, "redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        {
          label: "Delete Selected",
          click: () => sendCommand(window, "delete"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Graph", click: () => sendCommand(window, "graph-tab") },
        { label: "XML Code", click: () => sendCommand(window, "code-tab") },
        {
          label: "Fit Graph",
          accelerator: "F12",
          click: () => sendCommand(window, "fit"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  const window = new BrowserWindow({
    title: "Bayes Engine",
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const senderId = window.webContents.id;
  window.webContents.once("destroyed", () => authorizedPaths.delete(senderId));
  window.on("close", (event) => {
    if (applicationQuitting || closeApproved.delete(window)) return;
    event.preventDefault();
    window.webContents.send("window:close-requested");
  });
  installMenu(window);

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  applicationQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
