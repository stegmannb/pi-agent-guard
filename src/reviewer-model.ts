import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ModelSelectorComponent,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, type TUI } from "@mariozechner/pi-tui";
import type { ReviewerConfig } from "./reviewer-config.ts";

type SessionEntry = ReturnType<
	ExtensionContext["sessionManager"]["getBranch"]
>[number];
type PiModel = NonNullable<ExtensionContext["model"]>;
export type ReviewerModelSetting = ReviewerConfig["model"];
export const REVIEWER_MODEL_ENTRY_TYPE = "pi-guard-reviewer-model";

export type SessionModelOverride =
	| { kind: "none" }
	| { kind: "valid"; model: ReviewerModelSetting }
	| { kind: "invalid"; reason: string };

export interface ReviewerModelResolution {
	source: "session" | "global" | "main";
	setting: ReviewerModelSetting;
	model: PiModel | undefined;
	error?: string;
}

export function isReviewerModelSetting(
	value: unknown,
): value is ReviewerModelSetting {
	return (
		typeof value === "string" &&
		(value === "main" || /^[^/\s]+\/[^/\s][^\s]*$/.test(value))
	);
}

/** Read only the current branch line, so forks and tree navigation inherit correctly. */
export function readSessionModelOverride(
	entries: SessionEntry[],
): SessionModelOverride {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== REVIEWER_MODEL_ENTRY_TYPE
		)
			continue;
		const data = entry.data;
		if (
			data === null ||
			typeof data !== "object" ||
			!("model" in data) ||
			!isReviewerModelSetting(data.model)
		) {
			return {
				kind: "invalid",
				reason: "Stored reviewer model selection is invalid.",
			};
		}
		return { kind: "valid", model: data.model };
	}
	return { kind: "none" };
}

export function resolveReviewerModel(
	config: ReviewerConfig,
	ctx: ExtensionContext,
): ReviewerModelResolution {
	const override = readSessionModelOverride(ctx.sessionManager.getBranch());
	if (override.kind === "invalid") {
		return {
			source: "session",
			setting: "main",
			model: undefined,
			error: override.reason,
		};
	}
	const setting = override.kind === "valid" ? override.model : config.model;
	const source =
		override.kind === "valid"
			? "session"
			: setting === "main"
				? "main"
				: "global";
	if (!isReviewerModelSetting(setting)) {
		return {
			source,
			setting: "main",
			model: undefined,
			error: "Configured reviewer model is invalid.",
		};
	}
	if (setting === "main") {
		return {
			source,
			setting,
			model: ctx.model,
			...(ctx.model ? {} : { error: "No main model is selected." }),
		};
	}
	try {
		const separator = setting.indexOf("/");
		const model = ctx.modelRegistry.find(
			setting.slice(0, separator),
			setting.slice(separator + 1),
		);
		if (!model)
			return {
				source,
				setting,
				model: undefined,
				error: `Reviewer model ${setting} is unavailable.`,
			};
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			return {
				source,
				setting,
				model: undefined,
				error: `Reviewer model ${setting} has no configured authentication.`,
			};
		}
		return { source, setting, model };
	} catch (error) {
		return {
			source,
			setting,
			model: undefined,
			error: `Reviewer model lookup failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function formatReviewerModelStatus(
	resolution: ReviewerModelResolution,
): string {
	const selected = resolution.model
		? `${resolution.model.provider}/${resolution.model.id}`
		: resolution.setting;
	return `Reviewer model: ${selected} [${resolution.source}${resolution.setting === "main" ? " → main" : ""}]${resolution.error ? ` · ${resolution.error}` : ""}`;
}

export function setReviewerSessionModel(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	value: string,
): { ok: true; model: ReviewerModelSetting } | { ok: false; reason: string } {
	if (!isReviewerModelSetting(value)) {
		return {
			ok: false,
			reason: "Use main or a provider/model-id from Pi's model registry.",
		};
	}
	if (value !== "main") {
		try {
			ctx.modelRegistry.refresh();
			const separator = value.indexOf("/");
			const model = ctx.modelRegistry.find(
				value.slice(0, separator),
				value.slice(separator + 1),
			);
			if (!model)
				return { ok: false, reason: `Unknown reviewer model: ${value}` };
			if (
				!ctx.modelRegistry
					.getAvailable()
					.some(
						(available) =>
							available.provider === model.provider &&
							available.id === model.id,
					)
			) {
				return {
					ok: false,
					reason: `Reviewer model ${value} has no configured authentication.`,
				};
			}
		} catch (error) {
			return {
				ok: false,
				reason: `Reviewer model lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	try {
		pi.appendEntry(REVIEWER_MODEL_ENTRY_TYPE, { model: value });
	} catch (error) {
		return {
			ok: false,
			reason: `Reviewer model selection could not be saved in this session: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, model: value };
}

/** Pi's native selector saves to its SettingsManager; this one is always isolated. */
export class ReviewerModelSelector extends ModelSelectorComponent {
	private readonly onMain: () => void;

	constructor(
		tui: TUI,
		currentModel: PiModel | undefined,
		registry: ExtensionContext["modelRegistry"],
		onSelect: (model: PiModel) => void,
		onCancel: () => void,
		onMain: () => void,
		currentStatus: string,
	) {
		super(
			tui,
			currentModel,
			SettingsManager.inMemory(),
			registry,
			[],
			onSelect,
			onCancel,
		);
		this.onMain = onMain;
		this.addChild(
			new Text(`${currentStatus}\nAlt+M — Follow the current main model`, 0, 0),
		);
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "alt+m")) {
			this.onMain();
			return;
		}
		super.handleInput(data);
	}
}

export async function pickReviewerModel(
	ctx: ExtensionCommandContext,
	config: ReviewerConfig,
): Promise<ReviewerModelSetting | undefined> {
	if (!ctx.hasUI) return undefined;
	const current = resolveReviewerModel(config, ctx);
	let nativePickerOpened = false;
	try {
		const chosen = await ctx.ui.custom<ReviewerModelSetting | undefined>(
			(tui, _theme, _keybindings, done) => {
				nativePickerOpened = true;
				return new ReviewerModelSelector(
					tui,
					current.model,
					ctx.modelRegistry,
					(model) => done(`${model.provider}/${model.id}`),
					() => done(undefined),
					() => done("main"),
					formatReviewerModelStatus(current),
				);
			},
		);
		if (nativePickerOpened) return chosen;
	} catch (error) {
		ctx.ui.notify(
			`Reviewer model picker failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
	// RPC supports standard select dialogs but not custom TUI components.
	try {
		ctx.modelRegistry.refresh();
		const choices = ctx.modelRegistry
			.getAvailable()
			.map((model) => `${model.provider}/${model.id}`);
		const followMain = "Follow current main model";
		const selected = await ctx.ui.select(
			`Reviewer model (${current.source}: ${current.setting})`,
			[followMain, ...choices],
		);
		if (selected === followMain) return "main";
		if (
			selected &&
			choices.includes(selected) &&
			isReviewerModelSetting(selected)
		)
			return selected;
	} catch (error) {
		ctx.ui.notify(
			`Reviewer model picker failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
	return undefined;
}
