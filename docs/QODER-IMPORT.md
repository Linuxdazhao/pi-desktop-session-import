# Qoder projects and conversations

This feature adds three built-in source IDs: `qoder-desktop`, `qoder-ide` and
`qoder-cli`. It extends the plugin's existing scan, preview and Host import
workflow. The six existing source IDs and their behavior remain compatible.
The former six-source registry assertion is superseded by the nine declared
sources; custom sources cannot use any built-in ID.

## Workflow and data ownership

Scan local tools, choose a Qoder source, review its projects and conversations,
then select the conversations to import. Project registration is a separate
action and works even when a registered source workspace has no conversations.
The destination field can remap a missing source directory to an existing local
folder. It is checked again before importing a project-bound conversation.

Projects use the existing `pi.project.create` permission/API. Conversations use
the existing `pi.session.importBatch` with `mode: skip`, preserving Host origin
identity, validation, persistence and session refresh. No Host changes or new
permissions are required. Existing conversation edits/continuations are never
replaced. Repeated source registration resolves the same Host project path.

The current plugin project API registers one folder at a time. A multi-root
source workspace therefore exposes each folder separately; this plugin does
not create or modify logical Host project groups. Conversation cwd determines
its folder when available. It does not silently merge similarly named folders.

No project files, memory, `MEMORY.md`, rules, instructions, credentials, hooks,
plugins, schedules or provider settings are imported. Import does not invoke a
model or the Session Forge. Historical tool records are never executed.
Source model IDs are metadata; provider credentials are not resolved or copied.

## Source formats

- **Desktop:** OS application-data directories for `com.qoder.app.stable`,
  `com.qoder.app`, `com.qoder.app.beta` and `QoderApp`; read `main.sqlite` with
  `chat_sessions` and `chat_session_messages`. Optional `workspaces` rows supply
  standalone project roots. SQLite connections are read-only/query-only and
  use a read transaction, including committed WAL data. Deleted sessions and
  workspaces are excluded. Archived records remain explicitly selectable.
- **IDE:** OS application-data `Qoder` / `Qoder CN` workspace indexes, local
  folder URIs, and `ItemTable` history metadata under
  `lingma.chat.localHistory.<workspaceId>[.quest]`. Complete transcript content
  comes from `<config>/projects/<project>/transcript/<session>.jsonl` or
  top-level JSONL with positive IDE ownership evidence. Index-only records are
  labeled incomplete and cannot be imported as full conversations.
- **CLI:** `<config>/projects/<project>/<session>.jsonl`, with structured
  `workspace-directories`, entrypoint, or sibling state metadata establishing
  CLI ownership. Honor `QODER_CONFIG_DIR`; default to `~/.qoder`, and discover
  `~/.qoder-cn` separately. Encoded directory slugs never become guessed paths.

Desktop records support role in the payload or optional database column,
aggregate text/tools and ordered parts, including inline/indexed tool blocks.
Only payload versions 1/2 (or the older unversioned schema) are admitted; this
is a compatibility limit, not a claim that role location defines the version.
Known assistant failures are retained. Unsupported blocks, malformed records,
attachments and orphan/unfinished tool records produce review warnings.
Attachments are not fetched or copied. Unfinished tools become explicitly
labeled reference text, because the Host import contract has no running-tool
state. Reasoning is labeled reference text rather than a source system prompt.

An active JSONL leaf selects its ancestry; sibling leaves are separately
selectable histories. Native message ordering and call/result pairing are
preserved. Desktop-claimed IDs, including deleted rows, suppress shared JSONL
projections so they cannot reappear as CLI/IDE conversations. Ambiguous or
conflicting product ownership fails closed. An unreadable recognized database
can prevent the shared discovery pass from establishing ownership; its error
is visible instead of guessing another product.

Source/profile/native IDs determine stable imported external IDs. Copies with
conflicting content are not automatically chosen by timestamp. Source bodies
are re-read and their digests checked between scan, preview and commit; stale
selections require another scan. Renderer-supplied title, project or file-path
fields cannot redirect a source read. File reads reject containment escapes
and symlinks; source paths never authorize arbitrary attachment reads.

## Limits and compatibility

Discovery is bounded to 1,000 transcript files, 500 Desktop sessions per
database, 1,000 workspace/index rows, 20,000 source messages/records per session,
32 MiB per transcript, 4 MiB per JSONL line and 64 MiB decoded Desktop payloads
per snapshot. Exceeding a limit is a visible source error, not an empty success.
Host limits still apply; the existing truncation warnings remain in force.

No authentication key lookup or proprietary decryption is attempted. Other
cache database generations, encrypted bodies without a readable transcript,
remote workspace definitions and unsupported source schemas are not claimed
as complete migrations. macOS/Windows/Linux location resolution has synthetic
tests; actual installed-product acceptance on all three systems is not implied.

## Validation

Run `node --test test/*.test.mjs`. Qoder tests use temporary files and real
temporary SQLite databases; no original application data is read. They cover
old/new roles, WAL snapshots, ordering, tools, branches, project-only detection,
missing-folder remapping, duplicate import, source mutation, deletion,
unsupported versions, containment, limits and memory exclusion. The plugin
entry test crosses the real adapter/registry/commit wiring and substitutes
only the external Host SDK.

Manual installed-plugin scenarios:

1. Scan all three source products; inspect source/project attribution, warnings
   and separate sibling histories before selecting anything.
2. Register an empty Desktop workspace without importing a conversation. With
   a multi-root workspace, verify each folder is shown and registered separately.
3. Remap a missing folder, preview and import. Open the resulting Host project
   and conversation; no repository files or memory notes should be copied.
4. Continue the imported conversation in Host, then import the source again.
   Verify it is skipped and the continuation is retained.
5. Change or delete a selected source before import. Verify the per-item failure
   is visible; retry after an explicit rescan. Source bytes remain unchanged.
6. Inspect metadata-only IDE history, unavailable attachments and an unfinished
   tool. They must not appear as a complete history, copied asset or success.

## Format references

Implementation is original. Public reader/test shapes were used as format
evidence, without vendoring third-party source:

- [QwenPaw IDE reader and synthetic tests](https://github.com/agentscope-ai/QwenPaw/tree/14b02c597aee1b314f9bd12f8813e01543c3c328/tests/unit/portability).
- [observer Desktop SQL fixture](https://github.com/superbasedapp/observer/blob/9c2759d11bcd97cc14768f4ad5268e23ed50f900/testdata/qoder/work/main-sqlite-fixture.sql).
- [spark-agent Desktop parser tests](https://github.com/alexanderizh/spark-agent/blob/cfe1da7fb591e7bc20c3e05275f8f2ef650ab723/apps/desktop/src/main/services/HistoryImport/parsers.test.ts).
- [agentschat workspace schema tests](https://github.com/mocias/agentschat/blob/87b4e059b748307f1d0c38748fd1061beb58a8ed/checks/native-registration.test.cjs).
- [Official product separation](https://docs.qoder.com/qoder/overview) and
  [source-read-only import behavior](https://docs.qoder.com/qoder/data-import).

This plugin PR is tracked by
[PI-Desktop #2229](https://github.com/vastsa/PI-Desktop/issues/2229); the Host's
plugin-owned import direction is retained.
