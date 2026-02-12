/**
 * Console reporter with ANSI colors for human-readable log output.
 *
 * Formats LogEvent objects into colored terminal output.
 * Uses ANSI escape codes directly (no external dependencies).
 */

import type { LogEvent } from "../types.ts";

// ANSI escape codes for coloring output by log level
const ANSI = {
	reset: "\x1b[0m",
	gray: "\x1b[90m",
	blue: "\x1b[34m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
} as const;

const LEVEL_COLORS: Record<LogEvent["level"], string> = {
	debug: ANSI.gray,
	info: ANSI.blue,
	warn: ANSI.yellow,
	error: ANSI.red,
};

const LEVEL_LABELS: Record<LogEvent["level"], string> = {
	debug: "DBG",
	info: "INF",
	warn: "WRN",
	error: "ERR",
};

/**
 * Format a LogEvent into a single human-readable line with ANSI colors.
 *
 * Format: `[HH:MM:SS] LVL agent | event key=value key=value`
 */
export function formatLogLine(event: LogEvent): string {
	const color = LEVEL_COLORS[event.level];
	const label = LEVEL_LABELS[event.level];

	// Extract just the time portion for compact display
	const time = extractTime(event.timestamp);

	// Build the agent prefix
	const agentPart = event.agentName ? `${ANSI.dim}${event.agentName}${ANSI.reset} | ` : "";

	// Build key=value pairs from data
	const dataPart = formatData(event.data);
	const dataSuffix = dataPart.length > 0 ? ` ${ANSI.dim}${dataPart}${ANSI.reset}` : "";

	return `${ANSI.dim}[${time}]${ANSI.reset} ${color}${ANSI.bold}${label}${ANSI.reset} ${agentPart}${event.event}${dataSuffix}`;
}

/**
 * Print a LogEvent to the console, respecting verbose mode.
 *
 * When verbose is false, debug-level events are suppressed.
 * Errors go to stderr; everything else goes to stdout.
 */
export function printToConsole(event: LogEvent, verbose: boolean): void {
	if (!verbose && event.level === "debug") {
		return;
	}

	const line = formatLogLine(event);

	if (event.level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

/**
 * Extract the HH:MM:SS portion from an ISO timestamp.
 * Falls back to the raw timestamp if parsing fails.
 */
function extractTime(timestamp: string): string {
	// ISO 8601: "2024-01-15T14:30:00.123Z" -> "14:30:00"
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return timestamp;
}

/**
 * Format a data record as space-separated key=value pairs.
 * Handles nested objects by JSON-stringifying them.
 */
function formatData(data: Record<string, unknown>): string {
	const entries = Object.entries(data);
	if (entries.length === 0) {
		return "";
	}

	return entries
		.map(([key, value]) => {
			if (value === undefined || value === null) {
				return `${key}=null`;
			}
			if (typeof value === "string") {
				// Quote strings that contain spaces
				return value.includes(" ") ? `${key}="${value}"` : `${key}=${value}`;
			}
			if (typeof value === "object") {
				return `${key}=${JSON.stringify(value)}`;
			}
			return `${key}=${String(value)}`;
		})
		.join(" ");
}
