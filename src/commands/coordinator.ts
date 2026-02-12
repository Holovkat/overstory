/**
 * CLI command: overstory coordinator start|stop|status
 *
 * Manages the persistent coordinator agent lifecycle. The coordinator runs
 * at the project root (NOT in a worktree), receives work via mail and beads,
 * and dispatches agents via overstory sling.
 *
 * Unlike regular agents spawned by sling, the coordinator:
 * - Has no worktree (operates on the main working tree)
 * - Has no bead assignment (it creates beads, not works on them)
 * - Has no overlay CLAUDE.md (context comes via mail + beads + checkpoints)
 * - Persists across work batches
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import type { AgentSession } from "../types.ts";
import { createSession, isSessionAlive, killSession, sendKeys } from "../worktree/tmux.ts";

/** Default coordinator agent name. */
const COORDINATOR_NAME = "coordinator";

/** Tmux session name for the coordinator. */
const TMUX_SESSION = `overstory-${COORDINATOR_NAME}`;

/**
 * Load sessions registry from .overstory/sessions.json.
 */
export async function loadSessions(sessionsPath: string): Promise<AgentSession[]> {
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) {
		return [];
	}
	try {
		const text = await file.text();
		return JSON.parse(text) as AgentSession[];
	} catch {
		return [];
	}
}

/**
 * Save sessions registry to .overstory/sessions.json.
 */
export async function saveSessions(sessionsPath: string, sessions: AgentSession[]): Promise<void> {
	await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);
}

/**
 * Find the active coordinator session (if any).
 */
function findCoordinatorSession(sessions: AgentSession[]): AgentSession | undefined {
	return sessions.find(
		(s) =>
			s.agentName === COORDINATOR_NAME &&
			s.capability === "coordinator" &&
			s.state !== "completed" &&
			s.state !== "zombie",
	);
}

/**
 * Build the coordinator startup beacon — the first message sent to the coordinator
 * via tmux send-keys after Claude Code initializes.
 */
export function buildCoordinatorBeacon(): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${COORDINATOR_NAME} (coordinator) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: persistent orchestrator",
		`Startup: run mulch prime, check mail (overstory mail check --agent ${COORDINATOR_NAME}), check bd ready, check overstory group status, then await instructions`,
	];
	return parts.join(" — ");
}

/**
 * Start the coordinator agent.
 *
 * 1. Verify no coordinator is already running
 * 2. Load config
 * 3. Deploy hooks to project root's .claude/ (coordinator-specific guards)
 * 4. Create agent identity (if first time)
 * 5. Spawn tmux session at project root with Claude Code
 * 6. Send startup beacon
 * 7. Record session in sessions.json
 */
async function startCoordinator(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	// Check for existing coordinator
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const existing = findCoordinatorSession(sessions);

	if (existing) {
		const alive = await isSessionAlive(existing.tmuxSession);
		if (alive) {
			throw new AgentError(
				`Coordinator is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
				{ agentName: COORDINATOR_NAME },
			);
		}
		// Session recorded but tmux is dead — mark as completed and continue
		existing.state = "completed";
		await saveSessions(sessionsPath, sessions);
	}

	// Deploy coordinator-specific hooks to the project root's .claude/ directory.
	// The coordinator gets the same structural enforcement as other non-implementation
	// agents (Write/Edit/NotebookEdit blocked, dangerous bash commands blocked).
	await deployHooks(projectRoot, COORDINATOR_NAME, "coordinator");

	// Create coordinator identity if first run
	const identityBaseDir = join(projectRoot, ".overstory", "agents");
	await mkdir(identityBaseDir, { recursive: true });
	const existingIdentity = await loadIdentity(identityBaseDir, COORDINATOR_NAME);
	if (!existingIdentity) {
		await createIdentity(identityBaseDir, {
			name: COORDINATOR_NAME,
			capability: "coordinator",
			created: new Date().toISOString(),
			sessionsCompleted: 0,
			expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
			recentTasks: [],
		});
	}

	// Spawn tmux session at project root with Claude Code (interactive mode)
	const claudeCmd = "claude --model opus --dangerously-skip-permissions";
	const pid = await createSession(TMUX_SESSION, projectRoot, claudeCmd, {
		OVERSTORY_AGENT_NAME: COORDINATOR_NAME,
	});

	// Send beacon after TUI initialization delay
	await Bun.sleep(3_000);
	const beacon = buildCoordinatorBeacon();
	await sendKeys(TMUX_SESSION, beacon);

	// Follow-up Enter to ensure submission (same pattern as sling.ts)
	await Bun.sleep(500);
	await sendKeys(TMUX_SESSION, "");

	// Record session
	const session: AgentSession = {
		id: `session-${Date.now()}-${COORDINATOR_NAME}`,
		agentName: COORDINATOR_NAME,
		capability: "coordinator",
		worktreePath: projectRoot, // Coordinator uses project root, not a worktree
		branchName: config.project.canonicalBranch, // Operates on canonical branch
		beadId: "", // No specific bead assignment
		tmuxSession: TMUX_SESSION,
		state: "booting",
		pid,
		parentAgent: null, // Top of hierarchy
		depth: 0,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	};

	sessions.push(session);
	await saveSessions(sessionsPath, sessions);

	const output = {
		agentName: COORDINATOR_NAME,
		capability: "coordinator",
		tmuxSession: TMUX_SESSION,
		projectRoot,
		pid,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(output)}\n`);
	} else {
		process.stdout.write("Coordinator started\n");
		process.stdout.write(`  Tmux:    ${TMUX_SESSION}\n`);
		process.stdout.write(`  Root:    ${projectRoot}\n`);
		process.stdout.write(`  PID:     ${pid}\n`);
	}
}

/**
 * Stop the coordinator agent.
 *
 * 1. Find the active coordinator session
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in sessions.json
 */
async function stopCoordinator(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const session = findCoordinatorSession(sessions);

	if (!session) {
		throw new AgentError("No active coordinator session found", {
			agentName: COORDINATOR_NAME,
		});
	}

	// Kill tmux session with process tree cleanup
	const alive = await isSessionAlive(session.tmuxSession);
	if (alive) {
		await killSession(session.tmuxSession);
	}

	// Update session state
	session.state = "completed";
	session.lastActivity = new Date().toISOString();
	await saveSessions(sessionsPath, sessions);

	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
	} else {
		process.stdout.write(`Coordinator stopped (session: ${session.id})\n`);
	}
}

/**
 * Show coordinator status.
 *
 * Checks session registry and tmux liveness to report actual state.
 */
async function statusCoordinator(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const session = findCoordinatorSession(sessions);

	if (!session) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("Coordinator is not running\n");
		}
		return;
	}

	const alive = await isSessionAlive(session.tmuxSession);

	// Reconcile state: if session says active but tmux is dead, update
	if (!alive && session.state !== "completed" && session.state !== "zombie") {
		session.state = "zombie";
		session.lastActivity = new Date().toISOString();
		await saveSessions(sessionsPath, sessions);
	}

	const status = {
		running: alive,
		sessionId: session.id,
		state: session.state,
		tmuxSession: session.tmuxSession,
		pid: session.pid,
		startedAt: session.startedAt,
		lastActivity: session.lastActivity,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(status)}\n`);
	} else {
		const stateLabel = alive ? "running" : session.state;
		process.stdout.write(`Coordinator: ${stateLabel}\n`);
		process.stdout.write(`  Session:   ${session.id}\n`);
		process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
		process.stdout.write(`  PID:       ${session.pid}\n`);
		process.stdout.write(`  Started:   ${session.startedAt}\n`);
		process.stdout.write(`  Activity:  ${session.lastActivity}\n`);
	}
}

const COORDINATOR_HELP = `overstory coordinator — Manage the persistent coordinator agent

Usage: overstory coordinator <subcommand> [flags]

Subcommands:
  start                    Start the coordinator (spawns Claude Code at project root)
  stop                     Stop the coordinator (kills tmux session)
  status                   Show coordinator state

Options:
  --json                   Output as JSON
  --help, -h               Show this help

The coordinator runs at the project root and orchestrates work by:
  - Decomposing objectives into beads issues
  - Dispatching agents via overstory sling
  - Tracking batches via task groups
  - Handling escalations from agents and watchdog`;

/**
 * Entry point for `overstory coordinator <subcommand>`.
 */
export async function coordinatorCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${COORDINATOR_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startCoordinator(subArgs);
			break;
		case "stop":
			await stopCoordinator(subArgs);
			break;
		case "status":
			await statusCoordinator(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown coordinator subcommand: ${subcommand}. Run 'overstory coordinator --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
