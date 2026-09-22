# Task design — peer-required tasks

The task you hand a subagent decides whether the chat is used or neutered.

## The test

Before you launch, ask: **can this child complete the task without talking to anyone?**
Yes, and no peer input was needed — fine, silence is correct. Yes, but a peer's input
*would* have been needed — you wrote it away; rewrite around the one thing that belongs
to the peer. No, a peer-held fact or decision is genuinely required — the shape is right.

## Shaping a peer-required task

Keep the briefing self-contained about everything the child can safely act on; leave out
exactly one thing that genuinely belongs to the peer — a legitimate block, not
manufactured trivia:

- **Withheld fact** — a value only the peer holds (a codename, a prior decision); do not
  paste it into the briefing.
- **Cross-agent decision** — the task hinges on a call only the peer can make; the child
  asks, it does not assume.
- **Peer-state verification** — confirm what a peer produced rather than re-derive it.

## Anti-patterns

- **Self-contained by construction** — every value and expectation in the briefing.
- **The child's own question** — a question the task itself requires the child to answer.
- **Reachable trivia** — a question the child could reach by itself; asking is noise.

## Worked pairs

- Self-contained → silence: "Migrate the config loader to bun:sqlite and add tests."
  Nothing depends on a peer; the child finishes and says nothing.
- Peer-required → ask: "Set `stagingCodename` in `config.json`; `docs/staging.md` says
  where the value comes from — check it." The value is peer-held and absent from the
  briefing; the child's next correct move is a question.

This complements — never weakens — normal briefing discipline: the only thing left out is
the one thing that belongs to the peer.
