# yaca product design

## 1. Thesis: precise, quiet, accountable

yaca is a reading-first coding workbench. It should feel **precise** about what the agent is doing, **quiet** while the user reads, and **accountable** whenever tools or files change.

- **Precise**: Product Turns, Assistant Steps, thinking, tool declaration, execution, results, errors, and delivery state remain distinct. Source order and stable identities are preserved.
- **Quiet**: typography, spacing, subtle surfaces, and disclosure carry hierarchy. Assistant prose is not boxed, and ordinary rows do not become cards.
- **Accountable**: every command, shell invocation, file read, edit, diff, interruption, and Unknown Delivery state is inspectable. The UI never turns missing evidence into implied success.

Use React, TypeScript, Tailwind CSS, and shadcn/ui primitives. Styling lives in Tailwind theme tokens and utilities; product behavior is not hidden inside copied component CSS. Start from shadcn/ui's default character, then apply a cool neutral hierarchy with restrained cobalt for primary actions, active state, links, and focus.

Every visible action must map to a shipped Host command or explain why it is unavailable. Product-specific features outside the MVP do not appear as disabled promises.

## 2. Information architecture and shell

The desktop shell has three columns:

| Region | Default | Product role |
|---|---:|---|
| Sidebar | 280px | Workspace and Session navigation |
| Conversation | fluid, at least 640px when space permits | Primary reading and Prompt path |
| Inspector | 380px, optional | Complete tool input/output, diff, file, and error detail |

The Conversation is the last column to surrender width. As space contracts, the Inspector narrows and then closes before the Conversation drops below its preferred minimum. At narrower desktop widths the Sidebar becomes a compact rail or Sheet; complete phone adaptation is outside the MVP.

```text
┌─ Sidebar ───────┬──── Conversation ─────────────────┬─ Inspector ─────┐
│ yaca            │ Active Session / Run state       │ Selected tool   │
│ New Session     │                                  │ complete input  │
│ Workspace       │ Product Turns                    │ output / diff   │
│  Session        │                                  │ metadata        │
│  Session        │                                  │                 │
│ Add Workspace   │ Sticky Composer                  │                 │
└─────────────────┴──────────────────────────────────┴─────────────────┘
```

The Sidebar groups Sessions by Workspace and makes four states visible without relying on color: active, running, failed/interrupted, and idle. A Session inspected during another Run is selected for reading but is not labeled Active Session. The header must keep this distinction explicit. Workspace menus support a display-name edit that never implies a filesystem rename.

A separate Trash view lists Trashed Sessions with original Workspace, title, and removal time. Restore is the only trash action in the MVP. The view explains that yaca retains entries until the user manually clears its trash directory; it offers no permanent-delete control. Trashing the Active Session is unavailable while running/stopping; idle success selects the most recent surviving same-Workspace Session or the empty state.

The Inspector remains mounted while temporarily closed so disclosure, scroll, and selection survive layout toggles. Switching the inspected Session clears tool selection from the previous Session.

Overlays, menus, dialogs, toasts, and drag surfaces live at the shell root to avoid clipping by column scroll containers.

## 3. Conversation model and stable identity

The UI consumes Host projections, never raw Pi events:

```text
Session
└── Product Turn
    ├── User Prompt
    ├── Assistant Step
    │   ├── Thinking block
    │   ├── Text block
    │   └── Tool Call block + execution/result
    ├── Assistant Step
    └── terminal state
```

One accepted Prompt creates one Product Turn. Each model response and its requested tool executions form an Assistant Step. Tool loops create more Assistant Steps inside the same Product Turn.

Every Turn, Step, Block, and Tool Call has a stable Host identity. Streaming updates change one block in place. A final block replaces partial content without replacing its React key. Thinking disclosure, tool expansion, Inspector selection, code state, and scroll anchors must survive settlement.

The conversation projection has two visible layers:

- the Committed Snapshot, which remains readable through disconnect and restart;
- the Active Overlay, which contains the current Run's changing blocks.

When the Host commits a new Session Version, the Committed Snapshot replaces the corresponding overlay facts. A sequence gap or reconnect replaces local state through sync; the client does not invent missing deltas.

Assistant text uses a reading column near 748px and no message bubble. User Prompts use a subtle right-aligned surface with a bounded width. Turn-level copy, timing, model, Thinking Level, stopped, or error metadata appears once at the Product Turn tail instead of repeating after each Assistant Step.

History virtualizes by semantic Turn boundaries. Prepending older history preserves the first visible Turn's screen position rather than relying only on total scroll height.

## 4. Streaming, reading, and status

Run status is continuous across first-token wait, thinking, tool execution, and subsequent Assistant Steps. It does not flicker off when text pauses for a tool. Use factual labels such as `Working`, `Stopping`, `Interrupted`, and `Failed`; do not infer a more specific activity than the Host reports.

Auto-follow rules:

- A newly submitted Prompt moves to the active tail.
- Streaming follows only while the reader is already near the bottom.
- Scrolling upward suspends follow and reveals a `Return to latest` control.
- New deltas never steal the reading position after follow is suspended.
- Composer height changes move the tail control through measured layout, not fixed guesses.

Markdown accepts only projected text and its streaming state. Older settled blocks remain unchanged. Expensive highlighting and rich transforms may wait until block settlement. Raw HTML and unsafe links are sanitized. Incomplete streaming Markdown may be visually conservative, but final rendering must be correct.

Connection and command state remain visible:

```text
draft → awaiting acknowledgement → accepted → running → terminal
        └─ acceptance unproven ────────────────→ Unknown Delivery
                                  └─ terminal unproven ─→ Outcome Unknown
```

Reconnect atomically installs the full `app.sync` Host snapshot and global event watermark before applying buffered events. It discards duplicate sequences, uses another app sync on a gap or runtime-epoch mismatch, and never automatically resends the Prompt. Opening one Session never advances that watermark.

Unknown Delivery explains that a durable local mutation intent may not have committed, or that Prompt acceptance could not be proven. Outcome Unknown explains that Prompt acceptance is proven but the terminal result is not; after restart the UI may explain the interruption without relabeling the receipt as interrupted. Both expose an explicit `Acknowledge risk` action after full app sync. Blocking and acknowledgement follow the receipt's Host, Workspace, Session, or Run scope; a new Prompt receives a new mutation identity.

Empty and failure surfaces occupy the real shell rather than a demo layout. The same Conversation and Composer trees remain mounted when moving from empty Session to active Run.

## 5. Thinking, tools, and Inspector

Thinking is a compact disclosure row in original block order. While streaming, its summary shows the latest non-empty line so progress is perceptible without opening the full text. After settlement, the summary becomes stable. Enter, Space, click, and `aria-expanded` operate the same disclosure. Reduced motion removes the running sweep.

Tool Calls are first-class blocks, not Markdown. Declaration and execution are separate states:

- `preparing`: a dedicated declaration stream has supplied tool name and zero or more argument fragments; parsed arguments and presenter details may still be absent;
- `running`: the Host has started execution;
- `succeeded`, `failed`, or `aborted`: execution is terminal.

The compact Tool Row contains status, tool name, one factual summary, and an Inspect action. Chat expansions have bounded height; complete content belongs in the Inspector.

Dedicated presenters:

- **Read**: Workspace-relative display path, requested range, preview, truncation, and Host-retained complete text. It does not imply an SDK full-output file exists.
- **Edit/Write**: path, patch or unified diff, additions/deletions, and a Content Reference for a large diff.
- **Shell**: exact command, streaming output preview, exit code or signal, duration, truncation, and Host-retained complete output copied from the SDK's temporary path when needed.
- **Unknown**: tool name, safe formatted input, status, output preview, error, and complete content. An unknown tool never disappears or crashes the Turn.

The Inspector header names the selected Tool Call and its owning Session. It exposes complete input/output, structured details, diff, and Content Reference state. It never accepts an arbitrary file path from the browser.

Long content uses a bounded preview in Chat and Inspector streaming. `View complete content` appears only when the Host provides a valid Content Reference. If complete content could not be retained, show `Complete output unavailable` and the structured reason; silent truncation is unacceptable.

## 6. Composer and command behavior

One Composer remains mounted across empty state, active conversation, reconnect, and read-only inspection. It contains:

- an IME-safe multiline textarea;
- model and Thinking Desired Setting trigger;
- connection/delivery state where relevant;
- Send while idle or Stop while running;
- a concise reason when the current inspected Session is read-only.

Keyboard behavior:

- Enter submits only when composition is inactive and no menu owns the key.
- Shift+Enter inserts a newline.
- Escape closes the innermost popup before changing Composer state.
- Menu selection does not blur the textarea before activation.
- Primary controls remain reachable in logical Tab order.

Submission is transactional from the user's perspective. One activation creates one mutation identity, enters `awaiting acknowledgement`, and disables duplicate submission. Only a Prompt receipt uses `accepted`; local actions display committed or failed. A WebSocket acknowledgement alone is never fabricated as either outcome.

While a Run is active, the active Composer exposes Stop and allows editing the next draft but cannot submit another Prompt. Stop is bound to the visible `runId`; stale UI state receives a mismatch error instead of stopping a newer Run. When the user inspects another Session, its committed history remains interactive for reading, while the Composer explains that Prompts continue to target only the Active Session or requires returning to it.

Session create, activate, rename, trash, trash list/restore, Workspace registration, Workspace display-name update, and Workspace removal use real commands. Session removal uses an Alert Dialog and describes indefinite recoverable retention. Workspace removal states that Workspace files, Sessions, and Trashed Sessions are not deleted.

Slash commands, attachments, queueing, steering, follow-up, retry, and extension-contributed controls are absent from the MVP shell.

## 7. Model and Thinking Desired Settings

The model trigger shows the next-Run model and Thinking Level. It does not claim to be the model of the currently running Step; each Product Turn records the immutable model and Thinking snapshot used at Run start.

The selector has two keyboard-operable levels:

- Model, grouped by Provider from the Host model directory;
- Thinking Level, restricted to values the Host reports as supported for the Desired Model.

During a Run, selection updates Desired Settings. The UI labels the result `Applies to next run`. After the Run settles, the Host applies valid Desired Settings before accepting the next Prompt and reports the application state. A failed selection preserves the last accepted Desired Setting and shows a nearby structured error.

No fixed UI list may imply that every model supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The list comes from that model's Host catalog entry. The currently validated DeepSeek entry displays exactly `off`, `low`, `high`, and `max`; runtime clamping never appears as another choice.

Provider credentials never enter this UI. An unavailable credential produces an actionable Host error without revealing secret material.

## 8. Accessibility, themes, and responsive behavior

Required semantics:

- Workspace/Session navigation uses appropriate tree or grouped-list semantics with selected, active, and status text.
- Thinking and Tool Rows expose `aria-expanded` and named status.
- Model choice uses radio/menu semantics and visible selected state.
- Every icon-only button has an accessible name and Tooltip.
- Color is never the only carrier of running, failed, selected, or interrupted state.
- Disabled controls remain explainable by adjacent text or accessible description.
- Focus is never trapped behind a closed Inspector or overlay.

Light and Dark themes share semantic tokens rather than component-specific colors. The Settings control writes a Host-owned `system`, `light`, or `dark` preference. Before bootstrap, the browser may use the system preference only to avoid a blank or flashing shell; bootstrap atomically applies the persisted Host value, and update events keep multiple tabs consistent. Restart acceptance proves persistence under `~/.yaca/`.

`prefers-reduced-motion` removes sweep, large panel interpolation, and nonessential fades. State changes remain visible without animation. Normal motion uses short, consistent transitions and never animates token-by-token layout.

The minimum supported experience is desktop. Below the full three-column width, close the Inspector first, then reduce the Sidebar to a rail or Sheet. The Composer remains visible and the Conversation remains the primary surface. Complete phone interaction is outside the MVP and is not suggested by a compressed desktop imitation.

IME acceptance covers composition timing, legacy key code behavior, Safari delayed composition end, Enter, and Shift+Enter. Keyboard acceptance covers the complete Workspace → Session → Prompt → Stop → inspect-tool path.

## 9. Visual system and acceptance

The palette is cool neutral with restrained cobalt. Cobalt is reserved for primary action, active selection, focus, links, and running emphasis. Success, warning, and destructive colors appear only for their semantic states. Assistant content rests directly on the base background; Sidebar and Inspector use subtly differentiated surfaces.

Radius scale:

| Token | Use |
|---:|---|
| 4px | inline code, tiny status surfaces |
| 8px | rows, controls, compact disclosures |
| 12px | menus, code/diff surfaces, Inspector groups |
| 18px | Composer and user Prompt surface |

Use system sans with Chinese-capable fallbacks and a clear mono stack for code and terminal content. Assistant prose targets 16px with generous line height; interface text steps down through 14px, 13px, and 12px. Shadows belong to floating elements such as Composer, menus, dialogs, tooltips, and toasts, not ordinary messages.

Acceptance evidence includes:

- Light and Dark screenshots of empty Session, streaming thinking, multi-step tool loop, edit diff, shell output, error, Unknown Delivery, Outcome Unknown, Trash restore, and read-only Session inspection;
- reduced-motion capture proving state remains legible without animation;
- keyboard and screen-reader checks for navigation, Composer, Thinking, Tool Row, Inspector, model selection, dialogs, and Stop;
- long-content evidence at preview and complete-content boundaries;
- narrow desktop evidence showing Inspector-first collapse; and
- comparison against the thesis: every reviewed screen must remain precise about state, quiet in chrome, and accountable for side effects.
