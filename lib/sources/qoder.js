"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { toIso, truncateTitle, projectNameOf } = require("../util");
const { MAX_FILES, hash, readFile, optionalJson, entries, parseTranscript, localPath, locations } = require("./qoder-files");
const { branches, transcriptMessages, textOf } = require("./qoder-messages");
const { readDesktop } = require("./qoder-desktop");
const { readIde } = require("./qoder-ide");

const SOURCES = ["qoder-desktop", "qoder-ide", "qoder-cli"];
const keyOf = (profile, id) => hash(`${profile}\0${id}`).slice(0, 40);

/** One discovery pass establishes ownership across all three products. */
function createQoderAdapters(options = {}) {
  const home = options.home || os.homedir();
  const paths = { ...locations({ home, platform: options.platform || process.platform, env: options.env || process.env }), ...options.paths };
  const selections = new Map(SOURCES.map((source) => [source, new Map()]));
  const projects = new Map(SOURCES.map((source) => [source, new Map()]));
  let scanning;

  function addProject(source, profile, project) {
    const folder = localPath(project.path);
    if (!folder) return;
    const id = keyOf(profile, folder);
    projects.get(source).set(id, { id, path: folder, name: project.name || projectNameOf(folder), archived: project.archived || false });
  }

  function addSession(source, profile, data, reload) {
    const externalId = keyOf(profile, data.nativeId);
    const projectPath = localPath(data.projectPath);
    const warnings = [...new Set(data.warnings || [])];
    if (!data.messages.length) warnings.push("metadata-only");
    const summary = {
      source, externalId, selection: randomUUID(), title: truncateTitle(data.title) || data.nativeId,
      fullTitle: data.title || data.nativeId, projectName: projectNameOf(projectPath) || profile,
      projectPath, modelId: data.modelId || null, providerId: null,
      createdAt: data.createdAt, updatedAt: data.updatedAt,
      messageCount: data.messages.length, warnings, importable: data.messages.length > 0,
      archived: data.archived || false, parentId: data.parentId || null,
    };
    const previous = selections.get(source).get(externalId);
    if (previous) {
      if (previous.data.fingerprint !== data.fingerprint) {
        previous.summary.warnings.push("duplicate-conflict");
        previous.summary.importable = false;
      }
      return;
    }
    // Parsed bodies are released after discovery. Preview and commit re-read
    // the source, including its digest, through the retained private locator.
    const { messages: _messages, ...metadata } = data;
    selections.get(source).set(externalId, { summary, data: metadata, reload });
    if (projectPath) addProject(source, profile, { path: projectPath });
  }

  async function discover() {
    for (const map of selections.values()) map.clear();
    for (const map of projects.values()) map.clear();
    const desktopClaims = new Set(), ideClaims = new Map();
    for (const root of paths.desktopRoots) {
      const result = await readDesktop(root);
      if (!result) continue;
      const profile = path.basename(root);
      for (const id of result.claims) desktopClaims.add(id);
      for (const project of result.projects) addProject("qoder-desktop", profile, project);
      for (const data of result.sessions) {
        const nativeId = data.nativeId;
        addSession("qoder-desktop", profile, data,
          async () => (await readDesktop(root, nativeId))?.sessions.find((s) => s.nativeId === nativeId));
      }
    }
    for (const root of paths.ideRoots) {
      const result = await readIde(root);
      const profile = path.basename(root);
      for (const project of result.projects) addProject("qoder-ide", profile, project);
      for (const [id, info] of result.sessions) ideClaims.set(id, { ...info, profile });
    }
    let files = 0;
    const foundIde = new Set();
    for (const root of paths.configRoots) {
      const profile = path.basename(root);
      const projectRoot = path.join(root, "projects");
      for (const project of await entries(projectRoot)) {
        if (!project.isDirectory() || project.isSymbolicLink()) continue;
        const dir = path.join(projectRoot, project.name);
        for (const [parent, nested] of [[dir, false], [path.join(dir, "transcript"), true]]) {
          for (const file of await entries(parent)) {
            if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
            if (++files > MAX_FILES) throw new Error("Qoder transcript scan exceeds 1000 files");
            const filePath = path.join(parent, file.name);
            const snapshot = await readFile(root, filePath);
            const parsed = parseTranscript(snapshot.text);
            const ids = new Set(parsed.records.map((r) => r.sessionId).filter((id) => typeof id === "string"));
            if (ids.size !== 1) throw new Error("Qoder transcript has missing or conflicting session identity");
            const nativeId = [...ids][0];
            if (desktopClaims.has(nativeId)) continue;
            const statePath = path.join(dir, path.basename(file.name, ".jsonl"), "state.json");
            const state = nested ? null : await optionalJson(root, statePath);
            const cli = !nested && (Array.isArray(state?.value.workspaceDirectories) ||
              parsed.records.some((r) => r.type === "workspace-directories" || ["cli", "qodercli", "qoder-cli"].includes(r.entrypoint)));
            const ide = nested || ideClaims.has(nativeId) || parsed.records.some((r) => r.entrypoint === "ide");
            if (!cli && !ide) throw new Error("Qoder transcript product ownership is unknown");
            if (cli && ide) throw new Error("Qoder transcript product ownership conflicts");
            const source = cli ? "qoder-cli" : "qoder-ide";
            const info = ideClaims.get(nativeId) || {};
            if (ide) foundIde.add(nativeId);
            const workspace = parsed.records.filter((r) => r.type === "workspace-directories").at(-1)?.directories || state?.value.workspaceDirectories || [];
            const folders = (Array.isArray(workspace) ? workspace : []).map((p) => localPath(typeof p === "string" ? p : p?.path)).filter(Boolean);
            for (const folder of folders) addProject(source, profile, { path: folder });
            const groups = branches(parsed.records);
            for (const group of groups) {
              const branchLeaf = group.leaf;
              const build = (fresh, freshState) => {
                const branch = branches(fresh.records).find((b) => b.leaf === branchLeaf);
                if (!branch) throw new Error("Source branch changed; scan again");
                const first = branch.records[0];
                const createdAt = toIso(first?.timestamp ?? info.createdAt, "1970-01-01T00:00:00.000Z");
                const converted = transcriptMessages(branch.records, createdAt);
                const firstUser = branch.records.find((r) => r.type === "user" && !r.isMeta && textOf(r.message?.content));
                const cwd = branch.records.find((r) => localPath(r.cwd))?.cwd || folders[0] || info.projectPath;
                return { nativeId: branchLeaf ? `${nativeId}:branch:${branchLeaf}` : nativeId,
                  title: `${info.title || textOf(firstUser?.message?.content) || nativeId}${branchLeaf ? " (branch)" : ""}`,
                  createdAt, updatedAt: toIso(branch.records.at(-1)?.timestamp ?? freshState?.value.updatedAt, createdAt),
                  projectPath: cwd, modelId: branch.records.find((r) => r.message?.model)?.message.model || null,
                  fingerprint: hash(`${fresh.digest}\0${freshState?.digest || ""}`),
                  messages: converted.messages,
                  warnings: [...fresh.warnings, ...converted.warnings,
                    ...(fresh.records.some((r) => r.type === "attachment") ? ["attachment-not-imported"] : [])] };
              };
              const data = build({ ...parsed, digest: snapshot.digest }, state);
              addSession(source, profile, data, async () => {
                const current = await readFile(root, filePath);
                return build({ ...parseTranscript(current.text), digest: current.digest }, nested ? null : await optionalJson(root, statePath));
              });
            }
          }
        }
      }
    }
    for (const [id, info] of ideClaims) {
      if (foundIde.has(id) || desktopClaims.has(id)) continue;
      addSession("qoder-ide", info.profile, { nativeId: id, title: info.title,
        projectPath: info.projectPath, createdAt: toIso(info.createdAt, "1970-01-01T00:00:00.000Z"),
        updatedAt: toIso(info.createdAt, "1970-01-01T00:00:00.000Z"), messages: [], warnings: ["metadata-only"] }, async () => null);
    }
  }

  function scan() {
    if (!scanning) scanning = discover().finally(() => { scanning = null; });
    return scanning;
  }

  return SOURCES.map((source, index) => ({
    source, label: ["Qoder Desktop", "Qoder IDE", "Qoder CLI"][index],
    async scan() { await scan(); return [...selections.get(source).values()].map((r) => r.summary); },
    listProjects() { return [...projects.get(source).values()]; },
    async prepareProject(id, destination) {
      const project = projects.get(source).get(id);
      if (!project) throw new Error("Project was not returned by the current scan");
      const folder = localPath(destination || project.path);
      if (!folder || !(await fsp.stat(folder)).isDirectory()) throw new Error("Choose an existing local project folder");
      return { path: await fsp.realpath(folder), name: project.name };
    },
    async convert(selection) {
      const saved = selections.get(source).get(selection?.externalId);
      if (!saved || selection.selection !== saved.summary.selection) throw new Error("Session was not returned by the current scan");
      if (!saved.summary.importable) throw new Error("Conversation content is unavailable or conflicting");
      const current = await saved.reload();
      if (!current || current.fingerprint !== saved.data.fingerprint) throw new Error("Source changed; scan again before importing");
      const { summary } = saved;
      return { session: { id: `import-${source}-${summary.externalId}`, title: summary.fullTitle,
        projectPath: summary.projectPath, modelId: summary.modelId, providerId: null, mode: "agent",
        createdAt: summary.createdAt, updatedAt: summary.updatedAt },
        messages: current.messages.map((message) => {
          if (message.toolStatus === "running") return { id: message.id, role: "assistant", createdAt: message.createdAt,
            content: `[Unfinished tool: ${message.toolName}]\n${JSON.stringify(message.toolArgs ?? {})}${message.content ? `\n${message.content}` : ""}` };
          return message.reasoning ? { ...message, content: `[Reasoning]\n${message.content}` } : message;
        }), warnings: summary.warnings };
    },
  }));
}

module.exports = { createQoderAdapters, SOURCES };
