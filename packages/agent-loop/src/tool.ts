// loop-tool.ts — Tool definition, execution, and rendering for loop_control

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildPrompt, GOAL_MODE_MAX_ITERATIONS, type LoopState } from "./state.ts";

export function handleLoopControlTool(
	params: { status: "next" | "done"; summary: string; reason?: string },
	state: LoopState,
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
): {
	content: { type: "text"; text: string }[];
	details: LoopState | undefined;
	newState: LoopState;
} {
	if (!state.active) {
		return {
			content: [
				{ type: "text", text: "No active loop. Start one with /loop." },
			],
			details: undefined,
			newState: state,
		};
	}

	if (params.status === "done") {
		const newState = {
			...state,
			done: true,
			reasonDone: params.reason ?? params.summary,
			active: false,
		};
		return {
			content: [
				{
					type: "text",
					text: `✓ Loop complete after ${state.currentStep + 1} iteration(s). Reason: ${newState.reasonDone}`,
				},
			],
			details: { ...newState } as LoopState,
			newState,
		};
	}

	// status === "next" — advance
	const newState = { ...state, currentStep: state.currentStep + 1 };

	const atEnd =
		state.mode === "passes"
			? newState.currentStep >= state.maxSteps
			: state.mode === "pipeline"
				? newState.currentStep >= state.stages.length
				: newState.currentStep >= GOAL_MODE_MAX_ITERATIONS;

	if (atEnd) {
		const finalState = {
			...newState,
			done: true,
			active: false,
			reasonDone:
				state.mode === "goal"
					? `Safety cap reached (${GOAL_MODE_MAX_ITERATIONS} iterations) without an explicit 'done'`
					: `Completed all ${state.mode === "passes" ? "passes" : "stages"}`,
		};
		return {
			content: [
				{
					type: "text",
					text:
						state.mode === "goal"
							? `✓ Loop complete — safety cap reached after ${GOAL_MODE_MAX_ITERATIONS} iterations without an explicit 'done'.`
							: `✓ Loop complete — all ${state.maxSteps} iterations done.`,
				},
			],
			details: { ...finalState } as LoopState,
			newState: finalState,
		};
	}

	setTimeout(() => {
		pi.sendMessage(
			{
				customType: "loop-iteration",
				content: buildPrompt(newState),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}, 100);

	return {
		content: [
			{
				type: "text",
				text: `→ Advancing to step ${newState.currentStep + 1}. Summary: ${params.summary}`,
			},
		],
		details: { ...newState } as LoopState,
		newState,
	};
}

export function getLoopControlToolDefinition() {
	return {
		name: "loop_control",
		label: "Loop Control",
		description: [
			"Signal loop progress. Call this when you finish a loop iteration.",
			"status 'next': advance to the next step/pass/stage.",
			"status 'done': the goal is met or the final stage/pass is complete.",
			"Only available when a loop is active.",
		].join(" "),
		parameters: Type.Object({
			status: StringEnum(["next", "done"] as const),
			summary: Type.String({
				description: "Brief summary of what was accomplished this iteration",
			}),
			reason: Type.Optional(
				Type.String({ description: "Why the goal is met (for 'done')" }),
			),
		}),
	};
}

export function renderLoopControlCall(
	args: { status: string },
	theme: unknown,
) {
	const t = theme as {
		fg: (k: string, s: string) => string;
		bold: (s: string) => string;
	};
	return new Text(
		t.fg("toolTitle", t.bold("loop_control ")) +
			t.fg(args.status === "done" ? "success" : "accent", args.status),
		0,
		0,
	);
}

export function renderLoopControlResult(
	result: { details?: LoopState },
	_opts: unknown,
	theme: unknown,
) {
	const d = result.details as LoopState | undefined;
	if (!d) return new Text("", 0, 0);
	const t = theme as { fg: (color: string, text: string) => string };
	return new Text(
		t.fg(
			d.done ? "success" : "accent",
			`${d.done ? "✓" : "→"} step ${d.currentStep + 1} — ${d.mode}`,
		),
		0,
		0,
	);
}
