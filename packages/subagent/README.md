# @pi-better-ux/subagent

A trimmed subagent extension for Pi, based on the UI and in-process session design from `tintinweb/pi-subagents`.

## What it keeps

- SDK-created in-memory child sessions via `createAgentSession` and `SessionManager.inMemory`, not a child `pi --fork` process.
- An `AgentManager` that tracks live subagent sessions.
- tintinweb-style live widget above the editor.
- FleetView below the editor, with a live conversation viewer and stop/steer controls.
- Same project Pi resources, skills, and extension tools as the parent session.
- Recursion prevention by filtering this extension's own `subagent` and `wait_subagent` tools out of child sessions.

## What was intentionally cut

- Built-in sample/default agent types such as `general-purpose`, `Explore`, and `Plan`.
- Custom `.pi/agents/*.md` registries.
- tintinweb's `Agent` / `get_subagent_result` / `steer_subagent` tool names; this package keeps `subagent` plus the smaller `wait_subagent` result tool.
- Scheduling.
- Max-concurrency queues.
- Worktree isolation and persistent agent memory.

## Tool

### `subagent`

Runs one delegated task in a separate SDK-created Pi session.

Parameters:

| Name | Required | Description |
|---|---:|---|
| `prompt` | yes | The task or prompt for the subagent. |
| `model` | no | Per-call model override. Accepts `provider/modelId` or a fuzzy model name. |
| `thinking` | no | Per-call thinking override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `run_in_background` | no | Start the subagent and return immediately with an ID. Retrieve or wait for the result with `wait_subagent`. |

Effective model precedence:

1. Tool-call `model`.
2. `/subagent model ...` default.
3. Parent session model.
4. Pi's normal model fallback if the parent has no model.

Effective thinking precedence:

1. Tool-call `thinking`.
2. `/subagent thinking ...` default.
3. Parent Pi thinking level.

Invalid explicit model or thinking values return a hard error instead of silently falling back.


### `wait_subagent`

Retrieves the status/result for a subagent started with `run_in_background: true`.

Parameters:

| Name | Required | Description |
|---|---:|---|
| `agent_id` | yes | The ID returned by `subagent` when run in background. |
| `wait` | no | If `true`, wait until the subagent finishes before returning. Default `false` returns current status. |
| `verbose` | no | If `true`, include the child session transcript when available. |

Completed background results stay in memory until they are retrieved with `wait_subagent`, the Pi session shuts down, or the extension is unloaded.


## Command

### `/subagent`

Shows or updates global defaults stored at `~/.pi/agent/subagent.json`.

```text
/subagent
/subagent model anthropic/claude-sonnet-4-6
/subagent model inherit
/subagent thinking high
/subagent thinking inherit
/subagent clear
```

## Upstream notice

Large parts of the UI and session-management structure were copied from `tintinweb/pi-subagents` and then pruned. The upstream MIT license is kept in this package directory.
