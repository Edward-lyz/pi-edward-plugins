import { complete } from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Input, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import path from 'node:path';

const STATE_TYPE = 'co-dev-state';
const REVIEW_MESSAGE_TYPE = 'co-dev-review';
const DEFAULT_REVIEW_MODEL = 'DeepSeek-V4-Flash';
const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_TOOL_TEXT_CHARS = 8000;
const MAX_PATCH_CHARS = 32000;
const MAX_WRITE_CHARS = 12000;
const MAX_GIT_DIFF_CHARS = 50000;
const MAX_NESTED_GIT_REPOS = 8;
const MAX_TOOL_REPO_CANDIDATES = 12;
const MAX_UNTRACKED_FILES = 10;

type Decision = 'YES' | 'NO';

type PersistedState = {
	enabled?: boolean;
	modelSpec?: string;
	reviewCount?: number;
	lastDecision?: Decision;
	lastReviewAt?: number;
};

type ToolCallInfo = {
	name: string;
	arguments: Record<string, unknown>;
};

type RoundSections = {
	transcript: string;
	patches: string;
	writes: string;
	bash: string;
	repoHints: string[];
};

type ReviewDetails = {
	decision?: Decision;
	model: string;
	reviewCount: number;
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		cost: number;
	};
	error?: string;
};

type ResolvedReviewModel = {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
};

const REVIEW_SYSTEM_PROMPT = [
	'你是 co-dev，一个负责锐评主 agent 工作质量的代码审查子会话。',
	'你只做审查，不写代码，不调用工具。',
	'重点检查：用户需求是否完成、最终回答是否诚实准确、代码改动是否直接解决问题、是否存在 hidden fallback、mock、绕过校验、无意义小函数、过度抽象、缺少必要验证。',
	'YES 表示当前回答和代码改动已经足够好，可以结束任务。',
	'NO 表示还不应结束，主 agent 必须继续优化。',
	'输出必须使用下面格式，第一行只能是 LABEL: YES 或 LABEL: NO：',
	'LABEL: YES|NO',
	'REVIEW:',
	'- 用中文给出 3 到 8 条犀利但可执行的评价。',
	'ACTION:',
	'- 如果 LABEL 是 NO，给出主 agent 下一步必须做什么；如果 LABEL 是 YES，写可以结束的理由。',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to serialize co-dev review context: ${message}`);
	}
}

function formatExecFailure(command: string, code: number | null, stderr: string): string {
	return `${command} failed with exit code ${code}\nstderr:\n${truncateText(stderr, MAX_TOOL_TEXT_CHARS)}`;
}

function extractText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';

	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.join('\n');
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function cleanPathHint(value: string): string | undefined {
	const cleaned = value.trim().replace(/^['"]|['"]$/g, '').replace(/[),.;]+$/g, '');
	if (!cleaned || cleaned.length > 1000) return undefined;
	if (cleaned.includes('\n') || cleaned.startsWith('-')) return undefined;
	if (/^(https?:|ssh:|git@)/.test(cleaned)) return undefined;
	if (cleaned.includes('$(') || cleaned.includes('`')) return undefined;
	return cleaned;
}

function collectCommandRepoHints(command: string, repoHints: string[]): void {
	const gitCRegex = /\bgit\b[^\n;&|]*?\s-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
	for (const match of command.matchAll(gitCRegex)) {
		const hint = cleanPathHint(match[1] ?? match[2] ?? match[3] ?? '');
		if (hint) pushUnique(repoHints, hint);
	}

	const cdRegex = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
	for (const match of command.matchAll(cdRegex)) {
		const hint = cleanPathHint(match[1] ?? match[2] ?? match[3] ?? '');
		if (hint) pushUnique(repoHints, hint);
	}
}

function collectPatchRepoHints(patchText: string, repoHints: string[]): void {
	const fileRegex = /^\*\*\* (?:Add|Update|Delete|Move) File: (.+)$/gm;
	for (const match of patchText.matchAll(fileRegex)) {
		const hint = cleanPathHint(match[1]);
		if (hint) pushUnique(repoHints, hint);
	}
}

function collectNestedRepoHints(value: unknown, repoHints: string[], depth = 0): void {
	if (depth > 4) return;
	if (Array.isArray(value)) {
		for (const entry of value) collectNestedRepoHints(entry, repoHints, depth + 1);
		return;
	}
	if (!isRecord(value)) return;

	const nestedToolName = typeof value.recipient_name === 'string'
		? value.recipient_name
		: typeof value.name === 'string'
			? value.name
			: undefined;
	const nestedArgs = isRecord(value.parameters)
		? value.parameters
		: isRecord(value.arguments)
			? value.arguments
			: undefined;
	if (nestedToolName && nestedArgs) collectToolCallRepoHints(nestedToolName, nestedArgs, repoHints);

	for (const nestedValue of Object.values(value)) {
		if (isRecord(nestedValue) || Array.isArray(nestedValue)) collectNestedRepoHints(nestedValue, repoHints, depth + 1);
	}
}

function collectToolCallRepoHints(toolName: string, args: Record<string, unknown>, repoHints: string[]): void {
	for (const key of ['cwd', 'workdir', 'path', 'filePath', 'file_path', 'target', 'source']) {
		const value = args[key];
		if (typeof value === 'string') {
			const hint = cleanPathHint(value);
			if (hint) pushUnique(repoHints, hint);
		} else if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry !== 'string') continue;
				const hint = cleanPathHint(entry);
				if (hint) pushUnique(repoHints, hint);
			}
		}
	}

	for (const key of ['command', 'cmd']) {
		const command = args[key];
		if (typeof command === 'string') collectCommandRepoHints(command, repoHints);
	}

	for (const key of ['patch', 'input']) {
		const patchText = args[key];
		if (typeof patchText === 'string' && /(?:apply_patch|edit|patch)/i.test(toolName)) {
			collectPatchRepoHints(patchText, repoHints);
		}
	}

	for (const value of Object.values(args)) {
		if (isRecord(value) || Array.isArray(value)) collectNestedRepoHints(value, repoHints);
	}
}

async function resolveGitRepoRoot(pi: ExtensionAPI, ctx: ExtensionContext, hint: string): Promise<string | undefined> {
	const cleaned = cleanPathHint(hint);
	if (!cleaned) return undefined;

	let current = path.isAbsolute(cleaned) ? cleaned : path.resolve(ctx.cwd, cleaned);
	if (current.endsWith(`${path.sep}.git`)) current = path.dirname(current);
	for (let depth = 0; depth < 8; depth += 1) {
		const root = await pi.exec('git', ['-C', current, 'rev-parse', '--show-toplevel'], {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeout: 10000,
		});
		if (root.code === 0 && root.stdout.trim()) return root.stdout.trim();

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

async function buildUntrackedDiffs(pi: ExtensionAPI, ctx: ExtensionContext, repoDir: string): Promise<string> {
	const untrackedFiles = await pi.exec('git', ['-C', repoDir, 'ls-files', '--others', '--exclude-standard', '-z'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	if (untrackedFiles.code !== 0) {
		return formatExecFailure('git ls-files --others', untrackedFiles.code, untrackedFiles.stderr);
	}

	const filePaths = untrackedFiles.stdout.split('\0').filter(Boolean);
	if (filePaths.length === 0) return '(no untracked files)';

	const diffs: string[] = [];
	for (const filePath of filePaths.slice(0, MAX_UNTRACKED_FILES)) {
		const diff = await pi.exec('git', ['-C', repoDir, 'diff', '--no-ext-diff', '--no-index', '--', '/dev/null', filePath], {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeout: 10000,
		});
		const text = diff.code === 0 || diff.code === 1
			? diff.stdout.trim() || '(untracked file diff is empty)'
			: formatExecFailure('git diff --no-index', diff.code, diff.stderr);
		diffs.push(`### untracked ${filePath}\n${truncateText(text, MAX_PATCH_CHARS)}`);
	}
	if (filePaths.length > MAX_UNTRACKED_FILES) diffs.push(`[skipped ${filePaths.length - MAX_UNTRACKED_FILES} untracked files]`);
	return truncateText(diffs.join('\n\n'), MAX_GIT_DIFF_CHARS);
}

async function buildRepoChangeSection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoDir: string,
	label: string,
): Promise<string> {
	const status = await pi.exec('git', ['-C', repoDir, 'status', '--short'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	if (status.code !== 0) return `### ${label} ${repoDir}\n${formatExecFailure('git status', status.code, status.stderr)}`;

	const statusText = status.stdout.trim();
	if (!statusText) return `### ${label} ${repoDir}\n(git status is clean)`;

	const unstaged = await pi.exec('git', ['-C', repoDir, 'diff', '--no-ext-diff'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	const unstagedText = unstaged.code === 0
		? truncateText(unstaged.stdout.trim() || '(unstaged git diff is empty)', MAX_GIT_DIFF_CHARS)
		: formatExecFailure('git diff', unstaged.code, unstaged.stderr);

	const staged = await pi.exec('git', ['-C', repoDir, 'diff', '--no-ext-diff', '--cached'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	const stagedText = staged.code === 0
		? truncateText(staged.stdout.trim() || '(staged git diff is empty)', MAX_GIT_DIFF_CHARS)
		: formatExecFailure('git diff --cached', staged.code, staged.stderr);
	const untrackedText = await buildUntrackedDiffs(pi, ctx, repoDir);

	return [
		`### ${label} ${repoDir}`,
		'<git_status_short>',
		truncateText(statusText, MAX_TOOL_TEXT_CHARS),
		'</git_status_short>',
		'<unstaged_git_diff>',
		unstagedText,
		'</unstaged_git_diff>',
		'<staged_git_diff>',
		stagedText,
		'</staged_git_diff>',
		'<untracked_git_diff>',
		untrackedText,
		'</untracked_git_diff>',
	].join('\n');
}

async function buildNestedGitChanges(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const nestedGitDirs = await pi.exec('find', ['.', '-mindepth', '2', '-maxdepth', '4', '-name', '.git', '-print', '-prune'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	if (nestedGitDirs.code !== 0) {
		return formatExecFailure('find nested .git dirs', nestedGitDirs.code, nestedGitDirs.stderr);
	}

	const repoDirs = nestedGitDirs.stdout
		.split('\n')
		.map((path) => path.trim().replace(/\/\.git$/, ''))
		.filter(Boolean);
	if (repoDirs.length === 0) return '(no nested git repos found under cwd)';

	const sections: string[] = [];
	for (const repoDir of repoDirs.slice(0, MAX_NESTED_GIT_REPOS)) {
		const status = await pi.exec('git', ['-C', repoDir, 'status', '--short'], {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeout: 10000,
		});
		if (status.code !== 0) {
			sections.push(`### nested repo ${repoDir}\n${formatExecFailure('git status', status.code, status.stderr)}`);
			continue;
		}
		const statusText = status.stdout.trim();
		if (!statusText) continue;

		const unstaged = await pi.exec('git', ['-C', repoDir, 'diff', '--no-ext-diff'], {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeout: 10000,
		});
		const unstagedText = unstaged.code === 0
			? truncateText(unstaged.stdout.trim() || '(unstaged git diff is empty)', MAX_GIT_DIFF_CHARS)
			: formatExecFailure('git diff', unstaged.code, unstaged.stderr);

		const staged = await pi.exec('git', ['-C', repoDir, 'diff', '--no-ext-diff', '--cached'], {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeout: 10000,
		});
		const stagedText = staged.code === 0
			? truncateText(staged.stdout.trim() || '(staged git diff is empty)', MAX_GIT_DIFF_CHARS)
			: formatExecFailure('git diff --cached', staged.code, staged.stderr);

		sections.push([
			`### nested repo ${repoDir}`,
			'<git_status_short>',
			truncateText(statusText, MAX_TOOL_TEXT_CHARS),
			'</git_status_short>',
			'<unstaged_git_diff>',
			unstagedText,
			'</unstaged_git_diff>',
			'<staged_git_diff>',
			stagedText,
			'</staged_git_diff>',
		].join('\n'));
	}
	if (repoDirs.length > MAX_NESTED_GIT_REPOS) {
		sections.push(`[skipped ${repoDirs.length - MAX_NESTED_GIT_REPOS} nested git repos]`);
	}

	return sections.length ? truncateText(sections.join('\n\n'), MAX_GIT_DIFF_CHARS) : '(no dirty nested git repos found)';
}

async function buildToolRepoChanges(pi: ExtensionAPI, ctx: ExtensionContext, repoHints: string[]): Promise<string> {
	if (repoHints.length === 0) return '(no repo hints found in current-round tool calls)';

	const currentRoot = await resolveGitRepoRoot(pi, ctx, ctx.cwd);
	const repoRoots: string[] = [];
	const unresolvedHints: string[] = [];

	for (const hint of repoHints) {
		const root = await resolveGitRepoRoot(pi, ctx, hint);
		if (!root) {
			pushUnique(unresolvedHints, hint);
			continue;
		}
		if (currentRoot && root === currentRoot) continue;
		pushUnique(repoRoots, root);
		if (repoRoots.length >= MAX_TOOL_REPO_CANDIDATES) break;
	}

	const sections: string[] = [];
	for (const repoRoot of repoRoots) {
		sections.push(await buildRepoChangeSection(pi, ctx, repoRoot, 'tool repo'));
	}
	if (repoRoots.length >= MAX_TOOL_REPO_CANDIDATES) {
		sections.push(`[repo candidate limit reached: ${MAX_TOOL_REPO_CANDIDATES}]`);
	}
	if (unresolvedHints.length > 0) {
		sections.push([
			'<unresolved_repo_hints>',
			truncateText(unresolvedHints.join('\n'), MAX_TOOL_TEXT_CHARS),
			'</unresolved_repo_hints>',
		].join('\n'));
	}

	return sections.length
		? truncateText(sections.join('\n\n'), MAX_GIT_DIFF_CHARS)
		: '(tool calls only referenced current cwd repo or no resolvable external repo)';
}

function collectToolCalls(
	content: unknown,
	toolCalls: Map<string, ToolCallInfo>,
	transcript: string[],
	repoHints: string[],
): void {
	if (!Array.isArray(content)) return;

	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type !== 'toolCall') continue;
		if (typeof block.id !== 'string' || typeof block.name !== 'string') continue;

		const args = isRecord(block.arguments) ? block.arguments : {};
		toolCalls.set(block.id, { name: block.name, arguments: args });
		collectToolCallRepoHints(block.name, args, repoHints);
		transcript.push(`Assistant toolCall ${block.name}:\n${truncateText(formatJson(args), MAX_TOOL_TEXT_CHARS)}`);
	}
}

function buildRoundSections(messages: unknown[]): RoundSections {
	const transcript: string[] = [];
	const patches: string[] = [];
	const writes: string[] = [];
	const bash: string[] = [];
	const repoHints: string[] = [];
	const toolCalls = new Map<string, ToolCallInfo>();

	for (const message of messages) {
		if (!isRecord(message)) continue;
		const role = message.role;

		if (role === 'user') {
			const text = extractText(message.content).trim();
			if (text) transcript.push(`User:\n${truncateText(text, MAX_TOOL_TEXT_CHARS)}`);
			continue;
		}

		if (role === 'assistant') {
			const text = extractText(message.content).trim();
			if (text) transcript.push(`Assistant:\n${truncateText(text, MAX_TOOL_TEXT_CHARS)}`);
			collectToolCalls(message.content, toolCalls, transcript, repoHints);
			continue;
		}

		if (role !== 'toolResult') continue;

		const toolName = typeof message.toolName === 'string' ? message.toolName : 'unknown';
		const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
		const toolCall = toolCalls.get(toolCallId);
		const toolText = extractText(message.content).trim();
		const isError = message.isError === true ? ' ERROR' : '';
		transcript.push(`Tool result ${toolName}${isError}:\n${truncateText(toolText, MAX_TOOL_TEXT_CHARS)}`);

		if (/^(edit|apply_patch|functions\.apply_patch)$/.test(toolName)) {
			const detailPatch = isRecord(message.details) && typeof message.details.patch === 'string'
				? message.details.patch
				: undefined;
			const inputPatch = toolCall && typeof toolCall.arguments.input === 'string'
				? toolCall.arguments.input
				: undefined;
			const patchText = detailPatch ?? inputPatch;
			if (patchText) patches.push(`### ${toolName} patch\n${truncateText(patchText, MAX_PATCH_CHARS)}`);
		}

		if (/^(write|functions\.write_file)$/.test(toolName) && toolCall) {
			const filePath = typeof toolCall.arguments.path === 'string' ? toolCall.arguments.path : '(unknown path)';
			const content = typeof toolCall.arguments.content === 'string' ? toolCall.arguments.content : '';
			writes.push(`### write ${filePath}\n${truncateText(content, MAX_WRITE_CHARS)}`);
		}

		if (/^(bash|shell|exec_command|functions\.exec_command)$/.test(toolName) && toolCall) {
			const command = typeof toolCall.arguments.command === 'string'
				? toolCall.arguments.command
				: typeof toolCall.arguments.cmd === 'string'
					? toolCall.arguments.cmd
					: '(unknown command)';
			const commandCwd = typeof toolCall.arguments.cwd === 'string'
				? toolCall.arguments.cwd
				: typeof toolCall.arguments.workdir === 'string'
					? toolCall.arguments.workdir
					: undefined;
			bash.push(`### ${toolName}${commandCwd ? ` cwd=${commandCwd}` : ''}\n$ ${command}\n${truncateText(toolText, MAX_TOOL_TEXT_CHARS)}`);
		}
	}

	return {
		transcript: truncateText(transcript.join('\n\n---\n\n'), MAX_TRANSCRIPT_CHARS),
		patches: patches.join('\n\n') || '(no edit patch captured in this round)',
		writes: writes.join('\n\n') || '(no write tool content captured in this round)',
		bash: bash.join('\n\n') || '(no bash tool output captured in this round)',
		repoHints,
	};
}

function resolveReviewModel(ctx: ExtensionContext, modelSpec: string): Model<Api> {
	const spec = modelSpec.trim();
	if (!spec) throw new Error('co-dev review model is empty');

	const models = ctx.modelRegistry.getAvailable();
	const slashIndex = spec.indexOf('/');
	if (slashIndex > 0) {
		const provider = spec.slice(0, slashIndex);
		const modelId = spec.slice(slashIndex + 1);
		const providerLower = provider.toLowerCase();
		const modelLower = modelId.toLowerCase();
		const matches = models.filter(
			(model) => model.provider.toLowerCase() === providerLower && model.id.toLowerCase() === modelLower,
		);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`Ambiguous co-dev model: ${spec}`);
		throw new Error(`co-dev model not found: ${spec}`);
	}

	const specLower = spec.toLowerCase();
	const matches = models.filter(
		(model) => model.id.toLowerCase() === specLower || (model.name ?? '').toLowerCase() === specLower,
	);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const choices = matches.map((model) => `${model.provider}/${model.id}`).join(', ');
		throw new Error(`Ambiguous co-dev model ${spec}. Use provider/model. Matches: ${choices}`);
	}
	throw new Error(`co-dev model not found: ${spec}`);
}

async function resolveAuthedReviewModel(ctx: ExtensionContext, modelSpec: string): Promise<ResolvedReviewModel> {
	const model = resolveReviewModel(ctx, modelSpec);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Cannot use ${model.provider}/${model.id}: ${auth.error}`);
	if (!auth.apiKey) throw new Error(`No API key configured for ${model.provider}/${model.id}`);
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function buildReviewPrompt(pi: ExtensionAPI, ctx: ExtensionContext, messages: unknown[]): Promise<string> {
	const sections = buildRoundSections(messages);
	if (!sections.transcript.trim()) throw new Error('No current-round messages found for co-dev review');

	const gitStatus = await pi.exec('git', ['status', '--short', '--', '.'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	const gitStatusText = gitStatus.code === 0
		? truncateText(gitStatus.stdout.trim() || '(git status is clean)', MAX_TOOL_TEXT_CHARS)
		: `git status failed with exit code ${gitStatus.code}\nstderr:\n${truncateText(gitStatus.stderr, MAX_TOOL_TEXT_CHARS)}`;

	const unstagedGitDiff = await pi.exec('git', ['diff', '--no-ext-diff', '--', '.'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	const unstagedGitDiffText = unstagedGitDiff.code === 0
		? truncateText(unstagedGitDiff.stdout.trim() || '(unstaged git diff is empty)', MAX_GIT_DIFF_CHARS)
		: `unstaged git diff failed with exit code ${unstagedGitDiff.code}\nstderr:\n${truncateText(unstagedGitDiff.stderr, MAX_TOOL_TEXT_CHARS)}`;

	const stagedGitDiff = await pi.exec('git', ['diff', '--no-ext-diff', '--cached', '--', '.'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	const stagedGitDiffText = stagedGitDiff.code === 0
		? truncateText(stagedGitDiff.stdout.trim() || '(staged git diff is empty)', MAX_GIT_DIFF_CHARS)
		: `staged git diff failed with exit code ${stagedGitDiff.code}\nstderr:\n${truncateText(stagedGitDiff.stderr, MAX_TOOL_TEXT_CHARS)}`;

	const untrackedFiles = await pi.exec('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeout: 10000,
	});
	let untrackedGitDiffText: string;
	if (untrackedFiles.code !== 0) {
		untrackedGitDiffText = `git ls-files for untracked files failed with exit code ${untrackedFiles.code}\nstderr:\n${truncateText(untrackedFiles.stderr, MAX_TOOL_TEXT_CHARS)}`;
	} else {
		const untrackedPaths = untrackedFiles.stdout.split('\0').filter(Boolean);
		if (untrackedPaths.length === 0) {
			untrackedGitDiffText = '(no untracked files)';
		} else {
			const untrackedDiffs: string[] = [];
			for (const filePath of untrackedPaths.slice(0, 20)) {
				const untrackedGitDiff = await pi.exec('git', ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', filePath], {
					cwd: ctx.cwd,
					signal: ctx.signal,
					timeout: 10000,
				});
				const untrackedDiffText = untrackedGitDiff.code === 0 || untrackedGitDiff.code === 1
					? untrackedGitDiff.stdout.trim() || '(untracked file diff is empty)'
					: `untracked git diff failed with exit code ${untrackedGitDiff.code}\nstderr:\n${truncateText(untrackedGitDiff.stderr, MAX_TOOL_TEXT_CHARS)}`;
				untrackedDiffs.push(`### untracked ${filePath}\n${truncateText(untrackedDiffText, MAX_PATCH_CHARS)}`);
			}
			if (untrackedPaths.length > 20) {
				untrackedDiffs.push(`[skipped ${untrackedPaths.length - 20} untracked files]`);
			}
			untrackedGitDiffText = truncateText(untrackedDiffs.join('\n\n'), MAX_GIT_DIFF_CHARS);
		}
	}

	const gitChangesText = truncateText([
		'<git_status_short>',
		gitStatusText,
		'</git_status_short>',
		'',
		'<unstaged_git_diff>',
		unstagedGitDiffText,
		'</unstaged_git_diff>',
		'',
		'<staged_git_diff>',
		stagedGitDiffText,
		'</staged_git_diff>',
		'',
		'<untracked_git_diff>',
		untrackedGitDiffText,
		'</untracked_git_diff>',
	].join('\n'), MAX_GIT_DIFF_CHARS);
	const toolRepoChangesText = await buildToolRepoChanges(pi, ctx, sections.repoHints);
	const nestedGitChangesText = await buildNestedGitChanges(pi, ctx);

	return [
		'请审查主 agent 当前这一轮回答和代码改动质量。',
		'你要做出是否可以结束任务的判断。不要因为语气好就放行，只看事实和代码质量。',
		'如果发现 hidden fallback、mock、跳过真实校验、过度抽象、无意义小函数、没有必要验证、用户需求未完成，优先给 NO。',
		'如果 git change context 包含历史未提交内容，请优先结合 current_round_transcript、edit_patches、write_tool_content、tool_repos_after_round 判断当前轮新增或修改的部分。',
		'',
		`cwd: ${ctx.cwd}`,
		'',
		'<current_round_transcript>',
		sections.transcript,
		'</current_round_transcript>',
		'',
		'<edit_patches>',
		sections.patches,
		'</edit_patches>',
		'',
		'<write_tool_content>',
		sections.writes,
		'</write_tool_content>',
		'',
		'<bash_observations>',
		sections.bash,
		'</bash_observations>',
		'',
		'<tool_repos_after_round>',
		toolRepoChangesText,
		'</tool_repos_after_round>',
		'',
		'<current_git_diff_after_round>',
		gitChangesText,
		'</current_git_diff_after_round>',
		'',
		'<nested_git_repos_after_round>',
		nestedGitChangesText,
		'</nested_git_repos_after_round>',
	].join('\n');
}

function parseDecision(reviewText: string): Decision {
	const match = reviewText.match(/^\s*(?:LABEL\s*[:：]\s*)?(YES|NO)\b/im);
	if (!match) {
		throw new Error('co-dev reviewer output is missing a first-line LABEL: YES or LABEL: NO');
	}
	return match[1].toUpperCase() as Decision;
}

function formatModelSpec(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function buildReviewModelItems(ctx: ExtensionContext, currentModelSpec: string): SelectItem[] {
	return [...ctx.modelRegistry.getAvailable()]
		.sort((left, right) => formatModelSpec(left).localeCompare(formatModelSpec(right)))
		.map((model) => {
			const modelSpec = formatModelSpec(model);
			const label = modelSpec === currentModelSpec ? `${modelSpec} (current)` : modelSpec;
			const description = model.name && model.name !== model.id ? model.name : undefined;
			return { value: modelSpec, label, description };
		});
}


export default function (pi: ExtensionAPI) {
	let enabled = false;
	let reviewModelSpec = DEFAULT_REVIEW_MODEL;
	let reviewCount = 0;
	let lastDecision: Decision | undefined;
	let lastReviewAt: number | undefined;
	let reviewInProgress = false;

	const persistState = () => {
		pi.appendEntry<PersistedState>(STATE_TYPE, {
			enabled,
			modelSpec: reviewModelSpec,
			reviewCount,
			lastDecision,
			lastReviewAt,
		});
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus('co-dev', enabled ? `co-dev:${lastDecision ?? 'on'}` : undefined);
	};

	const reportError = (ctx: ExtensionContext, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`co-dev: ${message}`, 'error');
		pi.sendMessage<ReviewDetails>({
			customType: REVIEW_MESSAGE_TYPE,
			content: `co-dev error: ${message}`,
			display: true,
			details: {
				model: reviewModelSpec,
				reviewCount,
				error: message,
			},
		});
	};

	async function showSettings(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg('accent', theme.bold('co-dev Settings')), 1, 0));

			const settingsItems: SettingItem[] = [
				{
					id: 'enabled',
					label: 'Review loop',
					description: 'Run co-dev review after every agent answer',
					currentValue: enabled ? 'on' : 'off',
					values: ['on', 'off'],
				},
				{
					id: 'model',
					label: 'Review model',
					description: 'Enter to choose an available pi model',
					currentValue: reviewModelSpec,
					submenu: (currentValue, selectDone) => {
						const modelItems = buildReviewModelItems(ctx, currentValue);
						const modelList = new SelectList(
							modelItems,
							Math.min(modelItems.length, 15),
							{
								selectedPrefix: (text: string) => theme.fg('accent', text),
								selectedText: (text: string) => theme.fg('accent', text),
								description: (text: string) => theme.fg('muted', text),
								scrollInfo: (text: string) => theme.fg('dim', text),
								noMatch: (text: string) => theme.fg('warning', text),
							},
							{ maxPrimaryColumnWidth: 48 },
						);

						const selectedIndex = modelItems.findIndex((item) => item.value === currentValue);
						if (selectedIndex >= 0) modelList.setSelectedIndex(selectedIndex);

						modelList.onSelect = (item) => selectDone(item.value);
						modelList.onCancel = () => selectDone();
						return modelList;
					},
				},
				{
					id: 'review-count',
					label: 'Review count',
					description: 'Number of co-dev reviews stored in this session branch',
					currentValue: String(reviewCount),
					submenu: (currentValue, selectDone) => {
						const input = new Input();
						input.setValue(currentValue);
						input.onSubmit = (value) => selectDone(value.trim());
						input.onEscape = () => selectDone();

						const countInput = new Container();
						countInput.addChild(new Text(theme.fg('accent', theme.bold('Review count')), 1, 0));
						countInput.addChild(input);
						countInput.addChild(new Text(theme.fg('dim', 'Enter to save • Esc cancel')), 1, 0);

						return {
							render: (width: number) => countInput.render(width),
							invalidate: () => countInput.invalidate(),
							handleInput: (data: string) => input.handleInput(data),
						};
					},
				},
				{
					id: 'last-decision',
					label: 'Last decision',
					description: 'Most recent reviewer verdict',
					currentValue: lastDecision ?? 'none',
				},
			];

			let settingsList: SettingsList;

			const enableReviewLoop = (requestedModelSpec: string) => {
				void (async () => {
					try {
						const resolved = await resolveAuthedReviewModel(ctx, requestedModelSpec);
						if (reviewModelSpec !== requestedModelSpec) return;
						enabled = true;
						lastDecision = undefined;
						persistState();
						updateStatus(ctx);
						settingsList.updateValue('enabled', 'on');
						settingsList.updateValue('last-decision', 'none');
						ctx.ui.notify(`co-dev enabled with ${formatModelSpec(resolved.model)}`, 'info');
						tui.requestRender();
					} catch (error) {
						if (reviewModelSpec === requestedModelSpec) {
							enabled = false;
							persistState();
							updateStatus(ctx);
							settingsList.updateValue('enabled', 'off');
							tui.requestRender();
						}
						reportError(ctx, error);
					}
				})();
			};

			settingsList = new SettingsList(
				settingsItems,
				Math.min(settingsItems.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === 'enabled') {
						if (newValue === 'off') {
							enabled = false;
							persistState();
							updateStatus(ctx);
							ctx.ui.notify('co-dev disabled', 'info');
							return;
						}

						settingsList.updateValue('enabled', 'off');
						tui.requestRender();
						enableReviewLoop(reviewModelSpec);
						return;
					}

					if (id === 'model') {
						const wasEnabled = enabled;
						enabled = false;
						reviewModelSpec = newValue;
						lastDecision = undefined;
						persistState();
						updateStatus(ctx);
						settingsList.updateValue('last-decision', 'none');

						if (wasEnabled) {
							settingsList.updateValue('enabled', 'off');
							tui.requestRender();
							enableReviewLoop(newValue);
						} else {
							ctx.ui.notify(`co-dev model set to ${reviewModelSpec}`, 'info');
						}
						return;
					}

					if (id === 'review-count') {
						if (!/^(0|[1-9]\d*)$/.test(newValue)) {
							settingsList.updateValue('review-count', String(reviewCount));
							ctx.ui.notify('co-dev review count must be a non-negative integer', 'error');
							tui.requestRender();
							return;
						}

						const nextReviewCount = Number(newValue);
						if (!Number.isSafeInteger(nextReviewCount)) {
							settingsList.updateValue('review-count', String(reviewCount));
							ctx.ui.notify('co-dev review count is too large', 'error');
							tui.requestRender();
							return;
						}

						reviewCount = nextReviewCount;
						persistState();
						settingsList.updateValue('review-count', String(reviewCount));
						ctx.ui.notify(`co-dev review count set to ${reviewCount}`, 'info');
					}
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			container.addChild(settingsList);
			container.addChild(new Text(theme.fg('dim', 'enter/space edit • / search • esc close'), 1, 0));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.on('session_start', (_event, ctx) => {
		enabled = false;
		reviewModelSpec = DEFAULT_REVIEW_MODEL;
		reviewCount = 0;
		lastDecision = undefined;
		lastReviewAt = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== 'custom' || entry.customType !== STATE_TYPE) continue;
			const saved = entry.data as PersistedState | undefined;
			if (!saved) continue;
			enabled = saved.enabled === true;
			if (typeof saved.modelSpec === 'string' && saved.modelSpec.trim()) reviewModelSpec = saved.modelSpec;
			if (typeof saved.reviewCount === 'number') reviewCount = saved.reviewCount;
			if (saved.lastDecision === 'YES' || saved.lastDecision === 'NO') lastDecision = saved.lastDecision;
			if (typeof saved.lastReviewAt === 'number') lastReviewAt = saved.lastReviewAt;
		}

		updateStatus(ctx);
	});

	pi.registerCommand('co-dev', {
		description: 'Configure co-dev review loop',
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			try {
				if (!trimmed && ctx.hasUI) {
					await showSettings(ctx);
					return;
				}

				if (lower === 'settings' || lower === 'config') {
					if (ctx.hasUI) await showSettings(ctx);
					return;
				}

				if (!trimmed || lower === 'on') {
					const resolved = await resolveAuthedReviewModel(ctx, reviewModelSpec);
					enabled = true;
					lastDecision = undefined;
					persistState();
					updateStatus(ctx);
					if (ctx.hasUI) ctx.ui.notify(`co-dev enabled with ${formatModelSpec(resolved.model)}`, 'info');
					return;
				}

				if (lower === 'off') {
					enabled = false;
					persistState();
					updateStatus(ctx);
					if (ctx.hasUI) ctx.ui.notify('co-dev disabled', 'info');
					return;
				}

				if (lower === 'status') {
					const status = enabled ? `enabled, last=${lastDecision ?? 'none'}` : 'disabled';
					if (ctx.hasUI) ctx.ui.notify(`co-dev ${status}, model=${reviewModelSpec}, reviews=${reviewCount}`, 'info');
					return;
				}

				if (lower.startsWith('model ')) {
					const nextModelSpec = trimmed.slice('model '.length).trim();
					const resolved = await resolveAuthedReviewModel(ctx, nextModelSpec);
					reviewModelSpec = formatModelSpec(resolved.model);
					enabled = true;
					lastDecision = undefined;
					persistState();
					updateStatus(ctx);
					if (ctx.hasUI) ctx.ui.notify(`co-dev enabled with ${reviewModelSpec}`, 'info');
					return;
				}

				if (ctx.hasUI) ctx.ui.notify('Usage: /co-dev [settings|config|on|off|status|model <provider/model>]', 'warning');
			} catch (error) {
				reportError(ctx, error);
			}
		},
	});

	pi.on('agent_end', async (event, ctx) => {
		if (!enabled) return;

		if (reviewInProgress) {
			reportError(ctx, new Error('co-dev review is already running; refusing overlapping review'));
			return;
		}

		reviewInProgress = true;
		if (ctx.hasUI) ctx.ui.setStatus('co-dev', 'co-dev:reviewing');

		try {
			const resolved = await resolveAuthedReviewModel(ctx, reviewModelSpec);
			const reviewPrompt = await buildReviewPrompt(pi, ctx, event.messages);
			const response = await complete(
				resolved.model,
				{
					systemPrompt: REVIEW_SYSTEM_PROMPT,
					messages: [
						{
							role: 'user',
							content: [{ type: 'text', text: reviewPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					maxTokens: 2048,
					temperature: 0,
					signal: ctx.signal,
				},
			);
			const reviewText = extractText(response.content).trim();
			if (!reviewText) {
				throw new Error(
					`co-dev reviewer returned empty text (stopReason=${response.stopReason}, outputTokens=${response.usage.output})`,
				);
			}
			const decision = parseDecision(reviewText);

			reviewCount += 1;
			lastDecision = decision;
			lastReviewAt = Date.now();
			persistState();

			pi.sendMessage<ReviewDetails>({
				customType: REVIEW_MESSAGE_TYPE,
				content: reviewText,
				display: true,
				details: {
					decision,
					model: `${resolved.model.provider}/${resolved.model.id}`,
					reviewCount,
					usage: {
						input: response.usage.input,
						output: response.usage.output,
						totalTokens: response.usage.totalTokens,
						cost: response.usage.cost.total,
					},
				},
			});

			if (decision === 'NO') {
				pi.sendUserMessage(
					[
						'co-dev reviewer returned NO. Continue optimizing this task before treating it as complete.',
						'Address the review directly. If a review point is wrong, verify it with code or tests before disagreeing.',
						'',
						'<co-dev-review>',
						reviewText,
						'</co-dev-review>',
					].join('\n'),
					{ deliverAs: 'followUp' },
				);
			}
		} catch (error) {
			enabled = false;
			persistState();
			reportError(ctx, error);
		} finally {
			reviewInProgress = false;
			updateStatus(ctx);
		}
	});
}
