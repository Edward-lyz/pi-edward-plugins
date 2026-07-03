import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ALL_FEATURE_KEYS,
	CUSTOM_TOOL_NAMES,
	loadGlobalFeatureState,
	loadGlobalFeatureStateSync,
	saveGlobalFeatureState,
	buildFindFilesDetails,
	buildGrepDetails,
	buildGrepFailureMessage,
	buildReadFailureMessage,
	FFF_RUNTIME_NOT_READY_TEXT,
	grepNeedsBuiltinFallback,
	inferFffGrepMode,
	locationToReadParams,
	normalizeMode,
	normalizeOutputMode,
	type FeatureKey,
} from "./extension-common.ts";
import { FffEditor } from "./editor.ts";
import { FinderOperationError, RuntimeInitializationError } from "./errors.ts";
import { FffRuntime } from "./fff.ts";
import { registerCommands } from "./register-commands.ts";

export default function (pi: ExtensionAPI) {
	let runtime: FffRuntime | null = null;
	let enabledFeatures = new Set<FeatureKey>(ALL_FEATURE_KEYS);

	const initialFeatureState = loadGlobalFeatureStateSync();
	if (initialFeatureState.isOk()) {
		enabledFeatures = new Set(initialFeatureState.value ?? ALL_FEATURE_KEYS);
	}

	const isFeatureEnabled = (feature: FeatureKey) => enabledFeatures.has(feature);
	const getRuntime = () => runtime;
	const getEnabledFeatures = () => new Set(enabledFeatures);
	const setEnabledFeatures = (next: Set<FeatureKey>) => { enabledFeatures = new Set(next); };

	const syncCustomToolActivation = () => {
		const activeTools = new Set(pi.getActiveTools());
		for (const toolName of CUSTOM_TOOL_NAMES) {
			if (isFeatureEnabled("agentTools")) activeTools.add(toolName);
			else activeTools.delete(toolName);
		}
		pi.setActiveTools(Array.from(activeTools));
	};

	const applyUiConfiguration = (ctx: ExtensionContext) => {
		if (isFeatureEnabled("autocomplete") && runtime) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new FffEditor(tui, theme, keybindings, runtime!));
		}
		syncCustomToolActivation();
	};

	const persistFeatures = async () => {
		const saved = await saveGlobalFeatureState(enabledFeatures);
		if (saved.isErr()) console.error("Failed to save pi-fff feature state:", saved.error);
	};

	const restoreFeatures = async () => {
		const restored = await loadGlobalFeatureState();
		if (restored.isOk()) {
			enabledFeatures = new Set(restored.value ?? ALL_FEATURE_KEYS);
		} else {
			enabledFeatures = new Set(ALL_FEATURE_KEYS);
		}
		syncCustomToolActivation();
	};

	// --- tool_call interception: inject FFF path resolution into read/grep ---

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("read", event)) {
			if (!isFeatureEnabled("builtInReadEnhancement")) return;
			const rt = runtime;
			if (!rt) return;

			const path = event.input.path;
			if (!path || typeof path !== "string") return;

			const resolution = await rt.resolvePath(path, { allowDirectory: false, limit: 8 });
			if (resolution.isErr()) return; // let original read handle it (will produce a clear error)

			const resolved = resolution.value;
			void rt.trackQuery(path, resolved.absolutePath);
			const locationParams = locationToReadParams(resolved, event.input.offset, event.input.limit);
			event.input.path = resolved.absolutePath;
			if (locationParams.offset !== undefined) event.input.offset = locationParams.offset;
			if (locationParams.limit !== undefined) event.input.limit = locationParams.limit;
			return;
		}

		if (isToolCallEventType("grep", event)) {
			if (!isFeatureEnabled("builtInGrepEnhancement")) return;
			const rt = runtime;
			if (!rt) return;

			const input = event.input as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};

			// If the pattern/flags would need builtin fallback, skip FFF
			if (grepNeedsBuiltinFallback({ pattern: input.pattern, ignoreCase: input.ignoreCase, literal: input.literal })) return;

			// Resolve fuzzy path scope if provided
			if (input.path && typeof input.path === "string") {
				const scopeResult = await rt.resolvePath(input.path, { allowDirectory: true, limit: 8 });
				if (scopeResult.isOk()) {
					event.input.path = scopeResult.value.absolutePath;
				}
				// If resolution fails, leave path as-is for builtin grep
			}
			return;
		}
	});

	// --- Register find_files and fff_multi_grep as dedicated agent tools ---

	const agentToolsDisabledText = () => 'pi-fff agent tools are disabled. Use /fff-features to re-enable.';

	pi.registerTool({
		name: "find_files",
		label: "Find Files",
		description: "Browse ranked file candidates for a fuzzy query using fff.",
		promptSnippet: "Explore which files exist for a topic before reading one.",
		promptGuidelines: ["Use find_files when exploring a topic, looking for a file, or wanting ranked candidates before reading."],
		parameters: Type.Object({
			query: Type.String({ description: "Fuzzy file query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 20)" })),
			cursor: Type.Optional(Type.String({ description: "Cursor from a previous find_files result" })),
		}),
		async execute(_toolCallId, params) {
			if (!isFeatureEnabled("agentTools")) {
				return { content: [{ type: "text", text: agentToolsDisabledText() }], details: buildFindFilesDetails(undefined, "agentTools") };
			}
			const rt = runtime;
			if (!rt) {
				return { content: [{ type: "text", text: FFF_RUNTIME_NOT_READY_TEXT }], details: buildFindFilesDetails() };
			}
			const result = await rt.findFiles({ query: params.query, limit: params.limit, cursor: params.cursor });
			return result.match({
				err: (error) => ({ content: [{ type: "text" as const, text: error.message }], details: buildFindFilesDetails(undefined, undefined, error) }),
				ok: (value) => ({ content: [{ type: "text" as const, text: value.formatted }], details: buildFindFilesDetails(value) }),
			});
		},
	});

	pi.registerTool({
		name: "fff_multi_grep",
		label: "FFF Multi Grep",
		description: "Search file contents for any of multiple literal patterns using fff multi-grep.",
		promptSnippet: "Search for any of several literals at once using fff multi-grep.",
		promptGuidelines: ["Use fff_multi_grep when searching for multiple aliases or renamed symbols in one pass."],
		parameters: Type.Object({
			patterns: Type.Array(Type.String({ description: "Literal pattern" }), { minItems: 1 }),
			path: Type.Optional(Type.String({ description: "Optional exact or fuzzy file/folder scope" })),
			glob: Type.Optional(Type.String({ description: "Optional glob filter such as *.ts" })),
			constraints: Type.Optional(Type.String({ description: "Optional native FFF constraints" })),
			context: Type.Optional(Type.Number({ description: "Context lines (default: 0)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum matches (default: 60)" })),
			cursor: Type.Optional(Type.String({ description: "Cursor from a previous result" })),
			outputMode: Type.Optional(Type.String({ description: "content, files_with_matches, count, or usage" })),
		}),
		async execute(_toolCallId, params) {
			if (!isFeatureEnabled("agentTools")) {
				return { content: [{ type: "text", text: agentToolsDisabledText() }], details: buildGrepDetails(undefined, "agentTools") };
			}
			const rt = runtime;
			if (!rt) {
				return { content: [{ type: "text", text: FFF_RUNTIME_NOT_READY_TEXT }], details: buildGrepDetails() };
			}
			const result = await rt.multiGrepSearch({
				patterns: params.patterns,
				pathQuery: params.path,
				glob: params.glob,
				constraints: params.constraints,
				context: params.context,
				limit: params.limit ?? 60,
				cursor: params.cursor,
				includeCursorHint: false,
				outputMode: normalizeOutputMode(params.outputMode) ?? "files_with_matches",
			});
			return result.match({
				err: (error) => ({ content: [{ type: "text" as const, text: buildGrepFailureMessage(error, params.path) }], details: buildGrepDetails(undefined, undefined, error) }),
				ok: (value) => ({ content: [{ type: "text" as const, text: value.formatted }], details: buildGrepDetails(value) }),
			});
		},
	});

	// --- Commands ---

	registerCommands(pi, {
		getRuntime,
		isFeatureEnabled,
		getEnabledFeatures,
		setEnabledFeatures,
		persistFeatures,
		applyUiConfiguration,
	});

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		runtime?.dispose();
		runtime = new FffRuntime(ctx.cwd);
		await restoreFeatures();
		applyUiConfiguration(ctx);

		void (async () => {
			const activeRuntime = runtime;
			if (!activeRuntime) return;
			const warmed = await activeRuntime.warm(1500);
			if (runtime !== activeRuntime) return;
			if (warmed.isErr()) {
				if (isFeatureEnabled("statusUI")) ctx.ui.notify(`fff unavailable: ${warmed.error.message}`, "warning");
				return;
			}
			const indexed = warmed.value.indexedFiles ? ` (${warmed.value.indexedFiles} files)` : "";
			if (isFeatureEnabled("statusUI")) ctx.ui.notify(`fff ready${indexed}`, "info");
		})();
	});

	pi.on("session_shutdown", async () => {
		runtime?.dispose();
		runtime = null;
	});
}
