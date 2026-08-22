import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("Usage: node scripts/run-local-only.mjs <command> [...args]");
}

const guard = new URL("../test/support/local-network-guard.mjs", import.meta.url).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${guard}`].filter(Boolean).join(" ");
const result = spawnSync(command, args, {
  env: {
    ...process.env,
    INSIGHT_TEST_NETWORK: "local-only",
    NODE_OPTIONS: nodeOptions,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
