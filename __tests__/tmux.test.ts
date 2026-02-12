import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../src/errors.ts";
import {
	createSession,
	isSessionAlive,
	killSession,
	listSessions,
	sendKeys,
} from "../src/worktree/tmux.ts";

/**
 * Helper to create a mock Bun.spawn return value.
 *
 * The actual code reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

describe("createSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("creates session and returns PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// tmux list-sessions
			return mockSpawnResult("overstory-auth:42\noverstory-data:99\n", "", 0);
		});

		const pid = await createSession(
			"overstory-auth",
			"/repo/worktrees/auth",
			"claude --task 'do work'",
		);

		expect(pid).toBe(42);
	});

	test("passes correct args to tmux new-session", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("my-session:1234\n", "", 0);
		});

		await createSession("my-session", "/work/dir", "echo hello");

		const firstCallArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = firstCallArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"new-session",
			"-d",
			"-s",
			"my-session",
			"-c",
			"/work/dir",
			"echo hello",
		]);

		const opts = firstCallArgs[1] as { cwd: string };
		expect(opts.cwd).toBe("/work/dir");
	});

	test("calls list-sessions after creating to get PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("test-agent:7777\n", "", 0);
		});

		await createSession("test-agent", "/tmp", "ls");

		expect(spawnSpy).toHaveBeenCalledTimes(2);
		const secondCallArgs = spawnSpy.mock.calls[1] as unknown[];
		const cmd = secondCallArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "list-sessions", "-F", "#{session_name}:#{pid}"]);
	});

	test("throws AgentError if session creation fails", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "duplicate session: my-session", 1));

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if list-sessions fails after creation", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// new-session succeeds
				return mockSpawnResult("", "", 0);
			}
			// list-sessions fails
			return mockSpawnResult("", "error listing sessions", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if session PID not found in list", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return mockSpawnResult("", "", 0);
			}
			// List returns sessions but not the one we created
			return mockSpawnResult("other-session:999\n", "", 0);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("AgentError includes session name context", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "duplicate session: agent-foo", 1));

		try {
			await createSession("agent-foo", "/tmp", "ls");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("agent-foo");
			expect(agentErr.agentName).toBe("agent-foo");
		}
	});
});

describe("listSessions", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("parses session list output", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("overstory-auth:42\noverstory-data:99\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.name).toBe("overstory-auth");
		expect(sessions[0]?.pid).toBe(42);
		expect(sessions[1]?.name).toBe("overstory-data");
		expect(sessions[1]?.pid).toBe(99);
	});

	test("returns empty array when no server running", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("", "no server running on /tmp/tmux-501/default", 1),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("returns empty array when 'no sessions' in stderr", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "no sessions", 1));

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("throws AgentError on other tmux failures", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "protocol version mismatch", 1));

		await expect(listSessions()).rejects.toThrow(AgentError);
	});

	test("skips malformed lines", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("valid-session:123\nmalformed-no-colon\n:no-name\n\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("valid-session");
		expect(sessions[0]?.pid).toBe(123);
	});

	test("passes correct args to tmux", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await listSessions();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "list-sessions", "-F", "#{session_name}:#{pid}"]);
	});
});

describe("killSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls tmux kill-session with correct args", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await killSession("overstory-auth");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "kill-session", "-t", "overstory-auth"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: nonexistent", 1));

		await expect(killSession("nonexistent")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: ghost-agent", 1));

		try {
			await killSession("ghost-agent");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("ghost-agent");
			expect(agentErr.agentName).toBe("ghost-agent");
		}
	});
});

describe("isSessionAlive", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns true when session exists (exit 0)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const alive = await isSessionAlive("overstory-auth");

		expect(alive).toBe(true);
	});

	test("returns false when session does not exist (non-zero exit)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find session: nonexistent", 1));

		const alive = await isSessionAlive("nonexistent");

		expect(alive).toBe(false);
	});

	test("passes correct args to tmux has-session", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await isSessionAlive("my-agent");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "has-session", "-t", "my-agent"]);
	});
});

describe("sendKeys", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("passes correct args to tmux send-keys", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await sendKeys("overstory-auth", "echo hello world");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "send-keys", "-t", "overstory-auth", "echo hello world", "Enter"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: dead-agent", 1));

		await expect(sendKeys("dead-agent", "echo test")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: my-agent", 1));

		try {
			await sendKeys("my-agent", "test command");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("my-agent");
			expect(agentErr.agentName).toBe("my-agent");
		}
	});
});
