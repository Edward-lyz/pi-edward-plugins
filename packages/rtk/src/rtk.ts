import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 2_000;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (typeof cmd !== "string" || cmd.trim() === "") return;
      if (cmd.startsWith("rtk ")) return;

      const rewrite = await pi.exec("rtk", ["rewrite", cmd], {
        timeout: REWRITE_TIMEOUT_MS,
        signal: ctx.signal,
      });
      if (rewrite.code !== 0 && rewrite.code !== 3) return;
      const rewritten = rewrite.stdout.trim();
      if (rewritten) event.input.command = rewritten;
      return;
    }

    if (event.toolName !== "exec_command") return;
    const input = event.input as { cmd?: unknown };
    const cmd = input.cmd;
    if (typeof cmd !== "string" || cmd.trim() === "") return;
    if (cmd.startsWith("rtk ")) return;

    const rewrite = await pi.exec("rtk", ["rewrite", cmd], {
      timeout: REWRITE_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (rewrite.code !== 0 && rewrite.code !== 3) return;
    const rewritten = rewrite.stdout.trim();
    if (rewritten) input.cmd = rewritten;
  });
}
