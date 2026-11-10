import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createQoderAdapters } = require("../lib/sources/qoder");

test("plugin entry scans, previews, remaps and imports Qoder through the existing Host API with skip semantics", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-plugin-flow-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); delete globalThis.pi; });
  const sourceFolder = path.join(home, "missing-source-folder");
  const destination = path.join(home, "destination");
  fs.mkdirSync(destination);
  const config = path.join(home, ".qoder");
  const projectDir = path.join(config, "projects", "slug");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(file, [
    { sessionId: "session", type: "workspace-directories", directories: [sourceFolder] },
    { sessionId: "session", uuid: "u", type: "user", cwd: sourceFolder, timestamp: "2026-11-01T10:00:00Z", message: { content: "A sample question" } },
    { sessionId: "session", uuid: "a", parentUuid: "u", type: "assistant", timestamp: "2026-11-01T10:00:01Z", message: { content: "A sample answer" } },
  ].map(JSON.stringify).join("\n"));
  // These are outside every supported source reader and must not participate.
  fs.mkdirSync(path.join(projectDir, "memory"));
  fs.writeFileSync(path.join(projectDir, "memory", "MEMORY.md"), "DO NOT IMPORT THIS MEMORY");
  const adapters = createQoderAdapters({ home, env: {}, paths: { desktopRoots: [], ideRoots: [], configRoots: [config] } });
  const registry = require.resolve("../lib/registry");
  require.cache[registry] = { id: registry, filename: registry, loaded: true, exports: {
    ADAPTERS: adapters, getAdapter: (source) => adapters.find((a) => a.source === source), allAdapters: () => adapters,
  } };
  delete require.cache[require.resolve("../main")];
  const main = require("../main");
  const imported = new Map(), batches = [], projectCalls = [];
  globalThis.pi = {
    project: { create: async (input) => { projectCalls.push(input); return { projectId: 42 }; } },
    session: { importBatch: async (input) => {
      batches.push(input);
      assert.equal(input.mode, "skip");
      let count = 0;
      for (const session of input.sessions) {
        if (!imported.has(session.externalId)) { imported.set(session.externalId, session); count += 1; }
      }
      return { imported: count, skipped: input.sessions.length - count, results: [] };
    } },
    agent: { complete: () => { throw new Error("Import must not extract memory"); } },
    fs: { writeText: () => { throw new Error("Import must not write notes"); } },
  };
  const scan = await main.onPanelInvoke("import.scanSource", { source: "qoder-cli" });
  assert.equal(scan.count, 1);
  assert.equal(scan.projectCount, 1);
  const { sessions, projects } = await main.onPanelInvoke("import.sessions", { source: "qoder-cli" });
  const preview = await main.onPanelInvoke("import.convertBatch", { source: "qoder-cli", items: sessions });
  assert.equal(preview.sessions[0].messages.length, 2);
  assert.equal(preview.sessions[0].session.projectPath, sourceFolder);
  const beforeMapping = await main.onPanelInvoke("import.commit", { source: "qoder-cli", items: sessions });
  assert.equal(beforeMapping.failed.length, 1);
  assert.equal(batches.length, 0, "missing project must not become an unbound import");
  await assert.rejects(main.onPanelInvoke("import.project", { source: "qoder-cli", projectId: "forged", destinationPath: destination }), /current scan/);
  await main.onPanelInvoke("import.project", { source: "qoder-cli", projectId: projects[0].id, destinationPath: destination });
  assert.equal(batches.length, 0, "project-only operation writes no conversation");
  assert.equal(projectCalls.length, 1);
  const first = await main.onPanelInvoke("import.commit", { source: "qoder-cli", items: sessions });
  assert.equal(first.imported, 1);
  assert.equal(batches[0].source, "qoder-cli");
  assert.equal(batches[0].sessions[0].projectPath, fs.realpathSync(destination));
  assert.equal(batches[0].sessions[0].projectId, 42);
  assert.ok(!JSON.stringify(batches).includes("DO NOT IMPORT THIS MEMORY"));
  const saved = [...imported.values()][0];
  saved.messages.push({ role: "user", content: "Continued in Host" });
  const second = await main.onPanelInvoke("import.commit", { source: "qoder-cli", items: sessions });
  assert.equal(second.skipped, 1);
  assert.equal(saved.messages.at(-1).content, "Continued in Host");
  fs.appendFileSync(file, '\n{"type":"last-prompt","sessionId":"session"}');
  const stale = await main.onPanelInvoke("import.commit", { source: "qoder-cli", items: sessions });
  assert.equal(stale.failed.length, 1);
  assert.match(stale.failed[0].error, /Source changed/);
  assert.equal(batches.length, 2, "stale content does not reach Host");
  fs.writeFileSync(path.join(projectDir, "broken.jsonl"), "not json\n");
  const partial = await main.onPanelInvoke("import.scanSource", { source: "qoder-cli", full: true });
  assert.equal(partial.found, true);
  assert.equal(partial.count, 1);
  assert.equal(partial.error.code, "PARTIAL_SOURCE", "partial projects must not mask source diagnostics");
});

test("a Desktop project without conversations is detected and can be registered independently", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-empty-project-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); delete globalThis.pi; });
  const root = path.join(home, "desktop"), folder = path.join(home, "project");
  fs.mkdirSync(root); fs.mkdirSync(folder);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(root, "main.sqlite"));
  db.exec(`CREATE TABLE chat_sessions (session_id TEXT, title TEXT);
    CREATE TABLE chat_session_messages (session_id TEXT, message_id TEXT, sequence INTEGER, payload_json TEXT);
    CREATE TABLE workspaces (workspace_id TEXT, root_paths_json TEXT);`);
  db.prepare("INSERT INTO workspaces VALUES (?,?)").run("empty", JSON.stringify([folder])); db.close();
  const adapters = createQoderAdapters({ home, env: {}, paths: { desktopRoots: [root], ideRoots: [], configRoots: [] } });
  const registry = require.resolve("../lib/registry");
  require.cache[registry] = { id: registry, filename: registry, loaded: true, exports: {
    ADAPTERS: adapters, getAdapter: (source) => adapters.find((a) => a.source === source), allAdapters: () => adapters,
  } };
  delete require.cache[require.resolve("../main")];
  const main = require("../main");
  let writes = 0;
  globalThis.pi = { project: { create: async () => { writes += 1; return { projectId: 1 }; } } };
  const result = await main.onPanelInvoke("import.scanSource", { source: "qoder-desktop" });
  assert.equal(result.found, true); assert.equal(result.count, 0); assert.equal(result.projectCount, 1);
  const { projects, sessions } = await main.onPanelInvoke("import.sessions", { source: "qoder-desktop" });
  assert.deepEqual(sessions, []);
  await main.onPanelInvoke("import.project", { source: "qoder-desktop", projectId: projects[0].id });
  assert.equal(writes, 1);
});
