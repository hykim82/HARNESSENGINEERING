# Status board (start here when you return)

**Updated: <YYYY-MM-DD HH:MM KST>**

## Where I am

- <current phase / position in one or two lines>
- Just did: <last concrete action>

## Human's next action (pick one)

1. <action, e.g. move HYK-XX to Done in Linear>
2. <action, e.g. start a new session with the boot line>

## Issue states

- Done: <ids>
- In Review: <ids>
- Todo / In Progress: <ids>

## Relay rules

- Human says "go to the <role> terminal" → role reads `.harness/<role>-task.md`.
- Role result: `.harness/<role>.md` + `>>> DONE: <role> @ <time>`.
- Role → Human: "<role> done" → Human reads and updates this board.
