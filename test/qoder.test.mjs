import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createQoderAdapters } = require("../lib/sources/qoder");
const { locations, readFile, parseTranscript, MAX_BYTES } = require("../lib/sources/qoder-files");
const { transcriptMessages, branches, desktopMessages } = require("../lib/sources/qoder-messages");
const { readDesktop } = require("../lib/sources/qoder-desktop");
const { readIde } = require("../lib/sources/qoder-ide");
const T = "2026-11-01T10:00:00.000Z";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-import-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const desktopRoot = path.join(home, "com.qoder.app.stable");
  const ideRoot = path.join(home, "Qoder");
  const configRoot = path.join(home, ".qoder");
  const folder = path.join(home, "sample project");
  fs.mkdirSync(folder);
  const adapters = createQoderAdapters({ home, env: {}, paths: {
    desktopRoots: [desktopRoot], ideRoots: [ideRoot], configRoots: [configRoot],
  } });
  const source = (id) => adapters.find((a) => a.source === id);
  return { home, desktopRoot, ideRoot, configRoot, folder, adapters, source };
}

function desktop(f, { role = true, wal = false } = {}) {
  fs.mkdirSync(f.desktopRoot, { recursive: true });
  const db = new DatabaseSync(path.join(f.desktopRoot, "main.sqlite"));
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE workspaces (workspace_id TEXT, name TEXT, root_paths_json TEXT, deleted_at INTEGER);
    CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, workspace_id TEXT,
      model TEXT, owner_session_id TEXT, created_at TEXT, updated_at TEXT, deleted_at INTEGER, archived INTEGER);
    CREATE TABLE chat_session_messages (session_id TEXT, message_id TEXT, sequence INTEGER,
      payload_json TEXT, created_at INTEGER, ${role ? "role TEXT," : ""} payload_schema_version INTEGER);`);
  db.prepare("INSERT INTO workspaces VALUES (?,?,?,NULL)").run("w", "Sample", JSON.stringify([f.folder]));
  const add = (id, payload, version = 1) => db.prepare(`INSERT INTO chat_session_messages VALUES (?,?,?,?,?,${role ? "?," : ""}?)`)
    .run("desktop-s", id, id === "u" ? 0 : 1, JSON.stringify(payload), Date.parse(T), ...(role ? [payload.role || "assistant"] : []), version);
  db.prepare("INSERT INTO chat_sessions VALUES (?,?,?,?,?,?,?,?,NULL,0)").run("desktop-s", "Desktop history", f.folder, "w", "historical-model", null, T, T);
  return { db, add };
}

function transcript(f, { id = "cli-s", nested = false, lines, state = true } = {}) {
  const dir = path.join(f.configRoot, "projects", "slug-with-hyphens");
  const file = path.join(dir, ...(nested ? ["transcript"] : []), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = lines || [
    { type: "workspace-directories", sessionId: id, directories: [f.folder] },
    { type: "user", sessionId: id, uuid: "u", cwd: f.folder, timestamp: T, message: { role: "user", content: "Hello" } },
    { type: "assistant", sessionId: id, uuid: "a", parentUuid: "u", timestamp: T, message: { model: "m", content: [{ type: "text", text: "Hello back" }] } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (!nested && state) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, "state.json"), JSON.stringify({ sessionId: id, workspaceDirectories: [f.folder], updatedAt: T }));
  }
  return file;
}

test("Desktop reads payload/column roles, tools, reasoning and empty registered projects without writing source", async (t) => {
  const f = fixture(t);
  const { db, add } = desktop(f);
  add("u", { role: "user", text: "Hello", timestamp: T });
  add("a", { parts: [
    { type: "thinking", text: "Inspecting" },
    { type: "tool", tool: { id: "c", name: "Read", input: { file: "README.md" }, status: "failed", response: "missing" } },
    { type: "text", text: "Unavailable" },
  ], tools: [{ id: "c", name: "Read", status: "failed", response: "missing" }] }, 2);
  db.close();
  const before = fs.readFileSync(path.join(f.desktopRoot, "main.sqlite"));
  const a = f.source("qoder-desktop");
  const [summary] = await a.scan();
  assert.equal(summary.source, "qoder-desktop");
  assert.equal(summary.projectPath, f.folder);
  assert.equal(a.listProjects().length, 1);
  const converted = await a.convert({ ...summary, filePath: "/forged", title: "forged", projectPath: "/forged" });
  assert.equal(converted.session.title, "Desktop history");
  assert.deepEqual(converted.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.match(converted.messages[1].content, /\[Reasoning\]/);
  assert.equal(converted.messages[2].toolStatus, "error");
  assert.equal(converted.messages[2].toolArgs.file, "README.md");
  assert.equal(converted.messages[2].toolResult, "missing");
  assert.deepEqual(fs.readFileSync(path.join(f.desktopRoot, "main.sqlite")), before);
  assert.equal(converted.session.providerId, null);
});

test("Desktop supports old role-less schemas and committed WAL rows", async (t) => {
  const f = fixture(t);
  const { db, add } = desktop(f, { role: false, wal: true });
  t.after(() => db.close());
  add("u", { role: "user", text: "WAL message", attachments: [{ path: "/outside/secret" }] });
  const a = f.source("qoder-desktop");
  const [summary] = await a.scan();
  assert.ok(summary.warnings.includes("attachment-not-imported"));
  assert.equal((await a.convert(summary)).messages[0].content, "WAL message");
});

test("Desktop stale/deleted selections and unsupported versions are rejected", async (t) => {
  const f = fixture(t);
  const { db, add } = desktop(f);
  t.after(() => db.close());
  add("u", { role: "user", text: "original" });
  const a = f.source("qoder-desktop");
  const [summary] = await a.scan();
  db.prepare("UPDATE chat_session_messages SET payload_json = ?").run(JSON.stringify({ role: "user", text: "changed" }));
  await assert.rejects(a.convert(summary), /Source changed/);
  db.exec("UPDATE chat_session_messages SET payload_schema_version = 99");
  assert.deepEqual(await a.scan(), []);
  assert.match(a.diagnostics().join(), /Unsupported.*version/);
  db.exec("UPDATE chat_session_messages SET payload_schema_version = 1; UPDATE chat_sessions SET deleted_at = 1");
  assert.deepEqual(await a.scan(), []);
});

test("CLI uses structured roots, keeps branches separate, and rejects forged or changed selections", async (t) => {
  const f = fixture(t);
  const lines = [
    { type: "workspace-directories", sessionId: "s", directories: [f.folder] },
    { type: "user", sessionId: "s", uuid: "u", timestamp: T, message: { content: "hello" } },
    { type: "assistant", sessionId: "s", uuid: "old", parentUuid: "u", timestamp: T, message: { content: "sibling" } },
    { type: "assistant", sessionId: "s", uuid: "current", parentUuid: "u", timestamp: T, message: { content: "active" } },
    { type: "active-leaf", sessionId: "s", leafUuid: "current" },
  ];
  const file = transcript(f, { id: "s", lines });
  const a = f.source("qoder-cli");
  const list = await a.scan();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.projectPath), [f.folder, f.folder]);
  assert.deepEqual((await a.convert(list[0])).messages.map((m) => m.content), ["hello", "active"]);
  assert.deepEqual((await a.convert(list[1])).messages.map((m) => m.content), ["hello", "sibling"]);
  await assert.rejects(a.convert({ ...list[0], selection: "forged" }), /current scan/);
  fs.appendFileSync(file, JSON.stringify({ sessionId: "s", type: "last-prompt" }) + "\n");
  await assert.rejects(a.convert(list[0]), /Source changed/);
});

test("Desktop-owned projections, including deleted sessions, are never misclassified as CLI", async (t) => {
  const f = fixture(t);
  const { db } = desktop(f);
  db.exec("UPDATE chat_sessions SET deleted_at = 1");
  db.close();
  transcript(f, { id: "desktop-s" });
  assert.deepEqual(await f.source("qoder-cli").scan(), []);
});

test("IDE workspace URI and legacy index retain project-only and incomplete entries", async (t) => {
  const f = fixture(t);
  const ws = path.join(f.ideRoot, "User", "workspaceStorage", "workspace");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "workspace.json"), JSON.stringify({ folder: pathToFileURL(f.folder).href }));
  const storage = path.join(f.ideRoot, "User", "globalStorage");
  fs.mkdirSync(storage, { recursive: true });
  const db = new DatabaseSync(path.join(storage, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  db.prepare("INSERT INTO ItemTable VALUES (?,?)").run("lingma.chat.localHistory.workspace.quest", JSON.stringify([
    { sessionId: "incomplete", title: "Only metadata", timestamp: T },
    { sessionId: "ide-s", title: "IDE title", timestamp: T },
  ]));
  db.close();
  transcript(f, { id: "ide-s", nested: true });
  const a = f.source("qoder-ide"), list = await a.scan();
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.fullTitle === "Only metadata").importable, false);
  await assert.rejects(a.convert(list.find((s) => s.fullTitle === "Only metadata")), /unavailable/);
  assert.equal((await a.convert(list.find((s) => s.fullTitle === "IDE title"))).messages.length, 2);
  assert.equal(a.listProjects()[0].path, f.folder);
  assert.equal((await a.prepareProject(a.listProjects()[0].id)).path, fs.realpathSync(f.folder));
  await assert.rejects(a.prepareProject("forged"), /current scan/);
});

test("unfinished tools are reference text and aggregate/parts text is not duplicated", async (t) => {
  const f = fixture(t);
  const { db, add } = desktop(f);
  add("a", { role: "assistant", text: "same", parts: [{ type: "text", text: "same" }],
    tools: [{ id: "pending", name: "Bash", input: { command: "echo sample" }, status: "running" }] });
  db.close();
  const a = f.source("qoder-desktop"), [summary] = await a.scan();
  const converted = await a.convert(summary);
  assert.equal(converted.messages.filter((m) => m.content === "same").length, 1);
  assert.match(converted.messages[1].content, /Unfinished tool/);
  assert.ok(converted.messages.every((m) => m.toolStatus !== "success"));
});

test("file reads refuse symlink escape and oversized files; parser reports malformed input", async (t) => {
  const f = fixture(t), root = path.join(f.home, "source"), outside = path.join(f.home, "outside");
  fs.mkdirSync(root); fs.writeFileSync(outside, "not a source");
  fs.symlinkSync(outside, path.join(root, "escape"));
  await assert.rejects(readFile(root, path.join(root, "escape")), /escapes/);
  const large = path.join(root, "large");
  const fd = fs.openSync(large, "w"); fs.ftruncateSync(fd, MAX_BYTES + 1); fs.closeSync(fd);
  await assert.rejects(readFile(root, large), /limit/);
  assert.deepEqual(parseTranscript('invalid\n{"type":"last-prompt"}\n').warnings, ["malformed-record"]);
});

test("locations honor platform roots and configured CLI directories without reading them", () => {
  const mac = locations({ home: "/home/sample", env: {}, platform: "darwin" });
  assert.ok(mac.desktopRoots[0].endsWith("Library/Application Support/com.qoder.app.stable"));
  const linux = locations({ home: "/home/sample", env: { XDG_CONFIG_HOME: "/xdg", QODER_CONFIG_DIR: "/custom" }, platform: "linux" });
  assert.equal(linux.configRoots[0], "/custom");
  assert.equal(linux.desktopRoots[0], path.join("/xdg", "com.qoder.app.stable"));
  const win = locations({ home: "/home/sample", env: { APPDATA: "/roaming", LOCALAPPDATA: "/local" }, platform: "win32" });
  assert.equal(win.desktopRoots.length, 8);
});

test("tool blocks keep order and distinguish orphan, failed and pending results", () => {
  const { messages, warnings } = transcriptMessages([
    { type: "assistant", uuid: "a", timestamp: T, message: { content: [
      { type: "text", text: "before" }, { type: "tool_use", id: "c", name: "Read", input: {} }, { type: "text", text: "after" },
    ] } },
    { type: "user", uuid: "u", timestamp: T, message: { content: [{ type: "tool_result", tool_use_id: "c", is_error: true, content: "missing" }] } },
  ], T);
  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool", "assistant"]);
  assert.equal(messages[1].toolStatus, "error");
  assert.deepEqual(warnings, []);
  const raw = desktopMessages([{ message_id: "a", payload_json: '{"role":"assistant","text":"fallback"}' }], T);
  assert.equal(raw.messages[0].content, "fallback");
  assert.equal(branches([{ type: "user", message: { content: "no UUID" } }]).length, 1);
});

test("active-leaf changes and branch extension preserve each branch's external identity", async (t) => {
  const f = fixture(t);
  const records = [
    { type: "workspace-directories", sessionId: "s", directories: [f.folder] },
    { type: "user", sessionId: "s", uuid: "u", timestamp: T, message: { content: "start" } },
    { type: "assistant", sessionId: "s", uuid: "a", parentUuid: "u", timestamp: T, message: { content: "branch-a" } },
    { type: "assistant", sessionId: "s", uuid: "b", parentUuid: "u", timestamp: T, message: { content: "branch-b" } },
    { type: "active-leaf", sessionId: "s", leafUuid: "a" },
  ];
  const file = transcript(f, { id: "s", lines: records });
  const a = f.source("qoder-cli");
  const identities = async () => {
    const result = new Map();
    for (const summary of await a.scan()) result.set((await a.convert(summary)).messages.at(-1).content, summary.externalId);
    return result;
  };
  const before = await identities();
  records.at(-1).leafUuid = "b";
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n"));
  const switched = await identities();
  assert.deepEqual([...switched].sort(), [...before].sort());
  records.push({ type: "assistant", sessionId: "s", uuid: "b2", parentUuid: "b", timestamp: T, message: { content: "branch-b-extended" } });
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n"));
  const extended = await identities();
  assert.equal(extended.get("branch-b-extended"), before.get("branch-b"));
  assert.equal(extended.get("branch-a"), before.get("branch-a"));
});

test("one malformed transcript leaves healthy Desktop and CLI results available with diagnostics", async (t) => {
  const f = fixture(t);
  const { db, add } = desktop(f); add("u", { role: "user", text: "healthy Desktop" }); db.close();
  const good = transcript(f);
  fs.writeFileSync(path.join(path.dirname(good), "broken.jsonl"), "not json\n");
  const [desktopRows, cliRows] = await Promise.all([f.source("qoder-desktop").scan(), f.source("qoder-cli").scan()]);
  assert.equal(desktopRows.length, 1);
  assert.equal(cliRows.length, 1);
  assert.deepEqual(f.source("qoder-desktop").diagnostics(), []);
  assert.match(f.source("qoder-cli").diagnostics().join(), /identity/);
});

test("IDE workspace metadata changes invalidate an otherwise unchanged transcript", async (t) => {
  const f = fixture(t);
  const ws = path.join(f.ideRoot, "User", "workspaceStorage", "w");
  fs.mkdirSync(ws, { recursive: true });
  const index = path.join(ws, "workspace.json");
  fs.writeFileSync(index, JSON.stringify({ folder: pathToFileURL(f.folder).href }));
  const storage = path.join(f.ideRoot, "User", "globalStorage"); fs.mkdirSync(storage, { recursive: true });
  const db = new DatabaseSync(path.join(storage, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  db.prepare("INSERT INTO ItemTable VALUES (?,?)").run("lingma.chat.localHistory.w", JSON.stringify([{ sessionId: "s", title: "Original", timestamp: T }]));
  db.close();
  transcript(f, { id: "s", nested: true });
  const a = f.source("qoder-ide"), [summary] = await a.scan();
  fs.writeFileSync(index, JSON.stringify({ folder: pathToFileURL(path.join(f.home, "moved")).href }));
  await assert.rejects(a.convert(summary), /metadata changed/);
});

for (const kind of ["desktop", "ide"]) test(`${kind} refuses a database replaced with an outside symlink during open`, async (t) => {
  const f = fixture(t);
  let root, file, read;
  if (kind === "desktop") {
    const { db } = desktop(f); db.close();
    root = f.desktopRoot; file = path.join(root, "main.sqlite"); read = readDesktop;
  } else {
    root = f.ideRoot; file = path.join(root, "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file); db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)"); db.close(); read = readIde;
  }
  const outside = path.join(f.home, "outside.sqlite"); fs.copyFileSync(file, outside);
  const original = fs.promises.lstat;
  let swapped = false;
  fs.promises.lstat = async function (target, ...args) {
    const result = await original.call(this, target, ...args);
    if (!swapped && target === file) { swapped = true; fs.unlinkSync(file); fs.symlinkSync(outside, file); }
    return result;
  };
  try { await assert.rejects(read(root), /database changed/); }
  finally { fs.promises.lstat = original; }
});
