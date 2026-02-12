/**
 * Tests for overstory coordinator command.
 *
 * Uses real temp directories and real git repos for file I/O and config loading.
 * Mocks tmux (interferes with developer sessions) and deployHooks (reads a
 * template file that may not exist in test context).
 *
 * WHY mock.module: tmux operations must be mocked because real tmux sessions
 * would interfere with developer sessions and are fragile in CI. deployHooks
 * reads a template from the repo's templates/ directory which may not exist
 * relative to the test's working directory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";

// --- Mocks ---

// Track calls for assertions
let tmuxCalls: {
	createSession: Array<{
		name: string;
		cwd: string;
		command: string;
		env?: Record<string, string>;
	}>;
	isSessionAlive: Array<{ name: string; result: boolean }>;
	killSession: Array<{ name: string }>;
	sendKeys: Array<{ name: string; keys: string }>;
};

/** Configurable mock responses for isSessionAlive per session name. */
let sessionAliveMap: Record<string, boolean>;

mock.module("../worktree/tmux.ts", () => ({
	createSession: async (
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number> => {
		tmuxCalls.createSession.push({ name, cwd, command, env });
		return 99999; // Fake PID
	},
	isSessionAlive: async (name: string): Promise<boolean> => {
		const alive = sessionAliveMap[name] ?? false;
		tmuxCalls.isSessionAlive.push({ name, result: alive });
		return alive;
	},
	killSession: async (name: string): Promise<void> => {
		tmuxCalls.killSession.push({ name });
	},
	sendKeys: async (name: string, keys: string): Promise<void> => {
		tmuxCalls.sendKeys.push({ name, keys });
	},
}));

mock.module("../agents/hooks-deployer.ts", () => ({
	deployHooks: async (): Promise<void> => {
		// No-op: skip template file reading in tests
	},
}));

// Import AFTER mocks are registered
const { buildCoordinatorBeacon, coordinatorCommand, loadSessions, saveSessions } = await import(
	"./coordinator.ts"
);

// --- Test Setup ---

let tempDir: string;
let overstoryDir: string;
let sessionsPath: string;
const originalCwd = process.cwd();

beforeEach(async () => {
	// Restore cwd FIRST so createTempGitRepo's git operations don't fail
	// if a prior test's tempDir was already cleaned up.
	process.chdir(originalCwd);

	tempDir = await realpath(await createTempGitRepo());
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	sessionsPath = join(overstoryDir, "sessions.json");

	// Write a minimal config.yaml so loadConfig succeeds
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	// Reset mock tracking
	tmuxCalls = {
		createSession: [],
		isSessionAlive: [],
		killSession: [],
		sendKeys: [],
	};
	sessionAliveMap = {};

	// Override cwd so coordinator commands find our temp project
	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

// --- Helpers ---

function makeCoordinatorSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-coordinator`,
		agentName: "coordinator",
		capability: "coordinator",
		worktreePath: tempDir,
		branchName: "main",
		beadId: "",
		tmuxSession: "overstory-coordinator",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 0,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

// --- Tests ---

describe("coordinatorCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["--help"]));
		expect(output).toContain("overstory coordinator");
		expect(output).toContain("start");
		expect(output).toContain("stop");
		expect(output).toContain("status");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["-h"]));
		expect(output).toContain("overstory coordinator");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand([]));
		expect(output).toContain("overstory coordinator");
		expect(output).toContain("Subcommands:");
	});
});

describe("coordinatorCommand unknown subcommand", () => {
	test("throws ValidationError for unknown subcommand", async () => {
		await expect(coordinatorCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});

	test("error message includes the bad subcommand name", async () => {
		try {
			await coordinatorCommand(["frobnicate"]);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.message).toContain("frobnicate");
			expect(ve.field).toBe("subcommand");
			expect(ve.value).toBe("frobnicate");
		}
	});
});

describe("startCoordinator", () => {
	test("writes session to sessions.json with correct fields", async () => {
		// Mock tmux as not having any existing session
		sessionAliveMap = {};

		// Override Bun.sleep to skip the 3s and 0.5s waits
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"]));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Verify sessions.json was written
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toHaveLength(1);

		const session = sessions[0];
		expect(session).toBeDefined();
		expect(session?.agentName).toBe("coordinator");
		expect(session?.capability).toBe("coordinator");
		expect(session?.tmuxSession).toBe("overstory-coordinator");
		expect(session?.state).toBe("booting");
		expect(session?.pid).toBe(99999);
		expect(session?.parentAgent).toBeNull();
		expect(session?.depth).toBe(0);
		expect(session?.beadId).toBe("");
		expect(session?.branchName).toBe("main");
		expect(session?.worktreePath).toBe(tempDir);
		expect(session?.id).toMatch(/^session-\d+-coordinator$/);

		// Verify tmux createSession was called
		expect(tmuxCalls.createSession).toHaveLength(1);
		expect(tmuxCalls.createSession[0]?.name).toBe("overstory-coordinator");
		expect(tmuxCalls.createSession[0]?.cwd).toBe(tempDir);

		// Verify sendKeys was called (beacon + follow-up Enter)
		expect(tmuxCalls.sendKeys.length).toBeGreaterThanOrEqual(1);
	});

	test("--json outputs JSON with expected fields", async () => {
		sessionAliveMap = {};
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		let output: string;
		try {
			output = await captureStdout(() => coordinatorCommand(["start", "--json"]));
		} finally {
			Bun.sleep = originalSleep;
		}

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.agentName).toBe("coordinator");
		expect(parsed.capability).toBe("coordinator");
		expect(parsed.tmuxSession).toBe("overstory-coordinator");
		expect(parsed.pid).toBe(99999);
		expect(parsed.projectRoot).toBe(tempDir);
	});

	test("rejects duplicate when coordinator is already running", async () => {
		// Write an existing active coordinator session
		const existing = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [existing]);

		// Mock tmux as alive for the existing session
		sessionAliveMap = { "overstory-coordinator": true };

		await expect(coordinatorCommand(["start"])).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["start"]);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("already running");
		}
	});

	test("cleans up dead session and starts new one", async () => {
		// Write an existing session that claims to be working
		const deadSession = makeCoordinatorSession({
			id: "session-dead-coordinator",
			state: "working",
		});
		await saveSessions(sessionsPath, [deadSession]);

		// Mock tmux as NOT alive for the existing session
		sessionAliveMap = { "overstory-coordinator": false };

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"]));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Verify the old session was marked completed and a new one was added
		const sessions = await loadSessions(sessionsPath);
		expect(sessions.length).toBeGreaterThanOrEqual(2);

		const oldSession = sessions.find((s) => s.id === "session-dead-coordinator");
		expect(oldSession).toBeDefined();
		expect(oldSession?.state).toBe("completed");

		const newSession = sessions.find((s) => s.id !== "session-dead-coordinator");
		expect(newSession).toBeDefined();
		expect(newSession?.state).toBe("booting");
		expect(newSession?.agentName).toBe("coordinator");
	});
});

describe("stopCoordinator", () => {
	test("marks session as completed after stopping", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [session]);

		// Tmux is alive so killSession will be called
		sessionAliveMap = { "overstory-coordinator": true };

		await captureStdout(() => coordinatorCommand(["stop"]));

		// Verify session is now completed
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.state).toBe("completed");

		// Verify killSession was called
		expect(tmuxCalls.killSession).toHaveLength(1);
		expect(tmuxCalls.killSession[0]?.name).toBe("overstory-coordinator");
	});

	test("--json outputs JSON with stopped flag", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [session]);
		sessionAliveMap = { "overstory-coordinator": true };

		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
	});

	test("handles already-dead tmux session gracefully", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [session]);

		// Tmux is NOT alive — should skip killSession
		sessionAliveMap = { "overstory-coordinator": false };

		await captureStdout(() => coordinatorCommand(["stop"]));

		// Verify session is completed
		const sessions = await loadSessions(sessionsPath);
		expect(sessions[0]?.state).toBe("completed");

		// killSession should NOT have been called since session was already dead
		expect(tmuxCalls.killSession).toHaveLength(0);
	});

	test("throws AgentError when no coordinator session exists", async () => {
		// No sessions.json at all
		await expect(coordinatorCommand(["stop"])).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["stop"]);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("No active coordinator session");
		}
	});

	test("throws AgentError when only completed sessions exist", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		await saveSessions(sessionsPath, [completed]);

		await expect(coordinatorCommand(["stop"])).rejects.toThrow(AgentError);
	});
});

describe("statusCoordinator", () => {
	test("shows 'not running' when no session exists", async () => {
		const output = await captureStdout(() => coordinatorCommand(["status"]));
		expect(output).toContain("not running");
	});

	test("--json shows running:false when no session exists", async () => {
		const output = await captureStdout(() => coordinatorCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});

	test("shows running state when coordinator is alive", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [session]);
		sessionAliveMap = { "overstory-coordinator": true };

		const output = await captureStdout(() => coordinatorCommand(["status"]));
		expect(output).toContain("running");
		expect(output).toContain(session.id);
		expect(output).toContain("overstory-coordinator");
	});

	test("--json shows correct fields when running", async () => {
		const session = makeCoordinatorSession({ state: "working", pid: 99999 });
		await saveSessions(sessionsPath, [session]);
		sessionAliveMap = { "overstory-coordinator": true };

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
		expect(parsed.state).toBe("working");
		expect(parsed.tmuxSession).toBe("overstory-coordinator");
		expect(parsed.pid).toBe(99999);
	});

	test("reconciles zombie: updates state when tmux is dead but session says working", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		await saveSessions(sessionsPath, [session]);

		// Tmux is NOT alive — triggers zombie reconciliation
		sessionAliveMap = { "overstory-coordinator": false };

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
		expect(parsed.state).toBe("zombie");

		// Verify sessions.json was updated
		const sessions = await loadSessions(sessionsPath);
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("reconciles zombie for booting state too", async () => {
		const session = makeCoordinatorSession({ state: "booting" });
		await saveSessions(sessionsPath, [session]);
		sessionAliveMap = { "overstory-coordinator": false };

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.state).toBe("zombie");
	});

	test("does not show completed sessions as active", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		await saveSessions(sessionsPath, [completed]);

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});
});

describe("buildCoordinatorBeacon", () => {
	test("is a single line (no newlines)", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).not.toContain("\n");
	});

	test("includes coordinator identity in header", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("[OVERSTORY] coordinator (coordinator)");
	});

	test("includes ISO timestamp", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("includes depth and parent info", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Depth: 0 | Parent: none");
	});

	test("includes persistent orchestrator role", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Role: persistent orchestrator");
	});

	test("includes startup instructions", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("overstory mail check --agent coordinator");
		expect(beacon).toContain("bd ready");
		expect(beacon).toContain("overstory group status");
	});

	test("parts are joined with em-dash separator", () => {
		const beacon = buildCoordinatorBeacon();
		// Should have exactly 2 " — " separators (3 parts)
		const dashes = beacon.split(" — ");
		expect(dashes).toHaveLength(3);
	});
});

describe("loadSessions / saveSessions", () => {
	test("loadSessions returns empty array when file does not exist", async () => {
		const sessions = await loadSessions(join(tempDir, "nonexistent.json"));
		expect(sessions).toEqual([]);
	});

	test("loadSessions returns empty array for malformed JSON", async () => {
		await Bun.write(sessionsPath, "not valid json");
		const sessions = await loadSessions(sessionsPath);
		expect(sessions).toEqual([]);
	});

	test("saveSessions then loadSessions round-trips correctly", async () => {
		const original = [makeCoordinatorSession()];
		await saveSessions(sessionsPath, original);
		const loaded = await loadSessions(sessionsPath);

		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.agentName).toBe("coordinator");
		expect(loaded[0]?.capability).toBe("coordinator");
	});

	test("saveSessions writes JSON with trailing newline", async () => {
		await saveSessions(sessionsPath, [makeCoordinatorSession()]);
		const raw = await Bun.file(sessionsPath).text();
		expect(raw.endsWith("\n")).toBe(true);
	});

	test("saveSessions writes tab-indented JSON", async () => {
		await saveSessions(sessionsPath, [makeCoordinatorSession()]);
		const raw = await Bun.file(sessionsPath).text();
		expect(raw).toContain("\t");
	});
});
