/**
 * Tests for overstory dashboard command.
 *
 * We only test help output and validation since the dashboard runs an infinite
 * polling loop. The actual rendering cannot be tested without complex mocking
 * of terminal state and multiple data sources.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../errors.ts";
import { dashboardCommand } from "./dashboard.ts";

describe("dashboardCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = originalWrite;
	});

	function output(): string {
		return chunks.join("");
	}

	test("--help flag prints help text", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("-h flag prints help text", async () => {
		await dashboardCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("--interval with non-numeric value throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "abc"])).rejects.toThrow(ValidationError);
	});

	test("--interval below 500 throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "499"])).rejects.toThrow(ValidationError);
	});

	test("--interval with NaN throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "not-a-number"])).rejects.toThrow(ValidationError);
	});

	test("--interval at exactly 500 passes validation", async () => {
		// This test verifies that interval validation passes for the value 500.
		// The command may fail later (e.g., loadConfig), or in our test environment
		// it might even start the polling loop (since we're in the overstory repo).
		// Either way, we just verify it doesn't throw a ValidationError about interval.

		// Set up a promise that rejects with a timeout error after 100ms
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("TIMEOUT")), 100);
		});

		try {
			// Race the command against a timeout
			await Promise.race([dashboardCommand(["--interval", "500"]), timeoutPromise]);
		} catch (err) {
			// If it's a ValidationError about interval, the test should fail
			if (err instanceof ValidationError && err.field === "interval") {
				throw new Error("Interval validation should have passed for value 500");
			}
			// TIMEOUT error means the command started running (validation passed) - this is good
			// Other errors (like from loadConfig) are also fine - they occur after validation
		}

		// If we reach here without throwing, validation passed
	});
});
