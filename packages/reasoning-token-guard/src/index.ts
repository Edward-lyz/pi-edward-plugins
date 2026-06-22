import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const ENTRY_TYPE = 'reasoning-token-guard';
const MIN_REASONING_TOKENS = 516;
const MAX_AUTO_RETRIES = 2;
const GPT_MODEL_PATTERN = /^gpt/i;
const GLOBAL_STATE_KEY = '__piBetterUxReasoningTokenGuard';

type ReasoningTokenMeasurement = {
	tokens: number;
	source: string;
};

type ReasoningTokenAudit = {
	version: 1;
	provider: string;
	model: string;
	api: string;
	responseId?: string;
	stopReason: AssistantMessage['stopReason'];
	threshold: number;
	reasoningTokens?: number;
	reasoningTokenSource?: string;
	reasoningTokenAvailable: boolean;
	outputTokens: number;
	totalTokens: number;
	blocked: boolean;
	retryQueued: boolean;
	retryAttempt: number;
	maxRetries: number;
	note?: string;
};

type RawCaptureState = {
	installed: boolean;
	fetchPatched: boolean;
	webSocketPatched: boolean;
	byResponseId: Map<string, ReasoningTokenMeasurement>;
};

type WebSocketLike = {
	addEventListener(type: string, listener: (event: unknown) => void): void;
};

type WebSocketConstructorLike = new (url: string | URL, options?: unknown) => WebSocketLike;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readNumber(root: unknown, path: string[]): number | undefined {
	let current = root;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function getRawCaptureState(): RawCaptureState {
	const globalScope = globalThis as typeof globalThis & {
		[GLOBAL_STATE_KEY]?: RawCaptureState;
	};
	globalScope[GLOBAL_STATE_KEY] ??= {
		installed: false,
		fetchPatched: false,
		webSocketPatched: false,
		byResponseId: new Map(),
	};
	return globalScope[GLOBAL_STATE_KEY];
}

function extractRawReasoningTokens(value: unknown): number | undefined {
	const candidates = [
		['usage', 'output_tokens_details', 'reasoning_tokens'],
		['usage', 'completion_tokens_details', 'reasoning_tokens'],
		['usage', 'reasoning_output_tokens'],
		['usage', 'reasoning_tokens'],
		['usage', 'reasoningTokens'],
		['last_token_usage', 'reasoning_output_tokens'],
		['total_token_usage', 'reasoning_output_tokens'],
	];

	for (const path of candidates) {
		const tokens = readNumber(value, path);
		if (tokens !== undefined) return tokens;
	}

	return undefined;
}

function captureRawEvent(state: RawCaptureState, event: unknown): void {
	if (!isRecord(event)) return;
	const response = isRecord(event.response) ? event.response : undefined;
	const responseId = typeof response?.id === 'string'
		? response.id
		: typeof event.id === 'string'
			? event.id
			: undefined;
	if (!responseId) return;

	const rawTokens = extractRawReasoningTokens(response ?? event);
	if (rawTokens === undefined) return;

	state.byResponseId.set(responseId, {
		tokens: rawTokens,
		source: response
			? 'raw.response.usage.output_tokens_details.reasoning_tokens'
			: 'raw.usage.completion_tokens_details.reasoning_tokens',
	});
}

function observeSseText(state: RawCaptureState, buffer: { text: string }, text: string): void {
	buffer.text += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	let separatorIndex = buffer.text.indexOf('\n\n');
	while (separatorIndex !== -1) {
		const chunk = buffer.text.slice(0, separatorIndex);
		buffer.text = buffer.text.slice(separatorIndex + 2);
		const data = chunk
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.join('\n')
			.trim();
		if (data && data !== '[DONE]') captureRawEvent(state, JSON.parse(data));
		separatorIndex = buffer.text.indexOf('\n\n');
	}
}

function shouldObserveResponse(response: Response): boolean {
	return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
}

function installFetchCapture(state: RawCaptureState): void {
	if (state.fetchPatched) return;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const response = await originalFetch(input, init);
		if (!response.body || !shouldObserveResponse(response)) return response;

		const decoder = new TextDecoder();
		const buffer = { text: '' };
		const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				observeSseText(state, buffer, decoder.decode(chunk, { stream: true }));
				controller.enqueue(chunk);
			},
			flush() {
				const tail = decoder.decode();
				if (tail) observeSseText(state, buffer, tail);
			},
		}));
		return new Response(stream, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	state.fetchPatched = true;
}

function installWebSocketCapture(state: RawCaptureState): void {
	if (state.webSocketPatched) return;
	const globalScope = globalThis as unknown as { WebSocket?: WebSocketConstructorLike };
	const OriginalWebSocket = globalScope.WebSocket;
	if (!OriginalWebSocket) return;

	const WrappedWebSocket = function (this: unknown, url: string | URL, options?: unknown): WebSocketLike {
		const socket = new OriginalWebSocket(url, options);
		socket.addEventListener('message', (event: unknown) => {
			if (!isRecord(event) || typeof event.data !== 'string') return;
			captureRawEvent(state, JSON.parse(event.data));
		});
		return socket;
	} as unknown as WebSocketConstructorLike;
	WrappedWebSocket.prototype = OriginalWebSocket.prototype;
	Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);
	globalScope.WebSocket = WrappedWebSocket;
	state.webSocketPatched = true;
}

function installRawReasoningTokenCapture(): RawCaptureState {
	const state = getRawCaptureState();
	if (state.installed) return state;
	installFetchCapture(state);
	installWebSocketCapture(state);
	state.installed = true;
	return state;
}

function extractReasoningTokens(message: AssistantMessage): ReasoningTokenMeasurement | undefined {
	const candidates: Array<[string, string[]]> = [
		['usage.reasoningTokens', ['usage', 'reasoningTokens']],
		['usage.reasoning_tokens', ['usage', 'reasoning_tokens']],
		['usage.reasoningOutputTokens', ['usage', 'reasoningOutputTokens']],
		['usage.reasoning_output_tokens', ['usage', 'reasoning_output_tokens']],
		['usage.outputTokensDetails.reasoningTokens', ['usage', 'outputTokensDetails', 'reasoningTokens']],
		['usage.output_tokens_details.reasoning_tokens', ['usage', 'output_tokens_details', 'reasoning_tokens']],
		['usage.completionTokensDetails.reasoningTokens', ['usage', 'completionTokensDetails', 'reasoningTokens']],
		['usage.completion_tokens_details.reasoning_tokens', ['usage', 'completion_tokens_details', 'reasoning_tokens']],
		['details.reasoningTokens', ['details', 'reasoningTokens']],
		['details.reasoning_tokens', ['details', 'reasoning_tokens']],
	];

	for (const [source, path] of candidates) {
		const tokens = readNumber(message, path);
		if (tokens !== undefined) return { tokens, source };
	}

	return undefined;
}

function getReasoningTokens(
	message: AssistantMessage,
	rawCaptureState: RawCaptureState,
): ReasoningTokenMeasurement | undefined {
	return extractReasoningTokens(message)
		?? (message.responseId ? rawCaptureState.byResponseId.get(message.responseId) : undefined);
}

function isTrackedModel(message: AssistantMessage): boolean {
	return GPT_MODEL_PATTERN.test(message.model)
		|| (message.responseModel !== undefined && GPT_MODEL_PATTERN.test(message.responseModel));
}

function isFinalReply(message: AssistantMessage): boolean {
	return message.stopReason === 'stop' || message.stopReason === 'length';
}

function withReasoningTokens(
	message: AssistantMessage,
	measurement: ReasoningTokenMeasurement,
): AssistantMessage {
	return {
		...message,
		usage: {
			...message.usage,
			reasoningTokens: measurement.tokens,
			reasoningTokenSource: measurement.source,
		},
	} as AssistantMessage;
}

function buildBlockedText(
	message: AssistantMessage,
	measurement: ReasoningTokenMeasurement,
	retryQueued: boolean,
	retryAttempt: number,
): string {
	const retryText = retryQueued
		? `Queued retry ${retryAttempt}/${MAX_AUTO_RETRIES}.`
		: `Max retries reached (${MAX_AUTO_RETRIES}).`;
	return [
		'Reasoning token guard blocked this assistant reply.',
		`Model: ${message.provider}/${message.model}`,
		`Reasoning tokens: ${measurement.tokens} < ${MIN_REASONING_TOKENS}`,
		retryText,
	].join('\n');
}

function notifyUnavailableOnce(ctx: ExtensionContext, warned: { value: boolean }): void {
	if (warned.value || !ctx.hasUI) return;
	warned.value = true;
	ctx.ui.notify(
		'reasoning-token-guard: provider did not expose real reasoning tokens; gating disabled for this message.',
		'warning',
	);
}

export default function reasoningTokenGuard(pi: ExtensionAPI) {
	const rawCaptureState = installRawReasoningTokenCapture();
	let retryAttempts = 0;
	const warnedUnavailable = { value: false };

	pi.on('input', (event) => {
		if (event.source !== 'extension') retryAttempts = 0;
	});

	pi.on('message_end', (event, ctx) => {
		if (event.message.role !== 'assistant') return;

		const message = event.message as AssistantMessage;
		if (!isTrackedModel(message)) return;

		const measurement = getReasoningTokens(message, rawCaptureState);
		const blocked = measurement !== undefined
			&& isFinalReply(message)
			&& measurement.tokens < MIN_REASONING_TOKENS;
		const retryQueued = blocked && retryAttempts < MAX_AUTO_RETRIES;
		const retryAttempt = retryQueued ? retryAttempts + 1 : retryAttempts;

		pi.appendEntry<ReasoningTokenAudit>(ENTRY_TYPE, {
			version: 1,
			provider: message.provider,
			model: message.model,
			api: message.api,
			...(message.responseId ? { responseId: message.responseId } : {}),
			stopReason: message.stopReason,
			threshold: MIN_REASONING_TOKENS,
			...(measurement ? {
				reasoningTokens: measurement.tokens,
				reasoningTokenSource: measurement.source,
			} : {}),
			reasoningTokenAvailable: measurement !== undefined,
			outputTokens: message.usage.output,
			totalTokens: message.usage.totalTokens,
			blocked,
			retryQueued,
			retryAttempt,
			maxRetries: MAX_AUTO_RETRIES,
			...(!measurement ? {
				note: 'Real reasoning token field unavailable; output tokens are not used as a proxy.',
			} : {}),
		});

		if (!measurement) {
			notifyUnavailableOnce(ctx, warnedUnavailable);
			return;
		}

		const messageWithReasoningTokens = withReasoningTokens(message, measurement);
		if (!blocked) return { message: messageWithReasoningTokens };

		if (retryQueued) {
			retryAttempts += 1;
			pi.setThinkingLevel('xhigh');
			pi.sendUserMessage([
				'Reasoning token guard rejected the previous assistant reply.',
				`Observed reasoning tokens: ${measurement.tokens}. Minimum required: ${MIN_REASONING_TOKENS}.`,
				`Retry attempt: ${retryAttempts}/${MAX_AUTO_RETRIES}.`,
				'Answer the original user request again with deeper private reasoning before finalizing.',
			].join('\n'), { deliverAs: 'followUp' });
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`reasoning-token-guard: blocked ${measurement.tokens} reasoning tokens`,
				retryQueued ? 'warning' : 'error',
			);
		}

		return {
			message: {
				...messageWithReasoningTokens,
				content: [{
					type: 'text',
					text: buildBlockedText(
						message,
						measurement,
						retryQueued,
						retryAttempt,
					),
				}],
				stopReason: 'stop',
			},
		};
	});
}
