import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeEntry, OverstoryConfig } from "../types.ts";
import type { DoctorCheck } from "./types.ts";
import { checkMergeQueue } from "./merge-queue.ts";

describe("checkMergeQueue", () => {
	let tempDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-test-"));
		mockConfig = {
			project: { name: "test", root: tempDir, canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
			},
			worktrees: { baseDir: "" },
			beads: { enabled: true },
			mulch: { enabled: true, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			watchdog: {
				tier0Enabled: true,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			sandbox: { enabled: true, allowedDomains: [], denyReadPaths: [] },
			logging: { verbose: false, redactSecrets: true },
		};
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("passes when merge queue file does not exist", () => {
		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.json exists");
		expect(checks[0]?.message).toContain("normal for new installations");
	});

	test("passes when merge queue is empty", () => {
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), "");

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.json format");
		expect(checks[0]?.message).toBe("Merge queue is empty");
	});

	test("passes with valid queue entries", () => {
		const entries: MergeEntry[] = [
			{
				branchName: "feature/test",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "pending",
				resolvedTier: null,
			},
			{
				branchName: "feature/another",
				beadId: "beads-def",
				agentName: "another-agent",
				filesModified: ["src/another.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "merged",
				resolvedTier: "clean-merge",
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.json format");
		expect(checks[0]?.message).toBe("All queue entries are valid");
	});

	test("fails when queue is not an array", () => {
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), '{"entries": []}');

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("fail");
		expect(checks[0]?.name).toBe("merge-queue.json format");
		expect(checks[0]?.message).toContain("must be a JSON array");
	});

	test("fails with invalid JSON", () => {
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), "not valid json");

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("fail");
		expect(checks[0]?.name).toBe("merge-queue.json format");
		expect(checks[0]?.message).toContain("Failed to parse");
	});

	test("fails with missing required fields", () => {
		const entries = [
			{
				branchName: "feature/test",
				// Missing beadId
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "pending",
				resolvedTier: null,
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const entryCheck = checks.find((c) => c?.name === "merge-queue.json entries");
		expect(entryCheck?.status).toBe("fail");
		expect(entryCheck?.details?.[0]).toContain("missing or invalid beadId");
	});

	test("fails with invalid status", () => {
		const entries = [
			{
				branchName: "feature/test",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "invalid-status",
				resolvedTier: null,
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const entryCheck = checks.find((c) => c?.name === "merge-queue.json entries");
		expect(entryCheck?.status).toBe("fail");
		expect(entryCheck?.details?.[0]).toContain("invalid status");
	});

	test("fails with invalid resolvedTier", () => {
		const entries = [
			{
				branchName: "feature/test",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "merged",
				resolvedTier: "invalid-tier",
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const entryCheck = checks.find((c) => c?.name === "merge-queue.json entries");
		expect(entryCheck?.status).toBe("fail");
		expect(entryCheck?.details?.[0]).toContain("invalid resolvedTier");
	});

	test("warns about stale entries", () => {
		const staleDate = new Date();
		staleDate.setDate(staleDate.getDate() - 2); // 2 days ago

		const entries: MergeEntry[] = [
			{
				branchName: "feature/stale",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: staleDate.toISOString(),
				status: "pending",
				resolvedTier: null,
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const staleCheck = checks.find((c) => c?.name === "merge-queue.json staleness");
		expect(staleCheck?.status).toBe("warn");
		expect(staleCheck?.message).toContain("potentially stale");
		expect(staleCheck?.details?.[0]).toContain("feature/stale");
	});

	test("does not warn about old completed entries", () => {
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 2); // 2 days ago

		const entries: MergeEntry[] = [
			{
				branchName: "feature/old-merged",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: oldDate.toISOString(),
				status: "merged",
				resolvedTier: "clean-merge",
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const staleCheck = checks.find((c) => c?.name === "merge-queue.json staleness");
		expect(staleCheck).toBeUndefined();
	});

	test("warns about duplicate branches", () => {
		const entries: MergeEntry[] = [
			{
				branchName: "feature/duplicate",
				beadId: "beads-abc",
				agentName: "test-agent",
				filesModified: ["src/test.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "pending",
				resolvedTier: null,
			},
			{
				branchName: "feature/duplicate",
				beadId: "beads-def",
				agentName: "another-agent",
				filesModified: ["src/another.ts"],
				enqueuedAt: new Date().toISOString(),
				status: "merged",
				resolvedTier: "clean-merge",
			},
		];

		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "merge-queue.json"), `${JSON.stringify(entries, null, "\t")}\n`);

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const duplicateCheck = checks.find((c) => c?.name === "merge-queue.json duplicates");
		expect(duplicateCheck?.status).toBe("warn");
		expect(duplicateCheck?.message).toContain("duplicate branch entries");
		expect(duplicateCheck?.details?.[0]).toContain("feature/duplicate");
	});
});
