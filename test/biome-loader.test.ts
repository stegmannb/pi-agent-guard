import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Script } from "node:vm";

const require = createRequire(import.meta.url);
const loaderPath = require.resolve("@biomejs/biome/bin/biome");
const installedLoader = readFileSync(loaderPath, "utf8");

interface LoaderOptions {
	platform?: string;
	arch?: string;
	report?: { getReport?: () => unknown };
	ldd?: string;
	lddFails?: boolean;
	binary?: string;
	spawnError?: Error;
}

/** Execute the entire installed loader; intercept only host facts and process launch. */
function runInstalled(options: LoaderOptions = {}) {
	let lddCalls = 0;
	let selected: string | undefined;
	let launches = 0;
	const process = {
		platform: options.platform ?? "linux",
		arch: options.arch ?? "x64",
		report: options.report,
		env: {
			...(options.binary ? { BIOME_BINARY: options.binary } : {}),
			npm_config_user_agent: "pnpm/10.32.1 node/v22.22.1 linux x64",
		},
		version: "v22.22.1",
		release: { name: "node" },
		argv: ["node", loaderPath, "check"],
		exitCode: undefined as number | undefined,
	};
	const childProcess = {
		execSync(command: string) {
			assert.equal(command, "ldd --version");
			lddCalls++;
			const output = Buffer.from(options.ldd ?? "musl libc (x86_64)");
			if (options.lddFails) throw { stderr: output };
			return output;
		},
		spawnSync(binary: string, args: string[], config: { shell: boolean }) {
			assert.equal(binary, selected);
			assert.deepEqual(Array.from(args), ["check"]);
			assert.equal(config.shell, false);
			launches++;
			return { status: 17, error: options.spawnError };
		},
	};
	const requireMock = Object.assign(
		(name: string) => {
			assert.equal(name, "child_process");
			return childProcess;
		},
		{
			resolve(name: string) {
				selected = name;
				return name;
			},
		},
	);
	new Script(installedLoader, { filename: loaderPath }).runInNewContext({
		process,
		require: requireMock,
		console,
	});
	assert.equal(launches, 1);
	assert.equal(process.exitCode, 17);
	return { selected, lddCalls };
}

for (const arch of ["x64", "arm64"]) {
	test(`installed Biome loader prefers Node glibc over host musl on ${arch}`, () => {
		let reports = 0;
		const result = runInstalled({
			arch,
			report: {
				getReport: () => {
					reports++;
					return { header: { glibcVersionRuntime: "2.42" } };
				},
			},
			ldd: "musl libc",
			lddFails: true,
		});
		assert.equal(result.selected, `@biomejs/cli-linux-${arch}/biome`);
		assert.equal(result.lddCalls, 0);
		assert.equal(reports, 1);
	});
}

for (const [name, report] of [
	["missing report", undefined],
	["missing report method", {}],
	["missing glibc field", { getReport: () => ({ header: {} }) }],
	[
		"empty glibc field",
		{ getReport: () => ({ header: { glibcVersionRuntime: "" } }) },
	],
	[
		"failed report",
		{
			getReport: () => {
				throw new Error("report unavailable");
			},
		},
	],
] as const) {
	test(`installed Biome loader retains musl ldd fallback with ${name}`, () => {
		const result = runInstalled({
			...(report ? { report } : {}),
			lddFails: true,
		});
		assert.equal(result.selected, "@biomejs/cli-linux-x64-musl/biome");
		assert.equal(result.lddCalls, 1);
	});
}

test("installed Biome loader retains non-musl ldd fallback", () => {
	const result = runInstalled({ ldd: "ldd (GNU libc) 2.42" });
	assert.equal(result.selected, "@biomejs/cli-linux-x64/biome");
	assert.equal(result.lddCalls, 1);
});

for (const [platform, binary] of [
	["darwin", "@biomejs/cli-darwin-x64/biome"],
	["win32", "@biomejs/cli-win32-x64/biome.exe"],
]) {
	test(`installed Biome loader leaves ${platform} selection unchanged`, () => {
		assert.ok(platform);
		const result = runInstalled({
			platform,
			report: {
				getReport: () => assert.fail("Non-Linux must not inspect libc"),
			},
		});
		assert.equal(result.selected, binary);
		assert.equal(result.lddCalls, 0);
	});
}

test("installed Biome loader preserves BIOME_BINARY and launch errors", () => {
	const result = runInstalled({
		binary: "/custom/biome",
		report: {
			getReport: () => assert.fail("Explicit binary must bypass detection"),
		},
	});
	assert.equal(result.selected, "/custom/biome");
	assert.equal(result.lddCalls, 0);
	const error = new Error("launch failed");
	assert.throws(
		() => runInstalled({ spawnError: error }),
		(thrown) => thrown === error,
	);
});

test("installed patched Biome 2.4.11 launches its actual native binary", () => {
	const metadata = JSON.parse(
		readFileSync(require.resolve("@biomejs/biome/package.json"), "utf8"),
	);
	assert.equal(metadata.version, "2.4.11");
	assert.equal(
		execFileSync(process.execPath, [loaderPath, "--version"], {
			encoding: "utf8",
		}).trim(),
		"Version: 2.4.11",
	);
});
