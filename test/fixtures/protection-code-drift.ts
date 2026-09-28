import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SnapshotResponse } from "../../src/protection-snapshot.ts";

const [copy, mode] = process.argv.slice(2);
assert.ok(copy && mode);
const source = join(copy, "src/defaults.ts");
if (mode === "missing") rmSync(join(copy, "protection-code.json"));
if (mode === "before")
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// before import\n`);
if (mode === "incomplete") {
	const manifest = join(copy, "protection-code.json");
	const entries = JSON.parse(readFileSync(manifest, "utf8"));
	writeFileSync(
		manifest,
		JSON.stringify(
			entries.filter(
				(entry: { path: string }) => entry.path !== "src/defaults.ts",
			),
		),
	);
}
const { default: register } = await import(join(copy, "index.ts"));
if (mode === "after")
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// after import\n`);
let handler: ((request: unknown) => void) | undefined;
let start:
	| ((_event: unknown, ctx: ExtensionContext) => Promise<void>)
	| undefined;
const pi = {
	on: (name: string, callback: typeof start) => {
		if (name === "session_start") start = callback;
	},
	events: {
		on: (_name: string, callback: typeof handler) => {
			handler = callback;
		},
		emit() {},
	},
	registerTool() {},
	registerCommand() {},
} as unknown as ExtensionAPI;
register(pi);
assert.ok(start && handler);
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	sessionManager: { getSessionId: () => "drift-test", getBranch: () => [] },
} as unknown as ExtensionContext;
await start({}, ctx);
handler({
	version: 1,
	requestId: "code-drift",
	protectionId: "pi-agent-guard",
	expectedSessionId: "drift-test",
	targetCwd: process.cwd(),
	respond: (response: SnapshotResponse) =>
		process.stdout.write(JSON.stringify(response)),
});
