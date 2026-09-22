import { randomUUID } from "node:crypto";
import { Type } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@mariozechner/pi-coding-agent";

const ENTRY_TYPE = "pi-guard-required-decision";

interface DecisionOption {
	key: string;
	label: string;
}

interface DecisionRequest {
	id: string;
	sessionId: string;
	question: string;
	reason: string;
	options: DecisionOption[];
}

interface DecisionEntry {
	status: "pending" | "submitted" | "answered" | "cancelled";
	request: DecisionRequest;
	answerText?: string;
}

interface AnswerDelivery {
	request: DecisionRequest;
	text: string;
}

function validOption(option: unknown): option is DecisionOption {
	if (!option || typeof option !== "object") return false;
	const item = option as Record<string, unknown>;
	return (
		typeof item.key === "string" &&
		/^[a-z][a-z0-9_-]*$/.test(item.key) &&
		typeof item.label === "string" &&
		Boolean(item.label.trim())
	);
}

function validInput(
	input: unknown,
): input is Pick<DecisionRequest, "question" | "reason" | "options"> {
	if (!input || typeof input !== "object") return false;
	const value = input as Record<string, unknown>;
	if (typeof value.question !== "string" || !value.question.trim())
		return false;
	if (typeof value.reason !== "string" || !value.reason.trim()) return false;
	if (!Array.isArray(value.options) || value.options.length < 2) return false;
	const keys = new Set<string>();
	for (const option of value.options) {
		if (!validOption(option) || keys.has(option.key)) return false;
		keys.add(option.key);
	}
	return true;
}

function requestText(request: DecisionRequest): string {
	return [
		`Decision required (${request.id})`,
		request.question,
		`Reason: ${request.reason}`,
		...request.options.map((option) => `${option.key}: ${option.label}`),
	].join("\n");
}

function toolResult(message: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: message }],
		details,
		isError,
	};
}

function hasDecisionSibling(ctx: ExtensionContext): boolean {
	const latestAssistant = ctx.sessionManager
		.getBranch()
		.findLast(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
	if (
		latestAssistant?.type !== "message" ||
		latestAssistant.message.role !== "assistant"
	)
		return false;
	return latestAssistant.message.content.some(
		(part) =>
			part.type === "toolCall" && part.name === "guard_require_decision",
	);
}

type BranchEntry = ReturnType<
	ExtensionContext["sessionManager"]["getBranch"]
>[number];

function isDeliveredAnswer(
	entry: BranchEntry,
	text: string | undefined,
): boolean {
	if (!text || entry.type !== "message" || entry.message.role !== "user")
		return false;
	const content = entry.message.content;
	return typeof content === "string"
		? content === text
		: content.some((part) => part.type === "text" && part.text === text);
}

function decisionEntry(
	entry: BranchEntry,
	sessionId: string,
): DecisionEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) return;
	const data = entry.data as DecisionEntry | undefined;
	if (
		!data?.request ||
		data.request.sessionId !== sessionId ||
		!validInput(data.request)
	)
		return;
	return data;
}

export class RequiredDecisionController {
	private readonly pi: ExtensionAPI;
	private pending: DecisionRequest | undefined;
	private reservedCallId: string | undefined;
	private dialogAbort: AbortController | undefined;
	private delivery: AnswerDelivery | undefined;
	private completedDelivery: DecisionRequest | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	registerTool(): void {
		this.pi.registerTool({
			name: "guard_require_decision",
			label: "Require user decision",
			description:
				"Stop and ask the human for a required decision. This tool never authorizes or executes another action. Call it alone, with a concrete question, why the decision is needed, and distinct answer options.",
			promptSnippet: "Stop for a required human decision before continuing",
			promptGuidelines: [
				"Call guard_require_decision alone when only the human can decide; do not include other work tools in the same assistant message.",
				"The answer is not a permission grant. Recheck pi-guard for later actions.",
			],
			parameters: Type.Object({
				question: Type.String(),
				reason: Type.String(),
				options: Type.Array(
					Type.Object({ key: Type.String(), label: Type.String() }),
					{ minItems: 2 },
				),
			}),
			execute: (toolCallId, _params, signal, _onUpdate, ctx) =>
				this.execute(toolCallId, signal, ctx),
		});
	}

	preflight(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): { block: true; reason: string } | undefined {
		if (
			event.toolName !== "guard_require_decision" &&
			hasDecisionSibling(ctx)
		) {
			return {
				block: true,
				reason:
					"[Blocked by pi-guard: guard_require_decision must be the only tool call in this assistant message]",
			};
		}
		if (this.pending || this.reservedCallId) {
			return {
				block: true,
				reason: `[Blocked by pi-guard: Required user decision ${this.pending?.id ?? "is starting"} is pending]`,
			};
		}
		if (event.toolName !== "guard_require_decision") return;
		if (!validInput(event.input)) {
			return {
				block: true,
				reason:
					"[Blocked by pi-guard: Decision requires a non-empty question and reason, plus at least two distinct keyed options]",
			};
		}
		this.pending = {
			id: randomUUID(),
			sessionId: ctx.sessionManager.getSessionId(),
			question: event.input.question.trim(),
			reason: event.input.reason.trim(),
			options: event.input.options.map((option) => ({
				key: option.key,
				label: option.label.trim(),
			})),
		};
		this.reservedCallId = event.toolCallId;
		return;
	}

	toolResult(toolName: string, toolCallId: string): void {
		// Another extension may block the reserved call after our preflight. In
		// that case execute never runs, so release the reservation on its result.
		if (
			toolName === "guard_require_decision" &&
			this.reservedCallId === toolCallId
		) {
			this.reservedCallId = undefined;
			this.pending = undefined;
		}
	}

	private persist(
		status: DecisionEntry["status"],
		request: DecisionRequest,
		answerText?: string,
	): void {
		this.pi.appendEntry(ENTRY_TYPE, {
			status,
			request,
			...(answerText ? { answerText } : {}),
		} satisfies DecisionEntry);
	}

	private async execute(
		toolCallId: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) {
		const request = this.pending;
		if (
			!request ||
			this.reservedCallId !== toolCallId ||
			request.sessionId !== ctx.sessionManager.getSessionId()
		) {
			return toolResult(
				"Decision request is stale or belongs to another session.",
				{},
				true,
			);
		}
		this.reservedCallId = undefined;
		const generation = this.generation;
		this.persist("pending", request);
		const text = requestText(request);
		if (!ctx.hasUI) {
			// Pi exposes abort as a fire-and-forget action. Waiting for it here deadlocks
			// because the tool itself is part of the active agent turn.
			const persisted = Boolean(ctx.sessionManager.getSessionFile());
			const resume = persisted
				? "Resume this saved session and use"
				: "This session has no durable storage; the request is lost when Pi exits. While Pi is still running, use";
			const feedback = `${text}\n\nThe turn has stopped. ${resume} /guard answer ${request.id} <option-key> [context]. No answer has been assumed.`;
			// Print text mode only emits final assistant text, not tool results. Stderr
			// remains visible there and does not corrupt JSON mode's stdout stream.
			console.error(`[pi-guard] ${feedback}`);
			ctx.abort();
			return toolResult(feedback, {
				requestId: request.id,
				status: "pending",
				persisted,
			});
		}
		const controller = new AbortController();
		this.dialogAbort = controller;
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) controller.abort();
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				text,
				[
					...request.options.map((option) => `${option.key}: ${option.label}`),
					"Cancel",
				],
				{ signal: controller.signal },
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.dialogAbort === controller) this.dialogAbort = undefined;
		}
		if (generation !== this.generation || this.pending?.id !== request.id) {
			return toolResult(
				"Decision request was interrupted by a session or branch change.",
				{ requestId: request.id, status: "interrupted" },
				true,
			);
		}
		if (controller.signal.aborted || !choice || choice === "Cancel") {
			this.persist("cancelled", request);
			this.pending = undefined;
			return toolResult(
				`Decision ${request.id} cancelled. No answer or permission was granted.`,
				{ requestId: request.id, status: "cancelled" },
			);
		}
		const selected = request.options.find(
			(option) => choice === `${option.key}: ${option.label}`,
		);
		if (!selected) {
			this.persist("cancelled", request);
			this.pending = undefined;
			return toolResult(
				`Decision ${request.id} received an invalid UI response and was cancelled.`,
				{ requestId: request.id, status: "cancelled" },
				true,
			);
		}
		this.persist("answered", request);
		this.pending = undefined;
		return toolResult(
			`The human selected ${selected.key}: ${selected.label} for decision ${request.id}. This does not authorize any tool action.`,
			{
				requestId: request.id,
				status: "answered",
				answer: selected.key,
			},
		);
	}

	answer(
		target: string,
		ctx: ExtensionCommandContext,
	): { ok: boolean; message: string } {
		const [id, key, ...contextParts] = target.trim().split(/\s+/);
		const request = this.pending;
		if (!id || !key)
			return {
				ok: false,
				message: "Usage: /guard answer <request-id> <option-key> [context]",
			};
		if (
			!request ||
			request.id !== id ||
			request.sessionId !== ctx.sessionManager.getSessionId()
		) {
			return {
				ok: false,
				message: "No pending decision with that ID in this session and branch.",
			};
		}
		if (this.dialogAbort || this.reservedCallId)
			return {
				ok: false,
				message: "Use the active decision dialog to answer this request.",
			};
		if (this.delivery) {
			return {
				ok: false,
				message:
					"The answer is being delivered. If no turn starts, resume this session and retry the command.",
			};
		}
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
			return {
				ok: false,
				message:
					"Wait for the current turn to stop before answering this decision.",
			};
		}
		const option = request.options.find((item) => item.key === key);
		if (!option)
			return {
				ok: false,
				message: `Unknown answer option. Choose: ${request.options.map((item) => item.key).join(", ")}`,
			};
		if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
			return {
				ok: false,
				message:
					"Select a model with configured authentication before answering. The decision remains pending.",
			};
		}
		const context = contextParts.join(" ");
		const answerText = `I answer decision ${id}: ${option.key} (${option.label}).${context ? ` Additional context: ${context}` : ""} Continue with this answer. It does not grant permission for any tool action.`;
		this.persist("submitted", request, answerText);
		this.delivery = { request, text: answerText };
		this.pi.sendUserMessage(answerText);
		return { ok: true, message: `Decision ${id} submitted: ${option.key}.` };
	}

	input(
		text: string,
		source: string,
		ctx: ExtensionContext,
	): { action: "handled" } | undefined {
		if (!this.pending) return;
		if (source === "extension" && this.delivery?.text === text) return;
		ctx.ui.notify(
			`Decision ${this.pending.id} is pending. Use /guard answer ${this.pending.id} <option-key> [context] first.`,
			"warning",
		);
		return { action: "handled" };
	}

	userMessage(content: unknown): void {
		const delivery = this.delivery;
		if (!delivery || !Array.isArray(content)) return;
		if (
			!content.some(
				(part) => part?.type === "text" && part.text === delivery.text,
			)
		)
			return;
		if (this.pending?.id !== delivery.request.id) return;
		this.pending = undefined;
		this.delivery = undefined;
		this.completedDelivery = delivery.request;
	}

	assistantMessageStarted(): void {
		if (!this.completedDelivery) return;
		this.persist("answered", this.completedDelivery);
		this.completedDelivery = undefined;
	}

	restore(ctx: ExtensionContext): void {
		this.sessionChanged();
		const sessionId = ctx.sessionManager.getSessionId();
		let submittedText: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (isDeliveredAnswer(entry, submittedText)) {
				this.pending = undefined;
				submittedText = undefined;
				continue;
			}
			const data = decisionEntry(entry, sessionId);
			if (!data) continue;
			this.pending =
				data.status === "pending" || data.status === "submitted"
					? data.request
					: undefined;
			submittedText = data.status === "submitted" ? data.answerText : undefined;
		}
		if (this.pending)
			ctx.ui.notify(
				`${requestText(this.pending)}\n\nAnswer with /guard answer ${this.pending.id} <option-key> [context].`,
				"warning",
			);
	}

	sessionChanged(): void {
		this.generation++;
		if (this.dialogAbort && this.pending) {
			this.persist("cancelled", this.pending);
		}
		this.dialogAbort?.abort();
		this.dialogAbort = undefined;
		this.pending = undefined;
		this.reservedCallId = undefined;
		this.delivery = undefined;
		this.completedDelivery = undefined;
	}
}
