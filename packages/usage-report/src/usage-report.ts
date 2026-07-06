import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import {
  SessionManager,
  getAgentDir,
  parseSkillBlock,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const DEFAULT_PORT = 30143;
const SERVER_VERSION = 3;
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

type DayModelBucket = {
  provider: string;
  model: string;
  messages: number;
  tokens: TokenTotals;
  repricedCost: number;
  unknownCostMessages: number;
  hasPrice: boolean;
};

type DayBucket = {
  date: string;
  tokens: TokenTotals;
  cost: number;
  assistantMessages: number;
  toolCalls: number;
  sessions: Set<string>;
  models: Map<string, DayModelBucket>;
  tools: Map<string, number>;
  skills: Map<string, number>;
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
    toolCalls: number;
    sessions: number;
    models: Array<{
      provider: string;
      model: string;
      messages: number;
      tokens: number;
      repricedCost: number;
      unknownCostMessages: number;
      hasPrice: boolean;
    }>;
    tools: Array<{ name: string; count: number }>;
    skills: Array<{ name: string; count: number }>;
  }>;
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

function addToolCall(toolName: string, toolCallId: string | undefined, seenToolCallIds: Set<string>, timestampMs: number, acc: ReportAccumulator): void {
  if (toolCallId && seenToolCallIds.has(toolCallId)) return;
  if (toolCallId) seenToolCallIds.add(toolCallId);
  const name = toolName.split('.').pop() ?? toolName;
  acc.toolCalls += 1;
  const day = getDayBucket(acc, localDateKey(timestampMs));
  incrementCounter(day.tools, name);
  day.toolCalls += 1;
}

function collectAssistantToolCalls(content: unknown, seenToolCallIds: Set<string>, timestampMs: number, acc: ReportAccumulator): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'toolCall') continue;
    if (typeof block.name !== 'string') continue;
    const toolCallId = typeof block.id === 'string' ? block.id : undefined;
    addToolCall(block.name, toolCallId, seenToolCallIds, timestampMs, acc);
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
    bucket = { date: dateKey, tokens: createTokenTotals(), cost: 0, assistantMessages: 0, toolCalls: 0, sessions: new Set(), models: new Map(), tools: new Map(), skills: new Map() };
    acc.days.set(dateKey, bucket);
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

  const dayModelKey = `${message.provider}/${message.model}`;
  let dayModel = day.models.get(dayModelKey);
  if (!dayModel) {
    dayModel = { provider: message.provider, model: message.model, messages: 0, tokens: createTokenTotals(), repricedCost: 0, unknownCostMessages: 0, hasPrice: false };
    day.models.set(dayModelKey, dayModel);
  }
  dayModel.messages += 1;
  addUsageTokens(dayModel.tokens, message.usage);
  dayModel.repricedCost += cost.knownCost;
  if (hasUnknownCost) dayModel.unknownCostMessages += 1;
  if (price) dayModel.hasPrice = true;
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
      const skillBlock = parseSkillBlock(extractMessageText(message.content));
      if (skillBlock) {
        incrementCounter(acc.skills, skillBlock.name);
        incrementCounter(getDayBucket(acc, localDateKey(timestampMs)).skills, skillBlock.name);
      }
      continue;
    }

    if (message.role === 'assistant') {
      currentTaskEnd = timestampMs;
      acc.assistantMessages += 1;
      incrementCounter(acc.thinkingLevels, thinkingLevel);
      collectAssistantToolCalls(message.content, seenToolCallIds, timestampMs, acc);
      addAssistantUsage(ctx, liteLlmPrices, message as AssistantMessage, session.id, timestampMs, acc);
      continue;
    }

    if (message.role === 'toolResult') {
      currentTaskEnd = timestampMs;
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
      if (typeof message.toolName === 'string') addToolCall(message.toolName, toolCallId, seenToolCallIds, timestampMs, acc);
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
      toolCalls: day.toolCalls,
      sessions: day.sessions.size,
      models: [...day.models.values()].map((model) => ({
        provider: model.provider,
        model: model.model,
        messages: model.messages,
        tokens: model.tokens.total,
        repricedCost: model.repricedCost,
        unknownCostMessages: model.unknownCostMessages,
        hasPrice: model.hasPrice,
      })),
      tools: [...day.tools.entries()].map(([name, count]) => ({ name, count })),
      skills: [...day.skills.entries()].map(([name, count]) => ({ name, count })),
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
  const globalState = globalThis as typeof globalThis & {
    __piUsageReportServer?: UsageReportServer;
    __piUsageReportServerVersion?: number;
  };
  if (!globalState.__piUsageReportServer || globalState.__piUsageReportServerVersion !== SERVER_VERSION) {
    globalState.__piUsageReportServer?.stop();
    globalState.__piUsageReportServer = new UsageReportServer();
    globalState.__piUsageReportServerVersion = SERVER_VERSION;
  }
  return globalState.__piUsageReportServer;
}

function reportHtml(): string {
  return `<!doctype html>
<html lang='zh-CN'>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1'>
  <title>Pi Usage Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070814;
      --panel: rgba(255, 255, 255, 0.052);
      --panel-hover: rgba(255, 255, 255, 0.08);
      --line: rgba(255, 255, 255, 0.09);
      --line-soft: rgba(255, 255, 255, 0.06);
      --text: rgba(255, 255, 255, 0.88);
      --muted: rgba(255, 255, 255, 0.35);
      --dim: rgba(255, 255, 255, 0.22);
      --blue: #60a5fa;
      --green: #4ade80;
      --amber: #fbbf24;
      --rose: #fb7185;
      --violet: #a78bfa;
      --indigo: #818cf8;
      --radius: 12px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--bg); }
    body {
      margin: 0;
      min-height: 100%;
      color: var(--text);
      font-family: var(--sans);
      background:
        radial-gradient(circle at 20% -10%, rgba(37, 99, 235, 0.25), transparent 34rem),
        radial-gradient(circle at 80% 5%, rgba(124, 58, 237, 0.18), transparent 30rem),
        linear-gradient(180deg, #070814 0%, #090b16 48%, #060712 100%);
      -webkit-font-smoothing: antialiased;
    }

    button { font: inherit; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(6, 6, 16, 0.72);
      backdrop-filter: blur(24px);
    }
    .topbar-inner {
      max-width: 1280px;
      height: 44px;
      margin: 0 auto;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .logo {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      color: #bfdbfe;
      font-family: Georgia, serif;
      font-size: 15px;
      font-weight: 700;
      background: rgba(59, 130, 246, 0.18);
      border: 1px solid rgba(96, 165, 250, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15);
    }
    .brand-title {
      font-size: 13px;
      font-weight: 650;
      letter-spacing: -0.01em;
      color: rgba(255, 255, 255, 0.86);
      white-space: nowrap;
    }

    .range-control {
      display: flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
    }
    .range-button {
      border: 0;
      border-radius: 6px;
      padding: 5px 12px;
      color: rgba(255, 255, 255, 0.42);
      background: transparent;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      transition: 150ms ease;
    }
    .range-button:hover { color: rgba(255, 255, 255, 0.72); background: rgba(255, 255, 255, 0.07); }
    .range-button.active { color: #fff; background: rgba(255, 255, 255, 0.15); }

    .top-actions { display: flex; align-items: center; gap: 8px; }
    .pricing-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.05);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .chip-dot { width: 6px; height: 6px; border-radius: 999px; animation: pulse 1.6s ease-in-out infinite; }
    .pricing-ok { color: rgba(74, 222, 128, 0.85); }
    .pricing-ok .chip-dot { background: var(--green); }
    .pricing-bad { color: rgba(251, 113, 133, 0.85); }
    .pricing-bad .chip-dot { background: var(--rose); }
    @keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

    .icon-button {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid var(--line);
      color: rgba(255, 255, 255, 0.42);
      background: rgba(255, 255, 255, 0.05);
      display: grid;
      place-items: center;
      cursor: pointer;
      transition: 150ms ease;
    }
    .icon-button:hover { color: rgba(255, 255, 255, 0.82); background: rgba(255, 255, 255, 0.10); }
    .icon-button.loading { animation: spin 900ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    main {
      max-width: 1280px;
      margin: 0 auto;
      padding: 16px 16px 20px;
      display: grid;
      gap: 12px;
    }
    .grid { display: grid; gap: 12px; }
    .kpi-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
    .main-grid { grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); }
    .lower-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }

    .panel {
      position: relative;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.11), 0 1px 4px rgba(0,0,0,0.5);
      backdrop-filter: blur(22px);
    }
    .panel-pad { padding: 16px; }
    .kpi {
      min-height: 108px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      cursor: default;
      transition: 150ms ease;
    }
    .kpi:hover { background: var(--panel-hover); }
    .kpi-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .kpi-label, .section-kicker, .tile-label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .kpi-icon { opacity: 0.72; font-size: 13px; }
    .kpi-value {
      font-family: var(--mono);
      font-size: 22px;
      line-height: 1;
      font-weight: 750;
      color: #fff;
      letter-spacing: -0.03em;
    }
    .kpi-sub { color: rgba(255, 255, 255, 0.30); font-size: 11px; line-height: 1.15; }
    .blue { color: var(--blue); } .green { color: var(--green); } .amber { color: var(--amber); }
    .rose { color: var(--rose); } .violet { color: var(--violet); } .indigo { color: var(--indigo); }

    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .section-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .section-icon { color: rgba(255, 255, 255, 0.30); font-size: 12px; }
    .section-right { color: var(--dim); font-family: var(--mono); font-size: 10px; white-space: nowrap; }

    .heatmap-wrap { position: relative; user-select: none; }
    .heatmap-scroller { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
    .heatmap-scroller::-webkit-scrollbar { display: none; }
    .dow-labels { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
    .dow-labels div { width: 10px; height: 11px; display: flex; align-items: center; color: var(--dim); font-size: 8px; line-height: 1; }
    .weeks { display: flex; gap: 2px; flex: 0 0 auto; }
    .week { display: flex; flex-direction: column; gap: 2px; }
    .heat-cell {
      width: 11px;
      height: 11px;
      border-radius: 2px;
      background: rgba(255,255,255,0.04);
      transition: 100ms ease;
    }
    .heat-cell:hover { outline: 1px solid rgba(255,255,255,0.30); transform: scale(1.12); }
    .h1 { background: rgba(30, 58, 138, 0.60); }
    .h2 { background: rgba(29, 78, 216, 0.66); }
    .h3 { background: rgba(59, 130, 246, 0.76); }
    .h4 { background: rgba(96, 165, 250, 0.92); }
    .heat-legend { display: flex; align-items: center; gap: 4px; margin-top: 8px; color: var(--dim); font-size: 9px; }
    .legend-cell { width: 9px; height: 9px; border-radius: 2px; }

    .tooltip {
      position: fixed;
      z-index: 50;
      pointer-events: none;
      min-width: 160px;
      padding: 9px 11px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(8, 8, 20, 0.94);
      box-shadow: 0 12px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.10);
      backdrop-filter: blur(18px);
      display: none;
    }
    .tooltip-title { font-size: 12px; font-weight: 700; margin-bottom: 4px; color: #fff; }
    .tooltip-main { font-family: var(--mono); font-size: 11px; color: rgba(255,255,255,0.62); }
    .tooltip-sub { font-size: 10px; color: var(--muted); margin-top: 3px; }

    .trend { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
    .trend-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .trend-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 750; }
    .trend-range { font-family: var(--mono); font-size: 10px; color: rgba(96,165,250,0.75); }
    .spark svg { width: 100%; height: 72px; display: block; }

    table { width: 100%; border-collapse: collapse; }
    th {
      padding: 8px 8px;
      border-bottom: 1px solid var(--line-soft);
      color: rgba(255, 255, 255, 0.30);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-align: right;
    }
    th:first-child { text-align: left; padding-left: 0; }
    th:last-child { padding-right: 0; }
    td {
      padding: 10px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      text-align: right;
      font-family: var(--mono);
      font-size: 11px;
      color: rgba(255, 255, 255, 0.62);
      vertical-align: middle;
    }
    td:first-child { text-align: left; padding-left: 0; }
    td:last-child { padding-right: 0; }
    tr:hover td { background: rgba(255,255,255,0.035); }
    .sort { border: 0; background: transparent; color: inherit; padding: 0; cursor: pointer; font-size: inherit; font-weight: inherit; }
    .model-provider { font-family: var(--sans); font-size: 9px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.06em; }
    .model-name { margin-top: 3px; color: rgba(255,255,255,0.78); font-size: 11px; line-height: 1.25; overflow-wrap: anywhere; }
    .price-ok { color: rgba(255,255,255,0.62); }
    .price-unknown { color: rgba(251,191,36,0.86); }
    .check { color: rgba(74,222,128,0.68); }
    .no-check { color: rgba(255,255,255,0.16); }
    .breakdown { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line-soft); display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; }
    .breakdown-row { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; }
    .breakdown-row strong { font-family: var(--mono); font-size: 10px; font-weight: 650; }

    .bar-list { display: grid; gap: 0; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin: 0 -4px; padding: 6px 4px; border-radius: 7px; transition: 100ms ease; }
    .bar-row:hover { background: rgba(255,255,255,0.04); }
    .bar-name { width: 112px; flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.62); font-family: var(--mono); font-size: 11px; }
    .bar-track { flex: 1 1 auto; height: 5px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,0.07); }
    .bar-fill { height: 100%; border-radius: inherit; transition: width 500ms ease; }
    .blue-bg { background: rgba(59, 130, 246, 0.68); }
    .violet-bg { background: rgba(139, 92, 246, 0.68); }
    .bar-count { width: 48px; flex: 0 0 auto; text-align: right; color: var(--muted); font-family: var(--mono); font-size: 10px; }

    .insight-stack { display: grid; gap: 8px; }
    .insight-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .tile { padding: 14px; display: grid; gap: 7px; }
    .tile-value { font-family: var(--mono); font-size: 18px; line-height: 1; font-weight: 800; }
    .tile-sub { color: var(--muted); font-size: 10px; line-height: 1.25; }
    .micro-panel { padding: 16px; display: grid; gap: 10px; }
    .micro-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .micro-row span:first-child { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 800; }
    .micro-row span:last-child { font-family: var(--mono); font-size: 11px; }

    .warning-link {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(251,191,36,0.20);
      background: rgba(251,191,36,0.06);
      color: rgba(251,191,36,0.84);
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .errors { overflow: hidden; }
    .errors button {
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      padding: 13px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
    }
    .errors button:hover { background: rgba(255,255,255,0.04); }
    .error-body { display: none; padding: 12px 16px 16px; border-top: 1px solid var(--line-soft); }
    .errors.expanded .error-body { display: grid; gap: 8px; }
    .error-line { padding: 11px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.56); font-family: var(--mono); font-size: 11px; line-height: 1.55; }
    .error-line b { color: rgba(251,191,36,0.68); margin-right: 8px; user-select: none; }

    .notice { padding: 14px 16px; border-radius: 12px; border: 1px solid rgba(251,191,36,0.18); background: rgba(251,191,36,0.06); color: rgba(251,191,36,0.84); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0 0; color: rgba(255,255,255,0.20); font-size: 10px; }
    .footer code { font-family: var(--mono); }
    .hide-sm { display: table-cell; }

    @media (max-width: 980px) {
      .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .main-grid, .lower-grid { grid-template-columns: 1fr; }
      .pricing-chip { display: none; }
    }
    @media (max-width: 640px) {
      .topbar-inner { padding: 0 10px; }
      .brand-title { display: none; }
      .range-button { padding: 5px 9px; }
      main { padding: 12px 10px 18px; }
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hide-sm { display: none; }
      th.hide-sm, td.hide-sm { display: none; }
      .footer { flex-direction: column; align-items: flex-start; }
      .bar-name { width: 96px; }
    }
  </style>
</head>
<body>
  <header class='topbar'>
    <div class='topbar-inner'>
      <div class='brand'>
        <div class='logo'>π</div>
        <div class='brand-title'>Pi Usage</div>
      </div>
      <div class='range-control' id='rangeControl' aria-label='Date range'>
        <button class='range-button' data-range='7d'>7d</button>
        <button class='range-button active' data-range='30d'>30d</button>
        <button class='range-button' data-range='90d'>90d</button>
        <button class='range-button' data-range='365d'>365d</button>
      </div>
      <div class='top-actions'>
        <div id='pricingChip' class='pricing-chip pricing-bad'><span class='chip-dot'></span><span>Loading</span></div>
        <button id='refreshButton' class='icon-button' aria-label='Refresh'>↻</button>
      </div>
    </div>
  </header>

  <main>
    <div id='kpis' class='grid kpi-grid'></div>

    <div class='grid main-grid'>
      <section class='panel panel-pad'>
        <div class='section-head'>
          <div class='section-title'><span class='section-icon'>▦</span><span class='section-kicker'>Activity</span></div>
          <div id='activitySummary' class='section-right'>-</div>
        </div>
        <div id='heatmap' class='heatmap-wrap'></div>
        <div class='trend'>
          <div class='trend-head'><span class='trend-label'>Token Volume</span><span id='trendRange' class='trend-range'>30d trend</span></div>
          <div id='sparkline' class='spark'></div>
        </div>
      </section>

      <section class='panel panel-pad'>
        <div class='section-head'>
          <div class='section-title'><span class='section-icon'>◌</span><span class='section-kicker'>Top Models</span></div>
          <div id='unknownModels' class='section-right amber'></div>
        </div>
        <div id='models'></div>
        <div id='tokenBreakdown' class='breakdown'></div>
      </section>
    </div>

    <div class='grid lower-grid'>
      <section class='panel panel-pad'>
        <div class='section-head'><div class='section-title'><span class='section-icon'>⌁</span><span class='section-kicker'>Top Tools</span></div></div>
        <div id='topTools' class='bar-list'></div>
      </section>

      <section class='panel panel-pad'>
        <div class='section-head'><div class='section-title'><span class='section-icon'>◇</span><span class='section-kicker'>Top Skills</span></div></div>
        <div id='topSkills' class='bar-list'></div>
      </section>

      <section class='insight-stack'>
        <div class='panel panel-pad'>
          <div class='section-head'><div class='section-title'><span class='section-icon'>✦</span><span class='section-kicker'>Insights</span></div></div>
          <div id='insights' class='insight-grid'></div>
        </div>
        <div id='microStats' class='panel micro-panel'></div>
        <button id='errorJump' class='warning-link' style='display: none;'>⚠ <span></span><span style='margin-left:auto'>⌄</span></button>
      </section>
    </div>

    <section id='scanErrors' class='panel errors' style='display: none;'></section>
    <div id='notices' class='grid'></div>
    <footer class='footer'><span id='generatedAt'>Generated -</span><code id='agentDir'>-</code></footer>
  </main>

  <div id='tooltip' class='tooltip'></div>

<script>
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const state = { report: null, range: '30d', sortField: 'tokens', sortDir: 'desc', errorsExpanded: false };
const nf = new Intl.NumberFormat('en-US');

const $ = (id) => document.getElementById(id);
const sum = (items, getter) => items.reduce((total, item) => total + getter(item), 0);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid numeric value for ' + label + ': ' + value);
  return number;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTokens(value) {
  const n = finiteNumber(value, 'tokens');
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtCount(value) {
  const n = finiteNumber(value, 'count');
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return nf.format(n);
}

function fmtCost(value, unknown) {
  const n = finiteNumber(value, 'cost');
  const digits = n > 0 && n < 1 ? 4 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + (unknown ? ' + unknown' : '');
}

function fmtDateShort(dateText) {
  return new Date(dateText + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function duration(seconds) {
  if (!seconds) return '-';
  const totalSeconds = finiteNumber(seconds, 'duration');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.round(totalSeconds % 60);
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  if (minutes > 0) return minutes + 'm ' + secs + 's';
  return secs + 's';
}

function aggregateLeaders(daily, field) {
  const counts = new Map();
  for (const day of daily) {
    for (const entry of day[field]) counts.set(entry.name, (counts.get(entry.name) || 0) + finiteNumber(entry.count, field + ' count'));
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));
}

function aggregateModels(daily) {
  const models = new Map();
  for (const day of daily) {
    for (const model of day.models) {
      const key = model.provider + '/' + model.model;
      let agg = models.get(key);
      if (!agg) {
        agg = { provider: model.provider, model: model.model, messages: 0, tokens: 0, repricedCost: 0, unknownCostMessages: 0, hasPrice: false };
        models.set(key, agg);
      }
      agg.messages += finiteNumber(model.messages, 'model messages');
      agg.tokens += finiteNumber(model.tokens, 'model tokens');
      agg.repricedCost += finiteNumber(model.repricedCost, 'model cost');
      agg.unknownCostMessages += finiteNumber(model.unknownCostMessages, 'model unknown');
      if (model.hasPrice) agg.hasPrice = true;
    }
  }
  return [...models.values()]
    .sort((left, right) => right.tokens - left.tokens || (left.provider + '/' + left.model).localeCompare(right.provider + '/' + right.model))
    .slice(0, 12);
}

function currentView(report) {
  const days = RANGE_DAYS[state.range] || 30;
  const daily = report.daily.slice(-days);
  return {
    days,
    daily,
    tokens: sum(daily, (day) => finiteNumber(day.tokens, 'daily tokens')),
    cost: sum(daily, (day) => finiteNumber(day.cost, 'daily cost')),
    messages: sum(daily, (day) => finiteNumber(day.assistantMessages, 'daily assistant messages')),
    toolCalls: sum(daily, (day) => finiteNumber(day.toolCalls, 'daily tool calls')),
    topModels: aggregateModels(daily),
    topTools: aggregateLeaders(daily, 'tools'),
    topSkills: aggregateLeaders(daily, 'skills'),
  };
}

function renderPricing(report) {
  const ok = report.pricing.status === 'ok';
  $('pricingChip').className = 'pricing-chip ' + (ok ? 'pricing-ok' : 'pricing-bad');
  $('pricingChip').innerHTML = '<span class="chip-dot"></span><span>' + (ok ? 'Prices live' : 'No prices') + '</span>';
}

function renderKpis(report, view) {
  const t = report.totals;
  const longestTask = t.longestTask;
  const taskSub = longestTask ? 'session ' + longestTask.sessionId.slice(0, 8) : 'no completed task';
  const cards = [
    ['Total Tokens', fmtTokens(view.tokens), fmtTokens(t.tokens.total) + ' all-time', 'blue', 'ϟ'],
    ['Est. Cost', fmtCost(view.cost), fmtCost(t.repricedCost) + ' all-time', 'green', '$'],
    ['Asst. Messages', nf.format(view.messages), nf.format(t.userMessages) + ' user', 'indigo', '✉'],
    ['Tool Calls', nf.format(view.toolCalls), nf.format(t.toolCalls) + ' all-time', 'violet', '⌁'],
    ['Streak', t.currentStreakDays + 'd', 'Best: ' + t.longestStreakDays + 'd', 'amber', '●'],
    ['Longest Task', duration(longestTask && longestTask.seconds), taskSub, 'rose', '◷'],
  ];
  $('kpis').innerHTML = cards.map(([label, value, sub, color, icon]) =>
    '<div class="panel kpi"><div class="kpi-top"><span class="kpi-label">' + label + '</span><span class="kpi-icon ' + color + '">' + icon + '</span></div><div class="kpi-value">' + value + '</div><div class="kpi-sub">' + escapeHtml(sub) + '</div></div>'
  ).join('');
}

function heatIntensity(tokens, maxTokens) {
  const value = finiteNumber(tokens, 'heatmap tokens');
  if (value === 0) return 0;
  const ratio = value / Math.max(1, maxTokens);
  if (ratio < 0.2) return 1;
  if (ratio < 0.45) return 2;
  if (ratio < 0.72) return 3;
  return 4;
}

function renderHeatmap(view) {
  const daily = view.daily;
  const maxTokens = Math.max(1, ...daily.map((day) => finiteNumber(day.tokens, 'daily tokens')));
  const firstDow = daily[0] ? new Date(daily[0].date + 'T00:00:00').getDay() : 0;
  const padded = Array(firstDow).fill(null).concat(daily);
  const weeks = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

  const weekHtml = weeks.map((week) => {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const day = week[i];
      if (!day) {
        cells += '<div class="heat-cell" style="visibility:hidden"></div>';
        continue;
      }
      const level = heatIntensity(day.tokens, maxTokens);
      cells += '<div class="heat-cell h' + level + '" data-date="' + day.date + '" data-tokens="' + day.tokens + '" data-cost="' + day.cost + '" data-messages="' + day.assistantMessages + '" data-sessions="' + day.sessions + '"></div>';
    }
    return '<div class="week">' + cells + '</div>';
  }).join('');

  $('heatmap').innerHTML =
    '<div class="heatmap-scroller"><div class="dow-labels"><div></div><div>M</div><div></div><div>W</div><div></div><div>F</div><div></div></div><div class="weeks">' + weekHtml + '</div></div>' +
    '<div class="heat-legend"><span>Less</span><span class="legend-cell h0"></span><span class="legend-cell h1"></span><span class="legend-cell h2"></span><span class="legend-cell h3"></span><span class="legend-cell h4"></span><span>More</span></div>';

  for (const cell of document.querySelectorAll('.heat-cell[data-date]')) {
    cell.addEventListener('mouseenter', showTooltip);
    cell.addEventListener('mousemove', moveTooltip);
    cell.addEventListener('mouseleave', hideTooltip);
  }
}

function showTooltip(event) {
  const cell = event.currentTarget;
  $('tooltip').innerHTML = '<div class="tooltip-title">' + fmtDateShort(cell.dataset.date) + '</div><div class="tooltip-main">' + fmtTokens(cell.dataset.tokens) + ' tok · ' + fmtCost(cell.dataset.cost) + '</div><div class="tooltip-sub">' + cell.dataset.messages + ' msgs · ' + cell.dataset.sessions + ' sessions</div>';
  $('tooltip').style.display = 'block';
  moveTooltip(event);
}

function moveTooltip(event) {
  $('tooltip').style.left = event.clientX + 14 + 'px';
  $('tooltip').style.top = event.clientY - 72 + 'px';
}

function hideTooltip() {
  $('tooltip').style.display = 'none';
}

function renderSparkline(view) {
  const daily = view.daily;
  const series = view.days > 90 ? weeklySeries(daily) : daily.map((day) => ({ label: day.date, tokens: day.tokens }));
  const width = 640;
  const height = 72;
  const pad = 4;
  const maxTokens = Math.max(1, ...series.map((point) => finiteNumber(point.tokens, 'sparkline tokens')));
  const points = series.map((point, index) => {
    const x = series.length <= 1 ? pad : pad + index * ((width - pad * 2) / (series.length - 1));
    const y = height - pad - (finiteNumber(point.tokens, 'sparkline tokens') / maxTokens) * (height - pad * 2);
    return [x, y];
  });
  const line = points.length ? points.map((point, index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ') : '';
  const area = line ? line + ' L' + (points[points.length - 1][0]).toFixed(1) + ' ' + (height - pad) + ' L' + points[0][0].toFixed(1) + ' ' + (height - pad) + ' Z' : '';
  $('sparkline').innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><defs><linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stop-color="#3b82f6" stop-opacity="0.35"/><stop offset="95%" stop-color="#3b82f6" stop-opacity="0.02"/></linearGradient></defs><path d="' + area + '" fill="url(#tokenGradient)"/><path d="' + line + '" fill="none" stroke="#3b82f6" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}

function weeklySeries(daily) {
  const weeks = [];
  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7);
    if (chunk.length) weeks.push({ label: chunk[0].date, tokens: sum(chunk, (day) => finiteNumber(day.tokens, 'weekly tokens')) });
  }
  return weeks;
}

function renderModels(view) {
  const models = [...view.topModels].sort((left, right) => {
    const leftValue = finiteNumber(left[state.sortField], 'model ' + state.sortField);
    const rightValue = finiteNumber(right[state.sortField], 'model ' + state.sortField);
    return state.sortDir === 'desc' ? rightValue - leftValue : leftValue - rightValue;
  });
  const headers = [
    ['model', 'Model'],
    ['messages', 'Msgs'],
    ['tokens', 'Tokens'],
    ['repricedCost', 'Cost'],
  ];
  const headerHtml = headers.map(([field, label], index) => {
    if (field === 'model') return '<th>' + label + '</th>';
    const active = state.sortField === field;
    const arrow = active ? (state.sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕';
    const cls = index === 3 ? ' class="hide-sm"' : '';
    return '<th' + cls + '><button class="sort" data-sort="' + field + '">' + label + arrow + '</button></th>';
  }).join('') + '<th class="hide-sm">✓</th>';

  const rows = models.map((model) => {
    const provider = escapeHtml(model.provider);
    const name = escapeHtml(model.model);
    const hasPrice = model.hasPrice;
    const unknown = model.unknownCostMessages > 0;
    return '<tr><td><div class="model-provider ' + providerColor(model.provider) + '">' + provider + '</div><div class="model-name">' + name + '</div></td><td>' + nf.format(model.messages) + '</td><td>' + fmtTokens(model.tokens) + '</td><td class="hide-sm ' + (unknown ? 'price-unknown' : 'price-ok') + '">' + fmtCost(model.repricedCost, unknown) + '</td><td class="hide-sm ' + (hasPrice ? 'check' : 'no-check') + '">' + (hasPrice ? '✓' : '—') + '</td></tr>';
  }).join('');

  $('models').innerHTML = '<table><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rows + '</tbody></table>';
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => toggleSort(button.dataset.sort));
  }
}

function providerColor(provider) {
  const lower = String(provider).toLowerCase();
  if (lower.includes('anthropic')) return 'rose';
  if (lower.includes('openai')) return 'green';
  if (lower.includes('google')) return 'amber';
  return 'blue';
}

function toggleSort(field) {
  if (state.sortField === field) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
  else {
    state.sortField = field;
    state.sortDir = 'desc';
  }
  renderModels(currentView(state.report));
}

function renderBreakdown(report) {
  const tokens = report.totals.tokens;
  const rows = [
    ['Input', tokens.input, 'blue'],
    ['Output', tokens.output, 'indigo'],
    ['Cache Read', tokens.cacheRead, 'green'],
    ['Cache Write', tokens.cacheWrite, 'amber'],
  ];
  $('tokenBreakdown').innerHTML = rows.map(([label, value, color]) => '<div class="breakdown-row"><span>' + label + '</span><strong class="' + color + '">' + fmtTokens(value) + '</strong></div>').join('');
}

function barRows(items, colorClass) {
  const max = Math.max(1, ...items.map((item) => finiteNumber(item.count, 'bar count')));
  if (!items.length) return '<div class="kpi-sub">No records</div>';
  return items.map((item) => {
    const count = finiteNumber(item.count, 'bar count');
    const pct = Math.max(0, Math.min(100, count / max * 100));
    return '<div class="bar-row"><span class="bar-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span><span class="bar-track"><span class="bar-fill ' + colorClass + '" style="width:' + pct.toFixed(1) + '%"></span></span><span class="bar-count">' + fmtCount(item.count) + '</span></div>';
  }).join('');
}

function renderLists(view) {
  $('topTools').innerHTML = barRows(view.topTools, 'blue-bg');
  $('topSkills').innerHTML = barRows(view.topSkills, 'violet-bg');
}

function renderInsights(report) {
  const i = report.insights;
  const quick = i.quickModePercent === undefined ? '-' : i.quickModePercent.toFixed(0) + '%';
  const tiles = [
    ['Quick Mode', quick, 'of assistant messages', 'amber'],
    ['Thinking', i.mostUsedThinkingLevel || '-', 'most used level', 'blue'],
    ['Skills Used', i.usedSkillsTotal, 'of ' + i.exploredSkills + ' explored', 'green'],
    ['Sessions', nf.format(report.totals.scannedSessions), (report.totals.listedSessions - report.totals.scannedSessions) + ' skipped', ''],
  ];
  $('insights').innerHTML = tiles.map(([label, value, sub, color]) => '<div class="panel tile"><span class="tile-label">' + label + '</span><span class="tile-value ' + color + '">' + escapeHtml(value) + '</span><span class="tile-sub">' + escapeHtml(sub) + '</span></div>').join('');
}

function renderMicroStats(report) {
  const t = report.totals;
  $('microStats').innerHTML = [
    ['Peak Day', fmtTokens(t.peakDayTokens), 'blue'],
    ['Partial Unk.', t.partialUnknownCostMessages, 'amber'],
    ['Listed', nf.format(t.listedSessions), ''],
  ].map(([label, value, color]) => '<div class="micro-row"><span>' + label + '</span><span class="' + color + '">' + value + '</span></div>').join('');
}

function renderErrors(report) {
  const errors = report.scanErrors || [];
  $('errorJump').style.display = errors.length ? 'flex' : 'none';
  $('errorJump').querySelector('span').textContent = errors.length + ' scan error' + (errors.length === 1 ? '' : 's');
  $('scanErrors').style.display = errors.length ? 'block' : 'none';
  $('scanErrors').className = 'panel errors' + (state.errorsExpanded ? ' expanded' : '');
  $('scanErrors').innerHTML = '<button id="errorsToggle"><span><span class="amber">⚠</span> <b class="amber">Scan Errors</b> <span class="kpi-sub">— ' + errors.length + ' issues detected</span></span><span>' + (state.errorsExpanded ? '⌃' : '⌄') + '</span></button><div class="error-body">' + errors.map((error, index) => '<div class="error-line"><b>' + (index + 1) + '.</b>' + escapeHtml(error) + '</div>').join('') + '</div>';
  $('errorsToggle').addEventListener('click', toggleErrors);
}

function toggleErrors() {
  state.errorsExpanded = !state.errorsExpanded;
  renderErrors(state.report);
}

function renderNotices(report) {
  const notices = [];
  if (report.pricing.status !== 'ok') notices.push('LiteLLM price source unavailable: ' + (report.pricing.error || 'unknown error'));
  if (report.totals.unknownCostMessages || report.totals.partialUnknownCostMessages) notices.push('Some model messages cannot be fully priced: unknown=' + report.totals.unknownCostMessages + ', partial=' + report.totals.partialUnknownCostMessages + '. They are shown as + unknown, not silently priced as $0.');
  $('notices').innerHTML = notices.map((notice) => '<div class="notice">' + escapeHtml(notice) + '</div>').join('');
}

function renderFooter(report) {
  $('generatedAt').textContent = 'Generated ' + new Date(report.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('agentDir').textContent = report.agentDir;
}

function render() {
  const report = state.report;
  if (!report) return;
  const view = currentView(report);
  for (const button of document.querySelectorAll('.range-button')) button.classList.toggle('active', button.dataset.range === state.range);
  $('activitySummary').textContent = fmtTokens(view.tokens) + ' · ' + fmtCost(view.cost);
  $('trendRange').textContent = view.days + 'd trend';
  const viewUnknown = view.topModels.reduce((sum, model) => sum + model.unknownCostMessages, 0);
  $('unknownModels').textContent = viewUnknown ? '⚠ ' + viewUnknown + ' unknown' : '';
  renderPricing(report);
  renderKpis(report, view);
  renderHeatmap(view);
  renderSparkline(view);
  renderModels(view);
  renderBreakdown(report);
  renderLists(view);
  renderInsights(report);
  renderMicroStats(report);
  renderErrors(report);
  renderNotices(report);
  renderFooter(report);
}

function renderFatal(error) {
  $('kpis').innerHTML = '<div class="notice" style="grid-column:1/-1">' + escapeHtml(error.message || error) + '</div>';
  $('pricingChip').className = 'pricing-chip pricing-bad';
  $('pricingChip').innerHTML = '<span class="chip-dot"></span><span>Failed</span>';
}

async function loadReport() {
  $('refreshButton').classList.add('loading');
  try {
    const response = await fetch('/api/report', { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    state.report = await response.json();
    render();
  } catch (error) {
    renderFatal(error);
  } finally {
    $('refreshButton').classList.remove('loading');
  }
}

for (const button of document.querySelectorAll('.range-button')) {
  button.addEventListener('click', () => {
    state.range = button.dataset.range;
    render();
  });
}
$('refreshButton').addEventListener('click', loadReport);
$('errorJump').addEventListener('click', () => {
  state.errorsExpanded = true;
  renderErrors(state.report);
  $('scanErrors').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
loadReport();
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
    description: 'Open the Pi token activity and API cost report dashboard: open, status, start [port], stop',
    handler: async (args, ctx) => {
      const [action = 'open', portArg] = args.trim().split(/\s+/).filter(Boolean);

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
