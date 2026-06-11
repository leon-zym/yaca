# yaca MVP scope

## Product promise

yaca is a desktop-first, local, single-user AI coding agent. Running `yaca` opens a loopback-only Web UI where a user can select a Workspace and Session, submit a Prompt, observe the complete agent loop, stop it, and recover the durable conversation after refresh, disconnection, or Host restart.

The browser never contacts a model Provider or executes tools. The Host is the only authority, and every yaca-owned persistent file lives under `~/.yaca/`.

## Required vertical path

The release path is complete only when a user can:

1. install yaca in a clean supported environment and start it with `yaca`;
2. register or select a Workspace;
3. create or open a Session, and recover a Trashed Session when needed;
4. choose a model and Thinking Level for the next Run;
5. submit a Prompt to a real model Provider;
6. observe Assistant text, thinking, tool calls, tool results, errors, and Run state as they occur;
7. inspect a file read, a file edit or diff, and a shell command in dedicated views;
8. verify a real Workspace file change without using the Pi TUI;
9. stop a controlled long-running Run;
10. refresh, disconnect, and restart the Host without automatic Prompt replay or duplicated submission; and
11. reopen the Session and inspect its Committed Snapshot.

## Included product capabilities

### Workspace and Session

- Register, list, select, update the display name of, and remove Workspace registrations.
- Validate Workspace paths as canonical, existing, directory, readable, searchable, and writable before registration; reject canonical duplicates.
- List, create, activate, inspect, rename, recoverably trash, list trashed, and restore Sessions.
- Retain Trashed Sessions and their referenced content indefinitely. The MVP has no permanent-delete command; users may clear `~/.yaca/trash/` manually.
- Run one Active Session at a time.
- Inspect another Session's Committed Snapshot while the Active Session is running; inspection does not replace the runtime.
- Change the Active Session only while no Run is active.

### Agent loop

- Submit a text Prompt while idle.
- Stream Product Turns containing source-ordered Assistant Steps and Content Blocks.
- Present thinking, text, tool declaration, tool execution, result, error, abort, and terminal state.
- Stop only the exact active `runId` observed by the caller and wait for the runtime to become idle; reject stale or mismatched Stop commands.
- Reject a second Prompt while a Run is active.

### Model controls

- List models made available by the Host's model runtime.
- Select a model and Thinking Level as Desired Settings.
- Preserve the model and Thinking Level snapshot used by an already-running Run.
- Apply accepted Desired Settings before the next Run and show that timing in the UI.
- Present only Thinking Levels declared by the selected model's catalog entry. The validated DeepSeek catalog currently exposes `off`, `low`, `high`, and `max`; internal clamping is never presented as an available choice.

### Tool presentation

- Dedicated read view with path, range, truncation, and complete-content access where available.
- Dedicated edit/write view with patch or diff and affected path.
- Dedicated shell view with command, streaming output, exit state, truncation, and complete-content access where available.
- A generic, safe fallback for every unknown tool.

### Resilience

- Reconcile realtime state with a bounded Host snapshot and an atomic event-sequence watermark after refresh or connection loss.
- Record state-changing command delivery durably before invoking the coding-agent runtime.
- Return an existing Command Receipt for a duplicate mutation identifier.
- Distinguish Unknown Delivery, where runtime acceptance is unproven, from Outcome Unknown, where acceptance is proven but no terminal result is durable.
- Never automatically replay either unknown state. Require sync and explicit risk acknowledgement before another side-effecting mutation for the affected Session.
- Rebuild committed conversation state from the durable Session after Host restart.
- Preserve partial visible output as interrupted when the Host can still prove it; otherwise show the Committed Snapshot and interruption explicitly.
- Persist the minimum Run identity envelope needed to relate the Prompt receipt, Run, Product Turn, Session, runtime projection epoch, and pre-Run Session Version.

### Product quality

- Useful first-run, no-Workspace, empty-Session, unavailable-model, disconnected, interrupted, failed, long-content, and unknown-tool states.
- Keyboard-complete primary paths, IME-safe submission, visible focus, and semantic controls.
- Light and Dark themes and `prefers-reduced-motion` support.
- A Host-owned `system`, `light`, or `dark` theme preference returned by bootstrap, updated through the application protocol, persisted under `~/.yaca/`, broadcast to connected clients, and verified across Host restart.
- Desktop visual review at the target three-column layout and narrower desktop breakpoints.
- No visible control without a working command or an explicit unavailable reason.

## Deliberate non-scope

The MVP does not include:

- public-network listening, remote access, accounts, organizations, RBAC, or collaboration;
- multiple active runtimes or parallel Runs;
- containers, virtual machines, or a security sandbox;
- Provider credential management UI;
- Pi Packages, Extensions, Skills, structured extension UI, or TUI component compatibility;
- steer, follow-up queues, retry, compact, fork, tree navigation, import, or full Pi TUI parity;
- attachments, a general artifact system, Trajectory, or complete mobile layouts;
- browser-to-Provider calls, browser-held Provider credentials, or browser-authoritative Session storage.

Workspace registration is an operating scope, not a sandbox. The local agent and shell execute with the user's OS permissions and can access paths outside the Workspace.

## Capability gates

SDK repository research confirms that the public 0.84.2 package exposes the required session factory/runtime, event, tool, model, Thinking Level, abort, and JSONL reopen surfaces. Release claims still require the following executable gates against the installed package:

1. Every SDK-owned credential, model, settings, Session, and auxiliary path is directed under `~/.yaca/`; startup fails closed if a yaca-owned write resolves elsewhere.
2. Runtime replacement re-subscribes without duplicate events, and a reopened JSONL produces the expected Committed Snapshot.
3. Product Turn settlement is mapped from public events without ending early during retry or tool loops.
4. Abort reaches idle deterministically and produces a truthful terminal projection.
5. `DEEPSEEK_API_KEY` works through the public model runtime without being written to repository files, responses, ordinary logs, or screenshots.
6. Supported Thinking Levels are read from the model catalog. For the currently validated DeepSeek model, fixtures and UI choices contain exactly `off`, `low`, `high`, and `max`; runtime clamp behavior does not add choices.
7. Read has no `fullOutputPath`, so the Host captures its complete returned content directly into Content Store when it crosses the realtime preview bound.
8. Bash temporary `fullOutputPath` content is copied into Content Store before the temporary path can expire.
9. Large edit/write diffs are persisted in Content Store before realtime projection; the dedicated view receives a bounded preview and opaque Content Reference.
10. Parallel tool completions are joined by `toolCallId` and retain declaration order in Product Turns.
11. Every runtime replacement or Host restart creates a new runtime projection epoch; old-epoch Active Overlay events are rejected.

## Release gates

The MVP is releasable only when:

- formatting, static checks, type checks, automated tests, and the production build pass from the lockfile;
- protocol compatibility, projection, Command Ledger, Pi adapter, reconnect, and restart suites pass;
- Playwright covers the required vertical path, Stop with exact Run identity, model/Thinking timing, theme restart persistence, trash/list/restore, refresh, forced connection loss, and Host restart;
- a real DeepSeek acceptance Run performs a tool call and file modification without exposing its credential;
- Light, Dark, reduced-motion, keyboard, long-content, and empty/error states have independent evidence;
- documentation describes the shipped behavior and known limits without placeholders or future features presented as current; and
- an independent review has no unresolved blocking or high-risk finding.
