import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

export default function codeBlockBoxExtension(pi: ExtensionAPI) {
	const origRenderToken = (Markdown.prototype as any).renderToken;

	(Markdown.prototype as any).renderToken = function (
		token: any,
		width: number,
		nextTokenType: string | undefined,
		styleContext: any,
	): string[] {
		if (token.type !== "code") {
			return origRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		// Extremely narrow terminal: fall back to no-box rendering
		if (width < 10) {
			return origRenderToken.call(this, token, width, nextTokenType, styleContext);
		}

		const border = this.theme.codeBlockBorder;
		const lines: string[] = [];

		// ┌─ lang ──────────────────────────────┐
		const lang = token.lang || "";
		if (lang) {
			const topDash = Math.max(1, width - 5 - lang.length);
			lines.push(border(`┌─ ${lang} ${"─".repeat(topDash)}┐`));
		} else {
			const topDash = Math.max(1, width - 2);
			lines.push(border(`┌${"─".repeat(topDash)}┐`));
		}

		// Content: │ ... │
		const innerWidth = Math.max(1, width - 4);
		const renderContentLine = (rawLine: string) => {
			const content = truncateToWidth(rawLine, innerWidth, "", false);
			const pad = Math.max(0, innerWidth - visibleWidth(content));
			return border("│ ") + content + " ".repeat(pad) + border(" │");
		};

		if (this.theme.highlightCode) {
			for (const hlLine of this.theme.highlightCode(token.text, token.lang)) {
				lines.push(renderContentLine(hlLine));
			}
		} else {
			for (const codeLine of token.text.split("\n")) {
				lines.push(renderContentLine(this.theme.codeBlock(codeLine)));
			}
		}

		// └─────────────────────────────────────┘
		const bottomDash = Math.max(1, width - 2);
		lines.push(border(`└${"─".repeat(bottomDash)}┘`));

		if (nextTokenType && nextTokenType !== "space") {
			lines.push("");
		}

		return lines;
	};

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("代码块已改用 Unicode 框线 (pi-code-block-fix)", "info");
	});
}