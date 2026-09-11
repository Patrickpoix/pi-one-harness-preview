import { DOCUMENT_TRANSFORM_TOOL_NAME } from "../artifacts/document-transform.mjs";
import { COMPUTER_TOOL_NAME } from "../computer-use/cua-adapter.mjs";

export const READONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
]);

export const FILESYSTEM_READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const LOCAL_MUTATION_TOOLS = new Set(["bash", "edit", "write"]);
const CORE_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

export const WEB_TOOLS = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);
export const BROWSER_TOOLS = ["agent_browser", "browser_execute"];
export const AGENT_TOOLS = new Set(["agent", "agent_swarm"]);
export const SCOPED_EXECUTION_TOOL_NAME = "task";
export const CAPABILITY_DISCOVERY_TOOL_NAME = "capability_open";
export const SKILL_OPEN_TOOL_NAME = "skill_open";

/**
 * Projects one Router/profile decision onto the minimum model-facing tool surface.
 * This module owns no runtime state and performs no authorization: execution-time
 * guards remain authoritative in the extension/host owners.
 */
export function selectProfileTools(profile, baseline, {
	allowCodex = false,
	allowMutation = false,
	commandOnly = false,
	capabilityFloor = false,
	forceReadonly = false,
	forbidWeb = false,
	forbidBrowser = false,
	forbidComputer = false,
	forbidAgent = false,
	requiredExecutionSurfaces = [],
} = {}) {
	const profiles = Array.isArray(profile) ? profile : [profile];
	const filter = (names) => baseline.filter((name) => names.has(name) && (allowCodex || name !== "codex_delegate"));
	const browserOwner = BROWSER_TOOLS.find((name) => baseline.includes(name));

	// Only an explicit whole-task user prohibition is allowed to shrink the
	// production capability floor. Router readonly guesses are not authority.
	if (forceReadonly) {
		const webCapable = !forbidWeb && profiles.some((current) => ["web", "academic", "browser"].includes(current));
		const allowed = new Set(webCapable ? READONLY_TOOLS : FILESYSTEM_READONLY_TOOLS);
		allowed.add(CAPABILITY_DISCOVERY_TOOL_NAME);
		allowed.add(SKILL_OPEN_TOOL_NAME);
		if (profiles.includes("browser") && !forbidBrowser && browserOwner) allowed.add(browserOwner);
		if (profiles.includes("computer") && !forbidComputer) allowed.add(COMPUTER_TOOL_NAME);
		if (!forbidAgent && profiles.some((current) => current === "agent" || current === "long")) allowed.add(SCOPED_EXECUTION_TOOL_NAME);
		return filter(allowed);
	}

	// Production uses Router as an optimizer, not a capability authority. Keep
	// a small recovery floor while deferring heavyweight optional schemas.
	if (capabilityFloor) {
		const allowed = new Set(commandOnly ? FILESYSTEM_READONLY_TOOLS : CORE_TOOLS);
		allowed.add(CAPABILITY_DISCOVERY_TOOL_NAME);
		allowed.add(SKILL_OPEN_TOOL_NAME);
		if (requiredExecutionSurfaces.includes("document")) allowed.add(DOCUMENT_TRANSFORM_TOOL_NAME);
		if (!forbidWeb && profiles.some((current) => ["web", "academic", "browser"].includes(current))) {
			for (const name of WEB_TOOLS) allowed.add(name);
		}
		if (profiles.includes("browser") && !forbidBrowser && browserOwner) allowed.add(browserOwner);
		if (profiles.includes("computer") && !forbidComputer) allowed.add(COMPUTER_TOOL_NAME);
		if (!forbidAgent && profiles.some((current) => current === "agent" || current === "long")) {
			allowed.add(SCOPED_EXECUTION_TOOL_NAME);
			allowed.add("agent_swarm");
		}
		if (forbidWeb) for (const name of WEB_TOOLS) allowed.delete(name);
		if (forbidBrowser) for (const name of BROWSER_TOOLS) allowed.delete(name);
		if (forbidComputer) allowed.delete(COMPUTER_TOOL_NAME);
		if (forbidAgent) {
			allowed.delete(SCOPED_EXECUTION_TOOL_NAME);
			for (const name of AGENT_TOOLS) allowed.delete(name);
		}
		if (allowCodex) allowed.add("codex_delegate");
		return filter(allowed);
	}

	const allowed = new Set();
	for (const current of profiles) {
		if (current === "readonly") {
			for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
			if (allowMutation) for (const name of LOCAL_MUTATION_TOOLS) allowed.add(name);
		}
		if (current === "lean") {
			for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
			if (allowMutation) for (const name of LOCAL_MUTATION_TOOLS) allowed.add(name);
		}
		if (current === "web" || current === "academic" || current === "browser") {
			for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
			if (!forbidWeb) {
				for (const name of READONLY_TOOLS) allowed.add(name);
				for (const name of WEB_TOOLS) allowed.add(name);
			}
		}
		if (current === "browser" && !forbidBrowser && browserOwner) allowed.add(browserOwner);
		if (current === "computer") {
			for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
			if (!forbidComputer) allowed.add(COMPUTER_TOOL_NAME);
		}
		if (current === "agent" || current === "long") {
			for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
			if (allowMutation) for (const name of LOCAL_MUTATION_TOOLS) allowed.add(name);
			if (!forbidAgent) for (const name of AGENT_TOOLS) allowed.add(name);
		}
	}
	if (forbidWeb) for (const name of WEB_TOOLS) allowed.delete(name);
	if (forbidBrowser) for (const name of BROWSER_TOOLS) allowed.delete(name);
	if (forbidComputer) allowed.delete(COMPUTER_TOOL_NAME);
	if (forbidAgent) for (const name of AGENT_TOOLS) allowed.delete(name);
	if (!allowed.size) for (const name of FILESYSTEM_READONLY_TOOLS) allowed.add(name);
	if (allowCodex) allowed.add("codex_delegate");
	return filter(allowed);
}
