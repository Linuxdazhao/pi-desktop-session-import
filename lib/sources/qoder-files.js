"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 20000;
const MAX_FILES = 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

async function readFile(root, file, maxBytes = MAX_BYTES) {
  const canonicalRoot = await fsp.realpath(root);
  const canonical = await fsp.realpath(file);
  if (!inside(canonicalRoot, canonical) || (await fsp.lstat(file)).isSymbolicLink()) {
    throw new Error("Source path escapes its data directory");
  }
  const handle = await fsp.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("Source file exceeds import limit");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Source changed while reading; scan again");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await fsp.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.dev !== current.dev || before.ino !== current.ino ||
        await fsp.realpath(file) !== canonical) throw new Error("Source changed while reading; scan again");
    return { text: bytes.toString("utf8"), digest: hash(bytes) };
  } finally {
    await handle.close();
  }
}

async function optionalJson(root, file) {
  try {
    const snapshot = await readFile(root, file, 1024 * 1024);
    return { ...snapshot, value: JSON.parse(snapshot.text) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** SQLite opens a pathname itself; fence its identity before and after reads. */
async function openDatabase(root, file) {
  const canonicalRoot = await fsp.realpath(root);
  const canonical = await fsp.realpath(file);
  const original = await fsp.lstat(file);
  if (!original.isFile() || original.isSymbolicLink() || !inside(canonicalRoot, canonical)) {
    throw new Error("Source database escapes its data directory");
  }
  const validate = async () => {
    const current = await fsp.lstat(file);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
        await fsp.realpath(file) !== canonical || await fsp.realpath(root) !== canonicalRoot) {
      throw new Error("Source database changed; scan again");
    }
  };
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(canonical, { readOnly: true, allowExtension: false });
  try {
    await validate();
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; BEGIN");
    return { db, validate };
  } catch (error) { db.close(); throw error; }
}

async function entries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function parseTranscript(text) {
  const records = [];
  const warnings = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (records.length >= MAX_RECORDS || Buffer.byteLength(line) > 4 * 1024 * 1024) {
      throw new Error("Source transcript exceeds import limit");
    }
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("record");
      records.push(record);
    } catch { warnings.add("malformed-record"); }
  }
  return { records, warnings: [...warnings] };
}

function localPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  if (value.startsWith("file:")) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

function rootPaths(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? [...new Set(value.map(localPath).filter(Boolean))] : [];
}

function locations({ home, env, platform }) {
  const appBases = platform === "darwin" ? [path.join(home, "Library", "Application Support")]
    : platform === "win32" ? [env.APPDATA, env.LOCALAPPDATA].filter(Boolean)
    : [env.XDG_CONFIG_HOME || path.join(home, ".config")];
  return {
    configRoots: [...new Set([env.QODER_CONFIG_DIR || path.join(home, ".qoder"), path.join(home, ".qoder-cn")])],
    desktopRoots: appBases.flatMap((base) =>
      ["com.qoder.app.stable", "com.qoder.app", "com.qoder.app.beta", "QoderApp"].map((name) => path.join(base, name))),
    ideRoots: appBases.flatMap((base) => ["Qoder", "Qoder CN"].map((name) => path.join(base, name))),
  };
}

module.exports = { MAX_BYTES, MAX_RECORDS, MAX_FILES, hash, inside, readFile, optionalJson, openDatabase, entries, parseTranscript, localPath, rootPaths, locations };
