import "./loaded-code.ts";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ModelSelectorComponent,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, type TUI } from "@mariozechner/pi-tui";
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

function findReviewerModel(
	ctx: ExtensionContext,
	setting: string,
): PiModel | undefined {
	const separator = setting.indexOf("/");
	const provider = setting.slice(0, separator);
	const id = setting.slice(separator + 1);
	return (
		ctx.modelRegistry.find(provider, id) ??
		(ctx.model?.provider === provider && ctx.model.id === id
			? ctx.model
			: undefined)
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
		const model = findReviewerModel(ctx, setting);
		if (!model)
			return {
				source,
				setting,
				model: undefined,
				error: `Reviewer model ${setting} is unavailable.`,
			};
		if (model !== ctx.model && !ctx.modelRegistry.hasConfiguredAuth(model)) {
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
			const model = findReviewerModel(ctx, value);
			if (!model)
				return { ok: false, reason: `Unknown reviewer model: ${value}` };
			if (model !== ctx.model && !ctx.modelRegistry.hasConfiguredAuth(model)) {
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

/** Keep the native picker while adapting the two Pi constructor contracts. */
export class ReviewerModelSelector extends Container {
	private readonly selector: ModelSelectorComponent;
	private readonly onMain: () => void;

	get focused(): boolean {
		return this.selector.focused;
	}

	set focused(value: boolean) {
		this.selector.focused = value;
	}

	constructor(
		tui: TUI,
		currentModel: PiModel | undefined,
		registry: ExtensionContext["modelRegistry"],
		onSelect: (model: PiModel) => void,
		onCancel: () => void,
		onMain: () => void,
		currentStatus: string,
		scopedModels: ReadonlyArray<{
			model: PiModel;
			thinkingLevel?: string;
		}> = [],
		PickerComponent: typeof ModelSelectorComponent = ModelSelectorComponent,
	) {
		super();
		// Pi 0.86's picker uses ModelRuntime and refreshes it in the background.
		// The extension API exposes a ModelRegistry facade, so supply only the
		// public runtime operations that the native picker calls.
		const prototype = PickerComponent.prototype as ModelSelectorComponent & {
			dispose?: () => void;
		};
		if (typeof prototype.dispose === "function") {
			const runtime = {
				getAvailableSnapshot: () => {
					const models = registry.getAvailable();
					if (
						currentModel &&
						!models.some(
							(model) =>
								model.provider === currentModel.provider &&
								model.id === currentModel.id,
						)
					)
						return [...models, currentModel];
					return models;
				},
				getModel: (provider: string, id: string) =>
					registry.find(provider, id) ??
					(currentModel?.provider === provider && currentModel.id === id
						? currentModel
						: undefined),
				getError: () => registry.getError(),
				refresh: async (options: unknown) => {
					const refresh = registry.refresh as (...args: unknown[]) => unknown;
					const result = await refresh.call(registry, options);
					return result ?? { errors: new Map(), aborted: false };
				},
			};
			const NativeSelector = PickerComponent as unknown as new (
				...args: unknown[]
			) => ModelSelectorComponent;
			this.selector = new NativeSelector(
				tui,
				currentModel,
				runtime,
				scopedModels,
				onSelect,
				onCancel,
			);
		} else {
			// Older Pi writes its selected model to SettingsManager. Keep that
			// manager in memory so the reviewer's choice never changes main.
			this.selector = new PickerComponent(
				tui,
				currentModel,
				SettingsManager.inMemory(),
				registry,
				scopedModels,
				onSelect,
				onCancel,
			);
		}
		this.addChild(this.selector);
		this.onMain = onMain;
		this.addChild(
			new Text(`${currentStatus}\nAlt+M — Follow the current main model`, 0, 0),
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+m")) {
			this.onMain();
			return;
		}
		this.selector.handleInput(data);
	}

	getSearchInput(): ReturnType<ModelSelectorComponent["getSearchInput"]> {
		return this.selector.getSearchInput();
	}

	dispose(): void {
		const selector = this.selector as ModelSelectorComponent & {
			dispose?: () => void;
		};
		selector.dispose?.();
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
					(
						ctx as ExtensionCommandContext & {
							scopedModels?: ReadonlyArray<{
								model: PiModel;
								thinkingLevel?: string;
							}>;
						}
					).scopedModels ?? [],
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
		const available = await ctx.modelRegistry.getAvailable();
		const choices = available.map((model) => `${model.provider}/${model.id}`);
		if (ctx.model && !choices.includes(`${ctx.model.provider}/${ctx.model.id}`))
			choices.push(`${ctx.model.provider}/${ctx.model.id}`);
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
