import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BayesEngineApi } from "../src/preload/api";
import {
  closeDocumentWindow,
  createCommandController,
  newDocument,
  openDocument,
  saveDocument,
} from "../src/renderer/commands";
import { useDocumentStore } from "../src/store/documentStore";
import { serializeXmlBif } from "../src/domain/serializer";
import { rainRootFile } from "./fixtures/domainFixtures";

function mockApi(overrides: Partial<BayesEngineApi> = {}): BayesEngineApi {
  return {
    openXmlBifFile: vi.fn().mockResolvedValue({ canceled: true }),
    saveXmlBifFile: vi.fn().mockResolvedValue({ canceled: true }),
    confirmDiscardChanges: vi.fn().mockResolvedValue("cancel"),
    onCommand: vi.fn().mockReturnValue(() => undefined),
    onCloseRequested: vi.fn().mockReturnValue(() => undefined),
    closeWindow: vi.fn(),
    ...overrides,
  };
}

describe("document commands", () => {
  beforeEach(() => useDocumentStore.getState().resetDocument());

  it("keeps a dirty document when New is canceled", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("cancel"),
    });
    const before = useDocumentStore.getState().sourceText;

    await expect(newDocument(api)).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(useDocumentStore.getState().sourceText).toBe(before);
  });

  it("saves a dirty document before New", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("save"),
      saveXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        path: "/tmp/saved.xml",
      }),
    });

    await expect(newDocument(api)).resolves.toEqual({ ok: true });
    expect(useDocumentStore.getState()).toMatchObject({
      path: undefined,
      dirty: false,
    });
  });

  it("keeps the window open when close confirmation is canceled", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("cancel"),
    });

    await expect(closeDocumentWindow(api)).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(api.closeWindow).not.toHaveBeenCalled();
  });

  it("does not close when saving is canceled", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("save"),
    });

    await expect(closeDocumentWindow(api)).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(api.closeWindow).not.toHaveBeenCalled();
  });

  it("closes after dirty changes are explicitly discarded", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("discard"),
    });

    await closeDocumentWindow(api);
    expect(api.closeWindow).toHaveBeenCalledOnce();
  });

  it("closes after successfully saving dirty changes", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      confirmDiscardChanges: vi.fn().mockResolvedValue("save"),
      saveXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        path: "/tmp/saved.xml",
      }),
    });

    await closeDocumentWindow(api);
    expect(api.closeWindow).toHaveBeenCalledOnce();
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it("prompts before Open and proceeds after discard", async () => {
    useDocumentStore.setState({ dirty: true });
    const text = serializeXmlBif(rainRootFile);
    const confirmDiscardChanges = vi.fn().mockResolvedValue("discard");
    const api = mockApi({
      confirmDiscardChanges,
      openXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        path: "/tmp/rain.xml",
        text,
      }),
    });

    await expect(openDocument(api)).resolves.toEqual({ ok: true });
    expect(confirmDiscardChanges).toHaveBeenCalledOnce();
    expect(useDocumentStore.getState().sourceText).toBe(text);
  });

  it("routes a shortcut once and ignores Delete in text input", async () => {
    const deleteSelected = vi.fn();
    const controller = createCommandController(mockApi(), {
      deleteSelected,
      setMode: vi.fn(),
      fitGraph: vi.fn(),
      setTab: vi.fn(),
    });
    const input = document.createElement("input");
    const typingDelete = new KeyboardEvent("keydown", { key: "Delete" });
    Object.defineProperty(typingDelete, "target", { value: input });
    controller.handleKeyDown(typingDelete);
    expect(deleteSelected).not.toHaveBeenCalled();

    const graphDelete = new KeyboardEvent("keydown", { key: "Delete" });
    controller.handleKeyDown(graphDelete);
    expect(deleteSelected).toHaveBeenCalledOnce();

    const undo = vi.spyOn(useDocumentStore.getState(), "undo");
    controller.handleKeyDown(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true }),
    );
    expect(undo).toHaveBeenCalledOnce();
    undo.mockRestore();
  });

  it("leaves document unchanged when open is canceled", async () => {
    const before = useDocumentStore.getState();

    await expect(openDocument(mockApi())).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(useDocumentStore.getState().model).toBe(before.model);
  });

  it("loads valid opened XMLBIF", async () => {
    const text = serializeXmlBif(rainRootFile);
    const api = mockApi({
      openXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        path: "/tmp/rain.xml",
        text,
      }),
    });

    await expect(openDocument(api)).resolves.toEqual({ ok: true });
    expect(useDocumentStore.getState()).toMatchObject({
      sourceText: text,
      path: "/tmp/rain.xml",
      dirty: false,
    });
  });

  it("keeps current document when opened XMLBIF is invalid", async () => {
    const before = useDocumentStore.getState();
    const api = mockApi({
      openXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        path: "/tmp/broken.xml",
        text: "<broken>",
      }),
    });

    const result = await openDocument(api);
    expect(result.ok).toBe(false);
    expect(useDocumentStore.getState().sourceText).toBe(before.sourceText);
    expect(useDocumentStore.getState().model).toBe(before.model);
  });

  it("saves exact source to existing path and clears dirty state", async () => {
    const text = serializeXmlBif(rainRootFile);
    useDocumentStore.getState().loadSource(text, "/tmp/rain.xml");
    useDocumentStore.setState({ dirty: true });
    const saveXmlBifFile = vi.fn().mockResolvedValue({
      canceled: false,
      path: "/tmp/rain.xml",
    });

    await expect(saveDocument(mockApi({ saveXmlBifFile }))).resolves.toEqual({
      ok: true,
    });
    expect(saveXmlBifFile).toHaveBeenCalledWith({
      path: "/tmp/rain.xml",
      text,
      saveAs: false,
    });
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it("saves exact invalid code instead of serializing the stale model", async () => {
    const invalidText = "<BIF><unfinished>";
    useDocumentStore.getState().setCodeDraft(invalidText);
    const saveXmlBifFile = vi.fn().mockResolvedValue({
      canceled: false,
      path: "/tmp/draft.xml",
    });

    await saveDocument(mockApi({ saveXmlBifFile }));

    expect(saveXmlBifFile).toHaveBeenCalledWith({
      path: undefined,
      text: invalidText,
      saveAs: false,
    });
  });

  it("requests a dialog when saving without a path", async () => {
    const saveXmlBifFile = vi.fn().mockResolvedValue({
      canceled: false,
      path: "/tmp/new.xmlbif",
    });

    await saveDocument(mockApi({ saveXmlBifFile }));

    expect(saveXmlBifFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: undefined, saveAs: false }),
    );
    expect(useDocumentStore.getState().path).toBe("/tmp/new.xmlbif");
  });

  it("forces a dialog for Save As even with an existing path", async () => {
    useDocumentStore.setState({ path: "/tmp/old.xml" });
    const saveXmlBifFile = vi.fn().mockResolvedValue({
      canceled: false,
      path: "/tmp/new.xml",
    });

    await saveDocument(mockApi({ saveXmlBifFile }), true);

    expect(saveXmlBifFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: undefined, saveAs: true }),
    );
  });

  it("preserves dirty state when save is canceled", async () => {
    useDocumentStore.setState({ dirty: true });

    await expect(saveDocument(mockApi())).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it("returns typed I/O failures without marking saved", async () => {
    useDocumentStore.setState({ dirty: true });
    const api = mockApi({
      saveXmlBifFile: vi.fn().mockResolvedValue({
        canceled: false,
        error: "Disk is full",
      }),
    });

    await expect(saveDocument(api)).resolves.toEqual({
      ok: false,
      message: "Disk is full",
    });
    expect(useDocumentStore.getState().dirty).toBe(true);
  });
});
