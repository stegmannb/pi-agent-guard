import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Input,
	matchesKey,
	SelectList,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";

export type ApprovalChoice =
	| "allow-once"
	| "allow-session"
	| "allow-project"
	| "allow-global"
	| "deny"
	| "feedback"
	| "resume-timeout"
	| `alternative-${number}`;

export type ApprovalOutcome =
	| { kind: "choice"; choice: ApprovalChoice }
	| { kind: "feedback"; text: string }
	| { kind: "timeout" }
	| { kind: "cancel" };

export interface ApprovalOption {
	value: ApprovalChoice;
	label: string;
	description?: string;
}

export interface ApprovalPresentation {
	command: string;
	cwd: string;
	recommendation: "allow" | "deny" | null;
	reason: string;
	options: ApprovalOption[];
	timeoutMs: number | null;
}

export interface ApprovalClock {
	now(): number;
	every(ms: number, tick: () => void): () => void;
}

const SYSTEM_CLOCK: ApprovalClock = {
	now: () => Date.now(),
	every: (ms, tick) => {
		const interval = setInterval(tick, ms);
		return () => clearInterval(interval);
	},
};

export function approvalOptions(
	project: boolean,
	global: boolean,
	alternatives: { input: { command: string } }[],
	paused = false,
): ApprovalOption[] {
	return [
		{ value: "allow-once", label: "Allow once" },
		{
			value: "allow-session",
			label: "Allow for this session",
			description: "Exact command · current directory · this session",
		},
		...(project
			? [
					{
						value: "allow-project" as const,
						label: "Allow for this project",
						description: "Save command-name rules in .pi/settings.json",
					},
				]
			: []),
		...(global
			? [
					{
						value: "allow-global" as const,
						label: "Allow globally",
						description: "Save command-name rules in global settings.json",
					},
				]
			: []),
		{ value: "deny", label: "Deny" },
		{ value: "feedback", label: "Give feedback" },
		...alternatives.map((alternative, index) => ({
			value: `alternative-${index}` as const,
			label: `Return alternative ${index + 1} to agent: ${alternative.input.command.slice(0, 72)}`,
		})),
		...(paused
			? [{ value: "resume-timeout" as const, label: "Resume timeout" }]
			: []),
	];
}

function rpcOptionLabel(option: ApprovalOption): string {
	return option.description
		? `${option.label} — ${option.description}`
		: option.label;
}

/** A single approval dialog: human input freezes its deadline until explicit resume. */
export class ApprovalDialog {
	private list: SelectList;
	private readonly input = new Input();
	private readonly header: Text;
	private readonly tui: TUI;
	private readonly presentation: ApprovalPresentation;
	private readonly done: (result: ApprovalOutcome) => void;
	private readonly signal: AbortSignal | undefined;
	private readonly clock: ApprovalClock;
	private stopTick?: () => void;
	private deadline: number | undefined;
	private remainingMs: number | null;
	private paused = false;
	private finished = false;
	private editingFeedback = false;
	private scrollOffset = 0;
	private readonly onAbort = () => this.finish({ kind: "cancel" });

	constructor(
		tui: TUI,
		presentation: ApprovalPresentation,
		done: (result: ApprovalOutcome) => void,
		signal?: AbortSignal,
		clock: ApprovalClock = SYSTEM_CLOCK,
	) {
		this.tui = tui;
		this.presentation = presentation;
		this.done = done;
		this.signal = signal;
		this.clock = clock;
		this.remainingMs = presentation.timeoutMs;
		this.deadline =
			presentation.timeoutMs === null
				? undefined
				: clock.now() + presentation.timeoutMs;
		this.header = new Text("", 0, 0);
		this.list = this.makeList(presentation.options);
		this.list.setSelectedIndex(
			presentation.options.findIndex(
				(option) =>
					option.value ===
					(presentation.recommendation === "allow" ? "allow-once" : "deny"),
			),
		);
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			if (value.trim()) this.finish({ kind: "feedback", text: value });
		};
		this.input.onEscape = () => {
			this.editingFeedback = false;
			this.tui.requestRender();
		};
		if (signal?.aborted) this.onAbort();
		else signal?.addEventListener("abort", this.onAbort, { once: true });
		if (!this.finished && this.deadline !== undefined) {
			this.stopTick = clock.every(100, () => {
				if (this.finished || this.paused) return;
				this.remainingMs = Math.max(
					0,
					(this.deadline ?? clock.now()) - clock.now(),
				);
				if (this.remainingMs === 0) this.finish({ kind: "timeout" });
				else this.tui.requestRender();
			});
		}
	}

	private makeList(options: ApprovalOption[]): SelectList {
		const list = new SelectList(
			options.map((option) => ({ ...option })),
			Math.max(2, Math.min(12, this.tui.terminal.rows - 8)),
			{
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		);
		list.onSelect = (item) => this.select(item.value as ApprovalChoice);
		list.onCancel = () => this.finish({ kind: "cancel" });
		return list;
	}

	private finish(outcome: ApprovalOutcome): void {
		if (this.finished) return;
		this.finished = true;
		this.stopTick?.();
		this.signal?.removeEventListener("abort", this.onAbort);
		this.done(outcome);
	}

	private pause(): void {
		if (this.paused || this.deadline === undefined) return;
		this.remainingMs = Math.max(0, this.deadline - this.clock.now());
		if (this.remainingMs === 0) {
			this.finish({ kind: "timeout" });
			return;
		}
		this.paused = true;
		const selected = this.list.getSelectedItem()?.value;
		const options = [
			...this.presentation.options,
			{ value: "resume-timeout" as const, label: "Resume timeout" },
		];
		this.list = this.makeList(options);
		this.list.setSelectedIndex(
			Math.max(
				0,
				options.findIndex((option) => option.value === selected),
			),
		);
	}

	private select(choice: ApprovalChoice): void {
		if (choice === "resume-timeout") {
			if (this.remainingMs !== null && this.remainingMs > 0) {
				this.deadline = this.clock.now() + this.remainingMs;
				this.paused = false;
				this.list = this.makeList(this.presentation.options);
			}
			this.tui.requestRender();
			return;
		}
		if (choice === "feedback") {
			this.editingFeedback = true;
			this.tui.requestRender();
			return;
		}
		this.finish({ kind: "choice", choice });
	}

	handleInput(data: string): void {
		if (this.finished) return;
		this.pause();
		if (this.finished) return;
		if (this.editingFeedback) {
			this.input.handleInput(data);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset += 5;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 5);
			this.tui.requestRender();
			return;
		}
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const p = this.presentation;
		const seconds =
			this.remainingMs === null ? 0 : Math.ceil(this.remainingMs / 1000);
		const total = p.timeoutMs ?? 1;
		const filled =
			this.remainingMs === null
				? 0
				: Math.ceil((20 * this.remainingMs) / total);
		const bar = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
		const status =
			this.remainingMs === null
				? "No timeout"
				: this.paused
					? `${bar} Timeout paused · ${seconds} s remaining`
					: `${bar} Auto-deny in ${seconds} s`;
		this.header.setText(
			`Cwd: ${p.cwd}\nRecommendation: ${p.recommendation ?? "Ask"}\nReason: ${p.reason}\nCommand:\n${p.command}`,
		);
		const details = this.header.render(width);
		const options = this.editingFeedback
			? ["Feedback to agent:", ...this.input.render(width)]
			: this.list.render(width);
		const detailHeight = Math.max(
			1,
			this.tui.terminal.rows - options.length - 5,
		);
		const start = Math.min(
			this.scrollOffset,
			Math.max(0, details.length - detailHeight),
		);
		const visible = details.slice(start, start + detailHeight);
		return [
			"Guard approval required",
			...visible,
			...(details.length > detailHeight
				? [
						`Details ${start + 1}-${start + visible.length}/${details.length} · PageUp/PageDown to scroll`,
					]
				: []),
			status,
			"",
			...options,
		];
	}

	invalidate(): void {
		this.header.invalidate();
		this.list.invalidate();
		this.input.invalidate();
	}

	dispose(): void {
		this.stopTick?.();
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}

export async function askApproval(
	ctx: ExtensionContext,
	presentation: ApprovalPresentation,
	signal?: AbortSignal,
): Promise<ApprovalOutcome> {
	if (!ctx.hasUI) return { kind: "cancel" };
	let opened = false;
	try {
		const result = await ctx.ui.custom<ApprovalOutcome>(
			(tui, _theme, _keybindings, done) => {
				opened = true;
				return new ApprovalDialog(tui, presentation, done, signal);
			},
		);
		if (opened) return result ?? { kind: "cancel" };
	} catch {
		return { kind: "cancel" };
	}
	// RPC has only final selections: no autonomous timeout while input activity is invisible.
	const options = presentation.options.filter(
		(option) => option.value !== "resume-timeout",
	);
	const ordered =
		presentation.recommendation === "allow"
			? options
			: [
					...options.filter((option) => option.value === "deny"),
					...options.filter((option) => option.value !== "deny"),
				];
	const labels = ordered.map(rpcOptionLabel);
	try {
		const picked = await ctx.ui.select(
			`Guard approval required\nCwd: ${presentation.cwd}\nCommand: ${presentation.command}\nRecommendation: ${presentation.recommendation ?? "Ask"}\nReason: ${presentation.reason}\nTimeout paused: input activity unavailable`,
			labels,
			signal ? { signal } : {},
		);
		const index = labels.indexOf(picked ?? "");
		const option = ordered[index];
		if (!option) return { kind: "cancel" };
		if (option.value === "feedback") {
			const feedback = await ctx.ui.input(
				"Give feedback to agent",
				"Feedback",
				signal ? { signal } : {},
			);
			return feedback?.trim()
				? { kind: "feedback", text: feedback }
				: { kind: "cancel" };
		}
		return { kind: "choice", choice: option.value };
	} catch {
		return { kind: "cancel" };
	}
}
