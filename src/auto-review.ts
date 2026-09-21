import { createHash, randomUUID } from "node:crypto";
import type { Usage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
	type ApprovalOutcome,
	type ApprovalPresentation,
	approvalOptions,
	askApproval,
} from "./approval-dialog.ts";
import {
	GLOBAL_SETTINGS_PATH,
	getProjectSettingsPath,
	isConfigWritable,
	saveRules,
} from "./config.ts";
import { type EvaluatedToolCall, evaluateToolCall } from "./evaluator.ts";
import { enforceToolEvaluation } from "./handlers.ts";
import { buildPolicySnapshot } from "./policy.ts";
import { getCommandName } from "./resolve.ts";
import {
	createReviewerRequest,
	type ReviewerAlternative,
	type ReviewerResult,
	reviewGuardRequest,
} from "./reviewer.ts";
import type { ReviewerConfig } from "./reviewer-config.ts";
import {
	type ReviewerModelResolution,
	resolveReviewerModel,
} from "./reviewer-model.ts";
import type { GuardContext, PolicySnapshot } from "./types.ts";

type Review = typeof reviewGuardRequest;
type Ask = typeof askApproval;

interface DeniedRequest {
	identity: string;
	requestId: string;
	sessionId: string;
	policyVersion: string;
	modelKey: string;
	approved: boolean;
}

interface PendingContext {
	text: string;
}

export interface AutoReviewDependencies {
	review?: Review;
	ask?: Ask;
	now?: () => number;
}

interface ReviewRun {
	event: ToolCallEvent;
	ctx: ExtensionContext;
	snapshot: PolicySnapshot;
	evaluated: EvaluatedToolCall;
	model: ReviewerModelResolution;
	identity: string;
	repeatKey: string;
	requestId: string;
	started: number;
	sessionEpoch: number;
	controller: AbortController;
}

function describeReview(result: ReviewerResult, run: ReviewRun) {
	if (result.ok) {
		return {
			alternatives: alternativeDescriptions(
				result.judgment.alternatives,
				run.snapshot,
				run.ctx.cwd,
			),
			reason: result.judgment.reason,
			decision: result.judgment.decision,
			source: `reviewer ${result.judgment.decision}`,
			model: result.model,
		};
	}
	return {
		alternatives: [],
		reason: result.reason,
		decision: "ask" as const,
		source: `reviewer ${result.error}`,
		model: run.model.setting,
	};
}

function identity(
	evaluated: EvaluatedToolCall,
	snapshot: PolicySnapshot,
	config: ReviewerConfig,
	modelKey: string,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				tool: evaluated.result.tool,
				input: evaluated.result.input,
				cwd: evaluated.result.cwd,
				policyVersion: snapshot.policyVersion,
				mode: config.mode,
				policy: config.policy,
				modelKey,
				reviewTimeoutMs: config.reviewTimeoutMs,
				approvalTimeoutMs: config.approvalTimeoutMs,
			}),
		)
		.digest("hex");
}

function reviewerModelKey(model: ReviewerModelResolution): string {
	return `${model.setting}:${model.model?.provider ?? "none"}/${model.model?.id ?? "none"}:${model.error ?? ""}`;
}

function blocked(
	source: string,
	requestId: string,
	reason: string,
	alternatives: string[] = [],
): ToolCallEventResult {
	return {
		block: true,
		reason: `[Blocked by pi-guard: ${source}; request ${requestId}; ${reason}${alternatives.length ? `\nAlternatives (not executed):\n${alternatives.join("\n")}` : ""}]`,
	};
}

function alternativeDescriptions(
	alternatives: ReviewerAlternative[],
	snapshot: PolicySnapshot,
	cwd: string,
): string[] {
	return alternatives.slice(0, 3).map((alternative, index) => {
		const checked = evaluateToolCall(
			snapshot,
			"bash",
			alternative.input,
			cwd,
		).result;
		return `${index + 1}. ${alternative.input.command} — ${alternative.reason}; changed effect: ${alternative.changedEffect}; guard: ${checked.disposition}${checked.parserError || checked.inputError ? ` (${checked.parserError ?? checked.inputError})` : ""}`;
	});
}

function retryMessage(reason: string, requestId: string): ToolCallEventResult {
	return blocked("stale decision", requestId, reason);
}

/** In-memory review state is scoped to one extension instance and one Pi session. */
export class AutoReviewController {
	private readonly pi: ExtensionAPI;
	private readonly context: GuardContext;
	private readonly config: ReviewerConfig;
	private readonly deps: AutoReviewDependencies;
	private readonly denied = new Map<string, DeniedRequest>();
	private readonly repeats = new Map<string, string>();
	private readonly pending = new Map<string, PendingContext>();
	private readonly inFlight = new Map<string, AbortController>();
	private userEpoch = 0;
	private sessionEpoch = 0;

	constructor(
		pi: ExtensionAPI,
		context: GuardContext,
		config: ReviewerConfig,
		deps: AutoReviewDependencies = {},
	) {
		this.pi = pi;
		this.context = context;
		this.config = config;
		this.deps = deps;
	}

	newUserInput(): void {
		this.userEpoch++;
		this.repeats.clear();
	}

	abortPending(): void {
		this.sessionEpoch++;
		for (const controller of this.inFlight.values()) controller.abort();
		this.inFlight.clear();
		this.pending.clear();
	}

	branchChanged(): void {
		this.abortPending();
		this.userEpoch++;
		this.denied.clear();
		this.repeats.clear();
	}

	sessionChanged(): void {
		this.abortPending();
		this.userEpoch++;
		this.denied.clear();
		this.repeats.clear();
		this.context.exactSessionGrants = [];
		this.context.sessionRules = {};
	}

	approve(
		requestId: string,
		ctx: ExtensionContext,
	): { ok: boolean; message: string } {
		const denied = this.denied.get(requestId);
		if (
			!denied ||
			denied.approved ||
			denied.sessionId !== ctx.sessionManager.getSessionId()
		)
			return {
				ok: false,
				message: "Unknown, stale, or already approved request ID.",
			};
		if (
			denied.policyVersion !== buildPolicySnapshot(this.context).policyVersion
		)
			return {
				ok: false,
				message:
					"The policy changed; this request can no longer be overridden.",
			};
		if (
			denied.modelKey !==
			reviewerModelKey(resolveReviewerModel(this.config, ctx))
		)
			return {
				ok: false,
				message:
					"The reviewer model changed; this request can no longer be overridden.",
			};
		denied.approved = true;
		return {
			ok: true,
			message: `One-time override set for request ${requestId}. Retry the exact command in the same directory.`,
		};
	}

	private audit(
		requestId: string,
		policyVersion: string,
		model: string,
		source: string,
		outcome: string,
		elapsedMs: number,
		usage?: Usage,
		humanDecision?: string,
	): void {
		try {
			this.pi.appendEntry("pi-guard-review-audit", {
				requestId,
				policyVersion,
				model,
				source,
				outcome,
				elapsedMs,
				...(usage ? { usage } : {}),
				...(humanDecision ? { humanDecision } : {}),
			});
		} catch {
			console.warn("[pi-guard] Review audit entry could not be recorded.");
		}
	}

	private fresh(
		snapshot: PolicySnapshot,
		evaluated: EvaluatedToolCall,
		sessionEpoch: number,
		ctx: ExtensionContext,
		modelKey: string,
	): boolean {
		if (sessionEpoch !== this.sessionEpoch || ctx.cwd !== evaluated.result.cwd)
			return false;
		if (reviewerModelKey(resolveReviewerModel(this.config, ctx)) !== modelKey)
			return false;
		const current = buildPolicySnapshot(this.context);
		const now = evaluateToolCall(
			current,
			evaluated.result.tool,
			evaluated.result.input,
			evaluated.result.cwd,
		);
		return (
			current.policyVersion === snapshot.policyVersion &&
			now.result.disposition === "ask" &&
			now.result.reviewEligible
		);
	}

	private rememberRejection(
		key: string,
		result: ToolCallEventResult,
	): ToolCallEventResult {
		this.repeats.set(
			key,
			result.reason ?? "Previously denied without new information.",
		);
		return result;
	}

	private saveBroadAllow(
		evaluated: EvaluatedToolCall,
		ctx: ExtensionContext,
		scope: "project" | "global",
	): void {
		const names = [
			...new Set((evaluated.bash?.askCommands ?? []).map(getCommandName)),
		];
		const path =
			scope === "project"
				? getProjectSettingsPath(ctx.cwd)
				: GLOBAL_SETTINGS_PATH;
		this.context.sessionRules.bash = this.context.sessionRules.bash ?? {};
		if (!saveRules(path, "bash", names, "allow"))
			throw new Error(`Could not save the ${scope} rules.`);
		for (const name of names) {
			this.context.sessionRules.bash[name] = "allow";
		}
	}

	private addSessionGrant(
		evaluated: EvaluatedToolCall,
		ctx: ExtensionContext,
	): void {
		this.context.exactSessionGrants.push({
			tool: evaluated.result.tool,
			input: structuredClone(evaluated.result.input),
			cwd: ctx.cwd,
		});
	}

	private addPending(toolCallId: string, text: string): void {
		this.pending.set(toolCallId, { text });
	}

	private async callReviewer(run: ReviewRun): Promise<ReviewerResult> {
		try {
			const request = createReviewerRequest(
				run.evaluated.result,
				run.snapshot,
				run.ctx.sessionManager.getBranch(),
				run.requestId,
			);
			if (run.model.error)
				return { ok: false, error: "model", reason: run.model.error };
			return await (this.deps.review ?? reviewGuardRequest)(
				request,
				this.config,
				{ modelRegistry: run.ctx.modelRegistry, mainModel: run.ctx.model },
				run.controller.signal,
				run.model.setting,
			);
		} catch (error) {
			return {
				ok: false,
				error: "provider",
				reason: `Reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private async askUser(
		run: ReviewRun,
		result: ReviewerResult,
		alternatives: string[],
		source: string,
		reason: string,
	): Promise<{
		outcome: ToolCallEventResult | undefined;
		humanDecision: string;
	}> {
		this.pi.events.emit("nudge", { body: "Command needs approval" });
		const options = approvalOptions(
			true,
			isConfigWritable(GLOBAL_SETTINGS_PATH),
			result.ok ? result.judgment.alternatives : [],
		);
		const presentation: ApprovalPresentation = {
			command: String(run.evaluated.result.input.command ?? ""),
			cwd: run.ctx.cwd,
			recommendation: result.ok ? result.judgment.recommendation : null,
			reason: `${source}: ${reason}`,
			options,
			timeoutMs: this.config.approvalTimeoutMs,
		};
		const selected = await (this.deps.ask ?? askApproval)(
			run.ctx,
			presentation,
			run.controller.signal,
		);
		if (
			!this.fresh(
				run.snapshot,
				run.evaluated,
				run.sessionEpoch,
				run.ctx,
				reviewerModelKey(run.model),
			)
		)
			return {
				outcome: retryMessage(
					"Session or policy changed during approval; retry the command.",
					run.requestId,
				),
				humanDecision: "stale",
			};
		return {
			outcome: this.handleChoice(
				selected,
				run.requestId,
				run.repeatKey,
				run.evaluated,
				run.ctx,
				alternatives,
				reason,
			),
			humanDecision:
				selected.kind === "choice"
					? selected.choice
					: selected.kind === "timeout"
						? "approval_timeout"
						: selected.kind === "cancel"
							? "approval_cancelled"
							: selected.kind,
		};
	}

	private async finishReview(
		run: ReviewRun,
		result: ReviewerResult,
	): Promise<ToolCallEventResult | undefined> {
		const { alternatives, reason, decision, source, model } = describeReview(
			result,
			run,
		);
		let outcome: ToolCallEventResult | undefined;
		let humanDecision: string | undefined;
		if (this.config.mode === "auto" && decision === "allow") {
			this.addPending(
				run.event.toolCallId,
				`Guard request ${run.requestId}: reviewer allowed. Reason: ${reason}${alternatives.length ? `\n${alternatives.join("\n")}` : ""}`,
			);
		} else if (this.config.mode === "auto" && decision === "deny") {
			this.denied.set(run.requestId, {
				identity: run.identity,
				requestId: run.requestId,
				sessionId: run.ctx.sessionManager.getSessionId(),
				policyVersion: run.snapshot.policyVersion,
				modelKey: reviewerModelKey(run.model),
				approved: false,
			});
			outcome = this.rememberRejection(
				run.repeatKey,
				blocked("reviewer deny", run.requestId, reason, alternatives),
			);
		} else if (!run.ctx.hasUI) {
			outcome = this.rememberRejection(
				run.repeatKey,
				blocked(
					source,
					run.requestId,
					`Human approval required but no interactive session is available. ${reason}`,
					alternatives,
				),
			);
		} else {
			const answer = await this.askUser(
				run,
				result,
				alternatives,
				source,
				reason,
			);
			outcome = answer.outcome;
			humanDecision = answer.humanDecision;
			if (!outcome)
				this.addPending(
					run.event.toolCallId,
					`Guard request ${run.requestId}: human approved. Reviewer ${decision}. Reason: ${reason}`,
				);
		}
		this.audit(
			run.requestId,
			run.snapshot.policyVersion,
			model,
			source,
			outcome?.block ? "blocked" : "allowed",
			(this.deps.now ?? Date.now)() - run.started,
			result.ok ? result.usage : undefined,
			humanDecision,
		);
		return outcome;
	}

	private handleChoice(
		outcome: ApprovalOutcome,
		requestId: string,
		key: string,
		evaluated: EvaluatedToolCall,
		ctx: ExtensionContext,
		alternatives: string[],
		reviewerReason: string,
	): ToolCallEventResult | undefined {
		if (outcome.kind === "timeout")
			return this.rememberRejection(
				key,
				blocked(
					"approval_timeout",
					requestId,
					`No human response before the approval deadline. Reviewer: ${reviewerReason}`,
					alternatives,
				),
			);
		if (outcome.kind === "cancel")
			return this.rememberRejection(
				key,
				blocked(
					"approval_cancelled",
					requestId,
					`Approval was cancelled. Reviewer: ${reviewerReason}`,
					alternatives,
				),
			);
		if (outcome.kind === "feedback") {
			this.newUserInput();
			return this.rememberRejection(
				key,
				blocked(
					"human feedback",
					requestId,
					`Reviewer: ${reviewerReason} Feedback: ${outcome.text}`,
					alternatives,
				),
			);
		}
		const choice = outcome.choice;
		if (choice === "deny")
			return this.rememberRejection(
				key,
				blocked(
					"human deny",
					requestId,
					`The user denied this invocation. Reviewer: ${reviewerReason}`,
					alternatives,
				),
			);
		if (choice.startsWith("alternative-")) {
			const index = Number(choice.slice("alternative-".length));
			return this.rememberRejection(
				key,
				blocked(
					"alternative selected",
					requestId,
					`Reviewer: ${reviewerReason} ${alternatives[index] ?? "Alternative unavailable; original command was not executed."}`,
					alternatives,
				),
			);
		}
		try {
			if (choice === "allow-session") this.addSessionGrant(evaluated, ctx);
			else if (choice === "allow-project")
				this.saveBroadAllow(evaluated, ctx, "project");
			else if (choice === "allow-global")
				this.saveBroadAllow(evaluated, ctx, "global");
			else if (choice !== "allow-once")
				return this.rememberRejection(
					key,
					blocked(
						"invalid choice",
						requestId,
						"No approval was selected.",
						alternatives,
					),
				);
		} catch (error) {
			return this.rememberRejection(
				key,
				blocked(
					"approval error",
					requestId,
					`The selected rule could not be saved: ${error instanceof Error ? error.message : String(error)}`,
					alternatives,
				),
			);
		}
		return undefined;
	}

	private override(
		key: string,
		ctx: ExtensionContext,
	): DeniedRequest | undefined {
		for (const denied of this.denied.values()) {
			if (
				denied.approved &&
				denied.identity === key &&
				denied.sessionId === ctx.sessionManager.getSessionId()
			) {
				denied.approved = false;
				this.denied.delete(denied.requestId);
				return denied;
			}
		}
		return undefined;
	}

	async handle(
		event: ToolCallEvent,
		ctx: ExtensionContext,
		snapshot: PolicySnapshot,
		evaluated: EvaluatedToolCall,
		isCurrentSession: () => boolean = () => true,
	): Promise<ToolCallEventResult | undefined> {
		if (evaluated.result.disposition === "deny")
			this.audit(
				randomUUID(),
				snapshot.policyVersion,
				"none",
				"policy",
				"deny",
				0,
			);
		if (
			this.config.mode === "off" ||
			!evaluated.result.reviewEligible ||
			evaluated.result.disposition !== "ask"
		)
			return enforceToolEvaluation(
				this.pi,
				evaluated,
				ctx,
				this.context.sessionRules,
				isCurrentSession,
			);
		const model = resolveReviewerModel(this.config, ctx);
		const key = identity(
			evaluated,
			snapshot,
			this.config,
			reviewerModelKey(model),
		);
		const repeatKey = `${key}:${this.userEpoch}`;
		const prior = this.repeats.get(repeatKey);
		const override = this.override(key, ctx);
		if (override) {
			this.addPending(
				event.toolCallId,
				`Guard request ${override.requestId}: human one-time override approved.`,
			);
			return;
		}
		if (prior)
			return blocked(
				"repeated request",
				randomUUID(),
				`Unchanged request was denied earlier in this user turn: ${prior}`,
			);
		const requestId = randomUUID();
		const controller = new AbortController();
		this.inFlight.set(event.toolCallId, controller);
		const run: ReviewRun = {
			event,
			ctx,
			snapshot,
			evaluated,
			model,
			identity: key,
			repeatKey,
			requestId,
			started: (this.deps.now ?? Date.now)(),
			sessionEpoch: this.sessionEpoch,
			controller,
		};
		try {
			const result = await this.callReviewer(run);
			if (
				!this.fresh(
					snapshot,
					evaluated,
					run.sessionEpoch,
					ctx,
					reviewerModelKey(run.model),
				)
			)
				return retryMessage(
					"Session or policy changed during review; retry the command.",
					requestId,
				);
			return await this.finishReview(run, result);
		} finally {
			this.inFlight.delete(event.toolCallId);
		}
	}

	toolResult(
		event: ToolResultEvent,
	): { content?: ToolResultEvent["content"] } | undefined {
		const pending = this.pending.get(event.toolCallId);
		if (!pending) return;
		this.pending.delete(event.toolCallId);
		if (event.isError) {
			this.pi.sendMessage(
				{
					customType: "pi-guard-review-result",
					display: true,
					content: [
						{
							type: "text",
							text: `${pending.text}\nTool failed; original error remains in its tool result.`,
						},
					],
				},
				{ triggerTurn: false },
			);
			return;
		}
		this.newUserInput();
		return {
			content: [...event.content, { type: "text", text: pending.text }],
		};
	}

	toolExecutionEnd(event: { toolCallId: string; isError: boolean }): void {
		const pending = this.pending.get(event.toolCallId);
		if (!pending) return;
		this.pending.delete(event.toolCallId);
		this.pi.sendMessage(
			{
				customType: "pi-guard-review-result",
				display: true,
				content: [
					{
						type: "text",
						text: `${pending.text}\nThe call did not return through the tool-result hook${event.isError ? "; a later gate or tool error may have blocked it" : ""}.`,
					},
				],
			},
			{ triggerTurn: false },
		);
	}
}
