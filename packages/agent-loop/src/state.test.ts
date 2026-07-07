import assert from "node:assert/strict";
import {
	buildPrompt,
	GOAL_MODE_MAX_ITERATIONS,
	parseGoalArgs,
	parsePassesArgs,
	parsePipelineArgs,
	type LoopState,
} from "./state.ts";

const goalState = parseGoalArgs(["goal", "fix", "tests"]);
assert.notEqual(typeof goalState, "string");
assert.equal((goalState as LoopState).mode, "goal");
assert.equal((goalState as LoopState).goal, "fix tests");
assert.equal((goalState as LoopState).maxSteps, Infinity);
assert.equal((goalState as LoopState).active, true);

assert.equal(parseGoalArgs(["goal"]), "Provide a goal description");

const passesState = parsePassesArgs(["passes", "3", "polish", "readme"]);
assert.notEqual(typeof passesState, "string");
assert.equal((passesState as LoopState).mode, "passes");
assert.equal((passesState as LoopState).maxSteps, 3);
assert.equal((passesState as LoopState).goal, "polish readme");

assert.equal(parsePassesArgs(["passes", "0", "x"]), "Provide a valid number of passes");
assert.equal(parsePassesArgs(["passes", "2"]), "Provide a task description");

const pipelineState = parsePipelineArgs(["pipeline", "a|b|c", "goal"]);
assert.notEqual(typeof pipelineState, "string");
assert.deepEqual((pipelineState as LoopState).stages, ["a", "b", "c"]);
assert.equal((pipelineState as LoopState).maxSteps, 3);
assert.equal((pipelineState as LoopState).goal, "goal");

const defaultGoalPipelineState = parsePipelineArgs(["pipeline", "a|b|c"]);
assert.notEqual(typeof defaultGoalPipelineState, "string");
assert.equal((defaultGoalPipelineState as LoopState).goal, "a → b → c");

assert.match(
	buildPrompt({ ...(pipelineState as LoopState), currentStep: 2 }),
	/final stage/,
);
assert.match(
	buildPrompt({ ...(passesState as LoopState), currentStep: 2 }),
	/final pass/,
);
assert.match(buildPrompt(goalState as LoopState), /Iteration 1/);
assert.equal(GOAL_MODE_MAX_ITERATIONS, 100);

console.log("state.test.ts OK");
