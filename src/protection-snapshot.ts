import "./loaded-code.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	CONFIG_LOCATION_ENV,
	GLOBAL_SETTINGS_PATH,
	getProjectSettingsPath,
	loadConfig,
	loadProjectConfig,
} from "./config.ts";
import {
	type FileReference,
	loadedCode,
	referencesUnchanged,
	sha256,
} from "./loaded-code.ts";
import { buildPolicySnapshot } from "./policy.ts";
import type { ReviewerConfig } from "./reviewer-config.ts";
import {
	readSessionModelOverride,
	resolveReviewerModel,
} from "./reviewer-model.ts";
import type { GuardContext } from "./types.ts";

export const PROTECTION_SNAPSHOT_EVENT = "pasa:protection:snapshot:v1";
export type UnsupportedReason =
	| "NOT_INITIALIZED"
	| "DISABLED"
	| "SESSION_MISMATCH"
	| "RUNTIME_MUTATION"
	| "CONFIG_DRIFT"
	| "CWD_UNREPRODUCIBLE"
	| "INITIALIZATION_FAILED"
	| "UNBACKED_CONFIGURATION";
export interface SnapshotRequest {
	version: 1;
	requestId: string;
	protectionId: "pi-agent-guard";
	expectedSessionId: string;
	targetCwd: string;
	respond: (response: SnapshotResponse) => void;
}
interface ResponseIdentity {
	version: 1;
	requestId: string;
	protectionId: "pi-agent-guard";
}
export type SnapshotResponse = ResponseIdentity &
	(
		| { status: "unsupported"; reason: UnsupportedReason }
		| {
				status: "ready";
				binding: { cwd: string; sessionId: string; generation: number };
				enabled: true;
				initialized: true;
				stateDigest: string;
				codeFiles: FileReference[];
				configurationFiles: FileReference[];
				environment: { name: string; sha256: string }[];
				replay: {
					kind: "file-backed";
					verifiedCwd: string;
					stateDigest: string;
				};
		  }
	);

// Object insertion order affects last-match-wins rules. Encode records as
// ordered pairs, rather than sorting away a policy-significant difference.
function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object")
		return Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, normalize(v)]);
	return value;
}
function digest(value: unknown): string {
	return sha256(JSON.stringify(normalize(value)));
}

function environment() {
	return ["PI_CODING_AGENT_DIR", "HOME", "PI_GUARD"].map((name) => ({
		name,
		sha256: digest(process.env[name] ?? null),
	}));
}

function containsCredential(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(
		([key, entry]) =>
			/^(api[_-]?key|secret|token|password|auth|authorization|authentication|authref|headers|access[_-]?token|refresh[_-]?token)$/i.test(
				key,
			) || containsCredential(entry),
	);
}

/** Records bytes from the actual config loaders, never a later filesystem scan. */
export class ConfigurationCapture {
	readonly files = new Map<
		string,
		{ realpath: string; sha256: string } | null
	>();
	unbacked = false;
	observe = (path: string, contents: string | undefined): void => {
		if (contents === undefined) {
			this.files.set(path, null);
			return;
		}
		if (
			path.endsWith("settings.json") &&
			containsCredential(JSON.parse(contents))
		)
			this.unbacked = true;
		this.files.set(path, {
			realpath: realpathSync(path),
			sha256: sha256(contents),
		});
	};
	unchanged(): boolean {
		try {
			return [...this.files].every(([path, entry]) =>
				entry === null
					? !existsSync(path)
					: realpathSync(path) === entry.realpath &&
						sha256(readFileSync(path)) === entry.sha256,
			);
		} catch {
			return false;
		}
	}
	references(): FileReference[] {
		return [...this.files.values()]
			.flatMap((entry) =>
				entry ? [{ path: entry.realpath, sha256: entry.sha256 }] : [],
			)
			.sort((a, b) => a.path.localeCompare(b.path));
	}
}

function replayState(cwd: string) {
	const capture = new ConfigurationCapture();
	const loaded = loadConfig(capture.observe);
	const project = loadProjectConfig(cwd, capture.observe);
	const context: GuardContext = {
		config: loaded.config,
		staticPolicy: {
			userRules: loaded.config.rules,
			projectRules: project?.config.rules ?? {},
			envRules: loaded.envRules,
			projectConfigPresent: project !== null,
		},
		activeProfile: undefined,
		sessionRules: {},
		exactSessionGrants: [],
	};
	return {
		capture,
		context,
		reviewer: loaded.reviewer,
		invalid: Boolean(
			loaded.warning ||
				loaded.reviewerError ||
				project?.warning ||
				capture.unbacked,
		),
	};
}

function policyState(context: GuardContext, reviewer: ReviewerConfig) {
	return {
		policy: buildPolicySnapshot(context),
		config: context.config,
		reviewer,
	};
}

function isRequest(value: unknown): value is SnapshotRequest {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<SnapshotRequest>;
	return (
		r.version === 1 &&
		r.protectionId === "pi-agent-guard" &&
		typeof r.requestId === "string" &&
		r.requestId.length > 0 &&
		typeof r.expectedSessionId === "string" &&
		typeof r.targetCwd === "string" &&
		typeof r.respond === "function"
	);
}

/** One controller belongs to one real registered Guard, never a standalone tool. */
export class ProtectionSnapshot {
	private ctx: ExtensionContext | undefined;
	private sessionId: string | undefined;
	private generation = 0;
	private lifecycle: UnsupportedReason | undefined = "NOT_INITIALIZED";
	private mutated = false;
	private observed: string | undefined;
	private readonly initialState: string;
	private readonly initialEnv = environment();
	private readonly code = loadedCode();
	private readonly requests = new Set<string>();
	private busy = 0;

	private readonly context: GuardContext;
	private readonly reviewer: ReviewerConfig;
	private readonly startupCwd: string;
	private readonly capture: ConfigurationCapture;
	private readonly unbacked: boolean;
	private readonly hasRuntimeState: () => boolean;

	constructor(
		pi: ExtensionAPI,
		context: GuardContext,
		reviewer: ReviewerConfig,
		startupCwd: string,
		capture: ConfigurationCapture,
		unbacked: boolean,
		hasRuntimeState: () => boolean,
	) {
		this.context = context;
		this.reviewer = reviewer;
		this.startupCwd = startupCwd;
		this.capture = capture;
		this.unbacked = unbacked;
		this.hasRuntimeState = hasRuntimeState;
		this.initialState = digest(policyState(context, reviewer));
		// Older test doubles do not expose on; actual Pi EventBus always does.
		pi.events.on?.(PROTECTION_SNAPSHOT_EVENT, (request) =>
			this.respond(request),
		);
	}

	beginSession(): void {
		this.lifecycle = "NOT_INITIALIZED";
		this.generation++;
		this.ctx = undefined;
	}
	failed(): void {
		this.lifecycle = "INITIALIZATION_FAILED";
		this.generation++;
	}
	endSession(): void {
		this.beginSession();
	}
	unsupportedLifecycle(): void {
		this.lifecycle = "RUNTIME_MUTATION";
		this.generation++;
	}
	started(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.lifecycle = undefined;
		this.mutated = false;
		this.observed = undefined;
		this.observe();
	}
	beginOperation(): void {
		this.busy++;
		this.generation++;
	}
	endOperation(): void {
		this.busy--;
		this.observe();
	}
	observe(): void {
		if (!this.ctx) return;
		try {
			const current = digest({
				state: policyState(this.context, this.reviewer),
				runtime: this.hasRuntimeState(),
				override: readSessionModelOverride(this.ctx.sessionManager.getBranch()),
				model: this.reviewerModel(this.ctx),
			});
			if (this.observed !== undefined && this.observed !== current) {
				this.mutated = true;
				this.generation++;
			}
			this.observed = current;
		} catch {
			if (!this.mutated) this.generation++;
			this.mutated = true;
		}
	}

	private reviewerModel(ctx: ExtensionContext): unknown {
		if (this.reviewer.mode === "off") return { mode: "off" };
		const resolution = resolveReviewerModel(this.reviewer, ctx);
		const model = resolution.model;
		if (!model || resolution.error) return undefined;
		// Never serialize model headers, credentials, auth references or errors.
		const url = new URL(model.baseUrl);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(model.headers && Object.keys(model.headers).length)
		)
			return undefined;
		const provider = getProviders().find((name) => name === model.provider);
		const builtin = provider
			? getModels(provider).find((candidate) => candidate.id === model.id)
			: undefined;
		if (!builtin || digest(builtin) !== digest(model)) return undefined;
		return builtin;
	}

	private reason(request: SnapshotRequest): UnsupportedReason | undefined {
		if (this.lifecycle) return this.lifecycle;
		const ctx = this.ctx;
		if (
			!ctx ||
			this.sessionId !== request.expectedSessionId ||
			ctx.sessionManager.getSessionId() !== this.sessionId
		)
			return "SESSION_MISMATCH";
		this.observe();
		if (!buildPolicySnapshot(this.context).guardEnabled) return "DISABLED";
		if (
			this.busy ||
			this.mutated ||
			this.hasRuntimeState() ||
			this.context.sessionEnabled !== undefined ||
			this.context.activeProfile !== undefined ||
			Object.keys(this.context.sessionRules).length ||
			this.context.exactSessionGrants.length ||
			readSessionModelOverride(ctx.sessionManager.getBranch()).kind !== "none"
		)
			return "RUNTIME_MUTATION";
		if (this.unbacked || this.capture.unbacked || !this.code)
			return "UNBACKED_CONFIGURATION";
		if (
			!referencesUnchanged(this.code) ||
			!this.capture.unchanged() ||
			digest(environment()) !== digest(this.initialEnv) ||
			process.env.PI_CODING_AGENT_DIR !==
				CONFIG_LOCATION_ENV.PI_CODING_AGENT_DIR ||
			process.env.HOME !== CONFIG_LOCATION_ENV.HOME
		)
			return "CONFIG_DRIFT";
		const replayReason = this.verifyReplay(request, ctx);
		if (replayReason) return replayReason;
		if (digest(policyState(this.context, this.reviewer)) !== this.initialState)
			return "RUNTIME_MUTATION";
		if (
			this.reviewer.mode !== "off" &&
			(this.reviewer.model === "main" ||
				!this.reviewerModel(ctx) ||
				existsSync(join(dirname(GLOBAL_SETTINGS_PATH), "models.json")))
		)
			return "UNBACKED_CONFIGURATION";
	}

	private verifyReplay(
		request: SnapshotRequest,
		ctx: ExtensionContext,
	): UnsupportedReason | undefined {
		try {
			if (
				!statSync(request.targetCwd).isDirectory() ||
				realpathSync(request.targetCwd) !== request.targetCwd
			)
				return "CWD_UNREPRODUCIBLE";
		} catch {
			return "CWD_UNREPRODUCIBLE";
		}
		const parent = replayState(this.startupCwd);
		if (
			parent.invalid ||
			digest(parent.capture.references()) !==
				digest(this.capture.references()) ||
			digest(policyState(parent.context, parent.reviewer)) !== this.initialState
		)
			return "CONFIG_DRIFT";
		const target = replayState(request.targetCwd);
		if (
			realpathSync(request.targetCwd) !== request.targetCwd ||
			realpathSync(ctx.cwd) !== realpathSync(this.startupCwd) ||
			target.invalid ||
			digest(policyState(target.context, target.reviewer)) !==
				this.initialState ||
			digest(
				[...target.capture.files].map(([path, entry]) => [
					path === getProjectSettingsPath(request.targetCwd)
						? getProjectSettingsPath(this.startupCwd)
						: path,
					entry?.sha256 ?? null,
				]),
			) !==
				digest(
					[...this.capture.files].map(([path, entry]) => [
						path,
						entry?.sha256 ?? null,
					]),
				)
		)
			return "CWD_UNREPRODUCIBLE";
	}

	private respond(value: unknown): void {
		if (!isRequest(value) || this.requests.has(value.requestId)) return;
		this.requests.add(value.requestId);
		const identity: ResponseIdentity = {
			version: 1,
			protectionId: "pi-agent-guard",
			requestId: value.requestId,
		};
		let response: SnapshotResponse;
		try {
			const reason = this.reason(value);
			const ctx = this.ctx;
			if (reason || !ctx || !this.code || !this.sessionId)
				response = {
					...identity,
					status: "unsupported",
					reason: reason ?? "NOT_INITIALIZED",
				};
			else {
				const stateDigest = digest({
					state: policyState(this.context, this.reviewer),
					model: this.reviewerModel(ctx),
				});
				response = {
					...identity,
					status: "ready",
					binding: {
						cwd: realpathSync(ctx.cwd),
						sessionId: this.sessionId,
						generation: this.generation,
					},
					enabled: true,
					initialized: true,
					stateDigest,
					codeFiles: structuredClone(this.code),
					configurationFiles: this.capture.references(),
					environment: structuredClone(this.initialEnv),
					replay: {
						kind: "file-backed",
						verifiedCwd: value.targetCwd,
						stateDigest,
					},
				};
			}
		} catch {
			response = {
				...identity,
				status: "unsupported",
				reason: "UNBACKED_CONFIGURATION",
			};
		}
		// A consumer callback throwing must never trigger a second response.
		value.respond(response);
	}
}
