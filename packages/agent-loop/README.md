# 🔄 Agent Loop

General-purpose loop extension for pi. Repeats agent turns automatically in three modes: until a goal is met, for a fixed number of passes, or through a sequence of named pipeline stages.

## Install

This package is installed via the local `pi-edward-plugins` monorepo package workflow, not with `pi install npm:pi-agent-loop`.

## What it does

Registers a `/loop` command and a `loop_control` tool. On each iteration, the agent does its work then calls `loop_control` to either advance to the next iteration (`next`) or declare the goal complete (`done`). The loop context is injected into the system prompt automatically so the agent always knows where it is.

## Commands

| Command | Description |
|---|---|
| `/loop goal <description>` | Repeat until the LLM declares the goal met (open-ended) |
| `/loop passes <N> <task>` | Run exactly N passes |
| `/loop pipeline <s1\|s2\|s3> <goal>` | Run named stages sequentially, stop after the last |
| `/loop-stop` | Stop the active loop immediately |

## Shortcut

| Shortcut | Description |
|---|---|
| `Ctrl+Shift+X` | Emergency abort — stops the loop and cancels the current turn |

## Tool: `loop_control`

The LLM calls this tool to signal progress. It is only active during a loop.

| Parameter | Type | Description |
|---|---|---|
| `status` | `"next" \| "done"` | Advance to next iteration or declare completion |
| `summary` | `string` | Brief summary of what was accomplished this iteration |
| `reason` | `string?` | Why the goal is met (used with `"done"`) |

## Examples

```
/loop goal Refactor all test files to use the new assertion API
/loop passes 3 Review and improve the README
/loop pipeline analyze|implement|test Write and test the new auth module
```

## TUI widget

While a loop is active, a status bar entry and widget show the current mode, goal, and iteration count.

## Differences from upstream pi-agent-loop

- Removed the dead `pi.on("agent_end", ...)` handler. It only read loop state and returned, so removing it does not change behavior.
- Added `GOAL_MODE_MAX_ITERATIONS = 100` as a safety cap for goal mode. Goal mode still displays `∞` and keeps `maxSteps: Infinity`, but `/loop goal` stops after 100 `next` iterations if the agent never calls `loop_control` with status `"done"`.
