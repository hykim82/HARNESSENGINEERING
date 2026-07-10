# Gate Criteria Card

<!--
Operating rules (read once, do not re-derive after a /clear):
1. Before dropping a task, the Orchestrator checks it against this card.
   On conflict, the card wins -- fix the task's instructions, not the card.
2. Full-scope / final-review tasks cite this card as the reference; the
   reviewer treats it as authoritative and checks the diff against every
   applicable entry.
3. When a review establishes a new criterion, add it to this card in the
   same cycle -- this is what keeps the card from drifting out of date.
-->

This card accumulates the project's own gate criteria over time. It starts
empty -- a criterion earns a place here only after a real review cycle
establishes it, not by guessing ahead of time what might matter.

## A. Hard gates

<!-- Blocking checks: violating one of these fails the task outright. -->

- <criterion> -- check: <command> -- origin: <cycle/issue>

## B. Code hygiene

<!-- Non-blocking-but-expected conventions (style, structure, docs). -->

- <criterion> -- check: <command> -- origin: <cycle/issue>

## C. Relay format

<!-- Relay-protocol conventions (task_id echo, DONE line format, etc). -->

- <criterion> -- check: <command> -- origin: <cycle/issue>

## Card history

<!-- One line per addition: date, criterion, which cycle/issue prompted it. -->

- <YYYY-MM-DD>: added "<criterion>" (origin: <cycle/issue>)
