# Import discovery and source errors

Opening the importer panel discovers local sources after locale and custom-source
initialization. App startup only registers the plugin; it does not scan histories.
Discovery reads supported local stores, never imports conversations, registers
projects, extracts memory, or invokes a model. Those writes remain explicit.

Rescan refreshes source caches, is disabled only while scanning, and becomes
available after success or failure. Initial discovery retains existing fast
scanners. An older background poll cannot overwrite a newer rescan's state.

A missing ZCode database returns no histories without creating source folders or
opening SQLite. Missing paths are distinguished from permission errors. Empty or
absent histories display “No history found”. EPERM/EACCES stays visible with a
localized file/system-permission hint; healthy partial results remain selectable.
Raw diagnostics are retained in the card tooltip and long errors wrap inside the
card. An OS denial is not bypassed, classified as corruption, or silently hidden.

Reproduction: in a disposable empty HOME, opening/scanning ZCode previously threw
`unable to open database file` from SQLite rather than returning no histories.
The panel previously made zero scan calls until clicking Scan and never re-enabled
the scan button afterwards. Tests use synthetic homes and the actual view script
with a small DOM fixture. Run `node --test test/*.test.mjs`.

Native installed-client and OS permission-grant workflows are not covered by the
synthetic tests. A runtime-specific EPERM alone does not establish which macOS
privacy or filesystem policy denied access.
