# Sidecar Runtime Decision

The sidecar (filesystem watcher, git-event listener, scheduler send loop) runs
**same-process** as the MCP stdio server — no subprocess spawn, no IPC.

When `METABOB_STATELESS !== 'true'` and the configured `ANALYSIS_API_URL` is not
`ide.metabob.com`, `SIDECAR_MODE` is `true`. Three `setInterval`-backed workers
start after the MCP transport connects: `startWatcher` (500 ms debounce),
`startGitWatcher` (5 s poll), and `Scheduler` (2 s send loop). All share the same
`LocalStore` SQLite handle. Watchers run even in anonymous mode; the scheduler
only starts when `METABOB_API_KEY` is set.
