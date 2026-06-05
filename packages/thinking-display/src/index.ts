import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type AssistantContent = AssistantMessage['content'][number];
type AssistantMessageRender = (this: AssistantMessageComponent, message: AssistantMessage) => void;

const ORIGINAL_UPDATE_CONTENT = Symbol.for('pi-better-ux.thinking-display.original-update-content');
const SHOULD_COLLAPSE = Symbol.for('pi-better-ux.thinking-display.should-collapse');

type PatchedAssistantMessagePrototype = AssistantMessageComponent & {
  updateContent: AssistantMessageRender;
  [ORIGINAL_UPDATE_CONTENT]?: AssistantMessageRender;
  [SHOULD_COLLAPSE]?: () => boolean;
};

function collapseThinkingContent(message: AssistantMessage): AssistantMessage {
  let hasThinking = false;
  let hasText = false;
  let hasToolCall = false;
  for (const content of message.content) {
    if (content.type === 'thinking' && content.thinking.trim() !== '') hasThinking = true;
    else if (content.type === 'text' && content.text.trim() !== '') hasText = true;
    else if (content.type === 'toolCall') hasToolCall = true;
  }
  if (!hasThinking) return message;

  const shouldShowThinkingMarker = hasText || !hasToolCall;

  let markerAdded = false;
  const collapsedContent: AssistantContent[] = [];
  for (const content of message.content) {
    if (content.type !== 'thinking') {
      collapsedContent.push(content);
      continue;
    }

    if (!shouldShowThinkingMarker || markerAdded || content.thinking.trim() === '') continue;
    collapsedContent.push(content);
    markerAdded = true;
  }

  return { ...message, content: collapsedContent };
}

function installThinkingRenderPatch(isCollapsed: () => boolean) {
  const prototype = AssistantMessageComponent.prototype as PatchedAssistantMessagePrototype;
  prototype[SHOULD_COLLAPSE] = isCollapsed;

  if (prototype[ORIGINAL_UPDATE_CONTENT]) return;

  const originalUpdateContent = prototype.updateContent;
  prototype[ORIGINAL_UPDATE_CONTENT] = originalUpdateContent;
  prototype.updateContent = function updateContentWithCollapsedThinking(message: AssistantMessage): void {
    if (!prototype[SHOULD_COLLAPSE]?.()) {
      originalUpdateContent.call(this, message);
      return;
    }

    const component = this as unknown as { hideThinkingBlock: boolean | undefined };
    const previousHideThinkingBlock = component.hideThinkingBlock;
    component.hideThinkingBlock = true;
    try {
      originalUpdateContent.call(this, collapseThinkingContent(message));
    } finally {
      component.hideThinkingBlock = previousHideThinkingBlock;
    }
  };
}

function applyThinkingDisplay(ctx: ExtensionContext, collapsed: boolean) {
  if (collapsed) {
    ctx.ui.setHiddenThinkingLabel('thinking');
    return;
  }

  ctx.ui.setHiddenThinkingLabel();
}

export default function thinkingDisplay(pi: ExtensionAPI) {
  let collapseThinking = true;

  installThinkingRenderPatch(() => collapseThinking);

  pi.on('session_start', (_event, ctx) => {
    applyThinkingDisplay(ctx, collapseThinking);
  });

  pi.registerCommand('thinking-display', {
    description: 'Control compact thinking rendering: on, off, status',
    handler: async (args, ctx) => {
      const action = args.trim();

      if (action === 'on') {
        collapseThinking = true;
        applyThinkingDisplay(ctx, collapseThinking);
        ctx.ui.notify('Thinking traces are collapsed into one marker.', 'info');
        return;
      }

      if (action === 'off') {
        collapseThinking = false;
        applyThinkingDisplay(ctx, collapseThinking);
        ctx.ui.notify('Native thinking rendering restored.', 'info');
        return;
      }

      if (action === '' || action === 'status') {
        const mode = collapseThinking ? 'collapsed' : 'native';
        ctx.ui.notify(`Thinking display: ${mode}. Usage: /thinking-display on|off|status`, 'info');
        return;
      }

      ctx.ui.notify(`Unknown thinking-display action: ${action}`, 'error');
    },
  });
}
