import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';

type ToolExecutionInstance = InstanceType<typeof ToolExecutionComponent> & {
  expanded?: boolean;
};

type ToolRender = (this: ToolExecutionInstance, width: number) => string[];

const ORIGINAL_RENDER = Symbol.for('pi-better-ux.tool-display.original-render');
const SHOULD_HIDE = Symbol.for('pi-better-ux.tool-display.should-hide');

type PatchedToolExecutionPrototype = ToolExecutionInstance & {
  render: ToolRender;
  [ORIGINAL_RENDER]?: ToolRender;
  [SHOULD_HIDE]?: () => boolean;
};

function installToolRenderPatch(isHidden: () => boolean) {
  const prototype = ToolExecutionComponent.prototype as PatchedToolExecutionPrototype;
  prototype[SHOULD_HIDE] = isHidden;

  if (prototype[ORIGINAL_RENDER]) return;

  const originalRender = prototype.render;
  prototype[ORIGINAL_RENDER] = originalRender;
  prototype.render = function renderToolExecution(width: number): string[] {
    if (prototype[SHOULD_HIDE]?.() && !this.expanded) return [];
    return originalRender.call(this, width);
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
  let hideCollapsedTools = true;
  const activeToolCalls = new Set<string>();

  installToolRenderPatch(() => hideCollapsedTools);

  pi.on('tool_execution_start', (event, ctx) => {
    activeToolCalls.add(event.toolCallId);
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    activeToolCalls.delete(event.toolCallId);
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.on('agent_end', (_event, ctx) => {
    activeToolCalls.clear();
    updateWorkingMessage(ctx, activeToolCalls);
  });

  pi.registerCommand('tool-display', {
    description: 'Control hidden collapsed tool rendering: on, off, expand, collapse, status',
    handler: async (args, ctx) => {
      const action = args.trim();

      if (action === 'on') {
        hideCollapsedTools = true;
        ctx.ui.notify('Collapsed tool rows are now hidden. Use Ctrl+O to show details.', 'info');
        return;
      }

      if (action === 'off') {
        hideCollapsedTools = false;
        ctx.ui.notify('Collapsed tool rows are now visible.', 'info');
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
        const mode = hideCollapsedTools ? 'hidden' : 'visible';
        const expanded = ctx.ui.getToolsExpanded() ? 'expanded' : 'collapsed';
        const help = 'Usage: /tool-display on|off|expand|collapse|status';
        ctx.ui.notify(`Tool display: ${mode}, ${expanded}. ${help}`, 'info');
        return;
      }

      ctx.ui.notify(`Unknown tool-display action: ${action}`, 'error');
    },
  });
}
