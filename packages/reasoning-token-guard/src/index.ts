import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const ENTRY_TYPE = 'reasoning-token-guard';
const MIN_REASONING_TOKENS = 516;
const MAX_TRANSPORT_RETRIES = 2;
const GPT_MODEL_PATTERN = /^gpt/i;
const GLOBAL_STATE_KEY = '__piBetterUxReasoningTokenGuard';
const PATCH_VERSION = 4;

type ReasoningTokenMeasurement = {
	tokens: number;
	source: string;
};

type RawRetryInfo = {
	attempts: number;
	rejectedReasoningTokens: number[];
	finalReasoningTokens?: number;
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
	transportRetries: number;
	rejectedReasoningTokens: number[];
	maxTransportRetries: number;
	note?: string;
};

type RawCaptureState = {
	patchVersion?: number;
	installed?: boolean;
	fetchPatched: boolean;
	webSocketPatched: boolean;
	fetchOriginal?: typeof fetch;
	fetchWrapped?: typeof fetch;
	webSocketOriginal?: WebSocketConstructorLike;
	webSocketWrapped?: WebSocketConstructorLike;
	notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
	byResponseId: Map<string, ReasoningTokenMeasurement>;
	retryByResponseId: Map<string, RawRetryInfo>;
};

type RawStreamSummary = {
	responseId?: string;
	measurement?: ReasoningTokenMeasurement;
	hasToolCall: boolean;
	terminal: boolean;
};

type WebSocketLike = {
	readyState?: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
};

type WebSocketConstructorLike = new (url: string | URL, options?: unknown) => WebSocketLike;

type PatchedWebSocketPrototype = {
	send?: (data: string) => void;
	addEventListener?: (type: string, listener: (event: unknown) => void) => void;
	__reasoningTokenGuardVersion?: number;
	__reasoningTokenGuardSend?: (data: string) => void;
	__reasoningTokenGuardAddEventListener?: (type: string, listener: (event: unknown) => void) => void;
};

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
		[GLOBAL_STATE_KEY]?: Partial<RawCaptureState>;
	};
	const state = globalScope[GLOBAL_STATE_KEY] ?? {};
	state.fetchPatched ??= false;
	state.webSocketPatched ??= false;
	state.byResponseId ??= new Map();
	state.retryByResponseId ??= new Map();
	globalScope[GLOBAL_STATE_KEY] = state;
	return state as RawCaptureState;
}

function extractReasoningMeasurement(value: unknown, sourcePrefix: string): ReasoningTokenMeasurement | undefined {
	const candidates: Array<[string, string[]]> = [
		['usage.output_tokens_details.reasoning_tokens', ['usage', 'output_tokens_details', 'reasoning_tokens']],
		['usage.completion_tokens_details.reasoning_tokens', ['usage', 'completion_tokens_details', 'reasoning_tokens']],
		['usage.reasoning_output_tokens', ['usage', 'reasoning_output_tokens']],
		['usage.reasoning_tokens', ['usage', 'reasoning_tokens']],
		['usage.reasoningTokens', ['usage', 'reasoningTokens']],
		['last_token_usage.reasoning_output_tokens', ['last_token_usage', 'reasoning_output_tokens']],
		['total_token_usage.reasoning_output_tokens', ['total_token_usage', 'reasoning_output_tokens']],
	];

	for (const [source, path] of candidates) {
		const tokens = readNumber(value, path);
		if (tokens !== undefined) return { tokens, source: `${sourcePrefix}.${source}` };
	}

	return undefined;
}

function createRawStreamSummary(): RawStreamSummary {
	return { hasToolCall: false, terminal: false };
}

function updateRawStreamSummary(summary: RawStreamSummary, event: unknown): void {
	if (!isRecord(event)) return;

	const eventType = typeof event.type === 'string' ? event.type : undefined;
	const item = isRecord(event.item) ? event.item : undefined;
	if ((eventType === 'response.output_item.added' || eventType === 'response.output_item.done')
		&& item?.type === 'function_call') {
		summary.hasToolCall = true;
	}

	const response = isRecord(event.response) ? event.response : undefined;
	const responseId = typeof response?.id === 'string'
		? response.id
		: typeof event.id === 'string'
			? event.id
			: undefined;
	if (responseId) summary.responseId = responseId;

	const measurement = extractReasoningMeasurement(
		response ?? event,
		response ? 'raw.response' : 'raw',
	);
	if (measurement) summary.measurement = measurement;

	if (eventType === 'response.completed'
		|| eventType === 'response.done'
		|| eventType === 'response.incomplete'
		|| eventType === 'response.failed'
		|| eventType === 'error') {
		summary.terminal = true;
	}
}

function observeSseText(summary: RawStreamSummary, buffer: { text: string }, text: string): void {
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
		if (data && data !== '[DONE]') updateRawStreamSummary(summary, JSON.parse(data));
		separatorIndex = buffer.text.indexOf('\n\n');
	}
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function decodeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
	if (typeof body === 'string') return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
	return undefined;
}

async function decodeWebSocketData(data: unknown): Promise<string | undefined> {
	if (typeof data === 'string') return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	if (isRecord(data) && typeof data.arrayBuffer === 'function') {
		const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return undefined;
}

function parseGuardedPayload(payload: unknown): Record<string, unknown> | undefined {
	const body = typeof payload === 'string'
		? parseJsonRecord(payload)
		: isRecord(payload)
			? payload
			: undefined;
	const model = body?.model;
	if (typeof model !== 'string' || !GPT_MODEL_PATTERN.test(model)) return undefined;
	return body?.stream === true || body?.type === 'response.create' ? body : undefined;
}

async function parseGuardedFetchBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Record<string, unknown> | undefined> {
	const requestBody = await decodeBody(init?.body);
	if (requestBody) return parseGuardedPayload(requestBody);

	if (typeof Request !== 'undefined' && input instanceof Request) {
		const inputBody = await input.clone().text();
		return inputBody ? parseGuardedPayload(inputBody) : undefined;
	}

	return undefined;
}

function shouldObserveResponse(response: Response): boolean {
	return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
}

async function bufferSseResponse(response: Response): Promise<{ body: Uint8Array; summary: RawStreamSummary }> {
	if (!response.body) throw new Error('Cannot buffer SSE response without body');

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	const decoder = new TextDecoder();
	const sseBuffer = { text: '' };
	const summary = createRawStreamSummary();
	let totalLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.byteLength;
			observeSseText(summary, sseBuffer, decoder.decode(value, { stream: true }));
		}
		const tail = decoder.decode();
		if (tail) observeSseText(summary, sseBuffer, tail);
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, summary };
}

function recordRawResponse(state: RawCaptureState, summary: RawStreamSummary, rejectedReasoningTokens: number[]): void {
	if (!summary.responseId) return;
	if (summary.measurement) state.byResponseId.set(summary.responseId, summary.measurement);
	state.retryByResponseId.set(summary.responseId, {
		attempts: rejectedReasoningTokens.length,
		rejectedReasoningTokens: [...rejectedReasoningTokens],
		...(summary.measurement ? { finalReasoningTokens: summary.measurement.tokens } : {}),
	});
}

function shouldReplayRawResponse(response: Response, summary: RawStreamSummary): boolean {
	return response.ok
		&& summary.terminal
		&& !summary.hasToolCall
		&& summary.measurement !== undefined
		&& summary.measurement.tokens < MIN_REASONING_TOKENS;
}

function notifyReplay(state: RawCaptureState, guardedPayload: Record<string, unknown>, attempt: number, tokens: number): void {
	const model = typeof guardedPayload.model === 'string' ? guardedPayload.model : 'gpt';
	state.notify?.(
		`reasoning-token-guard: ${model} reasoning tokens ${tokens} < ${MIN_REASONING_TOKENS}; replaying ${attempt}/${MAX_TRANSPORT_RETRIES}`,
		'warning',
	);
}

function notifyReplayAccepted(ctx: ExtensionContext, rawRetry: RawRetryInfo | undefined, measurement: ReasoningTokenMeasurement): void {
	if (!ctx.hasUI || !rawRetry || rawRetry.attempts === 0) return;
	ctx.ui.notify(
		`reasoning-token-guard: replay accepted; rejected ${rawRetry.rejectedReasoningTokens.join(', ')}; final ${measurement.tokens}`,
		'info',
	);
}

function bufferedResponse(response: Response, body: Uint8Array): Response {
	const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
	return new Response(arrayBuffer, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function installFetchCapture(state: RawCaptureState): void {
	if (globalThis.fetch === state.fetchWrapped && state.patchVersion === PATCH_VERSION) return;
	const originalFetch = globalThis.fetch === state.fetchWrapped && state.fetchOriginal
		? state.fetchOriginal
		: globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const guardedPayload = await parseGuardedFetchBody(input, init);
		if (!guardedPayload) return originalFetch(input, init);

		const rejectedReasoningTokens: number[] = [];
		while (true) {
			const response = await originalFetch(input, init);
			if (!response.body || !shouldObserveResponse(response)) return response;

			const { body, summary } = await bufferSseResponse(response);
			if (shouldReplayRawResponse(response, summary)
				&& rejectedReasoningTokens.length < MAX_TRANSPORT_RETRIES) {
				const reasoningTokens = summary.measurement?.tokens ?? 0;
				rejectedReasoningTokens.push(reasoningTokens);
				notifyReplay(state, guardedPayload, rejectedReasoningTokens.length, reasoningTokens);
				continue;
			}

			recordRawResponse(state, summary, rejectedReasoningTokens);
			return bufferedResponse(response, body);
		}
	};
	state.fetchOriginal = originalFetch;
	state.fetchWrapped = globalThis.fetch;
	state.fetchPatched = true;
}

function installWebSocketCapture(state: RawCaptureState): void {
	const globalScope = globalThis as unknown as { WebSocket?: WebSocketConstructorLike };
	const OriginalWebSocket = globalScope.WebSocket;
	if (!OriginalWebSocket) return;
	if (OriginalWebSocket === state.webSocketWrapped && state.patchVersion === PATCH_VERSION) return;
	const BaseWebSocket = OriginalWebSocket === state.webSocketWrapped && state.webSocketOriginal
		? state.webSocketOriginal
		: OriginalWebSocket;
	patchWebSocketPrototypeChain(BaseWebSocket, state);

	const WrappedWebSocket = function (this: unknown, url: string | URL, options?: unknown): WebSocketLike {
		const socket = new BaseWebSocket(url, options);
		const listeners = new Map<string, Set<(event: unknown) => void>>();
		const dispatch = (type: string, event: unknown) => {
			for (const listener of listeners.get(type) ?? []) listener(event);
		};

		socket.addEventListener('message', (event: unknown) => {
			observeWebSocketRawMessage(state, event);
			dispatch('message', event);
		});
		socket.addEventListener('open', (event) => dispatch('open', event));
		socket.addEventListener('error', (event) => dispatch('error', event));
		socket.addEventListener('close', (event) => dispatch('close', event));

		return {
			get readyState() {
				return socket.readyState;
			},
			send(data: string) {
				if (parseGuardedPayload(data)) {
					throw new Error('reasoning-token-guard forces SSE transport for GPT replay');
				}
				socket.send(data);
			},
			close(code?: number, reason?: string) {
				socket.close(code, reason);
			},
			addEventListener(type: string, listener: (event: unknown) => void) {
				const typeListeners = listeners.get(type) ?? new Set<(event: unknown) => void>();
				typeListeners.add(listener);
				listeners.set(type, typeListeners);
			},
			removeEventListener(type: string, listener: (event: unknown) => void) {
				listeners.get(type)?.delete(listener);
			},
		};
	} as unknown as WebSocketConstructorLike;
	WrappedWebSocket.prototype = BaseWebSocket.prototype;
	Object.setPrototypeOf(WrappedWebSocket, BaseWebSocket);
	globalScope.WebSocket = WrappedWebSocket;
	patchWebSocketPrototypeChain(WrappedWebSocket, state);
	state.webSocketOriginal = BaseWebSocket;
	state.webSocketWrapped = WrappedWebSocket;
	state.webSocketPatched = true;
}

function patchWebSocketPrototypeChain(WebSocketCtor: WebSocketConstructorLike, state: RawCaptureState): void {
	let current: unknown = WebSocketCtor;
	while (typeof current === 'function' && current !== Function.prototype) {
		const prototype = (current as { prototype?: PatchedWebSocketPrototype }).prototype;
		if (prototype) patchWebSocketPrototype(prototype, state);
		current = Object.getPrototypeOf(current);
	}
}

function patchWebSocketPrototype(prototype: PatchedWebSocketPrototype, state: RawCaptureState): void {
	if (prototype.__reasoningTokenGuardVersion === PATCH_VERSION) return;
	const originalSend = prototype.__reasoningTokenGuardSend ?? prototype.send;
	const originalAddEventListener = prototype.__reasoningTokenGuardAddEventListener ?? prototype.addEventListener;
	if (!originalSend || !originalAddEventListener) return;

	prototype.__reasoningTokenGuardSend = originalSend;
	prototype.__reasoningTokenGuardAddEventListener = originalAddEventListener;
	prototype.send = function (this: WebSocketLike, data: string): void {
		if (parseGuardedPayload(data)) {
			throw new Error('reasoning-token-guard forces SSE transport for GPT replay');
		}
		return originalSend.call(this, data);
	};
	prototype.addEventListener = function (this: WebSocketLike, type: string, listener: (event: unknown) => void): void {
		if (type === 'message') installWebSocketMessageObserver(this, state, originalAddEventListener);
		return originalAddEventListener.call(this, type, listener);
	};
	prototype.__reasoningTokenGuardVersion = PATCH_VERSION;
}

function installWebSocketMessageObserver(
	socket: WebSocketLike & { __reasoningTokenGuardObserved?: boolean },
	state: RawCaptureState,
	addEventListener: (type: string, listener: (event: unknown) => void) => void,
): void {
	if (socket.__reasoningTokenGuardObserved) return;
	socket.__reasoningTokenGuardObserved = true;
	addEventListener.call(socket, 'message', (event: unknown) => {
		observeWebSocketRawMessage(state, event);
	});
}

function observeWebSocketRawMessage(state: RawCaptureState, event: unknown): void {
	if (!isRecord(event)) return;
	if (typeof event.data === 'string') {
		recordWebSocketRawText(state, event.data);
		return;
	}
	void decodeWebSocketData(event.data).then((text) => {
		if (!text) return;
		recordWebSocketRawText(state, text);
	});
}

function recordWebSocketRawText(state: RawCaptureState, text: string): void {
	const parsedEvent = parseJsonRecord(text);
	if (!parsedEvent) return;
	const summary = createRawStreamSummary();
	updateRawStreamSummary(summary, parsedEvent);
	if (summary.responseId && summary.measurement) recordRawResponse(state, summary, []);
}

function installRawReasoningTokenCapture(): RawCaptureState {
	const state = getRawCaptureState();
	installFetchCapture(state);
	installWebSocketCapture(state);
	state.installed = true;
	state.patchVersion = PATCH_VERSION;
	return state;
}

function extractMessageReasoningTokens(message: AssistantMessage): ReasoningTokenMeasurement | undefined {
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
	return extractMessageReasoningTokens(message)
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

function buildBlockedText(message: AssistantMessage, measurement: ReasoningTokenMeasurement, rawRetry: RawRetryInfo | undefined): string {
	return [
		'Reasoning token guard blocked this assistant reply.',
		`Model: ${message.provider}/${message.model}`,
		`Reasoning tokens: ${measurement.tokens} < ${MIN_REASONING_TOKENS}`,
		`Transport retries: ${rawRetry?.attempts ?? 0}/${MAX_TRANSPORT_RETRIES}`,
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
	const warnedUnavailable = { value: false };

	pi.on('before_provider_request', (_event, ctx) => {
		rawCaptureState.notify = ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined;
	});

	pi.on('message_end', (event, ctx) => {
		if (event.message.role !== 'assistant') return;

		const message = event.message as AssistantMessage;
		if (!isTrackedModel(message)) return;

		const measurement = getReasoningTokens(message, rawCaptureState);
		const rawRetry = message.responseId ? rawCaptureState.retryByResponseId.get(message.responseId) : undefined;
		const blocked = measurement !== undefined
			&& isFinalReply(message)
			&& measurement.tokens < MIN_REASONING_TOKENS;

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
			transportRetries: rawRetry?.attempts ?? 0,
			rejectedReasoningTokens: rawRetry?.rejectedReasoningTokens ?? [],
			maxTransportRetries: MAX_TRANSPORT_RETRIES,
			...(!measurement ? {
				note: 'Real reasoning token field unavailable; output tokens are not used as a proxy.',
			} : {}),
		});

		if (message.responseId) {
			rawCaptureState.byResponseId.delete(message.responseId);
			rawCaptureState.retryByResponseId.delete(message.responseId);
		}

		if (!measurement) {
			if (isFinalReply(message)) notifyUnavailableOnce(ctx, warnedUnavailable);
			return;
		}

		const messageWithReasoningTokens = withReasoningTokens(message, measurement);
		notifyReplayAccepted(ctx, rawRetry, measurement);
		if (!blocked) return { message: messageWithReasoningTokens };

		if (ctx.hasUI) {
			ctx.ui.notify(
				`reasoning-token-guard: blocked ${measurement.tokens} reasoning tokens`,
				'error',
			);
		}

		return {
			message: {
				...messageWithReasoningTokens,
				content: [{
					type: 'text',
					text: buildBlockedText(message, measurement, rawRetry),
				}],
				stopReason: 'stop',
			},
		};
	});
}
