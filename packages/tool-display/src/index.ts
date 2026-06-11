import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import * as os from 'node:os';

type ToolExecutionInstance = InstanceType<typeof ToolExecutionComponent> & {
  expanded?: boolean;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { isError: boolean; details?: Record<string, unknown> };
  isPartial?: boolean;
  updateDisplay?: () => void;
};

type ToolRender = (this: ToolExecutionInstance, width: number) => string[];

const ORIGINAL_RENDER = Symbol.for('pi-better-ux.tool-display.original-render');
const SHOULD_HIDE = Symbol.for('pi-better-ux.tool-display.should-hide');
const GET_THEME = Symbol.for('pi-better-ux.tool-display.get-theme');

type ThemeLike = { fg(color: string, text: string): string };

type DiffRow = {
  left: string;
  right: string;
  kind: 'change' | 'context' | 'header';
};

type PatchedToolExecutionPrototype = ToolExecutionInstance & {
  render: ToolRender;
  [ORIGINAL_RENDER]?: ToolRender;
  [SHOULD_HIDE]?: () => boolean;
  [GET_THEME]?: () => ThemeLike | undefined;
};

const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  exec_command: '$',
  read: '◉',
  edit: '✎',
  write: '✦',
  apply_patch: 'Δ',
  find: '⌕',
  grep: '⌕',
  ls: '▤',
};

const FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'apply_patch']);

function baseToolName(toolName: string): string {
  return toolName.split('.').pop() ?? toolName;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function fitCell(text: string, width: number): string {
  const normalized = text.replace(/\t/g, '   ');
  return truncateToWidth(normalized, width, '…', true);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function patchStats(patchText: string): { files: string[]; additions: number; removals: number } {
  const files: string[] = [];
  let additions = 0;
  let removals = 0;

  for (const line of patchText.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (fileMatch?.[1]) files.push(fileMatch[1]);
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) removals++;
  }

  return { files, additions, removals };
}

function formatPatchSummary(patchText: string): string {
  const stats = patchStats(patchText);
  const file = stats.files[0] ? shortenPath(stats.files[0]) : 'patch';
  return `${file} +${stats.additions}/-${stats.removals}`;
}

function formatArgs(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';

  const name = baseToolName(toolName);
  if (name === 'bash' || name === 'exec_command') {
    const cmd = firstString(args.command, args.cmd);
    const line = cmd.split('\n')[0]!;
    const workdir = typeof args.workdir === 'string' ? ` @ ${shortenPath(args.workdir)}` : '';
    const summary = `${line}${workdir}`;
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'apply_patch') {
    const patchText = firstString(args.input, args.patch, args.diff);
    if (!patchText) return '';
    const summary = formatPatchSummary(patchText);
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'edit') {
    const pathVal = firstString(args.path, args.file_path);
    const editCount = Array.isArray(args.edits) ? ` · ${args.edits.length} edit(s)` : '';
    return `${shortenPath(pathVal)}${editCount}`;
  }
  if (name === 'write') {
    const pathVal = firstString(args.path, args.file_path);
    const content = typeof args.content === 'string' ? ` · ${args.content.split('\n').length} lines` : '';
    return `${shortenPath(pathVal)}${content}`;
  }
  if (name === 'grep') {
    const pattern = firstString(args.pattern, args.query);
    const pathVal = firstString(args.path, args.include);
    const summary = pathVal ? `${pattern} in ${shortenPath(pathVal)}` : pattern;
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'parallel' && Array.isArray(args.tool_uses)) {
    const names = args.tool_uses
      .map((toolUse) => typeof toolUse === 'object' && toolUse ? String((toolUse as Record<string, unknown>).recipient_name ?? '') : '')
      .filter(Boolean)
      .map(baseToolName)
      .join(', ');
    return `${args.tool_uses.length} tools: ${names}`;
  }
  const pathVal = args.path ?? args.file_path ?? args.command ?? '';
  if (!pathVal) return '';
  const s = shortenPath(String(pathVal));
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function stripDiffContent(line: string, prefix: string): string {
  const numberedMatch = line.match(new RegExp(`^\\${prefix}\\s*\\d+\\s(.*)$`));
  if (numberedMatch?.[1] !== undefined) return numberedMatch[1];
  return line.slice(1);
}

function buildDiffRows(diffText: string): DiffRow[] {
  const diffLines = diffText.split('\n');
  const parsed = diffLines.map((line) => {
    if (
      line.startsWith('*** ') ||
      line.startsWith('@@') ||
      line.startsWith('diff --git') ||
      line.startsWith('index ')
    ) {
      return { kind: 'header' as const, text: line };
    }
    if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'remove' as const, text: stripDiffContent(line, '-') };
    if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'add' as const, text: stripDiffContent(line, '+') };
    if (line.startsWith(' ')) return { kind: 'context' as const, text: stripDiffContent(line, ' ') };
    return { kind: 'header' as const, text: line };
  });

  const rows: DiffRow[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i]!;
    if (current.kind === 'header') {
      if (current.text) rows.push({ left: current.text, right: '', kind: 'header' });
      continue;
    }
    if (current.kind === 'context') {
      rows.push({ left: current.text, right: current.text, kind: 'context' });
      continue;
    }
    if (current.kind !== 'remove') {
      rows.push({ left: '', right: current.text, kind: 'change' });
      continue;
    }

    const removed: string[] = [];
    while (i < parsed.length && parsed[i]?.kind === 'remove') {
      removed.push(parsed[i]!.text);
      i++;
    }
    const added: string[] = [];
    while (i < parsed.length && parsed[i]?.kind === 'add') {
      added.push(parsed[i]!.text);
      i++;
    }
    i--;

    const pairCount = Math.max(removed.length, added.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
      rows.push({ left: removed[pairIndex] ?? '', right: added[pairIndex] ?? '', kind: 'change' });
    }
  }
  return rows;
}

function renderSideBySideDiff(title: string, diffText: string, width: number, t: ThemeLike): string[] {
  const columnWidth = Math.max(8, Math.floor((width - 9) / 2));
  const fullWidthText = Math.max(1, width - 2);
  const lines = [`  ${t.fg('toolTitle', fitCell(title, fullWidthText).trimEnd())}`];

  for (const row of buildDiffRows(diffText)) {
    if (row.kind === 'header') {
      lines.push(`  ${t.fg('muted', fitCell(row.left, fullWidthText).trimEnd())}`);
      continue;
    }
    const left = fitCell(row.left, columnWidth);
    const right = fitCell(row.right, columnWidth);
    if (row.kind === 'context') {
      lines.push(`  ${t.fg('muted', `  ${left} │  ${right}`)}`);
      continue;
    }
    lines.push(`  ${t.fg('error', `- ${left}`)} │ ${t.fg('success', `+ ${right}`)}`);
  }

  return ['', ...lines];
}

function editDiffFromArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  if (Array.isArray(args.edits)) {
    return args.edits
      .map((edit) => {
        if (!edit || typeof edit !== 'object') return '';
        const oldText = (edit as Record<string, unknown>).oldText;
        const newText = (edit as Record<string, unknown>).newText;
        if (typeof oldText !== 'string' || typeof newText !== 'string') return '';
        return `${oldText.split('\n').map((line) => `-${line}`).join('\n')}\n${newText.split('\n').map((line) => `+${line}`).join('\n')}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return `${args.oldText.split('\n').map((line) => `-${line}`).join('\n')}\n${args.newText.split('\n').map((line) => `+${line}`).join('\n')}`;
  }
  return '';
}

function renderMutationTool(instance: ToolExecutionInstance, width: number, t: ThemeLike, originalRender: ToolRender): string[] {
  const toolName = baseToolName(instance.toolName ?? '?');
  const pathSummary = formatArgs(toolName, instance.args);
  const titleStatus = instance.result?.isError ? '✗' : instance.result || instance.isPartial === false ? '✔' : '⏺';
  const title = `${titleStatus} ${TOOL_ICONS[toolName] ?? '⚙'} ${toolName}${pathSummary ? `  ${pathSummary}` : ''}`;

  if (toolName === 'apply_patch') {
    const patchText = firstString(instance.args?.input, instance.args?.patch, instance.args?.diff);
    if (patchText) return renderSideBySideDiff(title, patchText, width, t);
  }
  if (toolName === 'edit') {
    const diffText = typeof instance.result?.details?.diff === 'string' ? instance.result.details.diff : editDiffFromArgs(instance.args);
    if (diffText) return renderSideBySideDiff(title, diffText, width, t);
  }

  if (!instance.expanded) {
    instance.expanded = true;
    instance.updateDisplay?.();
  }
  return originalRender.call(instance, width);
}

function renderInlineSummary(instance: ToolExecutionInstance, t: ThemeLike): string {
  const toolName = baseToolName(instance.toolName ?? '?');
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
    const toolName = baseToolName(this.toolName ?? '');
    const t = prototype[GET_THEME]?.();
    if (t && FILE_MUTATION_TOOLS.has(toolName)) return renderMutationTool(this, width, t, originalRender);
    if (this.expanded) return originalRender.call(this, width);
    if (prototype[SHOULD_HIDE]?.()) return [];
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
