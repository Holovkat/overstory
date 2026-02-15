import { join } from "node:path";
import type { MergeEntry } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Merge queue health checks.
 * Validates merge-queue.json format and detects stale entries.
 */
export const checkMergeQueue: DoctorCheckFn = (_config, overstoryDir): DoctorCheck[] => {
	const checks: DoctorCheck[] = [];
	const queuePath = join(overstoryDir, "merge-queue.json");

	// Check if file exists
	if (!existsSync(queuePath)) {
		checks.push({
			name: "merge-queue.json exists",
			category: "merge",
			status: "pass",
			message: "No merge queue file (normal for new installations or no merges yet)",
		});
		return checks;
	}

	// Try to read and parse the queue
	let entries: MergeEntry[];
	try {
		const { readFileSync } = require("node:fs");
		const raw = readFileSync(queuePath, "utf-8") as string;
		const trimmed = raw.trim();

		if (trimmed === "") {
			checks.push({
				name: "merge-queue.json format",
				category: "merge",
				status: "pass",
				message: "Merge queue is empty",
			});
			return checks;
		}

		const parsed = JSON.parse(trimmed) as unknown;

		// Validate it's an array
		if (!Array.isArray(parsed)) {
			checks.push({
				name: "merge-queue.json format",
				category: "merge",
				status: "fail",
				message: "Merge queue must be a JSON array",
				details: [`Found: ${typeof parsed}`, "Expected: array of MergeEntry objects"],
				fixable: true,
			});
			return checks;
		}

		entries = parsed as MergeEntry[];
	} catch (err) {
		checks.push({
			name: "merge-queue.json format",
			category: "merge",
			status: "fail",
			message: "Failed to parse merge-queue.json",
			details: [
				err instanceof Error ? err.message : String(err),
				"File may be corrupted or contain invalid JSON",
			],
			fixable: true,
		});
		return checks;
	}

	// Validate each entry's structure
	const validStatuses = new Set(["pending", "merging", "merged", "conflict", "failed"]);
	const validTiers = new Set(["clean-merge", "auto-resolve", "ai-resolve", "reimagine"]);
	const invalidEntries: string[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const issues: string[] = [];

		// Check required fields
		if (!entry.branchName || typeof entry.branchName !== "string") {
			issues.push("missing or invalid branchName");
		}
		if (!entry.beadId || typeof entry.beadId !== "string") {
			issues.push("missing or invalid beadId");
		}
		if (!entry.agentName || typeof entry.agentName !== "string") {
			issues.push("missing or invalid agentName");
		}
		if (!Array.isArray(entry.filesModified)) {
			issues.push("missing or invalid filesModified array");
		}
		if (!entry.enqueuedAt || typeof entry.enqueuedAt !== "string") {
			issues.push("missing or invalid enqueuedAt");
		}
		if (!entry.status || !validStatuses.has(entry.status)) {
			issues.push(`invalid status: ${entry.status}`);
		}
		if (entry.resolvedTier !== null && !validTiers.has(entry.resolvedTier)) {
			issues.push(`invalid resolvedTier: ${entry.resolvedTier}`);
		}

		if (issues.length > 0) {
			invalidEntries.push(`Entry ${i} (${entry.branchName || "unknown"}): ${issues.join(", ")}`);
		}
	}

	if (invalidEntries.length > 0) {
		checks.push({
			name: "merge-queue.json entries",
			category: "merge",
			status: "fail",
			message: `Found ${invalidEntries.length} invalid queue entries`,
			details: invalidEntries,
			fixable: true,
		});
	} else {
		checks.push({
			name: "merge-queue.json format",
			category: "merge",
			status: "pass",
			message: "All queue entries are valid",
		});
	}

	// Check for stale entries
	const now = new Date();
	const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
	const staleEntries: string[] = [];

	for (const entry of entries) {
		if (!entry) continue;

		try {
			const enqueuedAt = new Date(entry.enqueuedAt);
			const ageMs = now.getTime() - enqueuedAt.getTime();

			// Warn about old pending/merging entries
			if ((entry.status === "pending" || entry.status === "merging") && ageMs > staleThresholdMs) {
				const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
				staleEntries.push(`${entry.branchName} (${entry.status}, ${ageHours}h old) - may be stuck`);
			}
		} catch {
			// Invalid date, already caught by validation above
		}
	}

	if (staleEntries.length > 0) {
		checks.push({
			name: "merge-queue.json staleness",
			category: "merge",
			status: "warn",
			message: `Found ${staleEntries.length} potentially stale queue entries`,
			details: staleEntries,
			fixable: true,
		});
	}

	// Check for duplicates (same branch appearing multiple times)
	const branchCounts = new Map<string, number>();
	for (const entry of entries) {
		if (!entry?.branchName) continue;
		branchCounts.set(entry.branchName, (branchCounts.get(entry.branchName) ?? 0) + 1);
	}

	const duplicates: string[] = [];
	for (const [branch, count] of branchCounts) {
		if (count > 1) {
			duplicates.push(`${branch} (appears ${count} times)`);
		}
	}

	if (duplicates.length > 0) {
		checks.push({
			name: "merge-queue.json duplicates",
			category: "merge",
			status: "warn",
			message: "Found duplicate branch entries in queue",
			details: duplicates,
			fixable: true,
		});
	}

	return checks;
};

/** Helper to check if file exists (synchronous). */
function existsSync(path: string): boolean {
	try {
		const { existsSync } = require("node:fs");
		return existsSync(path);
	} catch {
		return false;
	}
}
