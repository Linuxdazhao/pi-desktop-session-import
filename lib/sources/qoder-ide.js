"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { entries, optionalJson, localPath, inside } = require("./qoder-files");

/** Workspace indexes supply authoritative paths; directory slugs are ambiguous. */
async function readIde(root) {
  const projects = [], sessions = new Map(), claims = new Set();
  const storage = path.join(root, "User", "workspaceStorage");
  for (const entry of await entries(storage)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (projects.length >= 1000) throw new Error("IDE workspace index exceeds import limit");
    const index = await optionalJson(root, path.join(storage, entry.name, "workspace.json"));
    if (!index) continue;
    const folder = localPath(index.value.folder);
    if (folder) projects.push({ nativeId: entry.name, path: folder, name: path.basename(folder) });
  }
  const file = path.join(root, "User", "globalStorage", "state.vscdb");
  let canonical;
  try { canonical = await fsp.realpath(file); }
  catch (error) { if (error.code === "ENOENT") return { projects, sessions, claims }; throw error; }
  if (!inside(await fsp.realpath(root), canonical) || (await fsp.lstat(file)).isSymbolicLink()) {
    throw new Error("IDE index escapes its data directory");
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(canonical, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; BEGIN");
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'lingma.chat.localHistory.%' LIMIT 1001").all();
    if (rows.length > 1000) throw new Error("IDE history index exceeds import limit");
    for (const row of rows) {
      if (Buffer.byteLength(row.value) > 1024 * 1024) throw new Error("IDE history index exceeds import limit");
      const workspaceId = row.key.slice("lingma.chat.localHistory.".length).replace(/\.quest$/, "");
      const project = projects.find((p) => p.nativeId === workspaceId);
      const records = JSON.parse(row.value);
      if (!Array.isArray(records)) throw new Error("Unsupported Qoder IDE history index");
      for (const record of records) {
        const id = record.sessionId;
        if (typeof id !== "string") continue;
        claims.add(id);
        sessions.set(id, { title: record.title, projectPath: project?.path || null, createdAt: record.timestamp });
      }
    }
    db.exec("ROLLBACK");
  } finally { db.close(); }
  return { projects, sessions, claims };
}

module.exports = { readIde };
