import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

type TokenRates = {
	ttft: number | undefined;
	output: number | undefined;
	outputEstimated: boolean;
};

type RuntimeState = {
	roundStartedAt: number | undefined;
	roundFirstAssistantAt: number | undefined;
	messageStartedAt: number | undefined;
	estimatedOutputTokens: number;
	lastRates: TokenRates;
	requestRender: (() => void) | undefined;
};

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

function buildStatusLine(ctx: ExtensionContext, state: RuntimeState): string {
	const theme = ctx.ui.theme;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'no-model';
	const ttft = state.roundStartedAt !== undefined && state.roundFirstAssistantAt === undefined
		? Math.max(0.001, (Date.now() - state.roundStartedAt) / 1000)
		: state.roundFirstAssistantAt === undefined
			? state.lastRates.ttft
			: Math.max(0.001, (state.roundFirstAssistantAt - (state.roundStartedAt ?? state.roundFirstAssistantAt)) / 1000);
	const ratePrefix = state.lastRates.outputEstimated ? '~' : '';
	const rateText = `TTFT ${formatRate(ttft)}s · TPS ${ratePrefix}${formatRate(state.lastRates.output)}`;
	const cacheHitRate = formatCacheHitRate(ctx);

	return [
		theme.fg('accent', ` ${model} `),
		theme.fg('muted', formatWindow(ctx)),
		cacheHitRate === undefined ? undefined : theme.fg('muted', cacheHitRate),
		theme.fg('success', rateText),
	].filter((part): part is string => part !== undefined).join(theme.fg('dim', ' │ '));
}

export default function statusline(pi: ExtensionAPI) {
	const state: RuntimeState = {
		roundStartedAt: undefined,
		roundFirstAssistantAt: undefined,
		messageStartedAt: undefined,
		estimatedOutputTokens: 0,
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
					return [truncateToWidth(buildStatusLine(ctx, state), width, '…')];
				},
			};
		});
	});

	pi.on('session_shutdown', (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		state.requestRender = undefined;
	});

	pi.on('model_select', refresh);

	pi.on('before_agent_start', () => {
		state.roundStartedAt = Date.now();
		state.roundFirstAssistantAt = undefined;
		state.messageStartedAt = undefined;
		state.estimatedOutputTokens = 0;
		state.lastRates = { ttft: undefined, output: undefined, outputEstimated: false };
		refresh();
	});

	pi.on('before_provider_request', () => {
		state.messageStartedAt = Date.now();
		state.estimatedOutputTokens = 0;
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
		state.messageStartedAt = undefined;
		refresh();
	});
}
