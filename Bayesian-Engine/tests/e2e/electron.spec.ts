import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const fixturePath = (name: string) => resolve("tests/fixtures/xml", name);

interface DialogScript {
  openPaths?: string[];
  savePaths?: string[];
  confirmResponses?: number[];
}

async function scriptDialogs(
  app: ElectronApplication,
  script: DialogScript,
): Promise<void> {
  await app.evaluate(({ dialog }, value) => {
    const openPaths = [...(value.openPaths ?? [])];
    const savePaths = [...(value.savePaths ?? [])];
    const confirmResponses = [...(value.confirmResponses ?? [])];
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => {
        const path = openPaths.shift();
        return path
          ? { canceled: false, filePaths: [path] }
          : { canceled: true, filePaths: [] };
      },
    });
    Object.defineProperty(dialog, "showSaveDialog", {
      configurable: true,
      value: async () => {
        const filePath = savePaths.shift();
        return filePath ? { canceled: false, filePath } : { canceled: true };
      },
    });
    Object.defineProperty(dialog, "showMessageBox", {
      configurable: true,
      value: async () => ({ response: confirmResponses.shift() ?? 2 }),
    });
  }, script);
}

async function launch(script: DialogScript = {}): Promise<{
  app: ElectronApplication;
  window: Page;
}> {
  const app = await electron.launch({ args: ["out/main/main.js"] });
  await scriptDialogs(app, script);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle("Bayes Engine");
  return { app, window };
}

async function stop(app: ElectronApplication): Promise<void> {
  if (!app.process().killed) app.process().kill("SIGKILL");
}

async function openFixture(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Open" }).click();
  await expect(window.locator(".react-flow__node").first()).toBeVisible();
}

async function replaceCode(window: Page, source: string): Promise<void> {
  const editor = window.locator(".cm-content");
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await editor.press("Backspace");
  await window.keyboard.insertText(source);
}

test("opens Bayes Engine window", async () => {
  const { app, window } = await launch();
  try {
    await expect(
      window.getByRole("heading", { name: "Bayes Engine" }),
    ).toBeVisible();
  } finally {
    await stop(app);
  }
});

test("open, edit CPT and position, save as, then reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bayes-engine-e2e-"));
  const savedPath = join(directory, "edited.xml");
  const { app, window } = await launch({
    openPaths: [fixturePath("one-parent.xml"), savedPath],
    savePaths: [savedPath],
  });
  try {
    await openFixture(window);
    await expect(
      window.locator('.react-flow__edge[data-id="Rain->WetGrass"]'),
    ).toHaveCount(1);

    const rain = window.locator('.react-flow__node[data-id="Rain"]');
    await rain.click();

    await window.getByLabel("Root P(true)").fill("0.3");
    await window.getByLabel("Root P(false)").fill("0.7");
    await window.getByLabel("Root P(false)").press("Tab");

    const moved = window.locator('.react-flow__node[data-id="Rain"]');
    const box = await moved.boundingBox();
    if (!box) throw new Error("Rain node has no bounding box");
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(
      box.x + box.width / 2 + 45,
      box.y + box.height / 2 + 30,
    );
    await window.mouse.up();

    await window.getByRole("button", { name: "Save As" }).click();
    await expect(window.locator("footer")).toContainText(basename(savedPath));
    await window.getByRole("button", { name: "Open" }).click();
    await expect(
      window.locator('.react-flow__node[data-id="Rain"]'),
    ).toBeVisible();
    await window.locator('.react-flow__node[data-id="Rain"]').click();
    await expect(window.getByLabel("Root P(true)")).toHaveValue("0.3");
    await expect(window.getByLabel("Root P(false)")).toHaveValue("0.7");

    const saved = await readFile(savedPath, "utf8");
    expect(saved).toContain("<NAME>Rain</NAME>");
    expect(saved).toContain("<GIVEN>Rain</GIVEN>");
    expect(saved).toContain("<TABLE>0.3 0.7</TABLE>");
    expect(saved).toMatch(/<PROPERTY>position = \([^<]+\)<\/PROPERTY>/);
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates an influence diagram, edits utility values, saves, and reopens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bayes-engine-e2e-"));
  const savedPath = join(directory, "influence.xml");
  const { app, window } = await launch({
    openPaths: [savedPath],
    savePaths: [savedPath],
  });
  try {
    const pane = window.locator(".react-flow__pane");
    await window.getByLabel("Node type").selectOption("decision");
    await window.getByRole("button", { name: "Add Node" }).click();
    await pane.click({ position: { x: 180, y: 140 } });
    await expect(
      window.locator('.react-flow__node[data-id="Node1"]'),
    ).toBeVisible();

    await window.getByLabel("Node type").selectOption("utility");
    await window.getByRole("button", { name: "Add Node" }).click();
    await pane.click({ position: { x: 40, y: 40 } });
    await expect(
      window.locator('.react-flow__node[data-id="Node2"]'),
    ).toBeVisible();

    await window.getByRole("button", { name: "Add Arc" }).click();
    const source = window.locator(
      '.react-flow__node[data-id="Node1"] .react-flow__handle.source',
    );
    const target = window.locator(
      '.react-flow__node[data-id="Node2"] .react-flow__handle.target',
    );
    await source.click();
    await target.click();
    await expect(
      window.locator('.react-flow__edge[data-id="Node1->Node2"]'),
    ).toHaveCount(1);

    await window.locator('.react-flow__node[data-id="Node2"]').click();
    await expect(
      window.getByRole("heading", { name: "Utility values" }),
    ).toBeVisible();
    await window.getByLabel("State0 Value").fill("-12.5");
    await window.getByLabel("State0 Value").press("Tab");

    await window.getByRole("button", { name: "Save As" }).click();
    await expect(window.locator("footer")).toContainText(basename(savedPath));
    await window.getByRole("button", { name: "Open" }).click();
    await expect(
      window.locator('.react-flow__edge[data-id="Node1->Node2"]'),
    ).toHaveCount(1);
    await window.locator('.react-flow__node[data-id="Node2"]').click();
    await expect(window.getByLabel("State0 Value")).toHaveValue("-12.5");

    const saved = await readFile(savedPath, "utf8");
    expect(saved).toContain('<VARIABLE TYPE="decision">');
    expect(saved).toContain('<VARIABLE TYPE="utility">');
    expect(saved).toContain("<GIVEN>Node1</GIVEN>");
    expect(saved).toContain("<TABLE>-12.5 0</TABLE>");
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid XML keeps last graph, blocks edits, and resynchronizes when fixed", async () => {
  const valid = await readFile(fixturePath("root-node.xml"), "utf8");
  const { app, window } = await launch({
    openPaths: [fixturePath("root-node.xml")],
  });
  try {
    await openFixture(window);
    await window.getByRole("tab", { name: "XML Code" }).click();
    await replaceCode(window, "<BIF><broken></BIF>");
    await expect(
      window.getByText("Graph not synchronized with XML code"),
    ).toBeVisible();

    await window.getByRole("tab", { name: "Graph" }).click();
    await expect(
      window.locator('.react-flow__node[data-id="Rain"]'),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Add Node" }),
    ).toBeDisabled();
    await expect(
      window.getByRole("button", { name: "Delete", exact: true }),
    ).toBeDisabled();

    await window.getByRole("tab", { name: "XML Code" }).click();
    await replaceCode(window, valid.replaceAll("Rain", "Storm"));
    await expect(window.getByText("Synchronized", { exact: true })).toBeVisible(
      { timeout: 5_000 },
    );
    await window.getByRole("tab", { name: "Graph" }).click();
    await expect(
      window.locator('.react-flow__node[data-id="Storm"]'),
    ).toBeVisible();

    await window.getByLabel("Network name").fill("CodeEdited");
    await window.getByLabel("Network name").press("Enter");
    await window.getByRole("tab", { name: "XML Code" }).click();
    await expect(window.locator(".cm-content")).toContainText(
      "<NAME>CodeEdited</NAME>",
    );
  } finally {
    await stop(app);
  }
});

test("unsaved New honors Cancel and Discard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bayes-engine-e2e-"));
  const editablePath = join(directory, "rain.xml");
  await copyFile(fixturePath("root-node.xml"), editablePath);
  const { app, window } = await launch({
    openPaths: [editablePath],
    confirmResponses: [2, 1],
  });
  try {
    await openFixture(window);
    await window.getByLabel("Network name").fill("CanceledEdit");
    await window.getByLabel("Network name").press("Enter");
    await window.getByRole("button", { name: "New" }).click();
    await expect(window.getByLabel("Network name")).toHaveValue("CanceledEdit");

    await window.getByRole("button", { name: "New" }).click();
    await expect(
      window.getByText("No variables in this network"),
    ).toBeVisible();
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsaved New saves before replacing document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bayes-engine-e2e-"));
  const editablePath = join(directory, "rain.xml");
  await copyFile(fixturePath("root-node.xml"), editablePath);
  const { app, window } = await launch({
    openPaths: [editablePath],
    confirmResponses: [0],
  });
  try {
    await openFixture(window);
    await window.getByLabel("Network name").fill("SavedEdit");
    await window.getByLabel("Network name").press("Enter");
    await expect(window.locator("footer")).toContainText("*");
    await window.getByRole("button", { name: "New" }).click();
    await expect(
      window.getByText("No variables in this network"),
    ).toBeVisible();
    await expect
      .poll(async () => readFile(editablePath, "utf8"))
      .toContain("<NAME>SavedEdit</NAME>");
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("switches networks and edits only second network", async () => {
  const { app, window } = await launch({
    openPaths: [fixturePath("multi-network.xml")],
  });
  try {
    await openFixture(window);
    await window.getByLabel("Active network").selectOption("1");
    await expect(
      window.locator('.react-flow__node[data-id="B"]'),
    ).toBeVisible();
    await window.getByLabel("Network name").fill("SecondEdited");
    await window.getByLabel("Network name").press("Enter");
    await window.getByRole("tab", { name: "XML Code" }).click();
    const code = window.locator(".cm-content");
    await expect(code).toContainText("<NAME>First</NAME>");
    await expect(code).toContainText("<NAME>SecondEdited</NAME>");
  } finally {
    await stop(app);
  }
});
