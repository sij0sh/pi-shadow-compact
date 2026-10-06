import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const exact = /Summarization failed: generation hit the token cap and the summary is incomplete/;

// Minimal pre-recovery factory: disk replacement alone must not change the
// loaded handler. This avoids a dependency on Git history or a user installation.
const legacy = `export default function(pi) {
  pi.registerCommand("compact-native", { handler: (_, ctx) => ctx.compact({}) });
  pi.on("session_before_compact", () => undefined);
}`;

async function fixture(caseName: string) {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-cli-"));
  const agent = join(cwd, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 }, retry: { enabled: false },
  }));
  await writeFile(join(agent, "shadow-compact.json"), JSON.stringify({
    manualCompactMode: "native", idleCompact: { enabled: false },
    ...(caseName === "invalid-config" ? { unsupportedKey: true } : {}),
  }));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: "user", content: "historical task ".repeat(2000), timestamp: i });
    manager.appendMessage(fauxAssistantMessage("completed"));
  }
  const extension = join(cwd, "package/src/index.ts");
  await mkdir(dirname(extension), { recursive: true });
  const old = caseName === "upgrade-reload" || caseName === "stale-runtime";
  if (old) await writeFile(extension, legacy);
  else await cp(join(root, "src"), dirname(extension), { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = key.startsWith("SHADOW_COMPACT_") || key.startsWith("PI_CODING_AGENT_") ? "" : value;
  }
  env.PI_CODING_AGENT_DIR = agent;
  env.SHADOW_COMPACT_TRACE = join(agent, "trace.jsonl");
  const client = new RpcClient({ cliPath: cli, cwd, env, model: "cap-test/model", args: [
    "--offline", "-ne", "-ns", "-np", "-nc", "-e", extension,
    "-e", join(root, "test/helpers/cap-provider.ts"), "--thinking", "high", "--session", manager.getSessionFile()!,
  ] });
  await client.start();
  return {
    client,
    update: () => cp(join(root, "src"), dirname(extension), { recursive: true }),
    async traces(): Promise<Array<Record<string, unknown>>> {
      try { return (await readFile(env.SHADOW_COMPACT_TRACE!, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    async cleanup() { await client.stop(); await rm(cwd, { recursive: true, force: true }); },
  };
}

describe("bundled Pi CLI compaction routing and reload", () => {
  for (const caseName of ["fresh", "reload", "upgrade-reload", "stale-runtime", "pure-native", "invalid-config"]) {
    it(caseName, { timeout: 30000 }, async () => {
      const f = await fixture(caseName);
      const notifications: string[] = [];
      const offUI = f.client.onEvent((event) => {
        const record = event as unknown as Record<string, unknown>;
        if (record.type === "extension_ui_request" && record.method === "notify") notifications.push(String(record.message));
      });
      try {
        assert.ok((await f.client.getCommands()).some((command) => command.name === "compact-native"));
        const before = await f.client.getEntries();
        if (caseName === "upgrade-reload" || caseName === "stale-runtime") await f.update();
        if (caseName === "reload" || caseName === "upgrade-reload") assert.equal(await f.client.prompt("/cap-reload"), "handled");
        const succeeds = ["fresh", "reload", "upgrade-reload"].includes(caseName);
        if (caseName === "pure-native") {
          const ended = new Promise<string>((resolve) => {
            const off = f.client.onEvent((event) => {
              if (event.type === "compaction_end") { off(); resolve(event.errorMessage ?? ""); }
            });
          });
          await f.client.prompt("/compact-native"); assert.match(await ended, exact);
          assert.ok(notifications.some((message) => message.includes("token-cap recovery is disabled")));
        } else if (succeeds) {
          const result = await f.client.compact();
          assert.match(result.summary, /Continuation Checkpoint/);
          assert.ok(result.summary.length <= 16000);
        } else await assert.rejects(f.client.compact(), exact);
        const entries = await f.client.getEntries();
        const compactions = entries.entries.filter((entry) => entry.type === "compaction");
        const traces = await f.traces();
        const stages = traces.filter((record) => record.event === "summary_recovery").map((record) => record.stage);
        if (succeeds) {
          assert.equal(compactions.length, 1); assert.equal(compactions[0]!.fromHook, true);
          assert.deepEqual(stages, ["started", "completed"]);
          const route = traces.find((record) => record.event === "compaction_route" && record.route === "wrapped-native");
          assert.equal(route?.capability, "bounded-recovery-v2");
          const calls = traces.filter((record) => record.event === "summary_call");
          assert.deepEqual(calls.map((record) => record.stage), ["native-history", "builder", "builder", "verifier", "verifier"]);
          assert.ok(calls.every((record) => record.attemptId === route?.attemptId));
          assert.equal(calls[0]!.requestedMaxTokens, 13107);
          assert.equal(calls[0]!.requestedReasoning, "low");
        } else {
          assert.equal(compactions.length, 0); assert.deepEqual(stages, []);
          assert.equal(entries.leafId, before.leafId, "failure preserves finalized history");
          if (caseName !== "stale-runtime") assert.ok(traces.some((record) => record.route === caseName));
          if (caseName === "invalid-config") assert.ok(notifications.some((message) => message.includes("configuration unavailable")));
        }
        assert.equal((await f.client.getState()).thinkingLevel, "high", "summary reasoning never mutates acting policy");
      } finally { offUI(); await f.cleanup(); }
    });
  }
});
