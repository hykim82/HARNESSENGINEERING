# relay-watch (HYK-118)

## Problem

While the Orchestrator waits on a worker (CODER/REVIEW/VERIFY), two costs
accumulate purely from idling: the prompt cache's 5-minute TTL lapses if the
Orchestrator's own session goes quiet that long, forcing a cold (full-price,
slower) reprocess on the next turn; and nothing consumes a worker's result
the moment it lands — a human still has to notice completion and type
"완료" before the Orchestrator's turn resumes. `scripts/relay/watch-result.mjs`
is a small background loop the Orchestrator runs right after dropping a task,
so the same turn that drops the task can also detect and consume the result
without waiting on a human relay.

## Usage

Run in the background immediately after dropping `<role>-task.md`:

```sh
node scripts/relay/watch-result.mjs --role coder --interval-s 60 --max-wait-s 240
```

- **`--role <coder|review|verify>`** (required): which `.harness/<role>-task.md`
  / `.harness/<role>.md` pair to watch — passed straight through to
  `checkRelayHandshake` (`scripts/check/relay-handshake.mjs`), so "done"
  means the same thing it already means everywhere else in this harness:
  matching `task_id`, a parseable `dropped_at`/DONE timestamp pair, and the
  DONE time not predating the drop.
- **`--interval-s <n>`** (default `60`): how often to poll.
- **`--max-wait-s <n>`** (default `240`): the keep-alive tick threshold. If
  the worker still isn't done after this many seconds, the process exits
  anyway (**exit `3`**) instead of continuing to poll forever — the
  Orchestrator's own turn ending and restarting is what refreshes the
  Orchestrator's cache, so a keep-alive tick's job is just to end the turn
  periodically, not to keep watching indefinitely. Re-run the same command
  again for another `max-wait-s` window.
- **`--max-wait-s 0`**: **plain mode** — ignore the keep-alive threshold
  entirely and keep polling until the worker is actually done. Use this when
  stepping away (no Orchestrator turn is expected to wake up and re-arm the
  watch), since there is no one to restart the loop after a tick.

### Exit codes

- **`0`**: worker done. Stdout: `RESULT: <role> done (<reason>)`. The
  Orchestrator consumes the result immediately in the same turn.
- **`3`**: keep-alive tick — still not done after `max-wait-s`. Stdout:
  `TICK: <role> not done after <n>s (keep-alive tick)`. The Orchestrator
  re-arms (runs the command again) if it's still waiting, or asks whether to
  keep waiting after repeated ticks (see limitation ① below, HYK-112 spirit).

Both paths print exactly one line — this loop's whole purpose is to save
tokens on an idle wait, so its own output stays minimal.

## Cost rationale (why polling at all)

A cold reprocess (cache miss) costs roughly the same as a fresh conversation
turn; a keep-alive ping (ending and restarting a turn just to keep the cache
warm) costs much less — reading this document's own numbers, on the order of
~10% of a cold turn. For a wait under about 40 minutes, keep-alive pings are
cheaper in aggregate than eating one cold reprocess at the end; past that
break-even point the pings' cumulative cost starts to exceed a single cold
reprocess, so a very long unattended wait should prefer plain mode
(`--max-wait-s 0`) over repeated short keep-alive cycles. This ~40-minute
figure and the ~10% ping-cost estimate are both **arithmetic from the stated
cache-TTL/reprocess-cost assumptions, not a measurement of a live run** — see
limitation ③.

## Known limitations (honest, per this harness's own convention)

1. **"go" is still a human's job.** This loop only tells you whether the
   worker's *result* is done — it has no way to know whether a worker was
   actually started at all. If nobody has typed `go <task_id>` in the
   worker's terminal, the loop just ticks forever with the same "not done"
   reason, indistinguishable from a worker that is genuinely still working.
   Repeated ticks with zero progress across several re-arms is exactly the
   HYK-112 pattern (infrastructure/process stall, not a real wait) — the
   Orchestrator should stop re-arming and surface a `question_packet` rather
   than looping indefinitely on its own.
2. **Cache warming only benefits the Orchestrator's own session.** The
   worker terminal (a separate process/session) gets no benefit from this
   loop; only the Orchestrator session that runs `watch-result.mjs` and ends
   its turn on a tick has its own cache kept warm by that turn boundary.
3. **The subscription plan's `cache_read` cost weighting is opaque from
   outside.** The ~10%-of-a-cold-turn ping cost and the ~40-minute
   break-even point above are both derived from the stated assumptions
   (5-minute TTL, a keep-alive ping being cheap relative to a full turn),
   not from an actual measured comparison run under this account's billing.
   Treat them as a planning estimate; a real before/after token-usage
   comparison would be needed to confirm the benefit in practice, not
   assumed from this document alone.
4. **Removing the human "완료" relay narrows a supervision point.**
   Today, a human relaying "완료" is an implicit checkpoint — a person
   glances at the result before telling the Orchestrator to proceed. Once
   the Orchestrator consumes a result the instant `watch-result.mjs` reports
   `done`, that glance no longer gates consumption. The mechanical guarantee
   this loop relies on (`checkRelayHandshake`'s task_id match + timestamp
   ordering) is unchanged and still runs — this loop does not weaken *that*
   check — but the human is no longer necessarily the one who notices first.
