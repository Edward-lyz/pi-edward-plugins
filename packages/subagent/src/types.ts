import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { LifetimeUsage } from './usage.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type SubagentType = 'subagent';

export type WidgetMode = 'all' | 'background' | 'off';

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: 'running' | 'completed' | 'steered' | 'aborted' | 'stopped' | 'error';
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  pendingSteers?: string[];
  resultConsumed?: boolean;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  isBackground?: boolean;
  invocation?: AgentInvocation;
}

export interface AgentInvocation {
  modelName?: string;
  thinking?: ThinkingLevel;
}

export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  resultPreview: string;
}
