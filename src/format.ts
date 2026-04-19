import type { Redirect, Word } from "unbash";
import type { CommandRef } from "./types.ts";

export const FORMAT_COMMAND_DEFAULT_MAX_LENGTH = 120;
export const FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH = 40;

export function truncate(s: string, maxLength: number): string {
	return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
}

/**
 * Format an extracted command for display.
 *
 * Re-serializes from AST tokens, preserving original quoting via source slices.
 * The command name is always shown verbatim. If the full command fits, it is
 * shown unchanged. Otherwise, the formatter starts from the full display and
 * shrinks later tokens only as much as needed to fit within maxLength:
 *   - Path-like tokens get path-aware middle elision that preserves the tail.
 *   - Other tokens are prefix-truncated with "…".
 *   - argMaxLength acts as the minimum per-token elision target, not a hard cap
 *     when there is still room in the overall maxLength budget.
 * If the total result still exceeds maxLength, it is hard-truncated with "…".
 */
export function formatCommand(
	cmd: CommandRef,
	options?: { maxLength?: number; argMaxLength?: number },
): string {
	const maxLength = options?.maxLength ?? FORMAT_COMMAND_DEFAULT_MAX_LENGTH;
	const argMaxLength =
		options?.argMaxLength ?? FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH;

	const name = displayWord(cmd.node.name, cmd.source).replace(/\n/g, "↵");
	const tokenSpecs = [
		...cmd.node.suffix.map((arg) => {
			const full = displayWord(arg, cmd.source).replace(/\n/g, "↵");
			return makeTokenSpec(full, argMaxLength);
		}),
		...cmd.node.redirects.map((redirect) => {
			if (isRenderableHeredoc(redirect)) {
				const full = renderFullHeredoc(redirect, cmd.source);
				const min = renderElidedHeredoc(redirect, cmd.source, argMaxLength);
				return makeTokenSpec(full, argMaxLength, min);
			}
			const full = renderRedirect(redirect, cmd.source).replace(/\n/g, "↵");
			return makeTokenSpec(full, argMaxLength);
		}),
	];

	const fullDisplay = [name, ...tokenSpecs.map((spec) => spec.full)].join(" ");
	if (fullDisplay.length <= maxLength) return fullDisplay;

	const tokens = tokenSpecs.map((spec) => spec.full);
	let overflow = fullDisplay.length - maxLength;

	for (let i = tokenSpecs.length - 1; i >= 0 && overflow > 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: i is in bounds by loop guard
		const spec = tokenSpecs[i]!;
		// biome-ignore lint/style/noNonNullAssertion: i is in bounds by loop guard
		const current = tokens[i]!;
		const maxShrink = current.length - spec.min.length;
		if (maxShrink <= 0) continue;

		const nextTargetLength = current.length - Math.min(maxShrink, overflow);
		const shrunk = spec.shrink(nextTargetLength);
		tokens[i] = shrunk;
		overflow -= current.length - shrunk.length;
	}

	return truncate([name, ...tokens].join(" "), maxLength);
}

function isRenderableHeredoc(redirect: Redirect): boolean {
	return (
		(redirect.operator === "<<" || redirect.operator === "<<-") &&
		redirect.content != null
	);
}

function renderRedirect(redirect: Redirect, source: string): string {
	const prefix = redirectPrefix(redirect);
	const target = redirect.target ? displayWord(redirect.target, source) : "";
	return `${prefix}${target}`;
}

function heredocPrefix(redirect: Redirect, source: string): string {
	return `${redirectPrefix(redirect)}${heredocTargetDisplay(redirect, source)}↵`;
}

function renderFullHeredoc(redirect: Redirect, source: string): string {
	return `${heredocPrefix(redirect, source)}${(redirect.content ?? "").replace(/\n/g, "↵")}${heredocMarker(redirect, source)}`;
}

function renderElidedHeredoc(
	redirect: Redirect,
	source: string,
	argMaxLength: number,
): string {
	const prefix = heredocPrefix(redirect, source);
	const content = (redirect.content ?? "").replace(/\n/g, "↵");
	const full = content + heredocMarker(redirect, source);

	if (full.length <= argMaxLength) {
		return prefix + full;
	}

	return `${prefix}${content.slice(0, argMaxLength)}…`;
}

function redirectPrefix(redirect: Redirect): string {
	const fd =
		redirect.fileDescriptor != null ? String(redirect.fileDescriptor) : "";
	const variableName = redirect.variableName
		? `{${redirect.variableName}}`
		: "";
	return `${fd}${variableName}${redirect.operator}`;
}

function heredocTargetDisplay(redirect: Redirect, source: string): string {
	const marker = rawHeredocMarker(redirect, source);
	return redirect.heredocQuoted ? `'${marker}'` : marker;
}

function heredocMarker(redirect: Redirect, source: string): string {
	return rawHeredocMarker(redirect, source).replaceAll("\\", "");
}

function rawHeredocMarker(redirect: Redirect, source: string): string {
	if (!redirect.target) return "";
	const raw = displayWord(redirect.target, source);
	return raw.length > 0 ? raw : (redirect.target.value ?? redirect.target.text);
}

function displayWord(word: Word | undefined, source: string): string {
	if (!word) return "";
	const sliced = source.slice(word.pos, word.end);
	return sliced.length > 0 ? sliced : word.text;
}

function makeTokenSpec(
	full: string,
	argMaxLength: number,
	min = elideToken(full, argMaxLength),
): { full: string; min: string; shrink: (targetLength: number) => string } {
	return {
		full,
		min,
		shrink: (targetLength: number) => shrinkToken(full, targetLength, min),
	};
}

function elideToken(token: string, argMaxLength: number): string {
	if (isPathToken(token)) {
		const elided = elidePath(token);
		return elided.length < token.length ? elided : token;
	}
	if (token.length > argMaxLength) {
		return `${token.slice(0, argMaxLength)}…`;
	}
	return token;
}

function shrinkToken(token: string, targetLength: number, min: string): string {
	if (token.length <= targetLength) return token;
	if (targetLength <= min.length) return min;
	if (targetLength <= 1) return "…";
	if (isPathToken(token)) return shrinkPathToken(token, targetLength);
	return truncate(token, targetLength);
}

/**
 * Path-like detection using character composition.
 * A token is considered path-like if:
 *   - It contains a slash (required)
 *   - It is not a URL (no ://)
 *   - After stripping surrounding quotes, the non-space characters are
 *     ≥85% path-safe ([a-zA-Z0-9/._~$@%+=,:-]) — handles bare relative
 *     paths like packages/tui/src/terminal.ts and quoted paths with $
 *     like "$PROJECT_ROOT/src/routes/$page.tsx"
 *   - Spaces don't exceed 10% of the inner length (guards against sentences
 *     that happen to contain a slash)
 */
function isPathToken(token: string): boolean {
	if (!token.includes("/")) return false;
	if (token.includes("://")) return false;
	const inner = token.replace(/^["']|["']$/g, "");
	const spaces = (inner.match(/ /g) ?? []).length;
	if (spaces / inner.length > 0.1) return false;
	const nonSpace = inner.replace(/ /g, "");
	if (nonSpace.length === 0) return false;
	const safe = (nonSpace.match(/[a-zA-Z0-9/._~$@%+=,:-]/g) ?? []).length;
	return safe / nonSpace.length >= 0.85;
}

/**
 * Path-aware elision: keep the first two segments and the last.
 * /Users/jdiamond/code/pi-unbash → /Users/…/pi-unbash
 */
function elidePath(p: string): string {
	const parts = p.split("/");
	if (parts.length <= 3) return p;
	return `${parts.slice(0, 2).join("/")}/…/${parts[parts.length - 1]}`;
}

function shrinkPathToken(token: string, targetLength: number): string {
	const lastSlash = token.lastIndexOf("/");
	if (lastSlash <= 0) {
		return truncate(token, targetLength);
	}

	const suffix = token.slice(lastSlash);
	const prefixBudget = targetLength - suffix.length - 1;
	if (prefixBudget <= 0) {
		return truncate(token, targetLength);
	}

	return `${token.slice(0, prefixBudget)}…${suffix}`;
}
