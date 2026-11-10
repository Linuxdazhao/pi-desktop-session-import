"use strict";

const path = require("node:path");
const { MAX_BYTES, MAX_RECORDS, hash, openDatabase, rootPaths } = require("./qoder-files");
const { desktopMessages } = require("./qoder-messages");
const { toIso } = require("../util");

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
}

function optionalCols(have, names) {
  return names.map((name) => have.has(name) ? `"${name}"` : `NULL AS "${name}"`).join(", ");
}

async function readDesktop(root, selectedId) {
  const file = path.join(root, "main.sqlite");
  let connection;
  try {
    connection = await openDatabase(root, file);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { db, validate } = connection;
  try {
    const sc = columns(db, "chat_sessions"), mc = columns(db, "chat_session_messages");
    if (!["session_id", "title"].every((c) => sc.has(c)) ||
        !["session_id", "message_id", "sequence", "payload_json"].every((c) => mc.has(c))) {
      throw new Error("Unsupported Qoder Desktop database schema");
    }
    const claims = new Set(db.prepare("SELECT session_id FROM chat_sessions LIMIT 10001").all().map((r) => r.session_id));
    if (claims.size > 10000) throw new Error("Desktop session index exceeds import limit");
    const wc = columns(db, "workspaces");
    const projects = [];
    if (wc.has("workspace_id") && wc.has("root_paths_json")) {
      const rows = db.prepare(`SELECT workspace_id, root_paths_json, ${optionalCols(wc, ["name", "deleted_at", "archived"])} FROM workspaces LIMIT 1001`).all();
      if (rows.length > 1000) throw new Error("Desktop workspace index exceeds import limit");
      for (const row of rows) {
        if (row.deleted_at != null) continue;
        for (const folder of rootPaths(row.root_paths_json)) {
          projects.push({ nativeId: `${row.workspace_id}:${hash(folder).slice(0, 16)}`, workspaceId: row.workspace_id,
            path: folder, name: row.name || path.basename(folder), archived: Boolean(row.archived) });
        }
      }
    }
    const sessions = [];
    const rows = db.prepare(`SELECT session_id, title, ${optionalCols(sc, ["cwd", "model", "workspace_id", "owner_session_id", "session_kind", "created_at", "updated_at", "deleted_at", "archived"])}
      FROM chat_sessions ${selectedId ? "WHERE session_id = ?" : ""} ORDER BY session_id LIMIT 501`).all(...(selectedId ? [selectedId] : []));
    if (rows.length > 500) throw new Error("Desktop session scan exceeds 500 sessions");
    let bytes = 0;
    for (const row of rows) {
      if (row.deleted_at != null) continue;
      const messageRows = [];
      for (const message of db.prepare(`SELECT message_id, sequence,
          CASE WHEN length(CAST(payload_json AS BLOB)) <= ${MAX_BYTES} THEN payload_json ELSE NULL END AS payload_json,
          ${optionalCols(mc, ["role", "created_at", "updated_at", "payload_schema_version", "status"])}
        FROM chat_session_messages WHERE session_id = ? ORDER BY sequence, message_id LIMIT ${MAX_RECORDS + 1}`).iterate(row.session_id)) {
        if (message.payload_json == null || messageRows.length >= MAX_RECORDS) throw new Error("Desktop messages exceed import limit");
        bytes += Buffer.byteLength(message.payload_json);
        if (bytes > 64 * 1024 * 1024) throw new Error("Desktop snapshot exceeds 64 MiB import limit");
        if (message.payload_schema_version != null && ![1, 2].includes(message.payload_schema_version)) {
          throw new Error("Unsupported Qoder Desktop message version");
        }
        messageRows.push(message);
      }
      const createdAt = toIso(row.created_at, "1970-01-01T00:00:00.000Z");
      const project = projects.find((p) => p.workspaceId === row.workspace_id);
      const converted = desktopMessages(messageRows, createdAt);
      const projectPath = row.cwd || project?.path || null;
      const fingerprint = hash(JSON.stringify({ row, messageRows, project }));
      sessions.push({ nativeId: row.session_id, title: row.title || row.session_id, projectPath,
        createdAt, updatedAt: toIso(row.updated_at, createdAt), modelId: row.model || null,
        parentId: row.owner_session_id || null, archived: Boolean(row.archived), fingerprint, ...converted });
    }
    await validate();
    db.exec("ROLLBACK");
    return { sessions, projects, claims };
  } finally { db.close(); }
}

module.exports = { readDesktop };
