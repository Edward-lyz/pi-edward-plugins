import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolDefinition,
  ToolRenderContext,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  keyHint,
} from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstCommandLine(command: string | undefined): string {
  if (!command) return '…';
  return command.split('\n').find((line) => line.trim() !== '')?.trim() ?? '…';
}

function summarizeToolCall(toolName: string, args: unknown): string {
  const input = objectValue(args);

  if (toolName === 'bash') {
    const command = firstCommandLine(stringValue(input.command));
    const timeout = numberValue(input.timeout);
    return timeout === undefined ? `$ ${command}` : `$ ${command} · ${timeout}s`;
  }

  if (toolName === 'read') {
    const path = stringValue(input.path) ?? '…';
    const offset = numberValue(input.offset);
    const limit = numberValue(input.limit);
    const range = offset === undefined && limit === undefined
      ? ''
      : ` · ${offset ?? 1}:${limit ?? 'end'}`;
    return `read ${path}${range}`;
  }

  if (toolName === 'edit') {
    const path = stringValue(input.path) ?? '…';
    const edits = Array.isArray(input.edits) ? input.edits.length : 0;
    return `edit ${path} · ${edits} block${edits === 1 ? '' : 's'}`;
  }

  if (toolName === 'write') {
    const path = stringValue(input.path) ?? '…';
    const content = stringValue(input.content);
    const lineCount = content === undefined ? undefined : content.split('\n').length;
    return lineCount === undefined ? `write ${path}` : `write ${path} · ${lineCount} lines`;
  }

  if (toolName === 'grep') {
    const pattern = stringValue(input.pattern) ?? '…';
    const path = stringValue(input.path) ?? '.';
    const glob = stringValue(input.glob);
    return glob === undefined ? `grep ${pattern} in ${path}` : `grep ${pattern} in ${path} · ${glob}`;
  }

  if (toolName === 'find') {
    return `find ${stringValue(input.pattern) ?? '…'} in ${stringValue(input.path) ?? '.'}`;
  }

  if (toolName === 'ls') {
    return `ls ${stringValue(input.path) ?? '.'}`;
  }

  return toolName;
}

function compactCallText(toolName: string, args: unknown, theme: Theme, context: ToolRenderContext): string {
  const icon = context.isPartial ? '↻' : context.isError ? '✗' : '✓';
  const iconColor = context.isPartial ? 'muted' : context.isError ? 'error' : 'success';
  const title = theme.fg(iconColor, icon) + ' ' + theme.fg('toolTitle', theme.bold(toolName));
  const summary = theme.fg('muted', summarizeToolCall(toolName, args));
  const hint = context.expanded ? '' : theme.fg('dim', ` (${keyHint('app.tools.expand', 'details')})`);
  return `${title} ${summary}${hint}`;
}

function registerCompactRenderer(pi: ExtensionAPI, definition: ToolDefinition, isCompactEnabled: () => boolean) {
  pi.registerTool({
    ...definition,
    renderCall(args: unknown, theme: Theme, context: ToolRenderContext) {
      if ((!isCompactEnabled() || context.expanded) && definition.renderCall) {
        return definition.renderCall(args, theme, { ...context, lastComponent: undefined });
      }

      return new Text(compactCallText(definition.name, args, theme, context), 0, 0);
    },
    renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) {
      if (!isCompactEnabled() || options.expanded) {
        if (definition.renderResult) {
          return definition.renderResult(result, options, theme, { ...context, lastComponent: undefined });
        }

        return new Text(JSON.stringify(result, null, 2), 0, 0);
      }

      return new Container();
    },
  } as ToolDefinition);
}

export default function toolDisplay(pi: ExtensionAPI) {
  let compactEnabled = true;

  pi.on('session_start', (_event, ctx) => {
    const definitions = [
      createBashToolDefinition(ctx.cwd),
      createReadToolDefinition(ctx.cwd),
      createEditToolDefinition(ctx.cwd),
      createWriteToolDefinition(ctx.cwd),
      createGrepToolDefinition(ctx.cwd),
      createFindToolDefinition(ctx.cwd),
      createLsToolDefinition(ctx.cwd),
    ];

    for (const definition of definitions) {
      registerCompactRenderer(pi, definition as ToolDefinition, () => compactEnabled);
    }
  });

  pi.registerCommand('tool-display', {
    description: 'Control compact tool rendering: on, off, expand, collapse, status',
    handler: async (args, ctx) => {
      const action = args.trim();

      if (action === 'on') {
        compactEnabled = true;
        ctx.ui.notify('Tool display compact mode enabled.', 'info');
        return;
      }

      if (action === 'off') {
        compactEnabled = false;
        ctx.ui.notify('Tool display compact mode disabled.', 'info');
        return;
      }

      if (action === 'expand') {
        ctx.ui.setToolsExpanded(true);
        return;
      }

      if (action === 'collapse') {
        ctx.ui.setToolsExpanded(false);
        return;
      }

      if (action === '' || action === 'status') {
        const mode = compactEnabled ? 'on' : 'off';
        const expanded = ctx.ui.getToolsExpanded() ? 'expanded' : 'collapsed';
        const help = 'Usage: /tool-display on|off|expand|collapse|status';
        ctx.ui.notify(`Tool display: ${mode}, ${expanded}. ${help}`, 'info');
        return;
      }

      ctx.ui.notify(`Unknown tool-display action: ${action}`, 'error');
    },
  });
}
