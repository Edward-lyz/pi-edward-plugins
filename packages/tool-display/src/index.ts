import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { structuredPatch } from 'diff';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type ToolExecutionInstance = {
  expanded?: boolean;
  toolName?: string;
  toolCallId?: string;
  cwd?: string;
  args?: Record<string, unknown>;
  result?: {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError: boolean;
    details?: Record<string, unknown>;
  };
  isPartial?: boolean;
  updateDisplay?: () => void;
};

type ToolRender = (this: ToolExecutionInstance, width: number) => string[];

const ORIGINAL_RENDER = Symbol.for('pi-better-ux.tool-display.original-render');
const SHOULD_HIDE = Symbol.for('pi-better-ux.tool-display.should-hide');
const GET_THEME = Symbol.for('pi-better-ux.tool-display.get-theme');
const GET_REVIEW_DIFFS = Symbol.for('pi-better-ux.tool-display.get-review-diffs');
const GET_READ_GROUP = Symbol.for('pi-better-ux.tool-display.get-read-group');

type ThemeLike = { fg(color: string, text: string): string };

type PatchFileOp = {
  operation: 'Update' | 'Add' | 'Delete';
  path: string;
};

type DiffRow = {
  oldNumber?: number;
  newNumber?: number;
  text: string;
  kind: 'add' | 'delete' | 'context' | 'file';
};

type ReviewFileDiff = {
  path: string;
  rows: DiffRow[];
};

type FileSnapshot = {
  paths: string[];
  before: Map<string, string | null>;
};

type ReadGroup = {
  leadToolCallId: string;
  toolCallIds: string[];
  paths: string[];
  completed: Set<string>;
  failed: Set<string>;
};

type PatchedToolExecutionPrototype = ToolExecutionInstance & {
  render: ToolRender;
  [ORIGINAL_RENDER]?: ToolRender;
  [SHOULD_HIDE]?: () => boolean;
  [GET_THEME]?: () => ThemeLike | undefined;
  [GET_REVIEW_DIFFS]?: (toolCallId: string) => ReviewFileDiff[] | undefined;
  [GET_READ_GROUP]?: (toolCallId: string) => ReadGroup | undefined;
};

const FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'apply_patch']);
const BASH_PREVIEW_LINES = 5;

function baseToolName(toolName: string): string {
  const name = toolName.split('.').pop() ?? toolName;
  if (name === 'read_file') return 'read';
  if (name === 'write_file') return 'write';
  if (name === 'shell') return 'bash';
  return name;
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

function fitRenderedLine(line: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (visibleWidth(line) <= safeWidth) return line;
  return truncateToWidth(line, safeWidth, '…');
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function patchStats(patchText: string): {
  fileOps: PatchFileOp[];
  files: string[];
  additions: number;
  removals: number;
} {
  const fileOps: PatchFileOp[] = [];
  let additions = 0;
  let removals = 0;

  for (const line of patchText.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch?.[1] && fileMatch[2]) fileOps.push({ operation: fileMatch[1] as PatchFileOp['operation'], path: fileMatch[2] });
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) removals++;
  }

  return { fileOps, files: fileOps.map((file) => file.path), additions, removals };
}

function formatPatchSummary(patchText: string, cwd?: string): string {
  const stats = patchStats(patchText);
  const file = stats.files[0] ? displayPath(stats.files[0], cwd) : 'patch';
  return `${file} +${stats.additions}/-${stats.removals}`;
}

function displayToolName(toolName: string): string {
  if (toolName === 'exec_command') return 'Bash';
  if (toolName === 'apply_patch') return 'Patch';
  return `${toolName.slice(0, 1).toUpperCase()}${toolName.slice(1)}`;
}

function lineRangeSuffix(args: Record<string, unknown>): string {
  const offset = typeof args.offset === 'number' ? args.offset : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return '';
  const startLine = offset ?? 1;
  const endLine = limit === undefined ? '' : startLine + limit - 1;
  return `:${startLine}${endLine}`;
}

function formatArgs(toolName: string, args: Record<string, unknown> | undefined, cwd?: string): string {
  if (!args) return '';

  const name = baseToolName(toolName);
  if (name === 'bash' || name === 'exec_command') {
    const cmd = firstString(args.command, args.cmd);
    const line = cmd.split('\n')[0]!;
    const rawWorkdir = firstString(args.workdir, args.cwd);
    const workdir = rawWorkdir ? ` @ ${shortenPath(rawWorkdir)}` : '';
    const summary = `${line}${workdir}`;
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'read') {
    const pathVal = firstString(args.path, args.file_path, args.filePath);
    return `${displayPath(pathVal, cwd)}${lineRangeSuffix(args)}`;
  }
  if (name === 'apply_patch') {
    const patchText = firstString(args.input, args.patch, args.diff);
    if (!patchText) return '';
    const summary = formatPatchSummary(patchText, cwd);
    return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  }
  if (name === 'edit') {
    const pathVal = firstString(args.path, args.file_path, args.filePath);
    const editCount = Array.isArray(args.edits) ? ` · ${args.edits.length} edit(s)` : '';
    return `${displayPath(pathVal, cwd)}${editCount}`;
  }
  if (name === 'write') {
    const pathVal = firstString(args.path, args.file_path, args.filePath);
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
    const rawPath = firstString(input.path, input.file_path, input.filePath);
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
  const rows: DiffRow[] = [];
  let oldNumber: number | undefined;
  let newNumber: number | undefined;

  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (fileMatch?.[1]) {
      rows.push({ kind: 'file', text: fileMatch[1] });
      oldNumber = undefined;
      newNumber = undefined;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch?.[1] && hunkMatch[2]) {
      oldNumber = Number(hunkMatch[1]);
      newNumber = Number(hunkMatch[2]);
      continue;
    }

    if (line.startsWith('*** ') || line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) {
      const rowNumber = oldNumber;
      if (oldNumber !== undefined) oldNumber++;
      rows.push({ oldNumber: rowNumber, kind: 'delete', text: stripDiffContent(line, '-') });
      continue;
    }
    if (line.startsWith('+')) {
      const rowNumber = newNumber;
      if (newNumber !== undefined) newNumber++;
      rows.push({ newNumber: rowNumber, kind: 'add', text: stripDiffContent(line, '+') });
      continue;
    }
    if (line.startsWith(' ')) {
      const oldRowNumber = oldNumber;
      const newRowNumber = newNumber;
      if (oldNumber !== undefined) oldNumber++;
      if (newNumber !== undefined) newNumber++;
      rows.push({ oldNumber: oldRowNumber, newNumber: newRowNumber, kind: 'context', text: stripDiffContent(line, ' ') });
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
        rows.push({ oldNumber, newNumber, kind: 'context', text: line.slice(1) });
        oldNumber++;
        newNumber++;
        continue;
      }
      if (line.startsWith('-')) {
        rows.push({ oldNumber, kind: 'delete', text: line.slice(1) });
        oldNumber++;
        continue;
      }
      if (line.startsWith('+')) {
        rows.push({ newNumber, kind: 'add', text: line.slice(1) });
        newNumber++;
        continue;
      }
    }
  }

  return rows;
}

function reviewChangeStats(files: ReviewFileDiff[]): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const file of files) {
    for (const row of file.rows) {
      if (row.kind === 'delete') removals++;
      if (row.kind === 'add') additions++;
    }
  }
  return { additions, removals };
}

function formatChangeStats(additions: number, removals: number): string {
  const parts: string[] = [];
  if (additions > 0) parts.push(`Added ${additions} line${additions === 1 ? '' : 's'}`);
  if (removals > 0) parts.push(`Removed ${removals} line${removals === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function activityColor(instance: ToolExecutionInstance): string {
  if (instance.result?.isError) return 'error';
  if (!instance.result && instance.isPartial !== false) return 'muted';
  return 'success';
}

function renderActivityLine(title: string, instance: ToolExecutionInstance, width: number, t: ThemeLike): string {
  const color = activityColor(instance);
  const titleColor = color === 'error' ? 'error' : 'toolTitle';
  return fitRenderedLine(`${t.fg(color, '-')} ${t.fg(titleColor, title)}`, width);
}

function textOutput(instance: ToolExecutionInstance): string {
  return (instance.result?.content ?? [])
    .filter((content) => content.type === 'text')
    .map((content) => content.text ?? '')
    .join('\n')
    .replace(/\r/g, '');
}

function renderReviewDiff(
  title: string,
  files: ReviewFileDiff[],
  width: number,
  t: ThemeLike,
  cwd?: string,
  statusColor = 'success',
): string[] {
  if (width <= 0) return [''];
  const safeWidth = width;
  const maxLine = Math.max(1, ...files.flatMap((file) => file.rows.flatMap((row) => [row.oldNumber ?? 0, row.newNumber ?? 0])));
  const gutterWidth = Math.max(3, String(maxLine).length);
  const codeWidth = Math.max(1, safeWidth - 10 - gutterWidth * 2);
  const fullWidthText = Math.max(1, safeWidth - 2);
  const titleColor = statusColor === 'error' ? 'error' : 'toolTitle';
  const lines = [`${t.fg(statusColor, '-')} ${t.fg(titleColor, truncateToWidth(title, fullWidthText, '…'))}`];
  const stats = reviewChangeStats(files);
  const statsLine = formatChangeStats(stats.additions, stats.removals);
  if (statsLine) lines.push(`  ${t.fg('muted', statsLine)}`);

  for (const file of files) {
    if (file.path) {
      lines.push(`  ${t.fg('muted', `└ ${truncateToWidth(displayPath(file.path, cwd), fullWidthText - 3, '…')}`)}`);
    }
    for (const row of file.rows) {
      if (row.kind === 'file') {
        lines.push(`  ${t.fg('muted', `└ ${truncateToWidth(displayPath(row.text, cwd), fullWidthText - 3, '…')}`)}`);
        continue;
      }
      const oldNo = String(row.oldNumber ?? '').padStart(gutterWidth);
      const newNo = String(row.newNumber ?? '').padStart(gutterWidth);
      const marker = row.kind === 'delete' ? '-' : row.kind === 'add' ? '+' : ' ';
      const color = row.kind === 'delete' ? 'error' : row.kind === 'add' ? 'success' : 'muted';
      lines.push(`  ${t.fg(color, `${oldNo} │ ${newNo} │ ${marker} ${fitCell(row.text, codeWidth)}`)}`);
    }
  }

  return ['', ...lines.map((line) => fitRenderedLine(line, safeWidth))];
}

function renderUnifiedDiff(title: string, diffText: string, width: number, t: ThemeLike, cwd?: string, statusColor = 'success'): string[] {
  return renderReviewDiff(title, [{ path: '', rows: buildDiffRows(diffText) }], width, t, cwd, statusColor);
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

function mutationTitle(toolName: string, args: Record<string, unknown> | undefined, cwd?: string): string {
  if (toolName === 'apply_patch') {
    const patchText = firstString(args?.input, args?.patch, args?.diff);
    const stats = patchText ? patchStats(patchText) : undefined;
    if (stats?.fileOps.length === 1) {
      const fileOp = stats.fileOps[0]!;
      return `${fileOp.operation}(${displayPath(fileOp.path, cwd)})`;
    }
    if (stats && stats.fileOps.length > 1) return `Patch(${stats.fileOps.length} files)`;
    return 'Patch';
  }

  const pathVal = firstString(args?.path, args?.file_path, args?.filePath);
  if (toolName === 'edit') return `Update(${displayPath(pathVal, cwd)})`;
  if (toolName === 'write') return `Write(${displayPath(pathVal, cwd)})`;
  const argStr = formatArgs(toolName, args, cwd);
  return argStr ? `${displayToolName(toolName)}(${argStr})` : displayToolName(toolName);
}

function renderMutationTool(instance: ToolExecutionInstance, width: number, t: ThemeLike, originalRender: ToolRender): string[] {
  const toolName = baseToolName(instance.toolName ?? '?');
  const title = mutationTitle(toolName, instance.args, instance.cwd);
  const statusColor = activityColor(instance);

  if (toolName === 'apply_patch') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd, statusColor);
    const patchText = firstString(instance.args?.input, instance.args?.patch, instance.args?.diff);
    if (patchText) return renderUnifiedDiff(title, patchText, width, t, instance.cwd, statusColor);
  }
  if (toolName === 'edit') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd, statusColor);
    const diffText = typeof instance.result?.details?.diff === 'string' ? instance.result.details.diff : editDiffFromArgs(instance.args);
    if (diffText) return renderUnifiedDiff(title, diffText, width, t, instance.cwd, statusColor);
  }
  if (toolName === 'write') {
    const reviewDiffs = prototypeReviewDiffs(instance.toolCallId);
    if (reviewDiffs?.length) return renderReviewDiff(title, reviewDiffs, width, t, instance.cwd, statusColor);
  }

  if (instance.expanded) return originalRender.call(instance, width);
  return ['', renderActivityLine(title, instance, width, t)];
}

function prototypeReviewDiffs(toolCallId: string | undefined): ReviewFileDiff[] | undefined {
  if (!toolCallId) return undefined;
  const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
  return prototype[GET_REVIEW_DIFFS]?.(toolCallId);
}

function prototypeReadGroup(toolCallId: string | undefined): ReadGroup | undefined {
  if (!toolCallId) return undefined;
  const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
  return prototype[GET_READ_GROUP]?.(toolCallId);
}

function renderReadGroup(instance: ToolExecutionInstance, group: ReadGroup, width: number, t: ThemeLike): string[] {
  if (group.leadToolCallId !== instance.toolCallId) return [];
  const uniquePaths = [...new Set(group.paths)];
  const completed = group.completed.size;
  const total = group.toolCallIds.length;
  const failed = group.failed.size;
  const pathText = uniquePaths.length === 1 ? displayPath(uniquePaths[0]!, instance.cwd) : `${uniquePaths.length} files`;
  const progress = completed < total ? ` · ${completed}/${total}` : '';
  const failures = failed > 0 ? ` · ${failed} failed` : '';
  return ['', fitRenderedLine(t.fg('muted', `- Read ${pathText}${progress}${failures} (ctrl+o to expand)`), width)];
}

function renderBashTool(instance: ToolExecutionInstance, width: number, t: ThemeLike): string[] {
  const command = firstString(instance.args?.command, instance.args?.cmd);
  const timeout = typeof instance.args?.timeout === 'number' ? ` · timeout ${instance.args.timeout}s` : '';
  const rawWorkdir = firstString(instance.args?.workdir, instance.args?.cwd);
  const workdir = rawWorkdir ? ` @ ${shortenPath(rawWorkdir)}` : '';
  const oneLineCommand = command.split('\n')[0] ?? '';
  const commandPreview = oneLineCommand ? truncateToWidth(oneLineCommand, Math.max(12, width - 16), '…') : '...';
  const lines = [renderActivityLine(`Bash(${commandPreview}${workdir})${timeout}`, instance, width, t)];
  const commandLines = command.replace(/\r/g, '').split('\n');
  const showCommandBlock = instance.expanded || commandLines.length > 1 || visibleWidth(command) > Math.max(24, width - 8);

  if (command && showCommandBlock) {
    const maxCommandLines = instance.expanded ? commandLines.length : 8;
    lines.push(`  ${t.fg('muted', '```bash')}`);
    for (const line of commandLines.slice(0, maxCommandLines)) {
      lines.push(`  ${t.fg('mdCodeBlock', fitCell(line, Math.max(1, width - 2)))}`);
    }
    if (commandLines.length > maxCommandLines) lines.push(`  ${t.fg('muted', `... ${commandLines.length - maxCommandLines} more lines`)}`);
    lines.push(`  ${t.fg('muted', '```')}`);
  }

  const output = textOutput(instance).trimEnd();
  if (!output) return ['', ...lines.map((line) => fitRenderedLine(line, width))];

  const outputLines = output.split('\n');
  const maxOutputLines = instance.expanded ? outputLines.length : BASH_PREVIEW_LINES;
  const skipped = Math.max(0, outputLines.length - maxOutputLines);
  if (skipped > 0) lines.push(`  ${t.fg('muted', `... ${skipped} earlier lines`)}`);
  for (const line of outputLines.slice(skipped)) {
    lines.push(`  ${t.fg(instance.result?.isError ? 'error' : 'toolOutput', fitCell(line, Math.max(1, width - 2)))}`);
  }

  return ['', ...lines.map((line) => fitRenderedLine(line, width))];
}

function renderInlineSummary(instance: ToolExecutionInstance, t: ThemeLike, width: number): string {
  const toolName = baseToolName(instance.toolName ?? '?');
  const argStr = formatArgs(toolName, instance.args, instance.cwd);
  const title = argStr ? `${displayToolName(toolName)}(${argStr})` : displayToolName(toolName);
  return renderActivityLine(title, instance, width, t);
}

function installToolRenderPatch(
  isHidden: () => boolean,
  getTheme: () => ThemeLike | undefined,
  getReviewDiffs: (toolCallId: string) => ReviewFileDiff[] | undefined,
  getReadGroup: (toolCallId: string) => ReadGroup | undefined,
) {
  const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
  prototype[SHOULD_HIDE] = isHidden;
  prototype[GET_THEME] = getTheme;
  prototype[GET_REVIEW_DIFFS] = getReviewDiffs;
  prototype[GET_READ_GROUP] = getReadGroup;

  if (prototype[ORIGINAL_RENDER]) return;

  const originalRender = prototype.render;
  prototype[ORIGINAL_RENDER] = originalRender;
  prototype.render = function renderToolExecution(width: number): string[] {
    const toolName = baseToolName(this.toolName ?? '');
    const t = prototype[GET_THEME]?.();
    if (t && FILE_MUTATION_TOOLS.has(toolName)) return renderMutationTool(this, width, t, originalRender);
    if (this.expanded) return originalRender.call(this, width);
    if (prototype[SHOULD_HIDE]?.()) return [];
    if (t && toolName === 'read') {
      const readGroup = prototypeReadGroup(this.toolCallId);
      if (readGroup) return renderReadGroup(this, readGroup, width, t);
    }
    if (t && (toolName === 'bash' || toolName === 'exec_command')) return renderBashTool(this, width, t);
    if (!t) return originalRender.call(this, width);
    return ['', renderInlineSummary(this, t, width)];
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
  let currentReadGroup: ReadGroup | undefined;
  const activeToolCalls = new Set<string>();
  const snapshots = new Map<string, FileSnapshot>();
  const reviewDiffs = new Map<string, ReviewFileDiff[]>();
  const readGroups: ReadGroup[] = [];
  const readGroupByToolCallId = new Map<string, ReadGroup>();

  installToolRenderPatch(
    () => hideCollapsedTools,
    () => currentTheme,
    (toolCallId) => reviewDiffs.get(toolCallId),
    (toolCallId) => readGroupByToolCallId.get(toolCallId),
  );

  pi.on('tool_call', async (event, ctx) => {
    const toolName = baseToolName(event.toolName);
    currentTheme = ctx.ui.theme;
    if (toolName === 'read') {
      if (!currentReadGroup) {
        currentReadGroup = {
          leadToolCallId: event.toolCallId,
          toolCallIds: [],
          paths: [],
          completed: new Set(),
          failed: new Set(),
        };
        readGroups.push(currentReadGroup);
        while (readGroups.length > 200) {
          const removedGroup = readGroups.shift()!;
          for (const toolCallId of removedGroup.toolCallIds) readGroupByToolCallId.delete(toolCallId);
        }
      }
      const input = event.input as Record<string, unknown>;
      const rawPath = firstString(input.path, input.file_path, input.filePath);
      currentReadGroup.toolCallIds.push(event.toolCallId);
      currentReadGroup.paths.push(rawPath || 'file');
      readGroupByToolCallId.set(event.toolCallId, currentReadGroup);
      return;
    }

    currentReadGroup = undefined;
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
    const readGroup = readGroupByToolCallId.get(event.toolCallId);
    if (readGroup) {
      readGroup.completed.add(event.toolCallId);
      if (event.isError) readGroup.failed.add(event.toolCallId);
    }
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
    currentReadGroup = undefined;
    activeToolCalls.clear();
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('turn_start', (_event, ctx) => {
    currentTheme = ctx.ui.theme;
    currentReadGroup = undefined;
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
