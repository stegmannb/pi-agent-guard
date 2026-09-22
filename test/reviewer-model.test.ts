import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	initTheme,
} from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { evaluateToolCall } from "../src/evaluator.ts";
import { registerGuard } from "../src/index.ts";
import { buildPolicySnapshot } from "../src/policy.ts";
import {
	createReviewerRequest,
	type ReviewerDependencies,
	reviewGuardRequest,
} from "../src/reviewer.ts";
import type { ReviewerConfig } from "../src/reviewer-config.ts";
import {
	formatReviewerModelStatus,
	pickReviewerModel,
	REVIEWER_MODEL_ENTRY_TYPE,
	ReviewerModelSelector,
	readSessionModelOverride,
	resolveReviewerModel,
	setReviewerSessionModel,
} from "../src/reviewer-model.ts";
import type { GuardContext } from "../src/types.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

function model(provider: string, id: string): PiModel {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4000,
	};
}

const alpha = model("test", "alpha");
const beta = model("test", "family/beta");
const config: ReviewerConfig = {
	mode: "off",
	model: "test/alpha",
	policy: "",
	reviewTimeoutMs: 60_000,
	approvalTimeoutMs: 120_000,
};

function harness() {
	let entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]> = [];
	let main: PiModel | undefined = beta;
	let available = [alpha, beta];
	const notices: string[] = [];
	const statuses: string[] = [];
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const events = new Map<
		string,
		(event: unknown, ctx: ExtensionContext) => Promise<void> | void
	>();
	const registry = {
		refresh() {},
		getError: () => undefined,
		getAvailable: () => available,
		find: (provider: string, id: string) =>
			[alpha, beta].find(
				(item) => item.provider === provider && item.id === id,
			),
		hasConfiguredAuth: (item: PiModel) =>
			available.some(
				(candidate) =>
					candidate.provider === item.provider && candidate.id === item.id,
			),
	};
	const ui = {
		notify: (message: string) => notices.push(message),
		setStatus: (_key: string, value: string) => statuses.push(value),
		theme: { fg: (_color: string, value: string) => value },
		custom: async () => undefined,
		select: async (): Promise<string | undefined> => undefined,
	};
	const ctx = {
		hasUI: true,
		cwd: "/repo",
		ui,
		modelRegistry: registry,
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "reviewer-model-session",
		},
		get model() {
			return main;
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		appendEntry(customType: string, data: unknown) {
			entries = [
				...entries,
				{
					type: "custom",
					customType,
					data,
					id: String(entries.length),
					parentId: null,
					timestamp: "now",
				},
			];
		},
		registerCommand(
			name: string,
			command: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			commands.set(name, command.handler);
		},
		on(
			name: string,
			handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
		) {
			events.set(name, handler);
		},
		registerTool() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	return {
		pi,
		ctx,
		registry,
		ui,
		notices,
		statuses,
		commands,
		events,
		setEntries(value: typeof entries) {
			entries = value;
		},
		getEntries: () => entries,
		setMain(value: PiModel | undefined) {
			main = value;
		},
		setAvailable(value: PiModel[]) {
			available = value;
		},
	};
}

test("global default, session override, explicit main and working-model changes resolve separately", () => {
	const h = harness();
	assert.equal(
		resolveReviewerModel({ ...config, model: "main" }, h.ctx).model?.id,
		"family/beta",
	);
	let selected = resolveReviewerModel(config, h.ctx);
	assert.equal(selected.source, "global");
	assert.equal(selected.model?.id, "alpha");
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "main").ok, true);
	selected = resolveReviewerModel(config, h.ctx);
	assert.equal(selected.source, "session");
	assert.equal(selected.model?.id, "family/beta");
	h.setMain(alpha);
	assert.equal(resolveReviewerModel(config, h.ctx).model?.id, "alpha");
	assert.equal(
		setReviewerSessionModel(h.pi, h.ctx, "test/family/beta").ok,
		true,
	);
	h.setMain(undefined);
	assert.equal(resolveReviewerModel(config, h.ctx).model?.id, "family/beta");
	assert.equal(h.ctx.model, undefined);
	assert.match(
		formatReviewerModelStatus(resolveReviewerModel(config, h.ctx)),
		/session/,
	);
});

test("session branch and resume use the last entry on the current line; new session uses global", () => {
	const h = harness();
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "main").ok, true);
	const parent = h.getEntries();
	assert.equal(readSessionModelOverride(parent).kind, "valid");
	h.setEntries([...parent]); // resume or fork at the current leaf
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "main");
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "test/alpha").ok, true);
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "test/alpha");
	h.setEntries(parent); // tree navigation to branch before latest selection
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "main");
	h.setEntries([]); // independent new session
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "test/alpha");
	assert.equal(resolveReviewerModel(config, h.ctx).source, "global");
});

test("invalid direct selection, absent auth and corrupt persisted entry never fall back silently", () => {
	const h = harness();
	const before = h.getEntries().length;
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "wrong").ok, false);
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "test/missing").ok, false);
	h.setAvailable([alpha]);
	assert.equal(
		setReviewerSessionModel(h.pi, h.ctx, "test/family/beta").ok,
		false,
	);
	assert.equal(h.getEntries().length, before);
	h.setEntries([
		{
			type: "custom",
			customType: REVIEWER_MODEL_ENTRY_TYPE,
			data: { model: "broken" },
			id: "x",
			parentId: null,
			timestamp: "now",
		},
	]);
	assert.equal(readSessionModelOverride(h.getEntries()).kind, "invalid");
	const resolved = resolveReviewerModel(config, h.ctx);
	assert.equal(resolved.model, undefined);
	assert.match(resolved.error ?? "", /invalid/);
});

test("native selector searches registry and its save side effect stays in memory", async () => {
	initTheme("dark", false);
	const h = harness();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-picker-"));
	const pathToSettings = path.join(dir, "settings.json");
	fs.writeFileSync(pathToSettings, '{"defaultModel":"untouched"}');
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		let selected = "";
		const picker = new ReviewerModelSelector(
			{ requestRender() {} } as unknown as TUI,
			alpha,
			h.ctx.modelRegistry,
			(item) => {
				selected = `${item.provider}/${item.id}`;
			},
			() => {
				selected = "cancelled";
			},
			() => {
				selected = "main";
			},
			"Reviewer model: test/alpha [global]",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const key of "beta") picker.handleInput(key);
		assert.equal(picker.getSearchInput().getValue(), "beta");
		picker.handleInput("\r");
		assert.equal(selected, "test/family/beta");
		assert.equal(
			fs.readFileSync(pathToSettings, "utf8"),
			'{"defaultModel":"untouched"}',
		);
		selected = "";
		picker.handleInput("\u001bm"); // Alt+M
		assert.equal(selected, "main");
		selected = "";
		picker.handleInput("\u001b"); // Escape
		assert.equal(selected, "cancelled");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("RPC uses standard selector, cancellation preserves choice, print has no hanging picker", async () => {
	const h = harness();
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "test/alpha").ok, true);
	let selects = 0;
	h.ui.custom = async () => undefined; // RPC does not invoke the factory
	h.ui.select = async () => {
		selects++;
		return "test/family/beta";
	};
	assert.equal(await pickReviewerModel(h.ctx, config), "test/family/beta");
	assert.equal(selects, 1);
	h.ui.select = async () => undefined;
	assert.equal(await pickReviewerModel(h.ctx, config), undefined);
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "test/alpha");
	const printContext = { ...h.ctx, hasUI: false } as ExtensionCommandContext;
	assert.equal(await pickReviewerModel(printContext, config), undefined);
	assert.equal(selects, 1);
});

test("guard command persists only valid choices, reports status, and refreshes after session events", async () => {
	const h = harness();
	registerGuard(h.pi, {
		loaded: {
			config: { enabled: true, matchers: DEFAULT_CONFIG.matchers, rules: {} },
			reviewer: config,
		},
		projectResult: null,
		startupCwd: "/repo",
	});
	const guard = h.commands.get("guard");
	assert.ok(guard);
	await guard("model test/family/beta", h.ctx);
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "test/family/beta");
	await guard("model invalid", h.ctx);
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "test/family/beta");
	await guard("model main", h.ctx);
	assert.equal(resolveReviewerModel(config, h.ctx).setting, "main");
	await guard("model status", h.ctx);
	assert.match(h.notices.at(-1) ?? "", /main/);
	assert.match(h.notices.at(-1) ?? "", /Reviewer: off/);
	h.setEntries([]);
	await h.events.get("session_switch")?.({ type: "session_switch" }, h.ctx);
	assert.match(h.statuses.at(-1) ?? "", /global/);
	h.setMain(alpha);
	await h.events.get("model_select")?.({ type: "model_select" }, h.ctx);
	assert.match(h.statuses.at(-1) ?? "", /Reviewer model/);
});

test("an in-flight review keeps its model when the next call selects another", async () => {
	const h = harness();
	const guard: GuardContext = {
		config: { enabled: true, matchers: DEFAULT_CONFIG.matchers, rules: {} },
		staticPolicy: {
			userRules: {},
			projectRules: {},
			envRules: undefined,
			projectConfigPresent: false,
		},
		activeProfile: undefined,
		sessionRules: {},
		exactSessionGrants: [],
	};
	const snapshot = buildPolicySnapshot(guard);
	const evaluated = evaluateToolCall(
		snapshot,
		"bash",
		{ command: "git push" },
		"/repo",
	).result;
	const entries = [
		{
			type: "message",
			id: "u",
			parentId: null,
			timestamp: "now",
			message: { role: "user", content: "Inspect this repo", timestamp: 1 },
		},
	] as ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
	const firstRequest = createReviewerRequest(
		evaluated,
		snapshot,
		entries,
		"first",
	);
	const secondRequest = createReviewerRequest(
		evaluated,
		snapshot,
		entries,
		"second",
	);
	let releaseAuth: (() => void) | undefined;
	const seen: string[] = [];
	const deps: ReviewerDependencies = {
		mainModel: h.ctx.model,
		modelRegistry: {
			find: h.registry.find,
			getApiKeyAndHeaders: async () => {
				await new Promise<void>((resolve) => {
					releaseAuth = resolve;
				});
				return { ok: true, apiKey: "fake" };
			},
		},
		complete: (async (selected, context) => {
			seen.push(
				`${selected.provider}/${selected.id}:${JSON.parse(String(context.messages[0]?.content)).requestId}`,
			);
			return {
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							decision: "deny",
							recommendation: null,
							reason: "Not authorized",
						}),
					},
				],
			} as AssistantMessage;
		}) as NonNullable<ReviewerDependencies["complete"]>,
	};
	const activeConfig: ReviewerConfig = {
		...config,
		mode: "auto",
		model: "main",
		policy: "Ask before git push",
	};
	const first = reviewGuardRequest(firstRequest, activeConfig, deps);
	h.setMain(alpha);
	assert.equal(setReviewerSessionModel(h.pi, h.ctx, "test/alpha").ok, true);
	releaseAuth?.();
	assert.equal((await first).ok, true);
	deps.modelRegistry.getApiKeyAndHeaders = async () => ({
		ok: true,
		apiKey: "fake",
	});
	deps.mainModel = h.ctx.model;
	const override = resolveReviewerModel(activeConfig, h.ctx).setting;
	assert.equal(
		(
			await reviewGuardRequest(
				secondRequest,
				activeConfig,
				deps,
				undefined,
				override,
			)
		).ok,
		true,
	);
	assert.deepEqual(seen, ["test/family/beta:first", "test/alpha:second"]);
});
