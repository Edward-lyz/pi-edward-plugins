// loop-state.ts — Types and utilities for the loop extension

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type LoopMode = "goal" | "passes" | "pipeline";

export const GOAL_MODE_MAX_ITERATIONS = 100;

export interface LoopState {
	active: boolean;
	mode: LoopMode;
	currentStep: number;
	maxSteps: number; // Infinity for goal mode, N for passes, stages.length for pipeline
	goal: string; // User's description of what we're doing
	stages: string[]; // Pipeline stages (or single repeated task)
	done: boolean; // LLM signaled completion
	reasonDone: string; // Why the LLM stopped
}

export function emptyState(): LoopState {
	return {
		active: false,
		mode: "goal",
		currentStep: 0,
		maxSteps: 0,
		goal: "",
		stages: [],
		done: false,
		reasonDone: "",
	};
}

// Build the steer message for the current iteration
export function buildPrompt(state: LoopState): string {
	const step = state.currentStep;

	if (state.mode === "pipeline") {
		const stage = state.stages[step];
		const remaining = state.stages.length - step - 1;
		return [
			`## Loop — Pipeline stage ${step + 1}/${state.stages.length}`,
			`Overall goal: ${state.goal}`,
			`Current stage: **${stage}**`,
			remaining > 0
				? `Remaining stages: ${state.stages.slice(step + 1).join(" → ")}`
				: `This is the **final stage**. Call loop_control with status "done" when complete.`,
			`\nExecute this stage now. When finished, call loop_control with status "done" if this is the last stage, or "next" to advance.`,
		].join("\n");
	}

	if (state.mode === "passes") {
		return [
			`## Loop — Pass ${step + 1} of ${state.maxSteps}`,
			`Task: ${state.goal}`,
			step === 0
				? `This is the first pass. Do an initial implementation/analysis.`
				: step < state.maxSteps - 1
					? `This is a refinement pass. Review and improve on the previous pass.`
					: `This is the **final pass**. Do a final polish, then call loop_control with status "done".`,
			`\nWhen this pass is complete, call loop_control with status "next" (or "done" on the final pass).`,
		].join("\n");
	}

	// Goal mode — open-ended
	return [
		`## Loop — Iteration ${step + 1}`,
		`Goal: ${state.goal}`,
		`Work toward the goal. When the goal is fully met, call loop_control with status "done" and explain why.`,
		`If more work is needed, call loop_control with status "next" describing what's left.`,
	].join("\n");
}

// Argument parsing helpers to reduce complexity

export function parseGoalArgs(parts: string[]): LoopState | string {
	const goal = parts.slice(1).join(" ");
	if (!goal) {
		return "Provide a goal description";
	}
	return {
		active: true,
		mode: "goal",
		currentStep: 0,
		maxSteps: Infinity,
		goal,
		stages: [],
		done: false,
		reasonDone: "",
	};
}

export function parsePassesArgs(parts: string[]): LoopState | string {
	const n = parseInt(parts[1], 10);
	if (!n || n < 1) {
		return "Provide a valid number of passes";
	}
	const task = parts.slice(2).join(" ");
	if (!task) {
		return "Provide a task description";
	}
	return {
		active: true,
		mode: "passes",
		currentStep: 0,
		maxSteps: n,
		goal: task,
		stages: [],
		done: false,
		reasonDone: "",
	};
}

export function parsePipelineArgs(parts: string[]): LoopState | string {
	const stagesStr = parts[1];
	if (!stagesStr) {
		return "Provide stages separated by |";
	}
	const stages = stagesStr
		.split("|")
		.map((s) => s.trim())
		.filter(Boolean);
	if (stages.length === 0) {
		return "Need at least one stage";
	}
	const goal = parts.slice(2).join(" ") || stages.join(" → ");
	return {
		active: true,
		mode: "pipeline",
		currentStep: 0,
		maxSteps: stages.length,
		goal,
		stages,
		done: false,
		reasonDone: "",
	};
}

// Widget update logic
export function updateWidget(state: LoopState, ctx: ExtensionContext) {
	if (!state.active) {
		ctx.ui.setStatus("loop", undefined);
		ctx.ui.setWidget("loop", undefined);
		return;
	}

	const label =
		state.mode === "pipeline"
			? `stage ${state.currentStep + 1}/${state.stages.length}: ${state.stages[state.currentStep] ?? "?"}`
			: state.mode === "passes"
				? `pass ${state.currentStep + 1}/${state.maxSteps}`
				: `iteration ${state.currentStep + 1} (until goal met)`;

	ctx.ui.setStatus("loop", `🔄 ${label}`);
	ctx.ui.setWidget("loop", [
		`┌─ Loop: ${state.mode} ──────────`,
		`│ ${state.goal}`,
		`│ ${label}`,
		`└─ Ctrl+Shift+X to stop ────────`,
	]);
}

// System prompt injection logic
export function getSystemPromptAddition(state: LoopState): string {
	return [
		"",
		"",
		"## Active Loop",
		`Mode: ${state.mode} | Step: ${state.currentStep + 1}/${state.maxSteps === Infinity ? "∞" : state.maxSteps}`,
		`Goal: ${state.goal}`,
		"You MUST call `loop_control` when you finish your work for this iteration.",
		'Use status "next" to advance or "done" when the goal is fully met.',
	].join("\n");
}

// Tool execution logic
