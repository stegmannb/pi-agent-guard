import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	AuthStorage,
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@pasa/pi-sdk";
import type { SnapshotResponse } from "../../src/protection-snapshot.ts";

export async function loadRealGuard(cwd: string) {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir);
	const events = createEventBus();
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		eventBus: events,
		additionalExtensionPaths: [
			fileURLToPath(new URL("../../index.ts", import.meta.url)),
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 1);
	const sessionManager = SessionManager.inMemory(cwd);
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		authStorage,
		modelRegistry,
		tools: [],
	});
	function snapshot(targetCwd = cwd): SnapshotResponse {
		let response: SnapshotResponse | undefined;
		events.emit("pasa:protection:snapshot:v1", {
			version: 1,
			requestId: randomUUID(),
			protectionId: "pi-agent-guard",
			expectedSessionId: sessionManager.getSessionId(),
			targetCwd,
			respond: (value: SnapshotResponse) => {
				assert.equal(response, undefined);
				response = value;
			},
		});
		assert.ok(response);
		return response;
	}
	return { session, snapshot, sessionManager };
}
