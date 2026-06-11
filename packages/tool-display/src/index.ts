import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { structuredPatch } from 'diff';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
const GET_REVIEW_DIFFS = Symbol.for('pi-better-ux.tool-display.get-review-diffs');

type ThemeLike = { fg(color: string, text: string): string };

type DiffRow = {
  oldNumber?: number;
  newNumber?: number;
  left: string;
  right: string;
  kind: 'change' | 'context' | 'file';
};

type ReviewFileDiff = {
  path: string;
  rows: DiffRow[];
};

type FileSnapshot = {
  paths: string[];
  before: Map<string, string | null>;
};

type PatchedToolExecutionPrototype = ToolExecutionInstance & {
  render: ToolRender;
  [ORIGINAL_RENDER]?: ToolRender;
  [SHOULD_HIDE]?: () => boolean;
  [GET_THEME]?: () => ThemeLike | undefined;
  [GET_REVIEW_DIFFS]?: (toolCallId: string) => ReviewFileDiff[] | undefined;
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

function displayPath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return shortenPath(path);
}

function resolveFilePath(rawPath: string, cwd: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
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

function formatPatchSummary(patchText: string, cwd?: string): string {
  const stats = patchStats(patchText);
  const file = stats.files[0] ? displayPath(stats.files[0], cwd) : 'patch';
  return `${file} +${stats.additions}/-${stats.removals}`;
}

function formatArgs(toolName: string, args: Record<string, unknown> | undefined, cwd?: string): string {
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
    const summary = formatPatchSummary(patchText, cwd);
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'edit') {
    const pathVal = firstString(args.path, args.file_path);
    const editCount = Array.isArray(args.edits) ? ` · ${args.edits.length} edit(s)` : '';
    return `${displayPath(pathVal, cwd)}${editCount}`;
  }
  if (name === 'write') {
    const pathVal = firstString(args.path, args.file_path);
    const content = typeof args.content === 'string' ? ` · ${args.content.split('\n').length} lines` : '';
    return `${displayPath(pathVal, cwd)}${content}`;
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

function parsePatchPaths(patchText: string, cwd: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (fileMatch?.[1]) paths.add(resolveFilePath(fileMatch[1], cwd));
  }
  return [...paths];
}

function mutationPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  const name = baseToolName(toolName);
  if (name === 'edit' || name === 'write') {
    const rawPath = firstString(input.path, input.file_path);
    return rawPath ? [resolveFilePath(rawPath, cwd)] : [];
  }
  if (name === 'apply_patch') {
    const patchText = firstString(input.input, input.patch, input.diff);
    return patchText ? parsePatchPaths(patchText, cwd) : [];
  }
  return [];
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function buildDiffRows(diffText: string): DiffRow[] {
  const diffLines = diffText.split('\n');
  const parsed = diffLines.map((line) => {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (fileMatch?.[1]) return { kind: 'file' as const, text: fileMatch[1] };
    if (line.startsWith('*** ') || line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')) {
      return { kind: 'skip' as const, text: '' };
    }
    if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'remove' as const, text: stripDiffContent(line, '-') };
    if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'add' as const, text: stripDiffContent(line, '+') };
    if (line.startsWith(' ')) return { kind: 'context' as const, text: stripDiffContent(line, ' ') };
    return { kind: 'skip' as const, text: '' };
  });

  const rows: DiffRow[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i]!;
    if (current.kind === 'skip') continue;
    if (current.kind === 'file') {
      rows.push({ left: current.text, right: '', kind: 'file' });
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

function buildReviewRows(oldText: string, newText: string): DiffRow[] {
  const patch = structuredPatch('', '', oldText, newText, '', '', { context: 3 });
  const rows: DiffRow[] = [];

  for (const hunk of patch.hunks) {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]!;
      if (line.startsWith('\\')) continue;
      if (line.startsWith(' ')) {
        rows.push({ oldNumber, newNumber, left: line.slice(1), right: line.slice(1), kind: 'context' });
        oldNumber++;
        newNumber++;
        continue;
      }
      if (!line.startsWith('-')) {
        rows.push({ newNumber, left: '', right: line.slice(1), kind: 'change' });
        newNumber++;
        continue;
      }

      const removed: Array<{ number: number; text: string }> = [];
      while (i < hunk.lines.length && hunk.lines[i]?.startsWith('-')) {
        removed.push({ number: oldNumber, text: hunk.lines[i]!.slice(1) });
        oldNumber++;
        i++;
      }
      const added: Array<{ number: number; text: string }> = [];
      while (i < hunk.lines.length && hunk.lines[i]?.startsWith('+')) {
        added.push({ number: newNumber, text: hunk.lines[i]!.slice(1) });
        newNumber++;
        i++;
      }
      i--;

      const pairCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        rows.push({
          oldNumber: removed[pairIndex]?.number,
          newNumber: added[pairIndex]?.number,
          left: removed[pairIndex]?.text ?? '',
          right: added[pairIndex]?.text ?? '',
          kind: 'change',
        });
      }
    }
  }

  return rows;
}

function renderReviewDiff(title: string, files: ReviewFileDiff[], width: number, t: ThemeLike, cwd?: string): string[] {
  const maxLine = Math.max(1, ...files.flatMap((file) => file.rows.flatMap((row) => [row.oldNumber ?? 0, row.newNumber ?? 0])));
  const gutterWidth = Math.max(3, String(maxLine).length);
  const columnWidth = Math.max(8, Math.floor((width - 11 - gutterWidth * 2) / 2));
  const fullWidthText = Math.max(1, width - 2);
  const lines = [`  ${t.fg('toolTitle', truncateToWidth(title, fullWidthText, '…'))}`];

  for (const file of files) {
    if (file.path) {
      lines.push(`  ${t.fg('muted', `── ${truncateToWidth(displayPath(file.path, cwd), fullWidthText - 3, '…')}`)}`);
    }
    for (const row of file.rows) {
      const oldNo = String(row.oldNumber ?? '').padStart(gutterWidth);
      const newNo = String(row.newNumber ?? '').padStart(gutterWidth);
      const left = fitCell(row.left, columnWidth);
      const right = fitCell(row.right, columnWidth);
      if (row.kind === 'context') {
        lines.push(`  ${t.fg('muted', `${oldNo} │ ${left} │ ${newNo} │ ${right}`)}`);
        continue;
      }
      if (row.kind === 'file') {
        lines.push(`  ${t.fg('muted', `── ${truncateToWidth(displayPath(row.left, cwd), fullWidthText - 3, '…')}`)}`);
        continue;
      }
      lines.push(`  ${t.fg('error', `${oldNo}−│ ${left}`)} │ ${t.fg('success', `${newNo}+│ ${right}`)}`);
    }
  }

  return ['', ...lines.map((line) => truncateToWidth(line, width, '…'))];
}

function renderSideBySideDiff(title: string, diffText: string, width: number, t: ThemeLike, cwd?: string): string[] {
  return renderReviewDiff(title, [{ path: '', rows: buildDiffRows(diffText) }], width, t, cwd);
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
  const pathSummary = formatArgs(toolName, instance.args, instance.cwd);
  const titleStatus = instance.result?.isError ? '✗' : instance.result || instance.isPartial === false ? '✔' : '⏺';
  const title = `${titleStatus} ${TOOL_ICONS[toolName] ?? '⚙'} ${toolName}${pathSummary ? ` · ${pathSummary}` : ''}`;

  if (toolName === 'apply_patch') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd);
    const patchText = firstString(instance.args?.input, instance.args?.patch, instance.args?.diff);
    if (patchText) return renderSideBySideDiff(title, patchText, width, t, instance.cwd);
  }
  if (toolName === 'edit') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd);
    const diffText = typeof instance.result?.details?.diff === 'string' ? instance.result.details.diff : editDiffFromArgs(instance.args);
    if (diffText) return renderSideBySideDiff(title, diffText, width, t, instance.cwd);
  }
  if (toolName === 'write') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd);
  }

  if (!instance.expanded) {
    instance.expanded = true;
    instance.updateDisplay?.();
  }
  return originalRender.call(instance, width);
}

function prototypeReviewDiffs(toolCallId: string | undefined): ReviewFileDiff[] | undefined {
  if (!toolCallId) return undefined;
  const prototype = ToolExecutionComponent.prototype as PatchedToolExecutionPrototype;
  return prototype[GET_REVIEW_DIFFS]?.(toolCallId);
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

function installToolRenderPatch(
  isHidden: () => boolean,
  getTheme: () => ThemeLike | undefined,
  getReviewDiffs: (toolCallId: string) => ReviewFileDiff[] | undefined,
) {
  const prototype = ToolExecutionComponent.prototype as PatchedToolExecutionPrototype;
  prototype[SHOULD_HIDE] = isHidden;
  prototype[GET_THEME] = getTheme;
  prototype[GET_REVIEW_DIFFS] = getReviewDiffs;

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

async function captureSnapshot(toolName: string, toolCallId: string, input: Record<string, unknown>, ctx: ExtensionContext) {
  const paths = mutationPaths(toolName, input, ctx.cwd);
  if (paths.length === 0) return null;

  const before = new Map<string, string | null>();
  for (const filePath of paths) {
    before.set(filePath, await readTextFileIfExists(filePath));
  }
  return { toolCallId, snapshot: { paths, before } };
}

async function buildReviewDiffs(snapshot: FileSnapshot): Promise<ReviewFileDiff[]> {
  const files: ReviewFileDiff[] = [];
  for (const filePath of snapshot.paths) {
    const oldText = snapshot.before.get(filePath) ?? '';
    const newText = (await readTextFileIfExists(filePath)) ?? '';
    if (oldText === newText) continue;
    const rows = buildReviewRows(oldText, newText);
    if (rows.length > 0) files.push({ path: filePath, rows });
  }
  return files;
}

export default function toolDisplay(pi: ExtensionAPI) {
  let hideCollapsedTools = false;
  let currentTheme: ThemeLike | undefined;
  const activeToolCalls = new Set<string>();
  const snapshots = new Map<string, FileSnapshot>();
  const reviewDiffs = new Map<string, ReviewFileDiff[]>();

  installToolRenderPatch(
    () => hideCollapsedTools,
    () => currentTheme,
    (toolCallId) => reviewDiffs.get(toolCallId),
  );

  pi.on('tool_call', async (event, ctx) => {
    const toolName = baseToolName(event.toolName);
    if (!FILE_MUTATION_TOOLS.has(toolName)) return;

    try {
      const captured = await captureSnapshot(toolName, event.toolCallId, event.input, ctx);
      if (captured) snapshots.set(captured.toolCallId, captured.snapshot);
    } catch (error) {
      ctx.ui.notify(`Tool display snapshot failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  });

  pi.on('tool_execution_start', (event, ctx) => {
    currentTheme = ctx.ui.theme;
    activeToolCalls.add(event.toolCallId);
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    currentTheme = ctx.ui.theme;
    activeToolCalls.delete(event.toolCallId);
    const snapshot = snapshots.get(event.toolCallId);
    if (snapshot) {
      try {
        const files = await buildReviewDiffs(snapshot);
        if (files.length > 0) reviewDiffs.set(event.toolCallId, files);
      } catch (error) {
        ctx.ui.notify(`Tool display diff failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
      snapshots.delete(event.toolCallId);
    }
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
