# Sidecar Runtime Decision

The sidecar (filesystem watcher, git-event listener, scheduler send loop) runs
**same-process** as the MCP stdio server — no subprocess spawn, no IPC.

`SIDECAR_MODE` is `true` whenever `METABOB_STATELESS !== 'true'`; the endpoint
plays no part in the gate. It is the master switch for local state: setting
`METABOB_STATELESS=true` leaves `LocalStore` unconstructed, which also disables
`record_finding`'s local surfacing, the `get_problems` seed cache, and both
agent-resolver tools.

Three `setInterval`-backed workers start after the MCP transport connects and
share one `LocalStore` SQLite handle:

| Worker | Cadence |
|--------|---------|
| `startWatcher` | 500 ms debounce on filesystem events |
| `startGitWatcher` | 5 s poll |
| `Scheduler` | 2 s send loop |

Watchers run even in anonymous mode; the scheduler starts only when
`METABOB_API_KEY` is set.

The git watcher invokes git with `--no-optional-locks`, because `status` and
`diff` otherwise refresh the index and take `.git/index.lock`. It also skips a
tick entirely while an operation is in flight — `index.lock`, `rebase-merge`,
`rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` —
so polling never contends with the user's own git commands, and a rebase does
not re-enqueue the tracked-modified set at every replayed step.
