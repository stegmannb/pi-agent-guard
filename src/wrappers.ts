import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { formatCommand } from "./format.ts";
import { getCommandArgs, getCommandName } from "./resolve.ts";
import type { CommandRef } from "./types.ts";

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
	| { type: "passthrough"; flagArgs?: string[]; skipVarAssignments?: boolean }
	| { type: "flag"; flag: string; flagArgs?: string[] }
	| { type: "exec"; keywords: string[]; terminators: string[] | null };

/**
 * Registry of wrapper commands and how to extract sub-commands from them.
 * Key is the command name (as it appears in the AST).
 */
export const WRAPPER_COMMANDS: Record<string, WrapperSpec> = {
	xargs: {
		type: "passthrough",
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
			"-o",
			"-P",
			"-p",
			"-r",
			"-s",
			"-t",
			"-x",
		],
	},
	sudo: {
		type: "passthrough",
		flagArgs: [
			"-A",
			"-C",
			"-D",
			"-g",
			"-h",
			"-K",
			"-k",
			"-l",
			"-n",
			"-p",
			"-r",
			"-S",
			"-U",
			"-u",
			"-V",
			"-v",
		],
	},
	nice: { type: "passthrough", flagArgs: ["-n"] },
	nohup: { type: "passthrough" },
	env: {
		type: "passthrough",
		flagArgs: ["-C", "-S", "-u", "-v"],
		skipVarAssignments: true,
	},
	strace: {
		type: "passthrough",
		flagArgs: ["-o", "-O", "-p", "-S", "-e", "-E"],
	},
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

/**
 * Given a list of CommandRefs, expand any wrapper commands by extracting
 * their sub-commands. The original wrapper command is kept — it still needs
 * its own rule check. Sub-commands are recursively expanded for nested wrappers
 * (e.g. `sudo xargs rm`).
 *
 * Degenerate cases (wrapper with no sub-command, e.g. bare `xargs`) are
 * silently ignored — the wrapper itself is still checked against rules.
 */
/** Tracks which wrapper commands had sub-commands extracted. Used by
 * formatWrapperDisplay to replace the sub-command portion with `...`. */
export type ExpansionResult = {
	commands: CommandRef[];
	expandedWrappers: Set<CommandRef>;
};

export function expandWrapperCommands(commands: CommandRef[]): ExpansionResult {
	const expandedWrappers = new Set<CommandRef>();
	const result = doExpand(commands, expandedWrappers);
	return { commands: result, expandedWrappers };
}

function doExpand(
	commands: CommandRef[],
	expandedWrappers: Set<CommandRef>,
): CommandRef[] {
	const result: CommandRef[] = [...commands];

	for (const cmd of commands) {
		const name = getCommandName(cmd);
		const spec = WRAPPER_COMMANDS[name];
		if (!spec) continue;

		const subCommands = extractSubCommands(cmd, spec);
		if (subCommands.length > 0) {
			expandedWrappers.add(cmd);
			result.push(...doExpand(subCommands, expandedWrappers));
		}
	}

	return result;
}

/**
 * Extract sub-commands from a wrapper command based on its spec.
 */
function extractSubCommands(cmd: CommandRef, spec: WrapperSpec): CommandRef[] {
	switch (spec.type) {
		case "passthrough":
			return extractPassthrough(
				cmd,
				spec.flagArgs,
				spec.skipVarAssignments ?? false,
			);
		case "flag":
			return extractFlag(cmd, spec.flag, spec.flagArgs);
		case "exec":
			return extractExec(cmd, spec.keywords, spec.terminators);
	}
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
	flagArgs?: string[],
	skipVarAssignments = false,
): CommandRef[] {
	const args = getCommandArgs(cmd);

	// Skip flags that belong to the wrapper command.
	// We handle:
	// 1. Combined short flags with value: -n1 (xargs style)
	// 2. Flags with separate values: -n 1, -u root
	// 3. Long flags with values: --rcfile=file, --rcfile file
	// 4. NAME=VALUE var assignments (for env and similar)

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;

		// Skip NAME=VALUE var assignments (for env, etc.)
		if (skipVarAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
			i++;
			continue;
		}

		// If it doesn't start with -, we've found the sub-command
		if (!arg.startsWith("-")) break;

		// It's a flag. Check if it takes a value.
		if (arg.includes("=")) {
			// --flag=value or -f=value: value is inline, no separate arg to skip
			i++;
			continue;
		}

		// Check for combined short flag with value: -n1
		// This is a single arg like "-n1" where "-n" takes a value and "1" is that value
		if (arg.length > 2 && arg.startsWith("-") && !arg.startsWith("--")) {
			const flagPrefix = arg.slice(0, 2); // e.g. "-n"
			if (takesValue(flagPrefix, flagArgs)) {
				// Combined flag+value — no separate value arg to skip
				i++;
				continue;
			}
		}

		// Regular flag (short or long)
		i++;
		const flagTakesValue = takesValue(arg, flagArgs);
		if (flagTakesValue && i < args.length) {
			// The next arg might be the value for this flag.
			// But be careful: the next arg could also be a flag or a var assignment
			// rather than a plain value. We use a heuristic: if the next arg looks
			// like a flag or a var assignment, don't skip it.
			const nextArg = args[i];
			if (
				nextArg &&
				!nextArg.startsWith("-") &&
				!(skipVarAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(nextArg))
			) {
				i++;
			}
		}
	}

	if (i >= args.length) return [];

	// The remaining args form the sub-command
	const subCommandStr = args.slice(i).join(" ");
	return parseSubCommandString(subCommandStr);
}

/**
 * For flag-based wrappers: find the target flag and parse its string
 * argument as a bash script.
 *
 * Example: `bash -c 'rm -rf /'` → parse `rm -rf /`
 */
function extractFlag(
	cmd: CommandRef,
	targetFlag: string,
	flagArgs?: string[],
): CommandRef[] {
	const args = getCommandArgs(cmd);

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === targetFlag) {
			// Next arg is the script
			const scriptArg = args[i + 1];
			if (scriptArg) {
				return parseSubCommandString(scriptArg);
			}
			return [];
		}

		// Skip other flags that might consume values
		if (arg?.startsWith("-")) {
			if (arg.includes("=")) {
				// --flag=value: skip entire arg
				i++;
				continue;
			}

			// Check for combined short flag with value
			if (arg.length > 2 && !arg.startsWith("--")) {
				const flagPrefix = arg.slice(0, 2);
				if (takesValue(flagPrefix, flagArgs)) {
					i++;
					continue;
				}
			}

			i++;
			// Skip the value arg for flags that take one, unless it's our target flag
			if (takesValue(arg, flagArgs) && i < args.length) {
				const nextArg = args[i];
				if (nextArg !== targetFlag) {
					i++;
				}
			}
			continue;
		}

		// Non-flag arg before our target flag — this is a positional argument
		// For bash, `bash script.sh` is non-wrapped usage.
		// We've passed the point where -c would appear, so stop looking.
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
function extractExec(
	cmd: CommandRef,
	keywords: string[],
	terminators: string[] | null,
): CommandRef[] {
	const args = getCommandArgs(cmd);
	const results: CommandRef[] = [];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (keywords.includes(arg ?? "")) {
			i++;
			// Collect the sub-command
			const cmdParts: string[] = [];
			while (i < args.length) {
				const part = args[i];
				if (terminators?.includes(part ?? "")) {
					i++;
					break;
				}
				cmdParts.push(part ?? "");
				i++;
			}
			if (cmdParts.length > 0) {
				const subCommandStr = cmdParts.join(" ");
				const extracted = parseSubCommandString(subCommandStr);
				results.push(...extracted);
			}
			continue;
		}
		i++;
	}

	return results;
}

/**
 * Parse a command string and extract all top-level commands from it.
 */
function parseSubCommandString(str: string): CommandRef[] {
	try {
		const ast = parseBash(str);
		return extractAllCommandsFromAST(ast, str);
	} catch {
		// If we can't parse the sub-command string, we can't check it.
		// Return empty — the caller will still check the wrapper command
		// itself against rules.
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
	spec: { flagArgs?: string[]; skipVarAssignments?: boolean },
): string {
	const displayParts: string[] = [name];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === undefined) break;

		if (spec.skipVarAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
			displayParts.push(arg);
			i++;
			continue;
		}

		if (!arg.startsWith("-")) break;

		if (arg.includes("=")) {
			displayParts.push(arg);
			i++;
			continue;
		}

		if (arg.length > 2 && arg.startsWith("-") && !arg.startsWith("--")) {
			const flagPrefix = arg.slice(0, 2);
			if (takesValue(flagPrefix, spec.flagArgs)) {
				displayParts.push(arg);
				i++;
				continue;
			}
		}

		displayParts.push(arg);
		i++;
		if (takesValue(arg, spec.flagArgs) && i < args.length) {
			const nextArg = args[i];
			if (
				nextArg &&
				!nextArg.startsWith("-") &&
				!(spec.skipVarAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(nextArg))
			) {
				displayParts.push(nextArg);
				i++;
			}
		}
	}

	displayParts.push("...");
	return displayParts.join(" ");
}

function formatFlagDisplay(
	name: string,
	args: string[],
	spec: { flag: string; flagArgs?: string[] },
): string {
	const displayParts: string[] = [name];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === spec.flag) {
			displayParts.push(arg);
			displayParts.push("...");
			return displayParts.join(" ");
		}

		if (arg?.startsWith("-")) {
			if (arg.includes("=")) {
				displayParts.push(arg);
				i++;
				continue;
			}

			if (arg.length > 2 && !arg.startsWith("--")) {
				const flagPrefix = arg.slice(0, 2);
				if (takesValue(flagPrefix, spec.flagArgs)) {
					displayParts.push(arg);
					i++;
					continue;
				}
			}

			displayParts.push(arg);
			i++;
			if (takesValue(arg, spec.flagArgs) && i < args.length) {
				const nextArg = args[i];
				if (nextArg !== undefined && nextArg !== spec.flag) {
					displayParts.push(nextArg);
					i++;
				}
			}
			continue;
		}

		// Non-flag arg before target flag — positional arg
		displayParts.push(arg ?? "");
		i++;
	}

	// Never found the target flag — no sub-command to elide
	return displayParts.join(" ");
}

function formatExecDisplay(
	name: string,
	args: string[],
	keywords: string[],
): string {
	const displayParts: string[] = [name];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (keywords.includes(arg ?? "")) {
			displayParts.push(arg ?? "");
			displayParts.push("...");
			return displayParts.join(" ");
		}
		displayParts.push(arg ?? "");
	}

	// No keyword found — just return as-is
	return displayParts.join(" ");
}
