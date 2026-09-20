import { parse as parseBash } from "unbash";
import type { ExtractCtx } from "./extract.ts";
import { extractAllCommandsFromAST } from "./extract.ts";
import { formatCommand } from "./format.ts";
import { getCommandArgs, getCommandName } from "./resolve.ts";
import type { CommandRef } from "./types.ts";

interface ParserDiagnostic {
	message: string;
	pos: number;
}

interface ExpansionContext extends ExtractCtx {
	parserErrors: string[];
}

/**
 * Describes how a wrapper command embeds a sub-command.
 *
 * - "passthrough": The first non-flag/non-var-assignment argument (and everything
 *   after it) is a sub-command with its own arguments. Flags that consume a value
 *   are listed in `flagArgs` so we can skip past their values.
 *   Examples: xargs, sudo, nice, nohup, env, strace
 *
 * - "flag": A specific flag (e.g. `-c`) takes a string argument that is parsed
 *   as a bash script. The resulting commands are extracted and checked independently.
 *   Examples: bash -c, sh -c, zsh -c
 *
 * - "exec": The sub-command appears after one of `keywords` and runs until
 *   end-of-args (if `terminators` is null) or until a terminator token.
 *   Example: find . -exec rm {} \;  (keywords: ["-exec", "-ok"], terminators: [";", "\;", "+"])
 *   Example: fd . -e ts -x rm {}    (keywords: ["-x", "--exec", "-X", "--exec-batch"], terminators: null)
 */
export type WrapperSpec =
	| {
			type: "passthrough";
			flagArgs?: string[];
			skipVarAssignments?: boolean;
			separator?: string;
			skipArgs?: number;
	  }
	| { type: "flag"; flag: string; flagArgs?: string[] }
	| { type: "exec"; keywords: string[]; terminators: string[] | null };

/**
 * Registry of wrapper commands and how to extract sub-commands from them.
 * Key is the command name (as it appears in the AST).
 */
export const WRAPPER_COMMANDS: Record<string, WrapperSpec> = {
	xargs: {
		type: "passthrough",
		// Only flags that consume a separate value argument.
		// Boolean flags (-o, -p, -r, -t, -x) are intentionally omitted.
		flagArgs: [
			"-a",
			"-d",
			"-E",
			"-e",
			"-I",
			"-i",
			"-L",
			"-l",
			"-n",
			"-P",
			"-s",
		],
	},
	sudo: {
		type: "passthrough",
		// Only flags that consume a separate value argument.
		// Boolean flags (-A, -h, -K, -k, -n, -S, -V, -v) are intentionally omitted.
		flagArgs: ["-C", "-D", "-g", "-l", "-p", "-r", "-U", "-u"],
	},
	nice: { type: "passthrough", flagArgs: ["-n"] },
	nohup: { type: "passthrough" },
	env: {
		type: "passthrough",
		// -v is --debug (boolean); only flags that consume a value are listed.
		flagArgs: ["-C", "-S", "-u"],
		skipVarAssignments: true,
	},
	strace: {
		type: "passthrough",
		flagArgs: ["-o", "-O", "-p", "-S", "-e", "-E"],
	},
	// nix run ... -- cmd, nix shell ... -- cmd (-- separates nix args from command)
	nix: { type: "passthrough", separator: "--" },
	// direnv exec [DIR] COMMAND [...] — skip "exec" subcommand + directory arg
	direnv: { type: "passthrough", skipArgs: 2 },
	// devbox shellenv -c "cmd" — the -c flag's value is parsed as a shell script
	devbox: { type: "flag", flag: "-c" },
	// devenv shell -- cmd args — everything after -- is the sub-command
	devenv: { type: "passthrough", separator: "--" },
	bash: {
		type: "flag",
		flag: "-c",
		flagArgs: ["--init-file", "--rcfile", "-D"],
	},
	sh: { type: "flag", flag: "-c" },
	zsh: { type: "flag", flag: "-c" },
	find: {
		type: "exec",
		keywords: ["-exec", "-ok"],
		terminators: [";", "\\;", "+"],
	},
	fd: {
		type: "exec",
		keywords: ["-x", "--exec", "-X", "--exec-batch"],
		terminators: null,
	},
};

/** Tracks which wrapper commands had sub-commands extracted. Used by
 * formatWrapperDisplay to replace the sub-command portion with `...`. */
export type ExpansionResult = {
	commands: CommandRef[];
	expandedWrappers: Set<CommandRef>;
	parserErrors: string[];
};

/**
 * Given a list of CommandRefs, expand any wrapper commands by extracting
 * their sub-commands. The original wrapper command is kept — it still needs
 * its own rule check. Sub-commands are recursively expanded for nested wrappers
 * (e.g. `sudo xargs rm`).
 *
 * Degenerate cases (wrapper with no sub-command, e.g. bare `xargs`) are
 * silently ignored — the wrapper itself is still checked against rules.
 */
export function expandWrapperCommands(commands: CommandRef[]): ExpansionResult {
	const expandedWrappers = new Set<CommandRef>();
	// Start group IDs after the highest existing group
	const maxGroupId = commands.reduce(
		(max, cmd) => Math.max(max, cmd.group ?? 0),
		-1,
	);
	const ctx: ExpansionContext = {
		nextGroupId: maxGroupId + 1,
		parserErrors: [],
	};
	const result = doExpand(commands, expandedWrappers, ctx);
	return { commands: result, expandedWrappers, parserErrors: ctx.parserErrors };
}

function doExpand(
	commands: CommandRef[],
	expandedWrappers: Set<CommandRef>,
	ctx: ExpansionContext,
): CommandRef[] {
	const result: CommandRef[] = [...commands];

	for (const cmd of commands) {
		const name = getCommandName(cmd);
		const spec = WRAPPER_COMMANDS[name];
		if (!spec) continue;

		const subCommands = extractSubCommands(cmd, spec, ctx);
		if (subCommands.length > 0) {
			expandedWrappers.add(cmd);
			result.push(...doExpand(subCommands, expandedWrappers, ctx));
		}
	}

	return result;
}

/**
 * Extract sub-commands from a wrapper command based on its spec.
 */
function extractSubCommands(
	cmd: CommandRef,
	spec: WrapperSpec,
	ctx: ExpansionContext,
): CommandRef[] {
	switch (spec.type) {
		case "passthrough":
			return extractPassthrough(
				cmd,
				ctx,
				spec.flagArgs,
				spec.skipVarAssignments ?? false,
				spec.separator,
				spec.skipArgs,
			);
		case "flag":
			return extractFlag(cmd, ctx, spec.flag, spec.flagArgs);
		case "exec":
			return extractExec(cmd, ctx, spec.keywords, spec.terminators);
	}
}

/**
 * Scan past a passthrough wrapper's own flags to find where the sub-command starts.
 * Returns the index of the first sub-command argument, or args.length if none found.
 *
 * Handles:
 * 1. Combined short flags with value: -n1 (xargs style)
 * 2. Flags with separate values: -n 1, -u root
 * 3. Long flags with values: --rcfile=file, --rcfile file
 * 4. NAME=VALUE var assignments (for env and similar)
 * 5. Separator token: everything after `--` is the sub-command
 * 6. skipArgs: skip a fixed number of positional args after flags
 */
function separatorBoundary(
	args: string[],
	separator: string | undefined,
): number | undefined {
	if (!separator) return undefined;
	const separatorIndex = args.indexOf(separator);
	return separatorIndex >= 0 ? separatorIndex + 1 : args.length;
}

function nextPassthroughIndex(
	arg: string,
	index: number,
	args: string[],
	flagArgs: string[] | undefined,
	skipVarAssignments: boolean,
): number | undefined {
	if (skipVarAssignments && isVarAssignment(arg)) return index + 1;
	if (!arg.startsWith("-")) return undefined;

	const span = flagSpan(arg, index, args, flagArgs);
	const valueIsAssignment =
		span === 2 && skipVarAssignments && isVarAssignment(args[index + 1] ?? "");
	return index + (valueIsAssignment ? 1 : span);
}

function scanPassthroughBoundary(
	args: string[],
	flagArgs?: string[],
	skipVarAssignments = false,
	separator?: string,
	skipArgs?: number,
): number {
	// If a separator is configured, scan for it first. Everything after
	// the separator is the sub-command (even if it looks like flags).
	// If the separator is not found, there is no sub-command to extract.
	const separated = separatorBoundary(args, separator);
	if (separated !== undefined) return separated;

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;
		const next = nextPassthroughIndex(
			arg,
			i,
			args,
			flagArgs,
			skipVarAssignments,
		);
		if (next === undefined) break;
		i = next;
	}

	// After skipping flags, also skip a fixed number of positional args.
	// Used for commands like `direnv exec DIR cmd...` where the subcommand
	// and directory are positional arguments before the sub-command.
	if (skipArgs) {
		i = Math.min(i + skipArgs, args.length);
	}

	// Strip an optional `--` end-of-options separator. This is common when
	// callers want to ensure the remaining arguments are not interpreted as
	// flags by the wrapper (e.g. `direnv exec . -- kustomize version`).
	if (args[i] === "--") {
		i++;
	}

	return i;
}

function shellQuoteToken(token: string): string {
	return `'${token.replaceAll("'", `'"'"'`)}'`;
}

/**
 * For passthrough wrappers: skip the wrapper's own flags (and optionally
 * NAME=VALUE var assignments), then parse the remaining arguments as a
 * command string.
 *
 * Example: `xargs -0 rm -rf /some/dir` → parse `rm -rf /some/dir`
 */
function extractPassthrough(
	cmd: CommandRef,
	ctx: ExpansionContext,
	flagArgs?: string[],
	skipVarAssignments = false,
	separator?: string,
	skipArgs?: number,
): CommandRef[] {
	const args = getCommandArgs(cmd);
	const i = scanPassthroughBoundary(
		args,
		flagArgs,
		skipVarAssignments,
		separator,
		skipArgs,
	);
	if (i >= args.length) return [];
	return parseCommandTokens(args.slice(i), ctx);
}

/**
 * For flag-based wrappers: find the target flag and parse its string
 * argument as a bash script.
 *
 * Example: `bash -c 'rm -rf /'` → parse `rm -rf /`
 */
function extractFlag(
	cmd: CommandRef,
	ctx: ExpansionContext,
	targetFlag: string,
	flagArgs?: string[],
): CommandRef[] {
	const args = getCommandArgs(cmd);

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === targetFlag) {
			const scriptArg = args[i + 1];
			return scriptArg ? parseSubCommandString(scriptArg, ctx) : [];
		}

		if (arg?.startsWith("-")) {
			i += flagSpan(arg, i, args, flagArgs);
			continue;
		}

		// Non-flag arg before our target flag — positional argument.
		// For bash, `bash script.sh` is non-wrapped usage; stop looking.
		i++;
	}

	return [];
}

/**
 * For exec-style wrappers (find): extract command(s) between -exec/-ok
 * and their terminators (`;`, `\;`, or `+`).
 *
 * Example: `find . -name '*.ts' -exec rm {} \;` → parse `rm {}`
 */
/** Collect arguments between an exec keyword and its terminator. */
function collectExecCommand(
	args: string[],
	startIdx: number,
	terminators: string[] | null,
): { parts: string[]; nextIdx: number } {
	const parts: string[] = [];
	let i = startIdx;
	while (i < args.length) {
		const part = args[i];
		if (part === undefined) break;
		if (terminators?.includes(part)) return { parts, nextIdx: i + 1 };
		parts.push(part);
		i++;
	}
	return { parts, nextIdx: i };
}

function extractExec(
	cmd: CommandRef,
	ctx: ExpansionContext,
	keywords: string[],
	terminators: string[] | null,
): CommandRef[] {
	const args = getCommandArgs(cmd);
	const results: CommandRef[] = [];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;
		if (keywords.includes(arg)) {
			const { parts, nextIdx } = collectExecCommand(args, i + 1, terminators);
			i = nextIdx;
			if (parts.length > 0) {
				results.push(...parseCommandTokens(parts, ctx));
			}
			continue;
		}
		i++;
	}

	return results;
}

/**
 * Rebuild an argv-style embedded command without letting the shell parser
 * reinterpret its executable name as syntax or an assignment.
 */
function parseCommandTokens(
	tokens: string[],
	ctx: ExpansionContext,
): CommandRef[] {
	const [executable, ...args] = tokens;
	if (executable === undefined) return [];
	const placeholder = "__pi_guard_embedded_executable__";
	const serialized = [placeholder, ...args].map(shellQuoteToken).join(" ");
	const commands = parseSubCommandString(serialized, ctx);
	const command = commands[0];
	if (!command?.node.name) return commands;
	command.node.name = {
		pos: 0,
		end: 0,
		text: executable,
		value: executable,
		parts: [{ type: "Literal", text: executable, value: executable }],
	};
	return commands;
}

/**
 * Parse a command string and extract all top-level commands from it.
 * Uses the provided context for group ID allocation, or creates a fresh one.
 */
function parseSubCommandString(
	str: string,
	ctx: ExpansionContext,
): CommandRef[] {
	try {
		const ast = parseBash(str) as ReturnType<typeof parseBash> & {
			errors?: ParserDiagnostic[];
		};
		const diagnostics = ast.errors ?? [];
		if (diagnostics.length > 0) {
			ctx.parserErrors.push(
				...diagnostics.map(
					(diagnostic) =>
						`${diagnostic.message} at ${diagnostic.pos} in embedded command`,
				),
			);
			return [];
		}
		return extractAllCommandsFromAST(ast, str, ctx);
	} catch (error) {
		ctx.parserErrors.push(
			error instanceof Error
				? `${error.message} in embedded command`
				: "Unknown parser error in embedded command",
		);
		return [];
	}
}

/**
 * Check whether a flag consumes a value argument.
 *
 * Handles both long and short forms:
 * - `-n` matches flagArgs entry `-n` or `n`
 * - `--rcfile` matches flagArgs entry `--rcfile` or `rcfile`
 */
function takesValue(flag: string, flagArgs?: string[]): boolean {
	if (!flagArgs) return false;

	const stripped = flag.replace(/^-+/, "");
	return flagArgs.some((fa) => fa.replace(/^-+/, "") === stripped);
}

/** Check whether an argument is a NAME=VALUE variable assignment. */
function isVarAssignment(arg: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg);
}

/**
 * Returns how many argument positions the flag at args[i] consumes.
 * Returns 2 when the flag takes a separate value argument and the
 * next arg does not itself look like a flag.
 */
function flagSpan(
	arg: string,
	i: number,
	args: string[],
	flagArgs?: string[],
): number {
	if (arg.includes("=")) return 1;
	// Combined short flag with value: -n1
	if (
		arg.length > 2 &&
		!arg.startsWith("--") &&
		takesValue(arg.slice(0, 2), flagArgs)
	)
		return 1;
	if (takesValue(arg, flagArgs) && i + 1 < args.length) {
		const next = args[i + 1];
		if (next && !next.startsWith("-")) return 2;
	}
	return 1;
}

/**
 * Format a wrapper command for display, replacing the sub-command portion
 * with `...` to avoid duplicating the same command name in the prompt.
 *
 * Example: `xargs -0 rm -rf /dir` → `xargs -0 ...`
 * Example: `bash -c 'rm -rf /'` → `bash -c ...`
 * Example: `find . -exec rm {} \;` → `find . -exec ...`
 */
export function formatWrapperDisplay(cmd: CommandRef): string {
	const name = getCommandName(cmd);
	const args = getCommandArgs(cmd);
	const spec = WRAPPER_COMMANDS[name];
	if (!spec) return formatCommand(cmd);

	switch (spec.type) {
		case "passthrough":
			return formatPassthroughDisplay(name, args, spec);
		case "flag":
			return formatFlagDisplay(name, args, spec);
		case "exec":
			return formatExecDisplay(name, args, spec.keywords);
	}
}

function formatPassthroughDisplay(
	name: string,
	args: string[],
	spec: {
		flagArgs?: string[];
		skipVarAssignments?: boolean;
		separator?: string;
		skipArgs?: number;
	},
): string {
	const i = scanPassthroughBoundary(
		args,
		spec.flagArgs,
		spec.skipVarAssignments,
		spec.separator,
		spec.skipArgs,
	);
	return [name, ...args.slice(0, i), "..."].join(" ");
}

function formatFlagDisplay(
	name: string,
	args: string[],
	spec: { flag: string; flagArgs?: string[] },
): string {
	const parts: string[] = [name];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === spec.flag) {
			parts.push(arg, "...");
			return parts.join(" ");
		}

		if (arg?.startsWith("-")) {
			const span = flagSpan(arg, i, args, spec.flagArgs);
			for (let j = 0; j < span; j++) parts.push(args[i + j] ?? "");
			i += span;
			continue;
		}

		// Non-flag arg before target flag — positional arg
		parts.push(arg ?? "");
		i++;
	}

	// Never found the target flag — no sub-command to elide
	return parts.join(" ");
}

function formatExecDisplay(
	name: string,
	args: string[],
	keywords: string[],
): string {
	const displayParts: string[] = [name];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (keywords.includes(arg)) {
			displayParts.push(arg);
			displayParts.push("...");
			return displayParts.join(" ");
		}
		displayParts.push(arg);
	}

	// No keyword found — just return as-is
	return displayParts.join(" ");
}
