/**
 * System Context Injection Extension
 *
 * 自动注入系统信息和目录结构到 system prompt，类似 VS Code Copilot 的行为。
 * 包含：OS、shell、当前目录、目录树（可配置深度）。
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 20;
const IGNORE = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  ".tox", "dist", "build", ".next", ".nuxt", "target",
  ".pi", ".cache", ".mypy_cache", ".pytest_cache",
]);

function buildTree(dir: string, depth: number, prefix: string = ""): string[] {
  if (depth < 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries = entries
    .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
    .filter((e) => !IGNORE.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  const truncated = entries.length > MAX_ENTRIES_PER_DIR;
  if (truncated) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);

  const lines: string[] = [];
  for (const entry of entries) {
    const isDir = entry.isDirectory();
    lines.push(`${prefix}${isDir ? entry.name + "/" : entry.name}`);
    if (isDir) {
      const sub = buildTree(path.join(dir, entry.name), depth - 1, prefix + "  ");
      lines.push(...sub);
    }
  }
  if (truncated) lines.push(`${prefix}... (truncated)`);
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;
    const tree = buildTree(cwd, MAX_DEPTH).join("\n");

    const context = `
<system_context>
- OS: ${os.platform()} ${os.arch()} (${os.release()})
- Shell: ${process.env.SHELL ?? "unknown"}
- User: ${os.userInfo().username}
- CWD: ${cwd}
- Node: ${process.version}

Directory structure:
${tree || "(empty)"}
</system_context>`;

    return {
      systemPrompt: event.systemPrompt + "\n" + context,
    };
  });
}
