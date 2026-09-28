import "./loaded-code.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

export type ReviewerMode = "off" | "observe" | "auto";

/** Only global settings may select a reviewer or supply its instructions. */
export interface ReviewerConfig {
	mode: ReviewerMode;
	model: "main" | `${string}/${string}`;
	thinkingLevel: ThinkingLevel | null;
	policy: string;
	reviewTimeoutMs: number;
	approvalTimeoutMs: number | null;
}

export interface ReviewerConfigResult {
	reviewer: ReviewerConfig;
	reviewerError?: string;
}

export const DEFAULT_REVIEWER_CONFIG: ReviewerConfig = {
	mode: "off",
	model: "openai/gpt-6-luna",
	thinkingLevel: "xhigh",
	policy: "",
	reviewTimeoutMs: 60_000,
	approvalTimeoutMs: 120_000,
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Resolve plaintext once, when settings are loaded. Invalid settings disable review only. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit fail-closed checks keep each setting independently auditable.
export function loadReviewerConfigFromSettings(
	settings: unknown,
	globalSettingsDirectory: string,
	observe?: (path: string, contents: string | undefined) => void,
): ReviewerConfigResult {
	if (!record(settings) || !record(settings.guard)) {
		return { reviewer: { ...DEFAULT_REVIEWER_CONFIG } };
	}
	const raw = settings.guard.reviewer;
	if (raw === undefined) return { reviewer: { ...DEFAULT_REVIEWER_CONFIG } };
	const fail = (reason: string): ReviewerConfigResult => ({
		reviewer: { ...DEFAULT_REVIEWER_CONFIG },
		reviewerError: `Invalid global guard.reviewer: ${reason}`,
	});
	if (!record(raw)) return fail("expected an object");
	for (const key of Object.keys(raw)) {
		if (
			![
				"mode",
				"model",
				"thinkingLevel",
				"policy",
				"policyFile",
				"reviewTimeoutMs",
				"approvalTimeoutMs",
			].includes(key)
		) {
			return fail(`unknown key ${key}`);
		}
	}
	const mode = raw.mode ?? "off";
	if (mode !== "off" && mode !== "observe" && mode !== "auto")
		return fail("mode must be off, observe, or auto");
	const model = raw.model ?? DEFAULT_REVIEWER_CONFIG.model;
	if (
		typeof model !== "string" ||
		(model !== "main" && !/^[^/\s]+\/[^/\s][^\s]*$/.test(model))
	) {
		return fail("model must be main or provider/id");
	}
	const thinkingLevel =
		raw.thinkingLevel === undefined
			? DEFAULT_REVIEWER_CONFIG.thinkingLevel
			: raw.thinkingLevel;
	if (
		thinkingLevel !== null &&
		thinkingLevel !== "minimal" &&
		thinkingLevel !== "low" &&
		thinkingLevel !== "medium" &&
		thinkingLevel !== "high" &&
		thinkingLevel !== "xhigh"
	) {
		return fail(
			"thinkingLevel must be minimal, low, medium, high, xhigh, or null",
		);
	}
	if (raw.policy !== undefined && raw.policyFile !== undefined)
		return fail("set policy or policyFile, not both");
	if (raw.policy !== undefined && typeof raw.policy !== "string")
		return fail("policy must be plaintext");
	if (
		raw.policyFile !== undefined &&
		(typeof raw.policyFile !== "string" || !raw.policyFile.trim())
	) {
		return fail("policyFile must be a nonempty path");
	}
	const reviewTimeoutMs = raw.reviewTimeoutMs ?? 60_000;
	if (!positiveFinite(reviewTimeoutMs))
		return fail("reviewTimeoutMs must be positive and finite");
	const approvalTimeoutMs =
		raw.approvalTimeoutMs === undefined ? 120_000 : raw.approvalTimeoutMs;
	if (approvalTimeoutMs !== null && !positiveFinite(approvalTimeoutMs)) {
		return fail("approvalTimeoutMs must be positive and finite or null");
	}
	let policy = (raw.policy as string | undefined) ?? "";
	if (typeof raw.policyFile === "string") {
		try {
			const policyPath = path.resolve(globalSettingsDirectory, raw.policyFile);
			policy = fs.readFileSync(policyPath, "utf8");
			observe?.(policyPath, policy);
		} catch {
			return fail("policyFile could not be read");
		}
	}
	if (mode !== "off" && !policy.trim())
		return fail("observe/auto requires a nonempty policy");
	return {
		reviewer: {
			mode,
			model: model as ReviewerConfig["model"],
			thinkingLevel,
			policy,
			reviewTimeoutMs,
			approvalTimeoutMs,
		},
	};
}
