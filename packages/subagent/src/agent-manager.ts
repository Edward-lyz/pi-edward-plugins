import { randomUUID } from 'node:crypto';
import type { Model } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runAgent, steerAgent, type ToolActivity } from './agent-runner.js';
import type { AgentInvocation, AgentRecord, SubagentType, ThinkingLevel } from './types.js';
import { addUsage } from './usage.js';

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: 'manual' | 'threshold' | 'overflow'; tokensBefore: number };

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  inheritContext?: boolean;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    private onComplete?: OnAgentComplete,
    private onStart?: OnAgentStart,
    private onCompact?: OnAgentCompact,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type: 'subagent' satisfies SubagentType,
      description: options.description,
      status: 'running',
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: options.isBackground,
      invocation: options.invocation,
    };
    this.agents.set(id, record);
    this.startAgent(id, record, { pi, ctx, prompt, options });
    return id;
  }

  private startAgent(id: string, record: AgentRecord, { ctx, prompt, options }: SpawnArgs): void {
    record.status = 'running';
    record.startedAt = Date.now();
    this.onStart?.(record);

    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener('abort', onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener('abort', onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const promise = runAgent(ctx, prompt, {
      agentId: id,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      inheritContext: options.inheritContext,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === 'end') record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTextDelta: options.onTextDelta,
      onTurnEnd: options.onTurnEnd,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        if (record.pendingSteers?.length) {
          for (const message of record.pendingSteers) session.steer(message).catch(() => {});
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        if (record.status !== 'stopped') record.status = aborted ? 'aborted' : steered ? 'steered' : 'completed';
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();
        detach();
        if (!options.isBackground) record.resultConsumed = true;
        this.onComplete?.(record);
        return responseText;
      })
      .catch((error) => {
        if (record.status !== 'stopped') record.status = 'error';
        record.error = error instanceof Error ? error.message : String(error);
        record.completedAt ??= Date.now();
        detach();
        if (!options.isBackground) record.resultConsumed = true;
        this.onComplete?.(record);
        return '';
      });

    record.promise = promise;
  }

  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    options: Omit<SpawnOptions, 'isBackground'>,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawn(pi, ctx, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== 'running') return false;
    if (record.session) {
      steerAgent(record.session, message).catch(() => {});
    } else {
      record.pendingSteers ??= [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== 'running') return false;
    record.abortController?.abort();
    record.status = 'stopped';
    record.completedAt = Date.now();
    return true;
  }

  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === 'running') continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      record.session?.dispose?.();
      record.session = undefined;
      this.agents.delete(id);
    }
  }

  hasRunning(): boolean {
    return [...this.agents.values()].some(record => record.status === 'running');
  }

  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.status !== 'running') continue;
      record.abortController?.abort();
      record.status = 'stopped';
      record.completedAt = Date.now();
      count++;
    }
    return count;
  }

  async waitForAll(): Promise<void> {
    const pending = [...this.agents.values()].map(record => record.promise).filter(Boolean);
    await Promise.allSettled(pending);
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    for (const record of this.agents.values()) record.session?.dispose?.();
    this.agents.clear();
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === 'running') continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      if (!record.resultConsumed) continue;
      record.session?.dispose?.();
      record.session = undefined;
      this.agents.delete(id);
    }
  }
}
