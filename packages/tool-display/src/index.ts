import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';

type ToolExecutionInstance = InstanceType<typeof ToolExecutionComponent> & {
  expanded?: boolean;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { isError: boolean };
  isPartial?: boolean;
};

type ToolRender = (this: ToolExecutionInstance, width: number) => string[];

const ORIGINAL_RENDER = Symbol.for('pi-better-ux.tool-display.original-render');
const SHOULD_HIDE = Symbol.for('pi-better-ux.tool-display.should-hide');
const GET_THEME = Symbol.for('pi-better-ux.tool-display.get-theme');

type ThemeLike = { fg(color: string, text: string): string };

type PatchedToolExecutionPrototype = ToolExecutionInstance & {
  render: ToolRender;
  [ORIGINAL_RENDER]?: ToolRender;
  [SHOULD_HIDE]?: () => boolean;
  [GET_THEME]?: () => ThemeLike | undefined;
};

const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  read: '◉',
  edit: '✎',
  write: '✦',
  find: '⌕',
  grep: '⌕',
  ls: '▤',
};

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatArgs(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  if (toolName === 'bash') {
    const cmd = String(args.command ?? '');
    const line = cmd.split('\n')[0]!;
    return line.length > 60 ? `${line.slice(0, 57)}...` : line;
  }
  const pathVal = args.path ?? args.file_path ?? args.command ?? '';
  if (!pathVal) return '';
  const s = shortenPath(String(pathVal));
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function renderInlineSummary(instance: ToolExecutionInstance, t: ThemeLike): string {
  const toolName = instance.toolName ?? '?';
  const icon = TOOL_ICONS[toolName] ?? '⚙';
  const argStr = formatArgs(toolName, instance.args);
  const arg = argStr ? `  ${t.fg('muted', argStr)}` : '';

  if (!instance.result && instance.isPartial !== false) {
    return `  ${t.fg('toolTitle', `⏺ ${icon} ${toolName}`)}${arg}`;
  }
  if (instance.result?.isError) {
    return `  ${t.fg('error', `✗ ${icon} ${toolName}`)}${arg}`;
  }
  return `  ${t.fg('success', `✔ ${icon} ${toolName}`)}${arg}`;
}

function installToolRenderPatch(isHidden: () => boolean, getTheme: () => ThemeLike | undefined) {
  const prototype = ToolExecutionComponent.prototype as PatchedToolExecutionPrototype;
  prototype[SHOULD_HIDE] = isHidden;
  prototype[GET_THEME] = getTheme;

  if (prototype[ORIGINAL_RENDER]) return;

  const originalRender = prototype.render;
  prototype[ORIGINAL_RENDER] = originalRender;
  prototype.render = function renderToolExecution(width: number): string[] {
    if (this.expanded) return originalRender.call(this, width);
    if (prototype[SHOULD_HIDE]?.()) return [];
    const t = prototype[GET_THEME]?.();
    if (!t) return originalRender.call(this, width);
    return ['', renderInlineSummary(this, t)];
  };
}

function updateWorkingMessage(ctx: ExtensionContext, activeToolCalls: Set<string>) {
  if (activeToolCalls.size === 0) {
    ctx.ui.setWorkingMessage();
    return;
  }
  const suffix = activeToolCalls.size === 1 ? 'tool' : 'tools';
  ctx.ui.setWorkingMessage(`Working · ${activeToolCalls.size} ${suffix}`);
}

export default function toolDisplay(pi: ExtensionAPI) {
  let hideCollapsedTools = false;
  let currentTheme: ThemeLike | undefined;
  const activeToolCalls = new Set<string>();

  installToolRenderPatch(
    () => hideCollapsedTools,
    () => currentTheme,
  );

  pi.on('tool_execution_start', (event, ctx) => {
    currentTheme = ctx.ui.theme;
    activeToolCalls.add(event.toolCallId);
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    currentTheme = ctx.ui.theme;
    activeToolCalls.delete(event.toolCallId);
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('agent_end', (_event, ctx) => {
    currentTheme = ctx.ui.theme;
    activeToolCalls.clear();
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.registerCommand('tool-display', {
    description: 'Control tool rendering: on (inline summary), off (hidden), expand, collapse, status',
    handler: async (args, ctx) => {
      currentTheme = ctx.ui.theme;
      const action = args.trim();

      if (action === 'on') {
        hideCollapsedTools = false;
        ctx.ui.notify('Tool display: inline summary mode.', 'info');
        return;
      }
      if (action === 'off') {
        hideCollapsedTools = true;
        ctx.ui.notify('Tool display: hidden mode.', 'info');
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
        const mode = hideCollapsedTools ? 'hidden' : 'inline';
        const expanded = ctx.ui.getToolsExpanded() ? 'expanded' : 'collapsed';
        ctx.ui.notify(`Tool display: ${mode}, ${expanded}. Usage: /tool-display on|off|expand|collapse`, 'info');
        return;
      }

      ctx.ui.notify(`Unknown action: ${action}`, 'error');
    },
  });
}
