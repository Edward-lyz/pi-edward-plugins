# pi-better-ux

Pi Coding Agent 体验和效率增强插件集。

## Install

Run the install script from a clone. It installs the npm dependencies
(including the `fff` extension's `@ff-labs/fff-node` native module), ensures
the `rtk` CLI is present (used by the `rtk` extension), and registers the
package with pi:

```bash
./install.sh            # register with global pi settings (~/.pi/agent/settings.json)
./install.sh --local    # register with project pi settings (.pi/settings.json)
```

Or install manually:

```bash
# npm package, available after publishing
pi install npm:pi-better-ux

# Git package, pin a release tag for reproducibility
pi install git:github.com/Edward-lyz/pi-edward-plugins@v0.1.0

# Local development smoke test
pi -e .
```

The `rtk` extension needs the `rtk` CLI (>= 0.23.0) in `PATH`
(`brew install rtk` or `cargo install rtk`). The `fff` extension's
`@ff-labs/fff-node` dependency is installed by `npm install`. `install.sh`
handles both automatically.

## Extensions

| Extension | Path | What it does | Notes |
|---|---|---|---|
| `claude-style-tools` | `packages/claude-style-tools/src/index.ts`, `packages/claude-style-tools/src/spinner.ts` | Vendors Claude Code-style tool rows, spinner, grouped tool calls, Shiki diffs, and Codex `exec_command` / `write_stdin` / `apply_patch` rendering. | Forked from `pi-claude-style-tools`; load both files together. |
| `code-block-fix` | `packages/code-block-fix/src/code-block-fix.ts` | Renders markdown code blocks with Unicode box borders. | Monkey-patches Pi markdown rendering. |
| `fff` | `packages/fff/src/index.ts` (+ other files in `packages/fff/src/`) | FFF-powered fuzzy path resolution for `read` / `grep`, plus `find_files` and `fff_multi_grep` agent tools and `@` editor autocomplete. Commands: `/fff-features`, `/fff-status`, `/reindex-fff`. | Forked from `ShpetimA/pi-fff`; needs the `@ff-labs/fff-node` native module, installed by `npm install` (or `./install.sh`). |
| `rtk` | `packages/rtk/src/rtk.ts` | Rewrites `bash` / `exec_command` commands through `rtk rewrite` before execution. | Requires `rtk` in `PATH`. |
| `statusline` | `packages/statusline/src/statusline.ts` | Replaces the footer with model, context, cache-hit rate, TTFT, and output-rate info. | UI sessions only. |
| `subagent` | `packages/subagent/src/index.ts` | Runs delegated work in SDK-created in-memory Pi subagent sessions with tintinweb-style live widget and FleetView. | `/subagent` sets default model/thinking; tool args are `prompt`, optional `model`, optional `thinking`, optional `run_in_background`; use `wait_subagent` to wait for background results; child sessions filter out subagent tools to prevent recursion. |
| `system-context` | `packages/system-context/src/system-context.ts` | Injects OS, shell, cwd, Node version, and a shallow directory tree into the system prompt. | Directory tree depth is intentionally small. |
| `usage-report` | `packages/usage-report/src/usage-report.ts` | Serves a local usage dashboard with token activity, tool/skill counts, and API-cost estimates. | Use `/usage-report open\|start [port]\|status\|stop`; model prices come from Pi model config plus LiteLLM's public price table. |


## Load one extension

```json
{
  "packages": [
    {
      "source": "npm:pi-better-ux",
      "extensions": ["packages/code-block-fix/src/code-block-fix.ts"]
    }
  ]
}
```

For Git installs, replace `source` with
`git:github.com/Edward-lyz/pi-edward-plugins@v0.1.0`.

## Publish

Pi package discovery is npm-based. `pi.dev/packages` lists npm packages tagged
with the `pi-package` keyword and reads the `pi` manifest from `package.json`.

```bash
npm login
npm whoami
npm view pi-better-ux name version || true
npm run pack:dry-run
npm publish --access public
```

After publishing, wait for the pi.dev crawler to index the npm package. Users can
then install it with:

```bash
pi install npm:pi-better-ux
```

For a new release:

```bash
npm version patch
git push origin main --tags
npm publish --access public
```
