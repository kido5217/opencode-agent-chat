# Agent Chat

opencode v2 plugin that gives a session's main agent and subagents a shared, SQLite-backed chat for discussing project status and asking questions.

## Language

**Chat**:
The append-only log of messages belonging to one opencode session. A session's agents read from and post to its chat.
_Avoid_: Channel, room, thread, conversation

**Participant**:
An agent connected to a chat — the main agent or a live subagent — identified by its opencode session id. It joins when its session starts and leaves when its execution reaches a terminal state.
_Avoid_: Member, user, peer, teammate

**Main agent**:
The agent driving the root session; shown in the chat as `main`.
_Avoid_: Lead, orchestrator, parent

**Subagent**:
An agent spawned into a child session; it joins the chat when spawned and leaves when it finishes.
_Avoid_: Worker, child agent, minion

**Message**:
One append-only entry in a chat: sender, kind, optional recipient and parent, body, timestamp. Never edited or deleted.
_Avoid_: Post, entry, event, DM

**Kind**:
The role a message plays: `status`, `question`, `answer`, `blocker`, `finding`, `handoff`, or `system` (join/leave notices).
_Avoid_: Type, category, tag

**System message**:
An append-only message recording a membership change (`explore joined`, `explore left (completed)`), sent by the system rather than an agent.
_Avoid_: Notice, event, join message

**Open question**:
A message of kind `question` with no `answer` replying to it; derived by query, never stored.
_Avoid_: Pending question, ticket, task, request

**Cursor**:
The id of the last message a participant has read; drives what the unread digest shows.
_Avoid_: Offset, watermark, pointer

**Digest**:
The compact unread summary injected into a participant's context at its next model request.
_Avoid_: Inbox, notification, feed

**Join briefing**:
The first digest a participant receives after joining a chat: recent messages, open questions, and a history count; the participant's cursor starts at the latest message.
_Avoid_: Welcome message, backlog, catch-up

**Roster**:
The set of participants currently connected to a chat; a session whose execution has finished is not in it.
_Avoid_: Member list, presence, directory

**Chat handle**:
A participant's entry point to a chat. All of a participant's chat traffic — posts, reads, roster, and deliveries — flows through its handle.
_Avoid_: Client, facade, connection
