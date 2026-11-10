"use strict";

const path = require("node:path");
const { entries, optionalJson, localPath, hash, openDatabase } = require("./qoder-files");

/** Workspace indexes supply authoritative paths; directory slugs are ambiguous. */
async function readIde(root) {
  const projects = [], sessions = new Map(), claims = new Set();
  const revisions = [];
  const result = () => ({ projects, sessions, claims, fingerprint: hash(JSON.stringify(revisions)) });
  const storage = path.join(root, "User", "workspaceStorage");
  for (const entry of await entries(storage)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (projects.length >= 1000) throw new Error("IDE workspace index exceeds import limit");
    const index = await optionalJson(root, path.join(storage, entry.name, "workspace.json"));
    if (!index) continue;
    revisions.push(index.digest);
    const folder = localPath(index.value.folder);
    if (folder) projects.push({ nativeId: entry.name, path: folder, name: path.basename(folder) });
  }
  const file = path.join(root, "User", "globalStorage", "state.vscdb");
  let connection;
  try { connection = await openDatabase(root, file); }
  catch (error) { if (error.code === "ENOENT") return result(); throw error; }
  const { db, validate } = connection;
  try {
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'lingma.chat.localHistory.%' ORDER BY key LIMIT 1001").all();
    if (rows.length > 1000) throw new Error("IDE history index exceeds import limit");
    for (const row of rows) {
      revisions.push(hash(JSON.stringify(row)));
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
    await validate();
    db.exec("ROLLBACK");
  } finally { db.close(); }
  return result();
}

module.exports = { readIde };
