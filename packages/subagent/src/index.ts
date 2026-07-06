import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { AgentManager } from './agent-manager.js';
import { getAgentConversation, SUBAGENT_TOOL_NAMES } from './agent-runner.js';
import { resolveModel } from './model-resolver.js';
import {
  assertThinkingLevel,
  formatSubagentSettings,
  readSubagentSettings,
  writeSubagentSettings,
} from './settings.js';
import type { AgentInvocation, AgentRecord, ThinkingLevel } from './types.js';
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatMs,
  formatTokens,
  getDisplayName,
  SPINNER,
  type UICtx,
} from './ui/agent-widget.js';
import { FleetList, type FleetUICtx } from './ui/fleet-list.js';
import { addUsage, getLifetimeTotal, type LifetimeUsage } from './usage.js';

function textResult(message: string, details?: AgentDetails) {
  return { content: [{ type: 'text' as const, text: message }], details: details as any };
}

function firstPromptLine(prompt: string): string {
  const line = prompt.split('\n').find(value => value.trim())?.trim() ?? 'subagent task';
  return line.length <= 72 ? line : line.slice(0, 71) + '…';
}

function formatLifetimeTokens(value: { lifetimeUsage: LifetimeUsage }): string {
  const tokens = getLifetimeTotal(value.lifetimeUsage);
  return tokens > 0 ? formatTokens(tokens) : '';
}

function createActivityTracker(onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 0,
    responseText: '',
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: 'start' | 'end'; toolName: string }) => {
      if (activity.type === 'start') {
        state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
      onStreamUpdate?.();
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

function buildDetails(
  base: Pick<AgentDetails, 'displayName' | 'description' | 'subagentType' | 'modelName' | 'tags'>,
  record: AgentRecord,
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails['status'],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

function modelLabel(model: { name?: string; id: string } | undefined): string | undefined {
  if (!model) return undefined;
  return (model.name ?? model.id).replace(/^Claude\s+/i, '').replace(/-\d{8}$/, '').toLowerCase();
}

function sameModel(left: { provider: string; id: string } | undefined, right: { provider: string; id: string } | undefined): boolean {
  if (!left || !right) return false;
  return left.provider === right.provider && left.id === right.id;
}


function formatRecordResult(record: AgentRecord, verbose: boolean): string {
  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const tokens = formatLifetimeTokens(record);
  const stats = [`Status: ${record.status}`, `Tool uses: ${record.toolUses}`, `Duration: ${formatMs(durationMs)}`];
  if (tokens) stats.push(`Tokens: ${tokens}`);

  let output = [
    `Subagent: ${record.id}`,
    `Description: ${record.description}`,
    stats.join(' | '),
    '',
  ].join('\n');

  if (record.status === 'running') {
    output += 'Subagent is still running. Use wait_subagent with wait: true to wait for completion.';
  } else if (record.status === 'error') {
    output += `Error: ${record.error ?? 'unknown'}`;
  } else {
    output += record.result?.trim() || 'No output.';
  }

  if (verbose && record.session) {
    const conversation = getAgentConversation(record.session);
    if (conversation) output += `

--- Subagent Conversation ---
${conversation}`;
  }

  return output;
}

function commandUsage(): string {
  return [
    'Usage:',
    '  /subagent',
    '  /subagent model <provider/model 或 fuzzy name>',
    '  /subagent model inherit',
    '  /subagent thinking <off|minimal|low|medium|high|xhigh>',
    '  /subagent thinking inherit',
    '  /subagent clear',
  ].join('\n');
}

async function handleSubagentCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify(`Subagent defaults\n${formatSubagentSettings(readSubagentSettings())}`, 'info');
    return;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const value = rest.join(' ').trim();
  const settings = readSubagentSettings();

  if (command === 'clear') {
    const path = writeSubagentSettings({});
    ctx.ui.notify(`Subagent defaults cleared\n${path}`, 'info');
    return;
  }

  if (command === 'model') {
    if (!value) {
      ctx.ui.notify(commandUsage(), 'warning');
      return;
    }
    if (value === 'inherit') {
      delete settings.defaultModel;
      const path = writeSubagentSettings(settings);
      ctx.ui.notify(`Subagent default model cleared\n${path}`, 'info');
      return;
    }
    const resolved = resolveModel(value, ctx.modelRegistry);
    if (typeof resolved === 'string') {
      ctx.ui.notify(resolved, 'error');
      return;
    }
    settings.defaultModel = value;
    const path = writeSubagentSettings(settings);
    ctx.ui.notify(`Subagent default model set to ${resolved.provider}/${resolved.id}\n${path}`, 'info');
    return;
  }

  if (command === 'thinking') {
    if (!value) {
      ctx.ui.notify(commandUsage(), 'warning');
      return;
    }
    if (value === 'inherit') {
      delete settings.defaultThinking;
      const path = writeSubagentSettings(settings);
      ctx.ui.notify(`Subagent default thinking cleared\n${path}`, 'info');
      return;
    }
    settings.defaultThinking = assertThinkingLevel(value);
    const path = writeSubagentSettings(settings);
    ctx.ui.notify(`Subagent default thinking set to ${settings.defaultThinking}\n${path}`, 'info');
    return;
  }

  ctx.ui.notify(commandUsage(), 'warning');
}

export default function subagentExtension(pi: ExtensionAPI) {
  const agentActivity = new Map<string, AgentActivity>();
  let widget!: AgentWidget;
  let fleet!: FleetList;

  const manager = new AgentManager((record) => {
    const isError = record.status === 'error' || record.status === 'stopped' || record.status === 'aborted';
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    const usage = record.lifetimeUsage;
    const total = getLifetimeTotal(usage);
    pi.events.emit(isError ? 'subagents:failed' : 'subagents:completed', {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens: total > 0 ? { input: usage.input, output: usage.output, total } : undefined,
    });
    pi.appendEntry('subagents:record', {
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      result: record.result,
      error: record.error,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    });
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    widget.update();
  }, (record) => {
    pi.events.emit('subagents:started', {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    pi.events.emit('subagents:compacted', {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  widget = new AgentWidget(manager, agentActivity, () => 'all');
  fleet = new FleetList(manager, agentActivity);

  pi.on('tool_execution_start', async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  pi.on('session_before_switch', () => {
    manager.clearCompleted(true);
  });

  pi.on('session_shutdown', () => {
    manager.abortAll();
    fleet.dispose();
    widget.dispose();
    manager.dispose();
  });

  pi.registerCommand('subagent', {
    description: 'Configure default subagent model and thinking level',
    handler: handleSubagentCommand,
  });

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.SUBAGENT,
    label: 'Subagent',
    description:
      'Run one delegated task in a separate SDK-created Pi subagent session. The subagent uses the same project resources, skills, and extension tools as the parent, except this subagent tool is filtered out so it cannot spawn more subagents. Use model or thinking to override /subagent defaults for this call.',
    promptSnippet: 'Delegate one focused task to an isolated subagent session',
    promptGuidelines: [
      'Use subagent for focused work that benefits from a separate context window. Do not use it when a direct read, grep, or edit in the current session is enough.',
      'Give the subagent a self-contained prompt. It has the project tools and skills, but it has not seen the full parent conversation unless you include the relevant context in the prompt.',
      'If you call several subagents in one turn, Pi can execute them in parallel. Do not duplicate delegated work in the parent while they run.',
      'Use run_in_background for long-running work you do not need immediately, then call wait_subagent with wait: true when you need the result.',
    ],
    executionMode: 'parallel',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'The task or prompt for the subagent.',
      }),
      model: Type.Optional(Type.String({
        description: 'Optional model override for this run. Accepts provider/modelId or a fuzzy model name. Omit to use /subagent default, then parent model.',
      })),
      thinking: Type.Optional(Type.String({
        description: 'Optional thinking override for this run: off, minimal, low, medium, high, xhigh. Omit to use /subagent default, then parent thinking level.',
      })),
      run_in_background: Type.Optional(Type.Boolean({
        description: 'Set true to start the subagent and return immediately with an ID. Use wait_subagent to wait for or retrieve the result later.',
      })),
    }),

    renderCall(args, theme) {
      return new Text(`▸ ${theme.fg('toolTitle', theme.bold('Subagent'))}  ${theme.fg('muted', firstPromptLine(args.prompt))}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
        return new Text(text, 0, 0);
      }

      const stats = (detailsValue: AgentDetails) => {
        const parts: string[] = [];
        if (detailsValue.modelName) parts.push(detailsValue.modelName);
        if (detailsValue.tags) parts.push(...detailsValue.tags);
        if (detailsValue.turnCount != null && detailsValue.turnCount > 0) parts.push(`↻${detailsValue.turnCount}`);
        if (detailsValue.toolUses > 0) parts.push(`${detailsValue.toolUses} tool use${detailsValue.toolUses === 1 ? '' : 's'}`);
        if (detailsValue.tokens) parts.push(detailsValue.tokens);
        return parts.map(part => theme.fg('dim', part)).join(` ${theme.fg('dim', '·')} `);
      };

      if (isPartial || details.status === 'running') {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const suffix = stats(details);
        const activity = details.activity ?? 'thinking…';
        return new Text(`${theme.fg('accent', frame)}${suffix ? ' ' + suffix : ''}\n${theme.fg('dim', `  ⎿  ${activity}`)}`, 0, 0);
      }

      if (details.status === 'background') {
        return new Text(theme.fg('dim', `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      if (details.status === 'completed' || details.status === 'steered') {
        const suffix = stats(details);
        let text = `${theme.fg('success', '✓')}${suffix ? ' ' + suffix : ''} ${theme.fg('dim', '·')} ${theme.fg('dim', formatMs(details.durationMs))}`;
        if (expanded) {
          const resultText = result.content[0]?.type === 'text' ? result.content[0].text : '';
          if (resultText) {
            for (const line of resultText.split('\n').slice(0, 50)) text += `\n${theme.fg('dim', `  ${line}`)}`;
          }
        } else {
          text += `\n${theme.fg('dim', '  ⎿  Done')}`;
        }
        return new Text(text, 0, 0);
      }

      if (details.status === 'stopped') {
        return new Text(`${theme.fg('dim', '■')} ${stats(details)}\n${theme.fg('dim', '  ⎿  Stopped')}`, 0, 0);
      }

      return new Text(`${theme.fg('error', '✗')} ${stats(details)}\n${theme.fg('error', `  ⎿  Error: ${details.error ?? 'unknown'}`)}`, 0, 0);
    },

    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as UICtx);
      fleet.setUICtx(ctx.ui as unknown as FleetUICtx);

      const prompt = params.prompt.trim();
      if (!prompt) return textResult('Subagent prompt must be a non-empty string.');

      let settings;
      try {
        settings = readSubagentSettings();
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }

      if (params.model !== undefined && params.model.trim() === '') return textResult('Subagent model override must be non-empty when provided.');
      if (params.thinking !== undefined && params.thinking.trim() === '') return textResult('Subagent thinking override must be non-empty when provided.');

      const modelInput = params.model?.trim() || settings.defaultModel;
      let model = ctx.model;
      if (modelInput) {
        const resolved = resolveModel(modelInput, ctx.modelRegistry);
        if (typeof resolved === 'string') return textResult(resolved);
        model = resolved;
      }

      let thinking: ThinkingLevel | undefined;
      try {
        thinking = params.thinking ? assertThinkingLevel(params.thinking) : settings.defaultThinking ?? pi.getThinkingLevel();
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }

      const description = firstPromptLine(prompt);
      const modelName = model && !sameModel(model, ctx.model) ? modelLabel(model) : undefined;
      const invocation: AgentInvocation = { modelName, thinking };
      const invocationTags = buildInvocationTags(invocation);
      const detailBase = {
        displayName: getDisplayName('subagent'),
        description,
        subagentType: 'subagent',
        modelName: invocationTags.modelName,
        tags: invocationTags.tags.length > 0 ? invocationTags.tags : undefined,
      };

      let spinnerFrame = 0;
      const startedAt = Date.now();
      let subagentId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: activityState.toolUses,
          tokens: formatLifetimeTokens(activityState),
          turnCount: activityState.turnCount,
          durationMs: Date.now() - startedAt,
          status: 'running',
          activity: describeActivity(activityState.activeTools, activityState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
          agentId: subagentId,
        };
        onUpdate?.({ content: [{ type: 'text', text: `${activityState.toolUses} tool uses...` }], details: details as any });
      };

      const { state: activityState, callbacks } = createActivityTracker(streamUpdate);
      const originalOnSessionCreated = callbacks.onSessionCreated;
      callbacks.onSessionCreated = (session: any) => {
        originalOnSessionCreated(session);
        for (const record of manager.listAgents()) {
          if (record.session === session) {
            subagentId = record.id;
            agentActivity.set(record.id, activityState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
      };

      if (params.run_in_background) {
        const { state: backgroundState, callbacks: backgroundCallbacks } = createActivityTracker(() => {
          widget.update();
          fleet.update();
        });
        const originalBackgroundOnSessionCreated = backgroundCallbacks.onSessionCreated;
        backgroundCallbacks.onSessionCreated = (session: any) => {
          originalBackgroundOnSessionCreated(session);
          for (const record of manager.listAgents()) {
            if (record.session === session) {
              subagentId = record.id;
              agentActivity.set(record.id, backgroundState);
              widget.ensureTimer();
              fleet.ensureTimer();
              widget.update();
              fleet.update();
              break;
            }
          }
        };

        subagentId = manager.spawn(pi, ctx, prompt, {
          description,
          model,
          thinkingLevel: thinking,
          invocation,
          isBackground: true,
          ...backgroundCallbacks,
        });
        agentActivity.set(subagentId, backgroundState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        pi.events.emit('subagents:created', {
          id: subagentId,
          type: 'subagent',
          description,
          isBackground: true,
        });

        return textResult(
          `Subagent started in background.
Subagent ID: ${subagentId}
Description: ${description}

Use wait_subagent with this ID to wait for or retrieve the result.`,
          { ...detailBase, toolUses: 0, tokens: '', durationMs: 0, status: 'background' as const, agentId: subagentId },
        );
      }

      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);
      streamUpdate();

      let record: AgentRecord;
      try {
        const spawned = await manager.spawnAndWait(pi, ctx, prompt, {
          description,
          model,
          thinkingLevel: thinking,
          invocation,
          signal,
          ...callbacks,
        });
        subagentId = spawned.id;
        record = spawned.record;
      } catch (error) {
        clearInterval(spinnerInterval);
        return textResult(error instanceof Error ? error.message : String(error));
      }

      clearInterval(spinnerInterval);
      if (subagentId) {
        agentActivity.delete(subagentId);
        widget.markFinished(subagentId);
        fleet.onAgentFinished(subagentId);
      }

      const details = buildDetails(detailBase, record, activityState, { tokens: formatLifetimeTokens(activityState) });
      if (record.status === 'error') {
        return textResult(`Subagent failed: ${record.error}`, details);
      }
      if (record.status === 'stopped') {
        return textResult(`Subagent stopped.\n\n${record.result?.trim() || 'No output.'}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const stats = [`${record.toolUses} tool uses`];
      const tokenText = formatLifetimeTokens(activityState);
      if (tokenText) stats.push(tokenText);
      return textResult(
        `Subagent completed in ${formatMs(durationMs)} (${stats.join(', ')}).\n\n${record.result?.trim() || 'No output.'}`,
        details,
      );
    },
  }));

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.WAIT_RESULT,
    label: 'Wait Subagent',
    description: 'Check a background subagent status and optionally wait for its result. Use the subagent ID returned by the subagent tool with run_in_background.',
    promptSnippet: 'Wait for or retrieve a background subagent result',
    promptGuidelines: [
      'Use wait_subagent only for subagents already started with run_in_background. Do not poll repeatedly; pass wait: true when you need the final result.',
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'The subagent ID returned by subagent with run_in_background.',
      }),
      wait: Type.Optional(Type.Boolean({
        description: 'If true, wait until the subagent completes before returning. Default false returns current status immediately.',
      })),
      verbose: Type.Optional(Type.Boolean({
        description: 'If true, include the subagent conversation transcript when available.',
      })),
    }),
    execute: async (_toolCallId, params) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Subagent not found: ${params.agent_id}. It may have been cleaned up.`);

      if (params.wait && record.status === 'running' && record.promise) {
        await record.promise;
      }

      if (record.status !== 'running') record.resultConsumed = true;
      return textResult(formatRecordResult(record, params.verbose === true));
    },
  }));
}
