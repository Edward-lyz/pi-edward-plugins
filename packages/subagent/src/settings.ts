import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from './types.js';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface SubagentSettings {
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
}

function settingsPath(): string {
  return join(getAgentDir(), 'subagent.json');
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid subagent settings at ${path}: expected a JSON object`);
  }
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}

export function assertThinkingLevel(value: string): ThinkingLevel {
  const parsed = parseThinkingLevel(value);
  if (!parsed) {
    throw new Error(`Invalid thinking level: ${value}. Expected one of: ${THINKING_LEVELS.join(', ')}`);
  }
  return parsed;
}

export function readSubagentSettings(): SubagentSettings {
  const path = settingsPath();
  if (!existsSync(path)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read subagent settings at ${path}: ${message}`);
  }

  assertRecord(raw, path);

  const settings: SubagentSettings = {};
  if (raw.defaultModel !== undefined) {
    if (typeof raw.defaultModel !== 'string' || raw.defaultModel.trim() === '') {
      throw new Error(`Invalid subagent settings at ${path}: defaultModel must be a non-empty string`);
    }
    settings.defaultModel = raw.defaultModel.trim();
  }
  if (raw.defaultThinking !== undefined) {
    const thinking = parseThinkingLevel(raw.defaultThinking);
    if (!thinking) {
      throw new Error(`Invalid subagent settings at ${path}: defaultThinking must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    settings.defaultThinking = thinking;
  }

  return settings;
}

export function writeSubagentSettings(settings: SubagentSettings): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const normalized: SubagentSettings = {};
  if (settings.defaultModel) normalized.defaultModel = settings.defaultModel;
  if (settings.defaultThinking) normalized.defaultThinking = settings.defaultThinking;
  writeFileSync(path, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return path;
}

export function formatSubagentSettings(settings: SubagentSettings): string {
  return [
    `model: ${settings.defaultModel ?? 'inherit'}`,
    `thinking: ${settings.defaultThinking ?? 'inherit'}`,
  ].join('\n');
}
