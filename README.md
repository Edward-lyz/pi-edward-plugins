# pi-better-ux

Pi Coding Agent 体验和效率增强插件集。

## Install

```bash
# npm package, available after publishing
pi install npm:pi-better-ux

# Git package, pin a release tag for reproducibility
pi install git:github.com/Edward-lyz/pi-edward-plugins@v0.1.0

# Local development smoke test
pi -e .
```

## Extensions

| Extension | Path | What it does | Notes |
|---|---|---|---|
| `code-block-fix` | `packages/code-block-fix/src/index.ts` | Renders markdown code blocks with Unicode box borders. | Monkey-patches Pi markdown rendering. |
| `co-dev` | `packages/co-dev/src/index.ts` | Runs a second-model review loop after each agent answer. | Configure with `/co-dev`; requires a usable Pi model and API key. |
| `rtk` | `packages/rtk/src/index.ts` | Rewrites `bash` / `exec_command` commands through `rtk rewrite` before execution. | Requires `rtk` in `PATH`. |
| `statusline` | `packages/statusline/src/index.ts` | Replaces the footer with model, context, cache-hit rate, TTFT, and output-rate info. | UI sessions only. |
| `system-context` | `packages/system-context/src/index.ts` | Injects OS, shell, cwd, Node version, and a shallow directory tree into the system prompt. | Directory tree depth is intentionally small. |
| `thinking-display` | `packages/thinking-display/src/index.ts` | Collapses thinking traces into one compact `thinking` marker. | Use `/thinking-display on\|off\|status`. |
| `tool-display` | `packages/tool-display/src/index.ts` | Hides collapsed tool rows, shows a working message while tools run, and restores full tool details on expansion. | Use `Ctrl+O` or `/tool-display expand`. |

## Load one extension

```json
{
  "packages": [
    {
      "source": "npm:pi-better-ux",
      "extensions": ["packages/code-block-fix/src/index.ts"]
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
