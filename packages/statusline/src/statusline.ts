import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

type TokenRates = {
	ttft: number | undefined;
	output: number | undefined;
	outputEstimated: boolean;
};

type ThinkingMeasurement = {
	tokens: number;
	real: boolean;
};

type RuntimeState = {
	roundStartedAt: number | undefined;
	roundFirstAssistantAt: number | undefined;
	messageStartedAt: number | undefined;
	estimatedOutputTokens: number;
	currentThinking: ThinkingMeasurement | undefined;
	lastThinking: ThinkingMeasurement | undefined;
	lastRates: TokenRates;
	requestRender: (() => void) | undefined;
};

const WHITESPACE_PATTERN = /\s/u;
const LETTER_OR_NUMBER_PATTERN = /[\p{Letter}\p{Number}]/u;

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatWindow(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow) return 'ctx ?/?';
	const used = usage?.tokens;
	if (used === null || used === undefined) return `ctx ?/${formatCount(contextWindow)}`;
	const percent = usage?.percent === null || usage?.percent === undefined ? '?' : `${usage.percent.toFixed(0)}%`;
	return `ctx ${formatCount(used)}/${formatCount(contextWindow)} ${percent}`;
}

function formatCacheHitRate(ctx: ExtensionContext): string | undefined {
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let hitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;

		const message = entry.message as AssistantMessage;
		totalCacheRead += message.usage.cacheRead;
		totalCacheWrite += message.usage.cacheWrite;
		const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (promptTokens > 0) hitRate = (message.usage.cacheRead / promptTokens) * 100;
	}
	if (hitRate === undefined || (totalCacheRead === 0 && totalCacheWrite === 0)) return undefined;
	return `CH ${hitRate.toFixed(1)}%`;
}

function formatRate(value: number | undefined): string {
	if (value === undefined) return '…';
	if (value < 10) return value.toFixed(1);
	return value.toFixed(0);
}

function readNumber(root: unknown, path: string[]): number | undefined {
	let current = root;
	for (const key of path) {
		if (typeof current !== 'object' || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function isCjkCodePoint(codePoint: number): boolean {
	return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
		|| (codePoint >= 0x4e00 && codePoint <= 0x9fff)
		|| (codePoint >= 0xf900 && codePoint <= 0xfaff)
		|| (codePoint >= 0x3040 && codePoint <= 0x30ff)
		|| (codePoint >= 0xac00 && codePoint <= 0xd7af)
		|| (codePoint >= 0x20000 && codePoint <= 0x2fa1f);
}

function isAsciiLetterOrNumber(codePoint: number): boolean {
	return (codePoint >= 0x30 && codePoint <= 0x39)
		|| (codePoint >= 0x41 && codePoint <= 0x5a)
		|| (codePoint >= 0x61 && codePoint <= 0x7a);
}

function countGenericTokens(text: string): number {
	const encoder = new TextEncoder();
	let tokens = 0;
	let wordRun = '';
	const flushWordRun = () => {
		if (!wordRun) return;
		tokens += Math.max(1, Math.ceil(encoder.encode(wordRun).byteLength / 4));
		wordRun = '';
	};

	for (const char of text) {
		if (WHITESPACE_PATTERN.test(char)) {
			flushWordRun();
			continue;
		}

		const codePoint = char.codePointAt(0);
		if (codePoint === undefined) continue;
		if (isCjkCodePoint(codePoint)) {
			flushWordRun();
			tokens += 1;
			continue;
		}
		if (isAsciiLetterOrNumber(codePoint) || char === '\'') {
			wordRun += char;
			continue;
		}
		if (LETTER_OR_NUMBER_PATTERN.test(char)) {
			wordRun += char;
			continue;
		}
		flushWordRun();
		tokens += 1;
	}
	flushWordRun();
	return tokens;
}

function extractThinkingMeasurement(message: AssistantMessage): ThinkingMeasurement | undefined {
	const realTokenPaths = [
		['usage', 'reasoningTokens'],
		['usage', 'reasoning_tokens'],
		['usage', 'reasoningOutputTokens'],
		['usage', 'reasoning_output_tokens'],
		['usage', 'thinkingTokens'],
		['usage', 'thinking_tokens'],
		['usage', 'outputTokensDetails', 'reasoningTokens'],
		['usage', 'output_tokens_details', 'reasoning_tokens'],
		['usage', 'completionTokensDetails', 'reasoningTokens'],
		['usage', 'completion_tokens_details', 'reasoning_tokens'],
		['details', 'reasoningTokens'],
		['details', 'reasoning_tokens'],
	];
	for (const path of realTokenPaths) {
		const tokens = readNumber(message, path);
		if (tokens !== undefined) return { tokens, real: true };
	}

	const visibleThinking = message.content
		.filter((content) => content.type === 'thinking' && !content.redacted && content.thinking.trim().length > 0)
		.map((content) => content.type === 'thinking' ? content.thinking : '')
		.join('\n');
	if (!visibleThinking) return undefined;
	return { tokens: countGenericTokens(visibleThinking), real: false };
}

function formatThinking(measurement: ThinkingMeasurement | undefined): string | undefined {
	if (!measurement) return undefined;
	const prefix = measurement.real ? '' : '~';
	return `think ${prefix}${formatCount(measurement.tokens)}`;
}

function elapsedSeconds(start: number | undefined, end: number): number | undefined {
	if (start === undefined) return undefined;
	return Math.max(0.001, (end - start) / 1000);
}

function calculateRates(message: AssistantMessage, state: RuntimeState, endedAt: number): TokenRates {
	const ttft = elapsedSeconds(state.roundStartedAt, state.roundFirstAssistantAt ?? endedAt);
	const outputSeconds = elapsedSeconds(state.messageStartedAt, endedAt);
	if (outputSeconds === undefined) {
		return { ttft, output: undefined, outputEstimated: false };
	}
	return { ttft, output: message.usage.output / outputSeconds, outputEstimated: false };
}

function buildStatusLine(ctx: ExtensionContext, state: RuntimeState, pi: ExtensionAPI): string {
	const theme = ctx.ui.theme;
	const thinkingLevel = pi.getThinkingLevel();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id} · thinking ${thinkingLevel}` : `no-model · thinking ${thinkingLevel}`;
	const ttft = state.roundStartedAt !== undefined && state.roundFirstAssistantAt === undefined
		? Math.max(0.001, (Date.now() - state.roundStartedAt) / 1000)
		: state.roundFirstAssistantAt === undefined
			? state.lastRates.ttft
			: Math.max(0.001, (state.roundFirstAssistantAt - (state.roundStartedAt ?? state.roundFirstAssistantAt)) / 1000);
	const ratePrefix = state.lastRates.outputEstimated ? '~' : '';
	const rateText = `TTFT ${formatRate(ttft)}s · TPS ${ratePrefix}${formatRate(state.lastRates.output)}`;
	const cacheHitRate = formatCacheHitRate(ctx);
	const thinking = formatThinking(state.currentThinking ?? state.lastThinking);

	return [
		theme.fg('accent', ` ${model} `),
		theme.fg('muted', formatWindow(ctx)),
		cacheHitRate === undefined ? undefined : theme.fg('muted', cacheHitRate),
		thinking === undefined ? undefined : theme.fg('warning', thinking),
		theme.fg('success', rateText),
	].filter((part): part is string => part !== undefined).join(theme.fg('dim', ' │ '));
}

export default function statusline(pi: ExtensionAPI) {
	const state: RuntimeState = {
		roundStartedAt: undefined,
		roundFirstAssistantAt: undefined,
		messageStartedAt: undefined,
		estimatedOutputTokens: 0,
		currentThinking: undefined,
		lastThinking: undefined,
		lastRates: { ttft: undefined, output: undefined, outputEstimated: false },
		requestRender: undefined,
	};

	const refresh = () => state.requestRender?.();

	pi.on('session_start', (_event, ctx) => {
		ctx.ui.setFooter((tui) => {
			state.requestRender = () => tui.requestRender();
			const timer = setInterval(() => tui.requestRender(), 1000);
			return {
				dispose() {
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					return [truncateToWidth(buildStatusLine(ctx, state, pi), width, '…')];
				},
			};
		});
	});

	pi.on('session_shutdown', (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		state.requestRender = undefined;
	});

	pi.on('model_select', refresh);
	pi.on('thinking_level_select', refresh);

	pi.on('before_agent_start', () => {
		state.roundStartedAt = Date.now();
		state.roundFirstAssistantAt = undefined;
		state.messageStartedAt = undefined;
		state.estimatedOutputTokens = 0;
		state.currentThinking = undefined;
		state.lastThinking = undefined;
		state.lastRates = { ttft: undefined, output: undefined, outputEstimated: false };
		refresh();
	});

	pi.on('before_provider_request', () => {
		state.messageStartedAt = Date.now();
		state.estimatedOutputTokens = 0;
		state.currentThinking = undefined;
		state.lastRates.output = undefined;
		state.lastRates.outputEstimated = false;
		refresh();
	});

	pi.on('message_update', (event) => {
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === 'done' || streamEvent.type === 'error') {
			return;
		}

		const now = Date.now();
		state.roundFirstAssistantAt ??= now;
		state.lastRates.ttft = Math.max(0.001, (state.roundFirstAssistantAt - (state.roundStartedAt ?? state.roundFirstAssistantAt)) / 1000);

		const outputSeconds = elapsedSeconds(state.messageStartedAt, now);
		const outputTokens = streamEvent.partial.usage.output;
		state.currentThinking = extractThinkingMeasurement(streamEvent.partial);
		if (outputSeconds !== undefined && outputTokens > 0) {
			state.lastRates.output = outputTokens / outputSeconds;
			state.lastRates.outputEstimated = false;
		} else if (outputSeconds !== undefined && 'delta' in streamEvent) {
			state.estimatedOutputTokens += Math.max(1, Math.ceil(streamEvent.delta.length / 4));
			state.lastRates.output = state.estimatedOutputTokens / outputSeconds;
			state.lastRates.outputEstimated = true;
		}
		refresh();
	});

	pi.on('message_end', (event) => {
		if (event.message.role !== 'assistant') return;
		state.lastRates = calculateRates(event.message, state, Date.now());
		state.lastThinking = extractThinkingMeasurement(event.message);
		state.currentThinking = undefined;
		state.messageStartedAt = undefined;
		refresh();
	});
}
