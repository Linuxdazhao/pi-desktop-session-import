"use strict";

const { toIso } = require("../util");

const textOf = (value) => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n") : "";

/** Keep branches separate. A leaf selects its ancestry, never its siblings. */
function branches(records) {
  const messages = records.filter((r) => r.type === "user" || r.type === "assistant");
  const indexed = records.filter((r) => typeof r.uuid === "string");
  const byId = new Map(indexed.map((r) => [r.uuid, r]));
  if (byId.size !== indexed.length) throw new Error("Duplicate message identity in transcript");
  if (!messages.length || messages.some((r) => !r.uuid)) return [{ records: messages, leaf: null }];
  const parents = new Set(indexed.map((r) => r.parentUuid).filter(Boolean));
  const leaves = messages.filter((r) => !parents.has(r.uuid));
  const active = records.filter((r) => r.type === "active-leaf" && r.leafUuid).at(-1)?.leafUuid;
  leaves.sort((a, b) => Number(b.uuid === active) - Number(a.uuid === active) || a.uuid.localeCompare(b.uuid));
  return leaves.map((leaf, index) => {
    const chain = [], seen = new Set();
    let row = leaf;
    while (row) {
      if (seen.has(row.uuid)) throw new Error("Cyclic conversation branch");
      seen.add(row.uuid);
      if (row.type === "user" || row.type === "assistant") chain.push(row);
      row = byId.get(row.parentUuid);
    }
    return { records: chain.reverse(), leaf: leaves.length > 1 && index > 0 ? leaf.uuid : null };
  });
}

function transcriptMessages(records, fallback) {
  const messages = [], warnings = new Set(), tools = new Map();
  for (const row of records) {
    const role = row.type;
    if ((role !== "user" && role !== "assistant") || row.isMeta || !row.message) continue;
    const at = toIso(row.timestamp, fallback);
    const content = row.message.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const [index, block] of blocks.entries()) {
      if (!block || typeof block !== "object") { warnings.add("unsupported-content"); continue; }
      const id = row.uuid ? `${row.uuid}:${index}` : undefined;
      if (block.type === "text" && block.text) {
        messages.push({ id, role, content: block.text, createdAt: at });
      } else if (block.type === "thinking" && role === "assistant") {
        const content = block.thinking || block.text;
        if (content) messages.push({ id, role, content, createdAt: at, reasoning: true });
      } else if (block.type === "tool_use" && block.id) {
        const message = { id, role: "tool", content: "", createdAt: at,
          toolName: block.name || "tool", toolCallId: block.id, toolArgs: block.input, toolStatus: "running" };
        messages.push(message);
        tools.set(block.id, message);
      } else if (block.type === "tool_result") {
        const result = textOf(block.content);
        const pending = tools.get(block.tool_use_id);
        const message = pending || { id, role: "tool", createdAt: at, toolName: "tool", toolCallId: block.tool_use_id };
        message.content = result;
        message.toolResult = result;
        message.toolStatus = block.is_error ? "error" : "success";
        if (!pending) { messages.push(message); warnings.add("orphan-tool-result"); }
        tools.delete(block.tool_use_id);
      } else if (["image", "document", "attachment"].includes(block.type)) {
        warnings.add("attachment-not-imported");
      } else { warnings.add("unsupported-content"); }
    }
  }
  if ([...tools.values()].length) warnings.add("unfinished-tool");
  return { messages, warnings: [...warnings] };
}

/** Native Desktop stores either aggregate text/tools or ordered parts. */
function desktopMessages(rows, fallback) {
  const messages = [], warnings = new Set();
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { warnings.add("malformed-record"); continue; }
    if (!payload || typeof payload !== "object") { warnings.add("malformed-record"); continue; }
    const role = payload.role || row.role;
    if (role !== "user" && role !== "assistant") { warnings.add("non-conversation-record"); continue; }
    const at = toIso(payload.timestamp ?? row.created_at, fallback);
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const emitted = new Set();
    const emitTool = (tool) => {
      if (!tool || typeof tool !== "object" || !tool.id || emitted.has(tool.id)) return;
      emitted.add(tool.id);
      const result = typeof tool.response === "string" ? tool.response : tool.response == null ? "" : JSON.stringify(tool.response);
      const complete = ["completed", "success", "failed", "error"].includes(tool.status);
      const failed = tool.status === "failed" || tool.status === "error";
      messages.push({ id: `${row.message_id}:tool:${tool.id}`, role: "tool", content: result,
        createdAt: toIso(tool.startedAt, at), toolCallId: tool.id, toolName: tool.name || "tool",
        toolArgs: tool.input, ...(complete ? { toolResult: result } : {}),
        toolStatus: complete ? failed ? "error" : "success" : "running" });
      if (!complete) warnings.add("unfinished-tool");
    };
    for (const [index, part] of parts.entries()) {
      if (!part || typeof part !== "object") { warnings.add("unsupported-content"); continue; }
      if (part.type === "text" || part.type === "thinking") {
        if (part.text) messages.push({ id: `${row.message_id}:${index}`, role, content: part.text,
          createdAt: toIso(part.startedAt, at), ...(part.type === "thinking" ? { reasoning: true } : {}) });
      } else if (part.type === "tool") {
        const tool = part.tool || tools.find((tool) => tool && (tool.id === part.id || `tool:${tool.id}` === part.id));
        if (!tool) warnings.add("unsupported-content");
        emitTool(tool);
      } else { warnings.add("unsupported-content"); }
    }
    if (!parts.some((part) => part.type === "text") && payload.text) {
      messages.push({ id: row.message_id, role, content: payload.text, createdAt: at });
    }
    for (const tool of tools) emitTool(tool);
    if (payload.attachments?.length) warnings.add("attachment-not-imported");
    if (payload.failureReason) {
      messages.push({ id: `${row.message_id}:failure`, role: "assistant", content: String(payload.failureReason), createdAt: at });
      warnings.add("source-failure");
    }
  }
  return { messages, warnings: [...warnings] };
}

module.exports = { textOf, branches, transcriptMessages, desktopMessages };
