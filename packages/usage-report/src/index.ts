import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import {
  SessionManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const DEFAULT_PORT = 30143;
const LITELLM_PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type Price = {
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  source: 'pi' | 'litellm';
  key: string;
};

type LiteLlmPriceLoad = {
  status: 'ok' | 'unavailable';
  prices: Map<string, Price>;
  fetchedAt: string | undefined;
  error: string | undefined;
};

type DayBucket = {
  date: string;
  tokens: TokenTotals;
  cost: number;
  assistantMessages: number;
  sessions: Set<string>;
};

type ModelBucket = {
  provider: string;
  model: string;
  messages: number;
  tokens: TokenTotals;
  recordedCost: number;
  repricedCost: number;
  unknownCostMessages: number;
  priceSources: Map<string, number>;
};

type LongestTask = {
  seconds: number;
  sessionId: string;
  sessionPath: string;
  startedAt: string;
  endedAt: string;
};

type ReportAccumulator = {
  listedSessions: number;
  scannedSessions: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  recordedCost: number;
  repricedCost: number;
  unknownCostMessages: number;
  partialUnknownCostMessages: number;
  tokens: TokenTotals;
  activeDays: Set<string>;
  days: Map<string, DayBucket>;
  models: Map<string, ModelBucket>;
  tools: Map<string, number>;
  skills: Map<string, number>;
  thinkingLevels: Map<string, number>;
  longestTask: LongestTask | undefined;
  scanErrors: string[];
};

type UsageReport = {
  generatedAt: string;
  agentDir: string;
  pricing: {
    sourceUrl: string;
    status: 'ok' | 'unavailable';
    fetchedAt: string | undefined;
    error: string | undefined;
  };
  totals: {
    listedSessions: number;
    scannedSessions: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    tokens: TokenTotals;
    recordedCost: number;
    repricedCost: number;
    unknownCostMessages: number;
    partialUnknownCostMessages: number;
    currentStreakDays: number;
    longestStreakDays: number;
    peakDayTokens: number;
    longestTask: LongestTask | undefined;
  };
  insights: {
    quickModePercent: number | undefined;
    mostUsedThinkingLevel: string | undefined;
    exploredSkills: number;
    usedSkillsTotal: number;
  };
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    assistantMessages: number;
    sessions: number;
  }>;
  topModels: Array<{
    provider: string;
    model: string;
    messages: number;
    tokens: number;
    recordedCost: number;
    repricedCost: number;
    unknownCostMessages: number;
    priceSources: Record<string, number>;
  }>;
  topTools: Array<{ name: string; count: number }>;
  topSkills: Array<{ name: string; count: number }>;
  scanErrors: string[];
};

let liteLlmPriceCache: { expiresAt: number; loaded: LiteLlmPriceLoad } | undefined;

function createTokenTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addUsageTokens(totals: TokenTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.total += usage.totalTokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTimestampMs(value: string, sessionPath: string, entryId: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid session timestamp in ${sessionPath} entry ${entryId}: ${value}`);
  }
  return timestamp;
}

function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateKey: string, days: number): string {
  const [yearText, monthText, dayText] = dateKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateKey(date.getTime());
}

function incrementCounter(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounters(map: Map<string, number>, limit: number): Array<{ name: string; count: number }> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function extractMessageText(content: unknown): string {
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

function extractSkillReferences(text: string): string[] {
  const skills: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)\$([a-zA-Z][\w-]*)/g)) {
    skills.push(`$${match[1]}`);
  }
  for (const match of text.matchAll(/(?:^|\s)\/skill:([a-zA-Z][\w-]*)/g)) {
    skills.push(`$${match[1]}`);
  }
  return skills;
}

function addToolCall(toolName: string, toolCallId: string | undefined, seenToolCallIds: Set<string>, acc: ReportAccumulator): void {
  if (toolCallId && seenToolCallIds.has(toolCallId)) return;
  if (toolCallId) seenToolCallIds.add(toolCallId);
  incrementCounter(acc.tools, toolName.split('.').pop() ?? toolName);
  acc.toolCalls += 1;
}

function collectAssistantToolCalls(content: unknown, seenToolCallIds: Set<string>, acc: ReportAccumulator): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'toolCall') continue;
    if (typeof block.name !== 'string') continue;
    const toolCallId = typeof block.id === 'string' ? block.id : undefined;
    addToolCall(block.name, toolCallId, seenToolCallIds, acc);
  }
}

function priceFromPi(ctx: ExtensionContext, provider: string, model: string, responseModel: string | undefined): Price | undefined {
  const candidates = responseModel ? [responseModel, model] : [model];
  for (const candidate of candidates) {
    const modelDef = ctx.modelRegistry.find(provider, candidate);
    if (!modelDef) continue;

    const allZero = modelDef.cost.input === 0
      && modelDef.cost.output === 0
      && modelDef.cost.cacheRead === 0
      && modelDef.cost.cacheWrite === 0;
    if (allZero) continue;

    return {
      input: modelDef.cost.input / 1_000_000,
      output: modelDef.cost.output / 1_000_000,
      cacheRead: modelDef.cost.cacheRead / 1_000_000,
      cacheWrite: modelDef.cost.cacheWrite / 1_000_000,
      source: 'pi',
      key: `${provider}/${candidate}`,
    };
  }
  return undefined;
}

function priceFromLiteLlm(prices: Map<string, Price>, provider: string, model: string, responseModel: string | undefined): Price | undefined {
  const names = responseModel ? [responseModel, model] : [model];
  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(name, `${provider}/${name}`);
    if (name.startsWith('models/')) candidates.push(name.slice('models/'.length));
  }

  for (const candidate of candidates) {
    const price = prices.get(candidate.toLowerCase());
    if (price) return price;
  }
  return undefined;
}

function resolvePrice(
  ctx: ExtensionContext,
  liteLlmPrices: Map<string, Price>,
  provider: string,
  model: string,
  responseModel: string | undefined,
): Price | undefined {
  return priceFromPi(ctx, provider, model, responseModel)
    ?? priceFromLiteLlm(liteLlmPrices, provider, model, responseModel);
}

function calculateCost(usage: Usage, price: Price | undefined): { knownCost: number; unknownComponents: string[] } {
  if (!price) {
    return { knownCost: 0, unknownComponents: usage.totalTokens > 0 ? ['all'] : [] };
  }

  let knownCost = 0;
  const unknownComponents: string[] = [];
  const components: Array<{ name: string; tokens: number; price: number | undefined }> = [
    { name: 'input', tokens: usage.input, price: price.input },
    { name: 'output', tokens: usage.output, price: price.output },
    { name: 'cacheRead', tokens: usage.cacheRead, price: price.cacheRead },
    { name: 'cacheWrite', tokens: usage.cacheWrite, price: price.cacheWrite },
  ];

  for (const component of components) {
    if (component.tokens === 0) continue;
    if (component.price === undefined) {
      unknownComponents.push(component.name);
      continue;
    }
    knownCost += component.tokens * component.price;
  }
  return { knownCost, unknownComponents };
}

function getDayBucket(acc: ReportAccumulator, dateKey: string): DayBucket {
  let bucket = acc.days.get(dateKey);
  if (!bucket) {
    bucket = { date: dateKey, tokens: createTokenTotals(), cost: 0, assistantMessages: 0, sessions: new Set() };
    acc.days.set(dateKey, bucket);
  }
  return bucket;
}

function getModelBucket(acc: ReportAccumulator, provider: string, model: string): ModelBucket {
  const key = `${provider}/${model}`;
  let bucket = acc.models.get(key);
  if (!bucket) {
    bucket = {
      provider,
      model,
      messages: 0,
      tokens: createTokenTotals(),
      recordedCost: 0,
      repricedCost: 0,
      unknownCostMessages: 0,
      priceSources: new Map(),
    };
    acc.models.set(key, bucket);
  }
  return bucket;
}

function addAssistantUsage(
  ctx: ExtensionContext,
  liteLlmPrices: Map<string, Price>,
  message: AssistantMessage,
  sessionId: string,
  timestampMs: number,
  acc: ReportAccumulator,
): void {
  const price = resolvePrice(ctx, liteLlmPrices, message.provider, message.model, message.responseModel);
  const cost = calculateCost(message.usage, price);
  const hasUnknownCost = cost.unknownComponents.length > 0;

  addUsageTokens(acc.tokens, message.usage);
  acc.recordedCost += message.usage.cost.total;
  acc.repricedCost += cost.knownCost;
  if (hasUnknownCost) {
    if (cost.knownCost === 0) acc.unknownCostMessages += 1;
    else acc.partialUnknownCostMessages += 1;
  }

  const dateKey = localDateKey(timestampMs);
  acc.activeDays.add(dateKey);
  const day = getDayBucket(acc, dateKey);
  addUsageTokens(day.tokens, message.usage);
  day.cost += cost.knownCost;
  day.assistantMessages += 1;
  day.sessions.add(sessionId);

  const model = getModelBucket(acc, message.provider, message.model);
  model.messages += 1;
  addUsageTokens(model.tokens, message.usage);
  model.recordedCost += message.usage.cost.total;
  model.repricedCost += cost.knownCost;
  if (hasUnknownCost) model.unknownCostMessages += 1;
  incrementCounter(model.priceSources, price ? `${price.source}:${price.key}` : 'unknown');
}

function updateLongestTask(
  acc: ReportAccumulator,
  session: SessionInfo,
  startedAtMs: number | undefined,
  endedAtMs: number | undefined,
): void {
  if (startedAtMs === undefined || endedAtMs === undefined) return;
  const seconds = Math.max(0, (endedAtMs - startedAtMs) / 1000);
  if (acc.longestTask && seconds <= acc.longestTask.seconds) return;
  acc.longestTask = {
    seconds,
    sessionId: session.id,
    sessionPath: session.path,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
  };
}

function scanSession(
  ctx: ExtensionContext,
  liteLlmPrices: Map<string, Price>,
  session: SessionInfo,
  entries: SessionEntry[],
  acc: ReportAccumulator,
): void {
  let thinkingLevel = 'unknown';
  let currentTaskStart: number | undefined;
  let currentTaskEnd: number | undefined;
  const seenToolCallIds = new Set<string>();

  for (const entry of entries) {
    const timestampMs = parseTimestampMs(entry.timestamp, session.path, entry.id);
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = entry.thinkingLevel;
      continue;
    }
    if (entry.type !== 'message') {
      if (currentTaskStart !== undefined) currentTaskEnd = timestampMs;
      continue;
    }

    const message = entry.message;
    if (message.role === 'user') {
      updateLongestTask(acc, session, currentTaskStart, currentTaskEnd);
      currentTaskStart = timestampMs;
      currentTaskEnd = timestampMs;
      acc.userMessages += 1;
      for (const skill of extractSkillReferences(extractMessageText(message.content))) {
        incrementCounter(acc.skills, skill);
      }
      continue;
    }

    if (message.role === 'assistant') {
      currentTaskEnd = timestampMs;
      acc.assistantMessages += 1;
      incrementCounter(acc.thinkingLevels, thinkingLevel);
      collectAssistantToolCalls(message.content, seenToolCallIds, acc);
      addAssistantUsage(ctx, liteLlmPrices, message as AssistantMessage, session.id, timestampMs, acc);
      continue;
    }

    if (message.role === 'toolResult') {
      currentTaskEnd = timestampMs;
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
      if (typeof message.toolName === 'string') addToolCall(message.toolName, toolCallId, seenToolCallIds, acc);
    }
  }

  updateLongestTask(acc, session, currentTaskStart, currentTaskEnd);
}

function createAccumulator(listedSessions: number): ReportAccumulator {
  return {
    listedSessions,
    scannedSessions: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    recordedCost: 0,
    repricedCost: 0,
    unknownCostMessages: 0,
    partialUnknownCostMessages: 0,
    tokens: createTokenTotals(),
    activeDays: new Set(),
    days: new Map(),
    models: new Map(),
    tools: new Map(),
    skills: new Map(),
    thinkingLevels: new Map(),
    longestTask: undefined,
    scanErrors: [],
  };
}

function calculateCurrentStreak(activeDays: Set<string>): number {
  let dateKey = localDateKey(Date.now());
  let streak = 0;
  while (activeDays.has(dateKey)) {
    streak += 1;
    dateKey = addDays(dateKey, -1);
  }
  return streak;
}

function calculateLongestStreak(activeDays: Set<string>): number {
  const sorted = [...activeDays].sort();
  let longest = 0;
  let current = 0;
  let previous: string | undefined;
  for (const dateKey of sorted) {
    current = previous && addDays(previous, 1) === dateKey ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = dateKey;
  }
  return longest;
}

function createDailyReport(days: Map<string, DayBucket>): UsageReport['daily'] {
  return [...days.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      date: day.date,
      tokens: day.tokens.total,
      cost: day.cost,
      assistantMessages: day.assistantMessages,
      sessions: day.sessions.size,
    }));
}

function createModelReport(models: Map<string, ModelBucket>): UsageReport['topModels'] {
  return [...models.values()]
    .sort((left, right) => right.tokens.total - left.tokens.total || `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
    .slice(0, 12)
    .map((model) => ({
      provider: model.provider,
      model: model.model,
      messages: model.messages,
      tokens: model.tokens.total,
      recordedCost: model.recordedCost,
      repricedCost: model.repricedCost,
      unknownCostMessages: model.unknownCostMessages,
      priceSources: Object.fromEntries(model.priceSources.entries()),
    }));
}

function createInsights(acc: ReportAccumulator): UsageReport['insights'] {
  const quickMessages = (acc.thinkingLevels.get('off') ?? 0) + (acc.thinkingLevels.get('minimal') ?? 0);
  return {
    quickModePercent: acc.assistantMessages === 0 ? undefined : (quickMessages / acc.assistantMessages) * 100,
    mostUsedThinkingLevel: sortedCounters(acc.thinkingLevels, 1)[0]?.name,
    exploredSkills: acc.skills.size,
    usedSkillsTotal: [...acc.skills.values()].reduce((sum, count) => sum + count, 0),
  };
}

function buildUsageReport(acc: ReportAccumulator, pricing: LiteLlmPriceLoad): UsageReport {
  const daily = createDailyReport(acc.days);
  return {
    generatedAt: new Date().toISOString(),
    agentDir: getAgentDir(),
    pricing: {
      sourceUrl: LITELLM_PRICE_URL,
      status: pricing.status,
      fetchedAt: pricing.fetchedAt,
      error: pricing.error,
    },
    totals: {
      listedSessions: acc.listedSessions,
      scannedSessions: acc.scannedSessions,
      userMessages: acc.userMessages,
      assistantMessages: acc.assistantMessages,
      toolCalls: acc.toolCalls,
      tokens: acc.tokens,
      recordedCost: acc.recordedCost,
      repricedCost: acc.repricedCost,
      unknownCostMessages: acc.unknownCostMessages,
      partialUnknownCostMessages: acc.partialUnknownCostMessages,
      currentStreakDays: calculateCurrentStreak(acc.activeDays),
      longestStreakDays: calculateLongestStreak(acc.activeDays),
      peakDayTokens: daily.reduce((peak, day) => Math.max(peak, day.tokens), 0),
      longestTask: acc.longestTask,
    },
    insights: createInsights(acc),
    daily,
    topModels: createModelReport(acc.models),
    topTools: sortedCounters(acc.tools, 12),
    topSkills: sortedCounters(acc.skills, 12),
    scanErrors: acc.scanErrors,
  };
}

async function buildReport(ctx: ExtensionContext): Promise<UsageReport> {
  const pricing = await loadLiteLlmPrices();
  const sessions = await SessionManager.listAll();
  const acc = createAccumulator(sessions.length);

  for (const session of sessions) {
    try {
      const manager = SessionManager.open(session.path);
      scanSession(ctx, pricing.prices, session, manager.getEntries(), acc);
      acc.scannedSessions += 1;
    } catch (error) {
      acc.scanErrors.push(`${session.path}: ${errorMessage(error)}`);
    }
  }

  return buildUsageReport(acc, pricing);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`LiteLLM price field ${key} must be a finite number`);
  }
  return value;
}

function parseLiteLlmPrices(payload: unknown): Map<string, Price> {
  if (!isRecord(payload)) throw new Error('LiteLLM price payload must be a JSON object');

  const prices = new Map<string, Price>();
  for (const [modelKey, rawPrice] of Object.entries(payload)) {
    if (!isRecord(rawPrice)) continue;
    const input = readNumber(rawPrice, 'input_cost_per_token');
    const output = readNumber(rawPrice, 'output_cost_per_token');
    const cacheRead = readNumber(rawPrice, 'cache_read_input_token_cost');
    const cacheWrite = readNumber(rawPrice, 'cache_creation_input_token_cost');
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) continue;
    prices.set(modelKey.toLowerCase(), { input, output, cacheRead, cacheWrite, source: 'litellm', key: modelKey });
  }
  if (prices.size === 0) throw new Error('LiteLLM price payload did not contain usable model prices');
  return prices;
}

async function loadLiteLlmPrices(): Promise<LiteLlmPriceLoad> {
  const now = Date.now();
  if (liteLlmPriceCache && liteLlmPriceCache.expiresAt > now) return liteLlmPriceCache.loaded;

  let loaded: LiteLlmPriceLoad;
  try {
    const response = await fetch(LITELLM_PRICE_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    loaded = {
      status: 'ok',
      prices: parseLiteLlmPrices(await response.json()),
      fetchedAt: new Date().toISOString(),
      error: undefined,
    };
  } catch (error) {
    loaded = {
      status: 'unavailable',
      prices: new Map(),
      fetchedAt: undefined,
      error: errorMessage(error),
    };
  }

  liteLlmPriceCache = { expiresAt: now + (loaded.status === 'ok' ? PRICE_CACHE_TTL_MS : 60_000), loaded };
  return loaded;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

class UsageReportServer {
  private server: Server | undefined;
  private url: string | undefined;
  private currentCtx: ExtensionContext | undefined;
  private serverError: string | undefined;

  start(port = DEFAULT_PORT): string {
    if (this.server) return this.url as string;

    this.serverError = undefined;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server.on('error', (error) => {
      this.serverError = errorMessage(error);
      this.server = undefined;
      this.url = undefined;
    });
    this.server.listen(port, '127.0.0.1');
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = undefined;
    this.url = undefined;
  }

  getUrl(): string | undefined {
    return this.url;
  }

  getError(): string | undefined {
    return this.serverError;
  }

  attach(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
  }

  detach(ctx: ExtensionContext): void {
    if (this.currentCtx === ctx) this.currentCtx = undefined;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url ?? `http://127.0.0.1:${DEFAULT_PORT}`);
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, reportHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      if (!this.currentCtx) {
        sendJson(res, 409, { error: 'No active Pi session is attached to usage-report. Run /usage-report start or /usage-report open.' });
        return;
      }
      try {
        sendJson(res, 200, await buildReport(this.currentCtx));
      } catch (error) {
        sendJson(res, 500, { error: errorMessage(error) });
      }
      return;
    }
    sendText(res, 404, 'not found');
  }
}

function getServer(): UsageReportServer {
  const globalState = globalThis as typeof globalThis & { __piUsageReportServer?: UsageReportServer };
  globalState.__piUsageReportServer ??= new UsageReportServer();
  return globalState.__piUsageReportServer;
}

function reportHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Usage Report</title>
  <style>
    :root { color-scheme: light; --text: #343434; --muted: #8a8a8a; --line: #eeeeee; --soft: #f6f6f6; --blue1: #d6e7fb; --blue2: #a9cdf6; --blue3: #75acec; --blue4: #2f7fd5; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--text); background: #ffffff; }
    main { max-width: 1120px; margin: 0 auto; padding: 46px 36px 70px; }
    .profile { text-align: center; margin-bottom: 44px; }
    .avatar { width: 116px; height: 116px; border-radius: 999px; display: inline-grid; place-items: center; color: #fff; background: #f5c400; font-size: 42px; letter-spacing: 1px; }
    h1 { margin: 22px 0 6px; font-weight: 500; font-size: 30px; }
    .subtitle, .muted { color: var(--muted); }
    .stat-card { border: 1px solid var(--line); border-radius: 22px; display: grid; grid-template-columns: repeat(5, 1fr); overflow: hidden; margin-bottom: 54px; }
    .stat { min-height: 76px; display: grid; place-items: center; border-left: 1px solid var(--line); }
    .stat:first-child { border-left: 0; }
    .stat strong { display: block; font-size: 22px; font-weight: 500; }
    .stat span { display: block; color: var(--muted); margin-top: 3px; }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; margin-bottom: 18px; }
    h2 { font-size: 21px; margin: 0; font-weight: 650; }
    .heatmap { display: grid; grid-template-columns: repeat(53, 14px); grid-auto-flow: column; grid-template-rows: repeat(7, 14px); gap: 5px; min-height: 128px; }
    .cell { width: 14px; height: 14px; border-radius: 4px; background: #f5f5f5; }
    .l1 { background: var(--blue1); } .l2 { background: var(--blue2); } .l3 { background: var(--blue3); } .l4 { background: var(--blue4); }
    .month-row { display: grid; grid-template-columns: repeat(12, 1fr); margin-top: 12px; color: var(--muted); }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; margin-top: 52px; }
    .rows { display: grid; gap: 12px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: baseline; }
    .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .value { color: var(--muted); white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
    th { color: var(--muted); font-weight: 500; }
    .notice { margin-top: 22px; padding: 14px 16px; border-radius: 14px; background: var(--soft); color: #666; white-space: pre-wrap; }
    @media (max-width: 820px) { main { padding: 30px 18px 56px; } .stat-card { grid-template-columns: 1fr 1fr; } .split { grid-template-columns: 1fr; gap: 34px; } .heatmap { overflow-x: auto; } }
  </style>
</head>
<body>
<main>
  <section class="profile">
    <div class="avatar">PI</div>
    <h1>Pi Usage Report</h1>
    <div id="subtitle" class="subtitle">loading...</div>
  </section>
  <section id="summary" class="stat-card"></section>
  <section>
    <div class="section-head"><h2>Token 活动</h2><div class="muted">最近 365 天</div></div>
    <div id="heatmap" class="heatmap"></div>
    <div id="monthRow" class="month-row"></div>
  </section>
  <section class="split">
    <div><h2>活动洞察</h2><div id="insights" class="rows"></div></div>
    <div><h2>最常用的工具/技能</h2><div id="topTools" class="rows"></div></div>
  </section>
  <section style="margin-top: 52px;"><h2>模型与 API 计费</h2><div id="models"></div></section>
  <div id="notices"></div>
</main>
<script>
const nf = new Intl.NumberFormat('zh-CN');
const money = (value, unknown) => '$' + value.toFixed(value < 1 ? 4 : 2) + (unknown ? ' + unknown' : '');
const compact = (value) => {
  if (value < 10000) return nf.format(Math.round(value));
  if (value < 100000000) return (value / 10000).toFixed(value < 100000 ? 1 : 0) + '万';
  return (value / 100000000).toFixed(1) + '亿';
};
const duration = (seconds) => {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return h + '小时 ' + m + '分';
  if (m > 0) return m + '分 ' + s + '秒';
  return s + '秒';
};
const row = (name, value) => '<div class="row"><div class="name">' + name + '</div><div class="value">' + value + '</div></div>';
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function renderSummary(report) {
  const t = report.totals;
  document.getElementById('summary').innerHTML = [
    ['累计 Token 数', compact(t.tokens.total)],
    ['峰值 Token 数', compact(t.peakDayTokens)],
    ['最长任务时长≈', duration(t.longestTask && t.longestTask.seconds)],
    ['当前连续天数', t.currentStreakDays + ' 天'],
    ['API 计费', money(t.repricedCost, t.unknownCostMessages || t.partialUnknownCostMessages)],
  ].map(([label, value]) => '<div class="stat"><div><strong>' + value + '</strong><span>' + label + '</span></div></div>').join('');
}

function renderHeatmap(report) {
  const byDate = new Map(report.daily.map((day) => [day.date, day]));
  const max = Math.max(1, ...report.daily.map((day) => day.tokens));
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  const cells = [];
  for (let i = 0; i < start.getDay(); i++) cells.push('<div></div>');
  for (let i = 0; i < 365; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = dateKey(date);
    const day = byDate.get(key);
    const tokens = day ? day.tokens : 0;
    const level = tokens === 0 ? 0 : Math.max(1, Math.ceil(Math.log1p(tokens) / Math.log1p(max) * 4));
    cells.push('<div class="cell l' + level + '" title="' + key + ' · ' + compact(tokens) + ' tokens"></div>');
  }
  document.getElementById('heatmap').innerHTML = cells.join('');
  const months = [];
  const monthCursor = new Date(today);
  monthCursor.setDate(1);
  monthCursor.setMonth(monthCursor.getMonth() - 11);
  for (let i = 0; i < 12; i++) {
    const label = monthCursor.toLocaleDateString('zh-CN', { month: 'short' });
    months.push('<span>' + label + '</span>');
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }
  document.getElementById('monthRow').innerHTML = months.join('');
}

function renderInsights(report) {
  const i = report.insights;
  document.getElementById('insights').innerHTML = [
    row('快速模式', i.quickModePercent === undefined ? '-' : i.quickModePercent.toFixed(0) + '%'),
    row('最常用的推理强度', escapeHtml(i.mostUsedThinkingLevel || '-')),
    row('已探索的技能', nf.format(i.exploredSkills)),
    row('使用的技能总数', nf.format(i.usedSkillsTotal)),
    row('会话总数', nf.format(report.totals.scannedSessions) + '/' + nf.format(report.totals.listedSessions)),
  ].join('');
}

function renderTopTools(report) {
  const merged = [...report.topSkills, ...report.topTools].slice(0, 12);
  document.getElementById('topTools').innerHTML = merged.length
    ? merged.map((item) => row(escapeHtml(item.name), nf.format(item.count) + ' 次运行')).join('')
    : '<div class="muted">暂无工具或技能记录</div>';
}

function renderModels(report) {
  const rows = report.topModels.map((model) => '<tr><td>' + escapeHtml(model.provider + '/' + model.model) + '</td><td>' + compact(model.tokens) + '</td><td>' + nf.format(model.messages) + '</td><td>' + money(model.repricedCost, model.unknownCostMessages) + '</td></tr>').join('');
  document.getElementById('models').innerHTML = '<table><thead><tr><th>模型</th><th>Token</th><th>消息</th><th>API 计费</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderNotices(report) {
  const notices = [];
  if (report.pricing.status !== 'ok') notices.push('LiteLLM 价格源不可用：' + report.pricing.error);
  if (report.totals.unknownCostMessages || report.totals.partialUnknownCostMessages) notices.push('存在无法定价的模型消息：unknown=' + report.totals.unknownCostMessages + ', partial=' + report.totals.partialUnknownCostMessages + '。这些消息未按 0 美元处理。');
  if (report.scanErrors.length) notices.push('扫描错误：\n' + report.scanErrors.slice(0, 20).join('\n'));
  document.getElementById('notices').innerHTML = notices.map((text) => '<div class="notice">' + escapeHtml(text) + '</div>').join('');
}

async function load() {
  const response = await fetch('/api/report');
  if (!response.ok) throw new Error(await response.text());
  const report = await response.json();
  document.getElementById('subtitle').textContent = 'generated ' + new Date(report.generatedAt).toLocaleString();
  renderSummary(report);
  renderHeatmap(report);
  renderInsights(report);
  renderTopTools(report);
  renderModels(report);
  renderNotices(report);
}

load().catch((error) => {
  document.getElementById('subtitle').textContent = 'failed';
  document.getElementById('notices').innerHTML = '<div class="notice">' + escapeHtml(error.message) + '</div>';
});
</script>
</body>
</html>`;
}

export default function usageReport(pi: ExtensionAPI) {
  const server = getServer();

  pi.on('session_start', (_event, ctx) => {
    server.attach(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    server.detach(ctx);
  });

  pi.registerCommand('usage-report', {
    description: 'Show Pi token activity and API cost report: status, open, start [port], stop',
    handler: async (args, ctx) => {
      const [action = 'status', portArg] = args.trim().split(/\s+/).filter(Boolean);

      if (action === 'status') {
        const url = server.getUrl();
        const serverError = server.getError();
        ctx.ui.notify(serverError ? `Pi usage-report error: ${serverError}` : url ? `Pi usage-report: ${url}` : 'Pi usage-report is stopped', serverError ? 'error' : 'info');
        return;
      }

      if (action === 'open') {
        const url = server.getUrl() ?? server.start(DEFAULT_PORT);
        server.attach(ctx);
        const result = await pi.exec('open', [url], { cwd: ctx.cwd });
        if (result.code !== 0) throw new Error(result.stderr || `open failed with exit code ${result.code}`);
        ctx.ui.notify(`Opened ${url}`, 'info');
        return;
      }

      if (action === 'start') {
        const port = portArg ? parsePort(portArg) : DEFAULT_PORT;
        const url = server.start(port);
        server.attach(ctx);
        ctx.ui.notify(`Pi usage-report started at ${url}`, 'info');
        return;
      }

      if (action === 'stop') {
        server.stop();
        ctx.ui.notify('Pi usage-report stopped', 'info');
        return;
      }

      throw new Error(`Unknown usage-report action: ${action}`);
    },
  });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}
