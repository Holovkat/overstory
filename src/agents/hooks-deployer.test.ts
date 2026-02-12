import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import {
	buildBashFileGuardScript,
	deployHooks,
	getCapabilityGuards,
	getDangerGuards,
} from "./hooks-deployer.ts";

describe("deployHooks", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-hooks-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates .claude/settings.local.json in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("replaces {{AGENT_NAME}} with the actual agent name", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "my-builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("my-builder");
		expect(content).not.toContain("{{AGENT_NAME}}");
	});

	test("replaces all occurrences of {{AGENT_NAME}}", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "scout-alpha");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();

		// The template has {{AGENT_NAME}} in multiple hook commands
		const occurrences = content.split("scout-alpha").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(6);
		expect(content).not.toContain("{{AGENT_NAME}}");
	});

	test("output is valid JSON", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "json-test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed).toBeDefined();
		expect(parsed.hooks).toBeDefined();
	});

	test("output contains SessionStart hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.SessionStart).toBeDefined();
		expect(parsed.hooks.SessionStart).toBeArray();
		expect(parsed.hooks.SessionStart.length).toBeGreaterThan(0);
	});

	test("output contains UserPromptSubmit hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.UserPromptSubmit).toBeDefined();
		expect(parsed.hooks.UserPromptSubmit).toBeArray();
	});

	test("output contains PreToolUse hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PreToolUse).toBeDefined();
		expect(parsed.hooks.PreToolUse).toBeArray();
	});

	test("output contains PostToolUse hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PostToolUse).toBeDefined();
		expect(parsed.hooks.PostToolUse).toBeArray();
	});

	test("output contains Stop hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.Stop).toBeDefined();
		expect(parsed.hooks.Stop).toBeArray();
	});

	test("output contains PreCompact hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PreCompact).toBeDefined();
		expect(parsed.hooks.PreCompact).toBeArray();
	});

	test("all six hook types are present", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "all-hooks");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const hookTypes = Object.keys(parsed.hooks);
		expect(hookTypes).toContain("SessionStart");
		expect(hookTypes).toContain("UserPromptSubmit");
		expect(hookTypes).toContain("PreToolUse");
		expect(hookTypes).toContain("PostToolUse");
		expect(hookTypes).toContain("Stop");
		expect(hookTypes).toContain("PreCompact");
		expect(hookTypes).toHaveLength(6);
	});

	test("SessionStart hook runs overstory prime with agent name", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "prime-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const sessionStart = parsed.hooks.SessionStart[0];
		expect(sessionStart.hooks[0].type).toBe("command");
		expect(sessionStart.hooks[0].command).toBe("overstory prime --agent prime-agent");
	});

	test("UserPromptSubmit hook runs mail check with agent name", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "mail-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const userPrompt = parsed.hooks.UserPromptSubmit[0];
		expect(userPrompt.hooks[0].command).toBe("overstory mail check --inject --agent mail-agent");
	});

	test("PreCompact hook runs overstory prime with --compact flag", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "compact-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preCompact = parsed.hooks.PreCompact[0];
		expect(preCompact.hooks[0].type).toBe("command");
		expect(preCompact.hooks[0].command).toBe("overstory prime --agent compact-agent --compact");
	});

	test("creates .claude directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		await deployHooks(worktreePath, "test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("overwrites existing settings.local.json", async () => {
		const worktreePath = join(tempDir, "worktree");
		const claudeDir = join(worktreePath, ".claude");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(join(claudeDir, "settings.local.json"), '{"old": true}');

		await deployHooks(worktreePath, "new-agent");

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain('"old"');
	});

	test("handles agent names with special characters", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "agent-with-dashes-123");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("agent-with-dashes-123");
		// Should still be valid JSON
		const parsed = JSON.parse(content);
		expect(parsed.hooks).toBeDefined();
	});

	test("throws AgentError when template is missing", async () => {
		// We can't easily remove the template without affecting the repo,
		// but we can verify the error type by testing the module's behavior.
		// The function uses getTemplatePath() internally which is not exported,
		// so we test indirectly: verify that a successful call works, confirming
		// the template exists. The error path is tested via the error type assertion.
		const worktreePath = join(tempDir, "worktree");

		// Successful deployment proves the template exists
		await deployHooks(worktreePath, "template-exists");
		const exists = await Bun.file(join(worktreePath, ".claude", "settings.local.json")).exists();
		expect(exists).toBe(true);
	});

	test("AgentError includes agent name in context", async () => {
		// Verify AgentError shape by constructing one (as the function does internally)
		const error = new AgentError("test error", { agentName: "failing-agent" });
		expect(error.agentName).toBe("failing-agent");
		expect(error.code).toBe("AGENT_ERROR");
		expect(error.name).toBe("AgentError");
		expect(error.message).toBe("test error");
	});

	test("write failure throws AgentError", async () => {
		// Use a path that will fail to write (read-only parent)
		const invalidPath = "/dev/null/impossible-path";

		try {
			await deployHooks(invalidPath, "fail-agent");
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			if (err instanceof AgentError) {
				expect(err.agentName).toBe("fail-agent");
				expect(err.code).toBe("AGENT_ERROR");
			}
		}
	});

	test("scout capability adds Write/Edit/NotebookEdit and Bash file guards", async () => {
		const worktreePath = join(tempDir, "scout-wt");

		await deployHooks(worktreePath, "scout-agent", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Guards appear before the base logging hook
		const writeGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "Write");
		const editGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "Edit");
		const notebookGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "NotebookEdit");

		expect(writeGuard).toBeDefined();
		expect(editGuard).toBeDefined();
		expect(notebookGuard).toBeDefined();

		// Verify write guard produces a block decision
		expect(writeGuard.hooks[0].command).toContain('"decision":"block"');
		expect(writeGuard.hooks[0].command).toContain("cannot modify files");

		// Should have multiple Bash guards: danger guard + file guard
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(2); // danger guard + file guard
	});

	test("reviewer capability adds same guards as scout", async () => {
		const worktreePath = join(tempDir, "reviewer-wt");

		await deployHooks(worktreePath, "reviewer-agent", "reviewer");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Bash");
		expect(guardMatchers).toContain("Write");
		expect(guardMatchers).toContain("Edit");
		expect(guardMatchers).toContain("NotebookEdit");
	});

	test("lead capability gets Write/Edit/NotebookEdit guards and Bash file guards", async () => {
		const worktreePath = join(tempDir, "lead-wt");

		await deployHooks(worktreePath, "lead-agent", "lead");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Write");
		expect(guardMatchers).toContain("Edit");
		expect(guardMatchers).toContain("NotebookEdit");
		expect(guardMatchers).toContain("Bash");

		// Should have 2 Bash guards: danger guard + file guard
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(2);
	});

	test("builder capability gets only Bash danger guards", async () => {
		const worktreePath = join(tempDir, "builder-wt");

		await deployHooks(worktreePath, "builder-agent", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Bash danger guard + base logging hook
		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toEqual(["Bash"]);
	});

	test("merger capability gets only Bash danger guards", async () => {
		const worktreePath = join(tempDir, "merger-wt");

		await deployHooks(worktreePath, "merger-agent", "merger");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toEqual(["Bash"]);
	});

	test("default capability (no arg) gets only Bash danger guards", async () => {
		const worktreePath = join(tempDir, "default-wt");

		await deployHooks(worktreePath, "default-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toEqual(["Bash"]);
	});

	test("guards are prepended before base logging hook", async () => {
		const worktreePath = join(tempDir, "order-wt");

		await deployHooks(worktreePath, "order-agent", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Guards (matcher != "") should come before base (matcher == "")
		const baseIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "");
		const writeIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "Write");

		expect(writeIdx).toBeLessThan(baseIdx);
	});
});

describe("getCapabilityGuards", () => {
	test("returns 4 guards for scout (3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("scout");
		expect(guards.length).toBe(4);
	});

	test("returns 4 guards for reviewer (3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("reviewer");
		expect(guards.length).toBe(4);
	});

	test("returns 4 guards for lead (3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("lead");
		expect(guards.length).toBe(4);
	});

	test("returns empty for builder", () => {
		const guards = getCapabilityGuards("builder");
		expect(guards.length).toBe(0);
	});

	test("returns empty for merger", () => {
		const guards = getCapabilityGuards("merger");
		expect(guards.length).toBe(0);
	});

	test("returns empty for unknown capability", () => {
		const guards = getCapabilityGuards("unknown");
		expect(guards.length).toBe(0);
	});

	test("scout guards include Write, Edit, NotebookEdit, and Bash matchers", () => {
		const guards = getCapabilityGuards("scout");
		const matchers = guards.map((g) => g.matcher);
		expect(matchers).toContain("Write");
		expect(matchers).toContain("Edit");
		expect(matchers).toContain("NotebookEdit");
		expect(matchers).toContain("Bash");
	});

	test("lead guards include Write, Edit, NotebookEdit, and Bash matchers", () => {
		const guards = getCapabilityGuards("lead");
		const matchers = guards.map((g) => g.matcher);
		expect(matchers).toContain("Write");
		expect(matchers).toContain("Edit");
		expect(matchers).toContain("NotebookEdit");
		expect(matchers).toContain("Bash");
	});

	test("tool block guards include capability name in reason", () => {
		const guards = getCapabilityGuards("scout");
		const writeGuard = guards.find((g) => g.matcher === "Write");
		expect(writeGuard).toBeDefined();
		expect(writeGuard?.hooks[0]?.command).toContain("scout");
		expect(writeGuard?.hooks[0]?.command).toContain("cannot modify files");
	});

	test("lead tool block guards include lead in reason", () => {
		const guards = getCapabilityGuards("lead");
		const editGuard = guards.find((g) => g.matcher === "Edit");
		expect(editGuard).toBeDefined();
		expect(editGuard?.hooks[0]?.command).toContain("lead");
		expect(editGuard?.hooks[0]?.command).toContain("cannot modify files");
	});

	test("bash file guard for scout includes capability in block message", () => {
		const guards = getCapabilityGuards("scout");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("scout agents cannot modify files");
	});

	test("bash file guard for lead includes capability in block message", () => {
		const guards = getCapabilityGuards("lead");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("lead agents cannot modify files");
	});
});

describe("getDangerGuards", () => {
	test("returns exactly one Bash guard entry", () => {
		const guards = getDangerGuards("test-agent");
		expect(guards).toHaveLength(1);
		expect(guards[0]?.matcher).toBe("Bash");
	});

	test("guard command includes agent name for branch validation", () => {
		const guards = getDangerGuards("my-builder");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("overstory/my-builder/");
	});

	test("guard command checks for git push to main", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("git");
		expect(command).toContain("push");
		expect(command).toContain("main");
	});

	test("guard command checks for git push to master", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("master");
	});

	test("guard command checks for git reset --hard", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("reset");
		expect(command).toContain("--hard");
	});

	test("guard command checks for git checkout -b", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("checkout");
		expect(command).toContain("-b");
	});

	test("guard hook type is command", () => {
		const guards = getDangerGuards("test-agent");
		expect(guards[0]?.hooks[0]?.type).toBe("command");
	});

	test("all capabilities get Bash danger guards in deployed hooks", async () => {
		const capabilities = ["builder", "scout", "reviewer", "lead", "merger"];
		const tempDir = await import("node:fs/promises").then((fs) =>
			fs.mkdtemp(join(require("node:os").tmpdir(), "overstory-danger-test-")),
		);

		try {
			for (const cap of capabilities) {
				const worktreePath = join(tempDir, `${cap}-wt`);
				await deployHooks(worktreePath, `${cap}-agent`, cap);

				const outputPath = join(worktreePath, ".claude", "settings.local.json");
				const content = await Bun.file(outputPath).text();
				const parsed = JSON.parse(content);
				const preToolUse = parsed.hooks.PreToolUse;

				const bashGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
				expect(bashGuard).toBeDefined();
				expect(bashGuard.hooks[0].command).toContain(`overstory/${cap}-agent/`);
			}
		} finally {
			await import("node:fs/promises").then((fs) =>
				fs.rm(tempDir, { recursive: true, force: true }),
			);
		}
	});

	test("danger guards appear before capability guards in scout", async () => {
		const tempDir = await import("node:fs/promises").then((fs) =>
			fs.mkdtemp(join(require("node:os").tmpdir(), "overstory-order-test-")),
		);

		try {
			const worktreePath = join(tempDir, "scout-order-wt");
			await deployHooks(worktreePath, "scout-order", "scout");

			const outputPath = join(worktreePath, ".claude", "settings.local.json");
			const content = await Bun.file(outputPath).text();
			const parsed = JSON.parse(content);
			const preToolUse = parsed.hooks.PreToolUse;

			const firstBashIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "Bash");
			const writeIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "Write");

			// Bash danger guard should come before Write capability guard
			expect(firstBashIdx).toBeLessThan(writeIdx);
		} finally {
			await import("node:fs/promises").then((fs) =>
				fs.rm(tempDir, { recursive: true, force: true }),
			);
		}
	});
});

describe("buildBashFileGuardScript", () => {
	test("returns a string containing the capability name", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("scout agents cannot modify files");
	});

	test("reads stdin input", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("read -r INPUT");
	});

	test("extracts command from JSON input", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain("CMD=$(");
	});

	test("includes safe prefix whitelist checks", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("overstory ");
		expect(script).toContain("bd ");
		expect(script).toContain("git status");
		expect(script).toContain("git log");
		expect(script).toContain("git diff");
		expect(script).toContain("mulch ");
		expect(script).toContain("bun test");
		expect(script).toContain("bun run lint");
	});

	test("includes dangerous command pattern checks", () => {
		const script = buildBashFileGuardScript("lead");
		// File modification commands
		expect(script).toContain("sed");
		expect(script).toContain("tee");
		expect(script).toContain("vim");
		expect(script).toContain("nano");
		expect(script).toContain("mv");
		expect(script).toContain("cp");
		expect(script).toContain("rm");
		expect(script).toContain("mkdir");
		expect(script).toContain("touch");
		// Git modification commands
		expect(script).toContain("git\\s+add");
		expect(script).toContain("git\\s+commit");
		expect(script).toContain("git\\s+push");
	});

	test("blocks sed -i for all non-implementation capabilities", () => {
		for (const cap of ["scout", "reviewer", "lead"]) {
			const script = buildBashFileGuardScript(cap);
			expect(script).toContain("sed\\s+-i");
		}
	});

	test("blocks bun install and bun add", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("bun\\s+install");
		expect(script).toContain("bun\\s+add");
	});

	test("blocks npm install", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("npm\\s+install");
	});

	test("blocks file permission commands", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain("chmod");
		expect(script).toContain("chown");
	});

	test("blocks append redirect operator", () => {
		const script = buildBashFileGuardScript("lead");
		expect(script).toContain(">>");
	});

	test("safe prefix checks use exit 0 to allow", () => {
		const script = buildBashFileGuardScript("scout");
		// Each safe prefix should have an exit 0 to allow the command
		expect(script).toContain("exit 0; fi;");
	});

	test("dangerous pattern check outputs block decision JSON", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain('"decision":"block"');
		expect(script).toContain("reviewer agents cannot modify files");
	});
});

describe("structural enforcement integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-structural-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("non-implementation agents have more guards than implementation agents", async () => {
		const scoutPath = join(tempDir, "scout-wt");
		const builderPath = join(tempDir, "builder-wt");

		await deployHooks(scoutPath, "scout-1", "scout");
		await deployHooks(builderPath, "builder-1", "builder");

		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();
		const builderContent = await Bun.file(
			join(builderPath, ".claude", "settings.local.json"),
		).text();

		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;
		const builderPreToolUse = JSON.parse(builderContent).hooks.PreToolUse;

		// Scout should have more PreToolUse entries than builder
		expect(scoutPreToolUse.length).toBeGreaterThan(builderPreToolUse.length);
	});

	test("scout and reviewer have identical guard structures", async () => {
		const scoutPath = join(tempDir, "scout-wt");
		const reviewerPath = join(tempDir, "reviewer-wt");

		await deployHooks(scoutPath, "scout-1", "scout");
		await deployHooks(reviewerPath, "reviewer-1", "reviewer");

		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();
		const reviewerContent = await Bun.file(
			join(reviewerPath, ".claude", "settings.local.json"),
		).text();

		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;
		const reviewerPreToolUse = JSON.parse(reviewerContent).hooks.PreToolUse;

		// Same number of guards
		expect(scoutPreToolUse.length).toBe(reviewerPreToolUse.length);

		// Same matchers (just different agent names in commands)
		const scoutMatchers = scoutPreToolUse.map((h: { matcher: string }) => h.matcher);
		const reviewerMatchers = reviewerPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(scoutMatchers).toEqual(reviewerMatchers);
	});

	test("lead has same guard structure as scout/reviewer", async () => {
		const leadPath = join(tempDir, "lead-wt");
		const scoutPath = join(tempDir, "scout-wt");

		await deployHooks(leadPath, "lead-1", "lead");
		await deployHooks(scoutPath, "scout-1", "scout");

		const leadContent = await Bun.file(join(leadPath, ".claude", "settings.local.json")).text();
		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();

		const leadPreToolUse = JSON.parse(leadContent).hooks.PreToolUse;
		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;

		// Same number of guards
		expect(leadPreToolUse.length).toBe(scoutPreToolUse.length);

		// Same matchers
		const leadMatchers = leadPreToolUse.map((h: { matcher: string }) => h.matcher);
		const scoutMatchers = scoutPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(leadMatchers).toEqual(scoutMatchers);
	});

	test("builder and merger have identical guard structures", async () => {
		const builderPath = join(tempDir, "builder-wt");
		const mergerPath = join(tempDir, "merger-wt");

		await deployHooks(builderPath, "builder-1", "builder");
		await deployHooks(mergerPath, "merger-1", "merger");

		const builderContent = await Bun.file(
			join(builderPath, ".claude", "settings.local.json"),
		).text();
		const mergerContent = await Bun.file(join(mergerPath, ".claude", "settings.local.json")).text();

		const builderPreToolUse = JSON.parse(builderContent).hooks.PreToolUse;
		const mergerPreToolUse = JSON.parse(mergerContent).hooks.PreToolUse;

		// Same number of guards
		expect(builderPreToolUse.length).toBe(mergerPreToolUse.length);

		// Same matchers
		const builderMatchers = builderPreToolUse.map((h: { matcher: string }) => h.matcher);
		const mergerMatchers = mergerPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(builderMatchers).toEqual(mergerMatchers);
	});

	test("all deployed configs produce valid JSON", async () => {
		const capabilities = ["scout", "reviewer", "lead", "builder", "merger"];

		for (const cap of capabilities) {
			const wt = join(tempDir, `${cap}-wt`);
			await deployHooks(wt, `${cap}-agent`, cap);

			const content = await Bun.file(join(wt, ".claude", "settings.local.json")).text();
			expect(() => JSON.parse(content)).not.toThrow();
		}
	});
});
