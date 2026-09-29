/** Manual TUI-only smoke fixture. It presents options but never executes a command. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	ApprovalDialog,
	type ApprovalOutcome,
	approvalOptions,
} from "../../src/approval-dialog.ts";

export default function approvalSmoke(pi: ExtensionAPI): void {
	pi.registerCommand("guard-ui-smoke", {
		description:
			"Show the complete Guard approval dialog without running a command",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const long = args.trim() === "long";
			await ctx.ui.custom<ApprovalOutcome>(
				(tui, _theme, _keys, done) =>
					new ApprovalDialog(
						tui,
						{
							tool: "bash",
							command: long
								? "echo $(git status --short) && git push origin main --force-with-lease > /tmp/guard-smoke-output && echo this is a deliberately long command for the approval dialog smoke test"
								: "echo ok && git status --short",
							overview: long
								? "✔ echo $(...) &&\n\n✖ git status --short\n\n✖ git push origin main --force-with-lease > /tmp/guard-smoke-output &&\n✔ echo this is a deliberately long command for the approval dialog smoke test"
								: "✔ echo ok &&\n✖ git status --short",
							cwd: "/workspace/a/deeply/nested/project/directory/for/the/smoke/test",
							policyReasons: ["Fallback Bash rule requires approval."],
							recommendation: "deny",
							reason:
								"The destination and effect of this command need a human decision. This second sentence makes the explanation span several terminal lines.",
							alternatives: [
								"1. git status --short — Inspect changes; changed effect: no remote write; guard: ask",
							],
							options: approvalOptions(true, true, [
								{ input: { command: "git status --short" } },
								{ input: { command: "git diff --stat" } },
								{ input: { command: "git log -1" } },
							]),
							timeoutMs: 120_000,
						},
						done,
					),
			);
		},
	});
}
