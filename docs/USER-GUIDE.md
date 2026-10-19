# Metabob MCP user guide

This guide describes `@metabob/mcp` 0.3.0. Substrate capabilities depend on the connected deployment. This guide is for technical operators using an MCP-compatible agent to investigate code, preserve decisions, and coordinate work across sessions.

## 1. What you can accomplish

Metabob MCP runs beside your agent as a sidecar: a separate process that exposes tools through Model Context Protocol (MCP). It connects the agent to local code analysis and, when configured, shared knowledge and execution services.

Use it to:

- Find dependencies and likely affected tests before changing code.
- Record findings, decisions, and explanations that another session can retrieve.
- Delegate a bounded goal to a connected execution service and inspect its result.
- Answer questions returned by that service and record feedback about outcomes.

The agent still does the reasoning. Metabob supplies tools, persistent records, and coordination channels. Shared memory does not automatically establish agreement, correctness, or authority.

### Choose a starting path

| Your immediate task | Start here | Required services |
|---|---|---|
| Understand the impact of a code change | [Connect](#2-connect-your-agent), then [investigate](#3-first-task-investigate-a-change) | Local runtime |
| Share a finding or decision | [Preserve knowledge](#4-preserve-knowledge-another-session-can-use) | Local storage; concept-db for shared recall |
| Coordinate multiple agents | [Coordinate work](#5-coordinate-agents-and-delegated-work) | Shared concept-db; goal-host for delegated execution |
| Develop reusable procedures | [Develop procedures](#6-turn-experience-into-reusable-procedures) | Shared memory; execution services when evaluating delegated procedures |
| Set boundaries and review outcomes | [Steer behavior](#7-steer-behavior-and-review-authority) | Agent/tool permissions plus the relevant connected services |

The **substrate** is the collection of backend services. A **vessel** is a service advertising a capability. A **shape** names a type of knowledge or request. A **concept** is a stored knowledge record. You will encounter these terms in tool results.

## 2. Connect your agent

### Prerequisites

Use an MCP client that supports stdio servers, Node.js 18 or later, and Bun 1.1 or later on PATH. The launcher starts under Node and runs the server under Bun. `--help`, `--version`, and `doctor` can run under Node alone. For corporate TLS interception, the repository recommends Bun 1.2.23 or later.

For substrate access, you need an API key and a reachable substrate: the substrate installer writes both into `~/.substrate/config.json`. Installing this package does not install a substrate. See the [README](../README.md) for platform details, credentials, and client-specific setup.

For shared memory or delegated work, obtain the following from your deployment operator: the gateway endpoint, credentials and their access scope, available services, backend workspace location, and permitted operations. Use `registry_query` to check advertised capabilities once connected. Account provisioning and backend deployment are managed separately from this package.

### Configure the server

Add this server entry using your MCP client's configuration interface. The enclosing configuration format varies by client; this is the common `mcpServers` format:

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": ["@metabob/mcp@0.3.0"],
      "env": {
        "WORKSPACE_PATH": "/absolute/path/to/your/repository"
      }
    }
  }
}
```

The version is pinned to the version this guide describes. When the substrate installer has run, nothing else is needed: the server reads the config it wrote. Otherwise supply the key and endpoint through your client's environment settings (`METABOB_API_KEY` and `METABOB_ENDPOINT`, or `SUBSTRATE_API_KEY` and `SUBSTRATE_ENDPOINT`) or a config file such as `~/.substrate/config.json`:

```json
{
  "metabob": {
    "apiKey": "mb_your_api_key_here",
    "endpoint": "http://127.0.0.1:18080"
  }
}
```

Use your substrate's endpoint; there is no default. Keep credentials out of committed configuration. Config-file selection checks `SUBSTRATE_CONFIG_PATH`, then `METABOB_CONFIG_PATH`, then `.substrate/config.json` and `.metabob/config.json` in the server's launch directory, then `~/.substrate/config.json` and `~/.metabob/config.json`. A `.metabob/config.json` written by another tool (with no `metabob` section) is skipped with a warning, so it never hides your installer config. CLI flags override environment settings, which override file settings. Advanced endpoint overrides are documented in the [specification](SPEC.md#configuration).

Reconnect the MCP client. Confirm that it lists tools such as `init_workspace` and `analyze_impact`. Running the server in a terminal alone does not connect it to your agent. To check the connection to the substrate, run `npx @metabob/mcp@0.3.0 attach --check`: it reports each step (proxy, TLS, `/bootstrap`, identity, the key check, one read) and names the cause when one fails.

### Quick start after connecting

Ask your agent:

> Initialize this repository, report the indexed coverage, and analyze the impact of changing a file I name. Explain the affected components and tests before editing anything.

This first task needs no shared-memory or execution backend. Continue with section 3 for the exact tool arguments. Add shared memory after local analysis works; add delegated execution after confirming backend permissions and resource access.

### Understand where data goes

| Action | Data and effect |
|---|---|
| `init_workspace`, `analyze_impact`, `predict_cochanges`, `search_codebase` | Run on the local code index; send nothing off the machine |
| `record_finding` | Writes local findings and attempts to share them with concept-db |
| `concept_create` / `concept_link` | Writes knowledge or relationships to the connected concept-db |
| `run_goal_async` | Starts substrate execution; available capabilities may edit files or create commits |
| `provide_feedback` / `concept_record_usage` | Writes outcome feedback to backend services |

No workspace content leaves the machine: the server uploads no source files, and it registers nothing with the substrate. What reaches the substrate is what the tools above write. Sharing and access boundaries depend on deployment configuration. A repository name or a label in a concept is not an access-control rule.

## 3. First task: investigate a change

Ask your agent:

> Initialize this repository. Analyze the impact of changing `src/example.ts`, include affected tests, and explain the dependencies you found before making edits.

Replace the path with a real file in your repository. The following blocks are MCP tool arguments, not shell commands. You can ask the agent to make these calls or use your client's tool interface.

**Call `init_workspace`:**

```json
{
  "workspace_path": "/absolute/path/to/your/repository"
}
```

Check the reported file and component counts. If it reports unparsed files, call it again to continue. The scanner currently limits discovery to 2,000 eligible paths and skips files over 200,000 bytes; a large repository may require initializing a narrower directory. Default extensions cover JavaScript, TypeScript, and Python. Excluded directories and unsupported files are outside this analysis.

**Call `analyze_impact`:**

```json
{
  "changed_files": ["src/example.ts"],
  "direction": "both",
  "include_tests": true
}
```

Expected result: affected components and dependency information within the indexed code. Inspect relevant source and run appropriate tests before treating the proposed impact as complete. Dynamic behavior and unindexed code can leave gaps.

Use `predict_cochanges` for additional git-history hints. Its bundled GCN ranking is based on name features; a GCN-only suggestion is not evidence of a structural dependency.

**Success check:** the agent can explain an affected component, locate the supporting code, and identify what still needs verification.

## 4. Preserve knowledge another session can use

### Record an issue

After verifying an issue, call `record_finding` with its evidence. This example is illustrative; do not record it unless it describes a real finding:

```json
{
  "files": ["src/example.ts"],
  "summary": "Retry handler repeats a non-idempotent write",
  "details": "Record the triggering condition, observed behavior, and reproduction or test here.",
  "severity": "HIGH",
  "category": "correctness"
}
```

Save the returned `agf_*` ID and any shared concept ID. Read the result for sharing failures: local persistence can succeed while concept-db is unavailable. Another agent can call `get_problems` to recall shared findings, but a failed or truncated recall is not evidence that no findings exist.

After fixing and verifying the issue, call `mark_complete` with its returned ID and `action: "endorse"`. Use `action: "discard"` for a false positive. Discarding a local finding does not delete the original shared concept; shared verdict writes are best-effort. Read the result to see what was updated.

### Preserve a decision or procedure

Use `concept_create` for knowledge beyond individual code findings:

```json
{
  "shape": "review_procedure",
  "source_type": "memo",
  "summary": "Review retry changes for duplicate writes",
  "content": "Scope: this repository's write path. Before changing retries, inspect idempotency handling and test a timeout after the server accepts the write. Evidence: add the actual test and commit references. Owner: add the responsible reviewer. Review again when the write protocol changes."
}
```

`review_procedure` is a user-chosen label. It does not install a runnable skill. Include the scope, reasoning, evidence, owner, and conditions that would invalidate the advice. These are conventions in the content, not enforced fields.

Retrieve it with `concept_search`:

```json
{
  "query": "retry duplicate writes",
  "shape": "review_procedure",
  "content": "full",
  "limit": 5
}
```

If semantic search misses a known record, try list mode with `shape` and no `query`, or read it directly with `{"concept_id": "<returned concept ID>"}`. Search previews can truncate important conditions; read the full body before acting.

Use `concept_link` to connect relevant records with relationships such as `related_to`, `example_of`, or `contradicts`. A contradiction edge preserves disagreement; it does not decide which record is correct. Record the reviewer's resolution and evidence explicitly.

**Success check:** start a fresh session against the same backend and retrieve the decision by ID and by a relevant query. The agent should recover the reasoning and applicability conditions, not just the title.

## 5. Coordinate agents and delegated work

### Give each agent a bounded assignment

Record the goal, owned files or resources, constraints, evidence required, and reviewer. Have each agent recall that brief before starting. Assign distinct ownership or isolated working copies when multiple agents edit code.

Shared records help agents exchange conclusions, rejected approaches, and unresolved questions. The current tools do not provide a consensus protocol or guarantee conflict-free execution. Task claims are advisory, so multiple agents can receive the same task.

### Delegate to the connected execution service

First call `registry_query` with `{"mode": "shapes"}` to inspect available capabilities. An advertised capability still needs working services, credentials, and access to the relevant resources. Your local repository path is not automatically available on the backend.

Choose a small goal appropriate to that deployment. Call `run_goal_async` with a `goal` describing the intended outcome, scope, constraints, and acceptance evidence. This starts execution; it is not a preview. A dispatch is a learning run by default; for a probe that should not teach the substrate, pass `learning_mode: "observe"` and a tag such as `probe:<name>`. The reply states the mode as requested, and the `learning:` line of `goal_status` shows what the walk actually taught. Natural-language limits should be backed by actual tool permissions when they must be enforced.

Follow this sequence:

1. Save the returned `dispatchId`.
2. Call `goal_status` with `{"dispatch_id": "<returned dispatch ID>"}` until execution ends: a few quick checks, then 10–15 seconds apart.
3. Inspect the `reached` verdict and call `goal_reasoning` with the same `dispatch_id`.
4. When an execution ID is available, use `execution_trace` with `{"execution_id": "<returned execution ID>"}`.
5. Inspect the actual output, diff, or tests against the acceptance criteria.
6. Record a verdict with `provide_feedback`.

For example, after a partially successful run:

```json
{
  "dispatch_id": "<returned dispatch ID>",
  "verdict": "partial",
  "rationale": "The requested output exists, but the required failure-case test is missing.",
  "confidence": 0.9
}
```

`completed` describes execution status; it does not prove the goal was reached. Even a positive reach verdict needs checking against the actual result. Some executions lack a template trace; inspect `goal_reasoning` for the walk log. Feedback requires execution/template metadata and can fail when those records are missing. Save the dispatch ID, execution ID, selected template, output references, and your acceptance criteria; review promptly.

If the dispatch has been pruned, `provide_feedback` cannot recover it from an execution ID. Preserve your verdict, evidence, reviewer, and saved IDs in a `memo` concept or your team's review system, and ask the deployment operator to reconcile it. This preserves the assessment but does not attach a goal-verification label to the missing dispatch.

### Questions from the substrate

The server is a client of the substrate: it advertises nothing, so the substrate dispatches no questions to your agent, and `pull_assigned_work` reports that no task can arrive. A person answers the substrate's questions through its human surface. `submit_resolution` still delivers an answer to a task already in the local queue (`~/.metabob/sidecar.db`).

**Success check:** a second agent recovers its assignment from the shared ledger, returns an evidence-backed result, and the reviewer can connect that result to the original task without conflicting edits.

## 6. Turn experience into reusable procedures

The present workflow combines tool support with agent and human review:

1. Capture a successful execution, its input conditions, and verification evidence.
2. Ask an agent to draft a procedure specifying prerequisites, steps, expected results, exceptions, and escalation conditions.
3. Store the candidate with `concept_create`; use `memo` for authored guidance or `extracted` for an observed pattern derived from evidence.
4. Evaluate it on another representative case and on a case where it should not apply.
5. Record `concept_record_usage` with the candidate's `concept_id` and `outcome: "success"`, `"failure"`, or `"neutral"` according to the observed result. Include a real `trace_id` when available.
6. Have the responsible owner review the evidence before packaging it into an agent skill or registering an executable workflow using that environment's mechanisms.

Track each procedure through the following states in its content or your team's existing workflow system. These are recommended operating conventions; Metabob does not enforce these transitions:

| State | Evidence needed to advance |
|---|---|
| Candidate | Scope, prerequisites, steps, exceptions, owner, and source evidence recorded |
| Evaluated | Results from a representative case and a case where the procedure must decline or escalate |
| Approved | Named reviewer, procedure version, permitted actions, policy version, and review date recorded |
| Deployed | Skill or workflow installed through the execution environment, with matching permissions |
| Withdrawn | Execution permissions or registration removed in that environment; replacement or withdrawal reason recorded for future recall |

Concept usage contributes to backend relevance scoring. The documented score is `(times_succeeded + 1) / (times_loaded + 2)`: successful usage increases both counts, while failure and neutral usage add a load without success credit. Neutral usage therefore lowers the score; it should not be interpreted as a pull toward 0.5. It does not certify safety, establish causal effectiveness, or grant execution permissions. `concept_sequence` can expose observed sequences when the backend has accumulated them; an empty result is possible.

This repository supplies memory, relationship, feedback, and execution interfaces. A complete automatic process for generating, testing, approving, deploying, and revoking skills is not established here. Packaging and promotion remain explicit work.

### Example application: security operations

An operator could capture a known faulty-port alert with the exact device, port, time window, supporting ticket, and escalation owner. A candidate procedure could compare a new alert against those conditions and flag mismatches for review. Test it with a simultaneous alert from a different device to ensure that familiar noise does not hide a separate incident.

This is an application design example. The repository does not establish ready-made SOC connectors, production alert suppression, or measured security outcomes. Those integrations and evaluations would be part of building the application.

## 7. Steer behavior and review authority

Humans can specify goals and constraints, preserve decisions, resolve disagreements, inspect execution evidence, and record corrections. Separate the information an agent should consider from the permissions its tools actually hold.

| Operator action | What it does today | Boundary |
|---|---|---|
| Put scope and escalation rules in assignments and concepts | Makes instructions available for recall | Agent must retrieve and follow them |
| Inspect `goal_reasoning` and `execution_trace` | Exposes available decision and execution records | Does not by itself prevent an action |
| Use `provide_feedback` | Stores the agent's verdict as an `automated` goal-verification label | Not ground truth: goal-host does not overwrite a reach verdict with it |
| Use `concept_record_usage` | Supplies a relevance signal | Relevance is not authorization |
| Set `MB_OPERATOR_ID` | Adds a configured operator identifier to relevant records | Identifier is not proof that a human reviewed them |
| Restrict credentials, tool permissions, or backend execution rights | Enforces boundaries in the configured systems | Must be configured outside a stored concept |

Before enabling a procedure to act, identify who owns its approval, which resources it can change, what evidence is required, and how its permissions can be withdrawn. Record those decisions alongside the procedure. The current MCP surface does not establish a complete approval, expiry, or revocation lifecycle.

For feedback, state in the rationale whether the evidence was reviewed by a human or assessed by an agent. `provide_feedback` labels every verdict `automated`, because an agent's key writes it; a person's verdict is recorded through the substrate's human surface.

## 8. Troubleshooting

| Symptom | What to check next |
|---|---|
| MCP tools do not appear | Check client logs, Node/Bun on PATH, server entry, and reconnect |
| Local analysis has no components | Check workspace path, supported extensions, exclusions, parse progress, and scan limits |
| A substrate tool answers with a named cause (`key_rejected`, `anchor_unreachable`, `proxy_auth_required`, …) | Run `attach --check`; the cause is the attachment's state, not a transient error |
| Shared concept is missing | Check the original write result, backend/credentials, full-body direct read, and list-mode search |
| Discovery cannot locate a service | Use `registry_query`; ask the deployment operator to check service registration and endpoint configuration |
| Same task reaches multiple agents | Use explicit ownership or isolation; claims are not exclusive locks |
| Answer was recorded but goal did not resume | Check delivery message and `goal_reasoning`; terminal delivery failure does not retry |
| Goal completed but output is wrong | Inspect actual artifacts, record a supported feedback verdict, and revise the assignment |
| Feedback cannot be recorded | Check dispatch availability and execution/template metadata; preserve the review in a separate durable record if necessary |
| Corporate TLS connection fails | Run `npx @metabob/mcp@0.3.0 doctor` and inspect the report with the deployment/IT operator |

The doctor creates a JSON diagnostic artifact in the current directory and does not require an API key. Review the artifact before sharing it.

## 9. Check your deployment before expanding use

Walk through the workflow on your actual deployment with a new user and a bounded task:

1. Complete the local impact investigation and check coverage against the relevant source files.
2. Record a real, harmless finding; recover it in a second session; close it and confirm the visible result.
3. Retrieve a decision by ID and query, including the full conditions under which it applies.
4. Delegate an authorized goal, inspect its output, and record feedback while dispatch metadata is available.
5. In a test environment, check restart recovery, unavailable services, and duplicate assignments.
6. Evaluate one candidate procedure on both a matching and a nonmatching case before approving broader use.

Save actual tool outputs with sensitive information removed. Note time to the first useful result, assistance needed, recall failures, duplicate work, and whether the next user avoided repeating an investigation. These observations establish whether preserved experience improves the workflow. Concept counts and successful tool responses alone do not establish that benefit.

## 10. References and scope

- [README](../README.md): installation and configuration reference.
- [Tool specification](SPEC.md): parameters and backend behavior.
- [Coordination demonstration](COORDINATION-DEMONSTRATION.md): demonstrated results and known coordination limitations.
- [Value hypothesis](METABOB-VALUE-HYPOTHESIS.md): evaluation of where shared memory adds value.

This guide was checked against repository source and existing evaluation notes. Its connected-backend workflows still require a fresh end-to-end walkthrough on the deployment used by the reader.
