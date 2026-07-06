import type { Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { buildParentContext, extractText } from './context.js';
import type { ThinkingLevel } from './types.js';

export const SUBAGENT_TOOL_NAMES = {
  SUBAGENT: 'subagent',
  WAIT_RESULT: 'wait_subagent',
} as const;

const EXCLUDED_TOOL_NAMES = Object.values(SUBAGENT_TOOL_NAMES);

const SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent running inside the same Pi project as the parent session.

Work independently on the delegated prompt. Use the available project tools and skills normally, but do not try to spawn another subagent. Return a concise final answer with the concrete findings, files changed, validation performed, and any remaining risks.`;

export interface ToolActivity {
  type: 'start' | 'end';
  toolName: string;
}

export interface RunOptions {
  agentId?: string;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  inheritContext?: boolean;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: 'manual' | 'threshold' | 'overflow'; tokensBefore: number }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  aborted: boolean;
  steered: boolean;
}

function collectResponseText(session: AgentSession) {
  let text = '';
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_start') text = '';
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role !== 'assistant') continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return '';
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export async function runAgent(
  ctx: ExtensionContext,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: (base) => [base, SUBAGENT_SYSTEM_PROMPT].filter(Boolean).join('\n\n'),
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(ctx.cwd);

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: ctx.cwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    excludeTools: EXCLUDED_TOOL_NAMES,
    resourceLoader: loader,
  };

  const { session } = await createAgentSession(sessionOpts);
  session.setSessionName(options.agentId ? `subagent#${options.agentId.slice(0, 8)}` : 'subagent');

  await session.bindExtensions({
    onError: (error) => {
      options.onToolActivity?.({
        type: 'end',
        toolName: `extension-error:${error.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  let turnCount = 0;
  let currentMessageText = '';
  let aborted = false;
  const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'turn_end') {
      turnCount++;
      options.onTurnEnd?.(turnCount);
    }
    if (event.type === 'message_start') currentMessageText = '';
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === 'tool_execution_start') {
      options.onToolActivity?.({ type: 'start', toolName: event.toolName });
    }
    if (event.type === 'tool_execution_end') {
      options.onToolActivity?.({ type: 'end', toolName: event.toolName });
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const usage = (event.message as any).usage;
      if (usage) {
        options.onAssistantUsage?.({
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
        });
      }
    }
    if (event.type === 'compaction_end' && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) effectivePrompt = parentContext + prompt;
  }

  try {
    await session.prompt(effectivePrompt);
  } catch (error) {
    if ((error as any)?.name === 'AbortError') aborted = true;
    throw error;
  } finally {
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: false };
}

export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const message of session.messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : extractText(message.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const content of message.content) {
        if (content.type === 'text' && content.text) textParts.push(content.text);
        else if (content.type === 'toolCall') toolCalls.push(`  Tool: ${(content as any).name ?? (content as any).toolName ?? 'unknown'}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join('\n')}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join('\n')}`);
    } else if (message.role === 'toolResult') {
      const text = extractText(message.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
      parts.push(`[Tool Result (${message.toolName})]: ${truncated}`);
    }
  }

  return parts.join('\n\n');
}
