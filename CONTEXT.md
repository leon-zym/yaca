# yaca

yaca is a local coding workspace where one Host runs AI-assisted work and presents its durable history through a browser.

## Language

**Host**:
The local authority that owns coding-agent execution, credentials, workspaces, sessions, and durable state.
_Avoid_: Backend, server

**Workspace**:
A user-registered project root in which yaca may run an agent and its tools.
_Avoid_: Project, repository

**Session**:
A durable conversation associated with one Workspace.
_Avoid_: Chat, thread

**Active Session**:
The single Session currently attached to the live agent runtime. Other Sessions may be inspected as committed history while it runs.
_Avoid_: Current chat, selected thread

**Run**:
The execution created by one accepted user Prompt, ending in success, failure, interruption, or abort.
_Avoid_: Job, request

**Product Turn**:
The user-visible record of one Run, containing the Prompt and every Assistant Step produced before the Run terminates.
_Avoid_: Message group, Pi turn

**Assistant Step**:
One model response together with the tool executions it requests. A Product Turn may contain multiple Assistant Steps.
_Avoid_: Turn, response

**Content Block**:
A source-ordered piece of an Assistant Step: thinking, text, a tool call, or an error.
_Avoid_: Message part, card

**Committed Snapshot**:
The durable, read-only view of a Session that the Host can reconstruct after restart.
_Avoid_: Cache, transcript

**Active Overlay**:
The still-changing view of a live Run before its content is reconciled into a Committed Snapshot.
_Avoid_: Draft response, streaming message

**Command Receipt**:
The Host's durable, scoped record of whether a state-changing command was recorded and reached the outcome appropriate to its Host, Workspace, Session, or Run scope.
_Avoid_: Event, response

**Unknown Delivery**:
A terminal command outcome in which intent is durable but the Host cannot prove that the intended local change committed or that a Prompt was accepted.
_Avoid_: Failed, pending

**Outcome Unknown**:
A terminal command outcome in which runtime acceptance is proven but completion, failure, or abort cannot be proven after interruption.
_Avoid_: Unknown Delivery, failed

**Desired Setting**:
A model or Thinking Level selection recorded for the next Run without changing a Run already in progress.
_Avoid_: Current model, live setting

**Content Reference**:
An opaque, authorized reference to complete content that is too large for the realtime protocol.
_Avoid_: File path, blob URL

**Trashed Session**:
A recoverable Session removed from the active Session catalog and retained until the user manually clears it.
_Avoid_: Deleted Session, archived Session
