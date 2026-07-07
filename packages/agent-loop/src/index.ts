// index.ts — General-purpose agent loop extension
// Supports 3 modes:
//   /loop goal <description>     — repeat until the LLM declares the goal met
//   /loop passes <N> <task>      — repeat exactly N times
//   /loop pipeline <s1|s2|s3>    — run stages sequentially, stop after last
//
// The LLM gets a `loop_control` tool to signal progress/completion.
// Ctrl+Shift+X to abort at any time.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	buildPrompt,
	emptyState,
	getSystemPromptAddition,
	type LoopMode,
	type LoopState,
	parseGoalArgs,
	parsePassesArgs,
	parsePipelineArgs,
	updateWidget,
} from "./state.ts";
import {
	getLoopControlToolDefinition,
	handleLoopControlTool,
	renderLoopControlCall,
	renderLoopControlResult,
} from "./tool.ts";

export default function (pi: ExtensionAPI) {
	let state = emptyState();

	// ── Reconstruct state from session branch ────────────────────────────
	const reconstruct = (ctx: ExtensionContext) => {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "loop_control") {
				const d = msg.details as LoopState | undefined;
				if (d) state = { ...d };
			}
		}
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_switch", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_fork", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	// ── Tool: the LLM calls this to signal progress ─────────────────────
	pi.registerTool({
		...getLoopControlToolDefinition(),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = handleLoopControlTool(params, state, pi, ctx);
			state = result.newState;
			updateWidget(state, ctx);
			return {
				content: result.content,
				details: result.details,
			};
		},
		renderCall: renderLoopControlCall,
		renderResult: renderLoopControlResult,
	});

	// ── Inject loop context into the system prompt ───────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.active) return;
		return {
			systemPrompt: event.systemPrompt + getSystemPromptAddition(state),
		};
	});

	// ── /loop command — start a loop ─────────────────────────────────────
	pi.registerCommand("loop", {
		description:
			"Start a loop. Usage: /loop goal <desc> | /loop passes <N> <task> | /loop pipeline <s1|s2|s3> <goal>",
		getArgumentCompletions: () => [
			{
				value: "goal ",
				label: "goal <description>",
				description: "Loop until goal is met",
			},
			{
				value: "passes ",
				label: "passes <N> <task>",
				description: "Run exactly N passes",
			},
			{
				value: "pipeline ",
				label: "pipeline <s1|s2|s3> <goal>",
				description: "Run stages in order",
			},
		],
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage:\n  /loop goal <description>\n  /loop passes <N> <task>\n  /loop pipeline <s1|s2|s3> <goal>",
					"info",
				);
				return;
			}

			await ctx.waitForIdle();

			const parts = args.trim().split(/\s+/);
			const mode = parts[0] as LoopMode;

			let result: LoopState | string;

			if (mode === "goal") {
				result = parseGoalArgs(parts);
			} else if (mode === "passes") {
				result = parsePassesArgs(parts);
			} else if (mode === "pipeline") {
				result = parsePipelineArgs(parts);
			} else {
				ctx.ui.notify(
					`Unknown mode "${mode}". Use: goal, passes, or pipeline`,
					"error",
				);
				return;
			}

			if (typeof result === "string") {
				ctx.ui.notify(result, "error");
				return;
			}

			state = result;
			updateWidget(state, ctx);
			// Kick off the first iteration
			pi.sendUserMessage(buildPrompt(state));
		},
	});

	// ── /loop-stop command ───────────────────────────────────────────────
	pi.registerCommand("loop-stop", {
		description: "Stop the active loop",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No active loop", "info");
				return;
			}
			state.active = false;
			state.done = true;
			state.reasonDone = "Stopped by user";
			updateWidget(state, ctx);
			ctx.ui.notify(
				`Loop stopped after ${state.currentStep + 1} iteration(s)`,
				"warning",
			);
		},
	});

	// ── Ctrl+Shift+X — emergency stop ───────────────────────────────────
	pi.registerShortcut(Key.ctrlShift("x"), {
		description: "Stop the active loop",
		handler: async (ctx) => {
			if (!state.active) return;
			state.active = false;
			state.done = true;
			state.reasonDone = "Stopped by shortcut";
			updateWidget(state, ctx);
			ctx.abort(); // also abort the current LLM turn
			ctx.ui.notify("Loop aborted", "warning");
		},
	});
}
