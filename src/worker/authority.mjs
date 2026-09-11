import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyExternalAction } from "../external-actions.mjs";
import { canonicalize, discoverProtectedRoots } from "../protected-assets.mjs";
import { decideLocalExecution } from "../policy/local-execution.mjs";

function text(value) {
	return typeof value === "string" ? value.trim() : "";
}

function stable(value) {
	if (value == null) return "";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${key}:${stable(value[key])}`).join("|")}}`;
	return String(value);
}

function pathIdentity(value, platform = process.platform) {
	return platform === "win32" ? String(value).toLowerCase() : String(value);
}

function platformPath(platform = process.platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

export function canonicalPath(value, cwd, platform = process.platform) {
	const home = platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	const result = canonicalize(String(value || ""), cwd, home, platform);
	if (!result) throw new Error("invalid_path");
	return result;
}

export function isWithin(candidate, root, platform = process.platform) {
	const api = platformPath(platform);
	const current = pathIdentity(candidate, platform);
	const scope = pathIdentity(String(root).replace(/[\\/]+$/u, ""), platform);
	return current === scope || current.startsWith(`${scope}${api.sep}`);
}

export function normalizeScope(scope, cwd, { allowDefault = true, platform = process.platform } = {}) {
	const values = Array.isArray(scope) ? scope : allowDefault ? [cwd] : [];
	const normalized = [];
	const seen = new Set();
	for (const value of values) {
		const entry = canonicalPath(value, cwd, platform);
		if (seen.has(entry)) continue;
		seen.add(entry);
		normalized.push(entry);
	}
	return normalized;
}

export function scopeContainsPath(scope, candidate, cwd, platform = process.platform) {
	let normalized;
	try { normalized = canonicalPath(candidate, cwd, platform); } catch { return false; }
	return scope.some((root) => isWithin(normalized, root, platform));
}

export function guardPath(value, scope, cwd, { kind = "read", protectedRoots, allowProtectedExact = false, platform = process.platform } = {}) {
	const normalized = canonicalPath(value, cwd, platform);
	if (!scope.some((root) => isWithin(normalized, root, platform))) return { allowed: false, reason: "blocked_scope_expansion", path: normalized };
	const protectedMatch = (protectedRoots || discoverProtectedRoots({ cwd, platform })).find((root) => root.kind === "file" ? pathIdentity(normalized, platform) === pathIdentity(root.path, platform) : isWithin(normalized, root.path, platform));
	if (protectedMatch && !(allowProtectedExact && kind === "edit" && protectedMatch.kind === "file" && scope.includes(protectedMatch.path))) return { allowed: false, reason: "protected_boundary", path: normalized, protectedRoot: protectedMatch.path };
	if (["write", "edit", "bash"].includes(kind) && !scope.some((root) => isWithin(normalized, root, platform))) return { allowed: false, reason: "blocked_write_scope", path: normalized };
	return { allowed: true, path: normalized };
}

export function guardSearchResults(results, readScope, cwd) {
	const paths = Array.isArray(results) ? results : [];
	for (const value of paths) {
		const check = guardPath(value, readScope, cwd, { kind: "read" });
		if (!check.allowed) return { allowed: false, reason: "search_result_out_of_scope", path: check.path };
	}
	return { allowed: true, paths: paths.map((value) => canonicalPath(value, cwd)) };
}

export function commandIdentity(command) {
	// Only line endings and surrounding whitespace are transport-normalized.
	// Internal shell whitespace remains part of the exact admitted command.
	return String(command || "").replace(/\r\n?/gu, "\n").trim();
}

function simpleShellTokens(command) {
	const identity = commandIdentity(command);
	if (!identity || /[\r\n;&|<>`]/u.test(identity) || /\$\(/u.test(identity)) return null;
	const tokens = [];
	const pattern = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+)/gu;
	let cursor = 0;
	let match;
	while ((match = pattern.exec(identity)) !== null) {
		if (identity.slice(cursor, match.index).trim()) return null;
		tokens.push(match[1] ?? match[2] ?? match[3]);
		cursor = pattern.lastIndex;
	}
	if (identity.slice(cursor).trim()) return null;
	return tokens;
}

function pathWithin(candidate, root, platform = process.platform) {
	const api = platformPath(platform);
	const left = pathIdentity(api.resolve(candidate), platform);
	const right = pathIdentity(api.resolve(root).replace(/[\\/]+$/u, ""), platform);
	return left === right || left.startsWith(`${right}${api.sep}`);
}

function untrustedExecutableToken(value) {
	const token = String(value || "");
	return !token || token === "." || token === ".." || token.includes("/") || token.includes("\\") || path.posix.isAbsolute(token) || path.win32.isAbsolute(token);
}

function shellStartupHook(env) {
	return Object.entries(env || {}).some(([name, value]) => {
		if (!text(value)) return false;
		return name === "BASH_ENV" || name === "ENV" || name.startsWith("BASH_FUNC_");
	});
}

function resolvePathExecutable(executable, cwd, env) {
	const pathValue = env?.PATH ?? env?.Path;
	if (typeof pathValue !== "string" || !pathValue.trim()) return null;
	const delimiter = process.platform === "win32" ? ";" : ":";
	const extensions = process.platform === "win32"
		? ["", ...(String(env?.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))]
		: [""];
	for (const rawDirectory of pathValue.split(delimiter)) {
		const directory = rawDirectory.trim() || cwd;
		for (const extension of extensions) {
			const candidate = path.resolve(directory, `${executable}${extension}`);
			try {
				const stat = fsSync.statSync(candidate);
				if (!stat.isFile()) continue;
				return fsSync.realpathSync.native(candidate);
			} catch {
				// PATH resolution is advisory here; an unavailable entry is not a
				// reason to turn an otherwise safe command into a hard failure.
			}
		}
	}
	return null;
}

function quoteShellExecutable(executablePath) {
	const normalized = process.platform === "win32" ? String(executablePath).replace(/\\/gu, "/") : String(executablePath);
	return `'${normalized.replace(/'/gu, "'\"'\"'")}'`;
}

function resolvedExecutionCommand(command, cwd, env) {
	const identity = commandIdentity(command);
	const tokens = simpleShellTokens(identity);
	if (!tokens?.length) return { command: identity };
	const executableToken = String(tokens[0] || "");
	if (untrustedExecutableToken(executableToken)) return { command: identity };
	const executablePath = resolvePathExecutable(executableToken, cwd, env);
	if (!executablePath) return { command: identity };
	if (pathWithin(executablePath, cwd)) return { command: identity, executablePath, reason: "blocked_workspace_executable" };
	const firstToken = identity.match(/^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/u)?.[0];
	if (!firstToken) return { command: identity };
	return {
		command: `${quoteShellExecutable(executablePath)}${identity.slice(firstToken.length)}`,
		executablePath,
	};
}

/**
 * Shell is fail-closed: only a deliberately small class of commands whose
 * command semantics are read-only is marked confirmed_readonly. Everything
 * else is possible mutation and must enter a scoped command-grant path.
 */
export function classifyShellCommand(command, options = {}) {
	const identity = commandIdentity(command);
	const tokens = simpleShellTokens(identity);
	if (!tokens?.length) return { identity, classification: "possible_mutation", confirmedReadonly: false };
	const executableToken = String(tokens[0] || "");
	const executable = path.basename(executableToken).toLowerCase().replace(/\.exe$/u, "");
	const args = tokens.slice(1);
	if (untrustedExecutableToken(executableToken)) {
		return { identity, classification: "possible_mutation", confirmedReadonly: false, executable, reason: "blocked_untrusted_executable_identity" };
	}
	const enforceIdentity = options?.enforceExecutableIdentity === true;
	if (enforceIdentity && shellStartupHook(options.env)) {
		return { identity, classification: "possible_mutation", confirmedReadonly: false, executable, reason: "blocked_shell_startup_hook" };
	}
	if (enforceIdentity && options?.cwd) {
		const resolved = resolvePathExecutable(executableToken, options.cwd, options.env);
		if (resolved && pathWithin(resolved, options.cwd)) {
			return { identity, classification: "possible_mutation", confirmedReadonly: false, executable, executablePath: resolved, reason: "blocked_workspace_executable" };
		}
		const trustedRoots = Array.isArray(options.trustedExecutableRoots) ? options.trustedExecutableRoots.filter(Boolean) : [];
		if (resolved && trustedRoots.length && !trustedRoots.some((root) => pathWithin(resolved, root))) {
			return { identity, classification: "possible_mutation", confirmedReadonly: false, executable, executablePath: resolved, reason: "blocked_untrusted_executable_identity" };
		}
	}
	const simpleReaders = new Set(["pwd", "ls", "dir", "cat", "head", "tail", "wc", "grep", "where", "which", "echo", "printf"]);
	if (simpleReaders.has(executable)) return { identity, classification: "confirmed_readonly", confirmedReadonly: true, executable };
	if (executable === "rg" && !args.some((arg) => /^--pre(?:=|$)/u.test(String(arg)))) {
		return { identity, classification: "confirmed_readonly", confirmedReadonly: true, executable };
	}
	if (["node", "python", "python3", "npm", "pnpm", "yarn", "bun"].includes(executable)
		&& args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) {
		return { identity, classification: "confirmed_readonly", confirmedReadonly: true, executable };
	}
	return { identity, classification: "possible_mutation", confirmedReadonly: false, executable };
}

/**
 * Resolve only filesystem operands that a confirmed-readonly shell command can
 * actually reach. Pattern/flag tokens that are not paths are ignored; existing
 * files/directories and the static parent of glob operands are canonicalized to
 * their real path so a symlink cannot widen Worker read authority.
 */
export function readonlyShellReadPaths(command, cwd) {
	const classification = classifyShellCommand(command);
	if (!classification.confirmedReadonly) return [];
	const tokens = simpleShellTokens(command);
	if (!tokens?.length) return [];
	const executable = path.basename(String(tokens[0] || "")).toLowerCase().replace(/\.exe$/u, "");
	if (["pwd", "echo", "printf", "which", "where"].includes(executable)) return [];
	let operands = tokens.slice(1);
	if (["grep", "rg"].includes(executable)) {
		let patternConsumed = false;
		const next = [];
		for (let index = 0; index < operands.length; index += 1) {
			const token = String(operands[index] || "");
			if (token === "-e" || token === "--regexp") {
				index += 1;
				patternConsumed = true;
				continue;
			}
			if (token.startsWith("--regexp=")) {
				patternConsumed = true;
				continue;
			}
			if (token.startsWith("-")) continue;
			if (!patternConsumed) {
				patternConsumed = true;
				continue;
			}
			next.push(token);
		}
		operands = next;
	}
	const values = [];
	for (const token of operands) {
		let value = String(token || "");
		if (!value || value === "-") continue;
		if (value.startsWith("-") && value.includes("=")) value = value.slice(value.indexOf("=") + 1);
		else if (value.startsWith("-")) continue;
		if (!value) continue;
		const wildcard = value.search(/[?*[]/u);
		if (wildcard >= 0) {
			const prefix = value.slice(0, wildcard);
			value = prefix.endsWith("/") || prefix.endsWith("\\") ? prefix : path.dirname(prefix || ".");
		}
		let candidate;
		try { candidate = canonicalPath(value, cwd); } catch { continue; }
		try {
			const stat = fsSync.statSync(candidate);
			if (!stat.isFile() && !stat.isDirectory()) continue;
			candidate = fsSync.realpathSync.native(candidate);
		} catch {
			continue;
		}
		values.push(candidate);
	}
	return [...new Set(values)];
}

export function isOpaqueMutationCommand(command) {
	return classifyShellCommand(command).confirmedReadonly !== true;
}

/**
 * Classifies whether a model-facing Worker request asks for mutation authority.
 * This only inspects request shape; actual admission stays with WorkerRuntime.
 */
export function workerMutationRequested(input, toolName = "") {
	const requests = toolName === "agent_swarm" && Array.isArray(input?.requests) ? input.requests : [input];
	return requests.some((request) => {
		const role = String(request?.subagent_type ?? request?.role ?? "").toLowerCase();
		const mutationCommandGranted = Array.isArray(request?.command_grants) && request.command_grants.some((grant) => {
			const scope = grant?.expected_mutation_scope;
			return (Array.isArray(scope) && scope.length > 0) || (typeof scope === "string" && scope.trim().length > 0);
		});
		return /(?:coder|mutation|writer)/u.test(role)
			|| (Array.isArray(request?.write_scope) && request.write_scope.length > 0)
			|| mutationCommandGranted;
	});
}

/** Extracts command grants from both single-task and swarm request shapes. */
export function workerCommandGrantInputs(input, toolName = "") {
	const requests = toolName === "agent_swarm" && Array.isArray(input?.requests) ? input.requests : [input];
	return requests.flatMap((request) => {
		const grants = request?.command_grants ?? request?.commandGrants;
		const writeScope = request?.write_scope ?? request?.writeScope;
		return Array.isArray(grants) ? grants.map((grant) => ({ grant, writeScope })) : [];
	});
}

export function commandScriptPath(command) {
	const tokens = simpleShellTokens(command);
	if (!tokens?.length) return null;
	const executable = path.basename(String(tokens[0] || "")).toLowerCase().replace(/\.exe$/u, "");
	if (!["node", "python", "python3", "powershell", "pwsh", "bash"].includes(executable)) return null;
	const args = tokens.slice(1);
	if (args.some((arg) => /^-(?:e|c|command)$/iu.test(String(arg)))) return null;
	const file = args.find((arg) => /\.(?:mjs|cjs|js|py|ps1|sh|bat|cmd)$/iu.test(String(arg)) && !String(arg).startsWith("-"));
	return file || null;
}

const OPAQUE_EXTERNAL_LAUNCHER = /\b(?:node(?:\.exe)?|python(?:3)?(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash(?:\.exe)?|sh|zsh|cmd(?:\.exe)?|npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun(?:\.exe)?|npx(?:\.cmd)?|tsx(?:\.cmd)?|ts-node(?:\.cmd)?|deno(?:\.exe)?)\b/iu;

/**
 * External authority is separate from filesystem mutation scope. Directly
 * recognized external mutations keep the existing classifier owner, while
 * interpreter/script/package-runner commands are external-unknown because the
 * launcher text cannot prove that the process tree stays local.
 */
export function classifyCommandExternalAuthority(command) {
	const identity = commandIdentity(command);
	const direct = classifyExternalAction({ args: { command: identity } });
	if (direct.decision === "deny") return { required: true, kind: "recognized-external", action: direct.action, label: direct.label };
	if (classifyShellCommand(identity).confirmedReadonly) return { required: false, kind: "confirmed-readonly" };
	if (commandScriptPath(identity) || OPAQUE_EXTERNAL_LAUNCHER.test(identity)) {
		return { required: true, kind: "external-unknown", action: "external-unknown", label: "opaque process may have external side effects" };
	}
	return { required: false, kind: "local-command" };
}

export function isWorkerVerificationCommand(command) {
	const tokens = simpleShellTokens(command);
	if (!tokens || tokens.length < 2) return false;
	const executable = path.basename(String(tokens[0] || "")).toLowerCase().replace(/\.exe$/u, "");
	if (executable !== "node" || String(tokens[1]) !== "--test") return false;
	// The host owns the verification sandbox flags. A model-supplied permission
	// or isolation override would make the residual wider than the admitted
	// `node --test` contract, so reject it before execution-command rewriting.
	return !tokens.slice(2).some((arg) => /^(?:--permission(?:=|$)|--allow-|--(?:experimental-)?test-isolation(?:=|$))/iu.test(String(arg)));
}

/**
 * Hardens the one production verification residual with Node's own Permission
 * Model. `--test-isolation=none` avoids opening child-process authority just
 * to let the test runner start its per-file Node children. The resulting
 * process can read the admitted cwd but cannot write files or spawn children.
 */
export function workerVerificationExecutionCommand(command, executionCommand = command) {
	if (!isWorkerVerificationCommand(command)) return null;
	const identity = commandIdentity(executionCommand);
	const executable = identity.match(/^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/u)?.[0];
	if (!executable) return null;
	const tail = identity.slice(executable.length).trimStart();
	return `${executable} --permission --allow-fs-read=. --test-isolation=none${tail ? ` ${tail}` : ""}`;
}

function requiresCommandProvenance(command) {
	return Boolean(commandScriptPath(command))
		|| /(?:&&|\|\||[;&<>]|\b(?:node|python(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash)\s+-(?:e|c)\b|\b(?:npm|pnpm|yarn)\s+(?:install|add|exec)\b)/iu.test(commandIdentity(command));
}

export function createAuthorityRevision(input = {}) {
	return crypto.createHash("sha256").update(stable({
		cwd: input.cwd,
		workspace: input.workspace,
		readScope: input.readScope,
		writeScope: input.writeScope,
		authorityPaths: input.authorityPaths,
		authorityFingerprints: input.authorityFingerprints,
		authorityProjection: input.authorityProjection,
		authorityFiles: input.authorityFiles,
		effectiveMenu: input.effectiveMenu,
		selectedSkillRefs: input.selectedSkillRefs,
	})).digest("hex");
}

export function admitCommand(grants, command, cwd, envNames = [], hostEnv = process.env, hostFacts = {}) {
	const identity = commandIdentity(command);
	const canonicalCwd = canonicalPath(cwd, cwd);
	const envIdentity = (name) => workerEnvIdentity(name, hostFacts.platform || process.platform);
	const grant = (grants || []).find((candidate) => {
		const candidateEnv = new Set((candidate.allowedEnvNames || []).map(envIdentity));
		return commandIdentity(candidate.command) === identity
			&& canonicalPath(candidate.cwd || cwd, cwd) === canonicalCwd
			&& envNames.every((name) => candidateEnv.has(envIdentity(name)));
	});
	if (!grant) return { allowed: false, reason: "blocked_command_grant", command: identity, cwd: canonicalCwd };
	const hostAllowedEnvNames = new Set(resolveWorkerEnvAllowlist(Array.isArray(hostFacts.allowedEnvNames) ? hostFacts.allowedEnvNames : [], hostFacts.platform || process.platform).map(envIdentity));
	if (envNames.some((name) => !hostAllowedEnvNames.has(envIdentity(name)))) return { allowed: false, reason: "blocked_host_env_not_allowed", command: identity, cwd: canonicalCwd };
	const declaredEnv = Object.fromEntries(envNames.map((name) => [name, "declared"]));
	const shellClassification = classifyShellCommand(identity, { cwd: canonicalCwd, env: declaredEnv, enforceExecutableIdentity: true });
	if (shellClassification.reason === "blocked_untrusted_executable_identity" || shellClassification.reason === "blocked_workspace_executable" || shellClassification.reason === "blocked_shell_startup_hook") {
		return { allowed: false, reason: shellClassification.reason, command: identity, cwd: canonicalCwd };
	}
	const execution = resolvedExecutionCommand(identity, canonicalCwd, hostEnv);
	if (execution.reason) return { allowed: false, reason: execution.reason, command: identity, cwd: canonicalCwd };
	const expectedMutationScope = Array.isArray(grant.expectedMutationScope) ? grant.expectedMutationScope.some((value) => text(value)) : text(grant.expectedMutationScope);
	const explicitVerificationResidual = hostFacts.allowUnisolatedVerification === true
		&& isWorkerVerificationCommand(identity)
		&& Array.isArray(grant.verificationScope)
		&& grant.verificationScope.some((value) => text(value));
	if (!shellClassification.confirmedReadonly && !expectedMutationScope && !explicitVerificationResidual) return { allowed: false, reason: "blocked_expected_mutation_scope", command: identity, cwd: canonicalCwd };
	if (requiresCommandProvenance(identity) && !grant.provenance) return { allowed: false, reason: "blocked_needs_parent_execution", command: identity, cwd: canonicalCwd };
	if (grant.provenance && !expectedMutationScope && !explicitVerificationResidual) return { allowed: false, reason: "blocked_expected_mutation_scope", command: identity, cwd: canonicalCwd };
	const externalAuthority = classifyCommandExternalAuthority(identity);
	if (externalAuthority.required && grant.externalAuthorized !== true) {
		if (externalAuthority.kind === "recognized-external") {
			return { allowed: false, reason: "blocked_external_authorization_required", command: identity, cwd: canonicalCwd, externalAuthority };
		}
		const mechanicallyNetworkDenied = hostFacts.networkDenied === true;
		if (!mechanicallyNetworkDenied) {
			return { allowed: false, reason: "blocked_external_unknown_requires_authorization", command: identity, cwd: canonicalCwd, externalAuthority };
		}
	}
	return { allowed: true, grant, command: identity, executionCommand: execution.command, executablePath: execution.executablePath, cwd: canonicalCwd };
}

const DANGEROUS_WORKER_ENV = /(?:^|_)(?:TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|PASSWD)(?:$|_)/iu;
const DANGEROUS_WORKER_ENV_EXACT = new Set(["PATH", "PATHEXT", "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "SHELL", "COMSPEC", "PROMPT"]);

function workerEnvIdentity(name, platform = process.platform) {
	const value = String(name || "");
	return platform === "win32" ? value.toUpperCase() : value;
}

export function resolveWorkerEnvAllowlist(value = process.env.PI_ONE_WORKER_ALLOWED_ENV_NAMES, platform = process.platform) {
	const entries = Array.isArray(value) ? value : String(value || "").split(/[;,]/u);
	const accepted = entries.map((name) => String(name || "").trim()).filter((name) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return false;
		const upper = name.toUpperCase();
		return !DANGEROUS_WORKER_ENV_EXACT.has(upper) && !DANGEROUS_WORKER_ENV.test(upper);
	});
	const seen = new Set();
	return accepted.filter((name) => {
		const identity = workerEnvIdentity(name, platform);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

export function buildGrantedEnv(grant, baseEnv = process.env, hostAllowedNames = [], platform = process.platform) {
	const names = new Set((grant?.allowedEnvNames || []).map((name) => workerEnvIdentity(name, platform)));
	const hostAllowed = new Set(resolveWorkerEnvAllowlist(hostAllowedNames, platform).map((name) => workerEnvIdentity(name, platform)));
	const env = {};
	for (const [name, value] of Object.entries(baseEnv || {})) {
		const identity = workerEnvIdentity(name, platform);
		if (names.has(identity) && hostAllowed.has(identity) && value != null) env[name] = value;
	}
	return env;
}

export class WriterLeaseManager {
	#leases = new Map();
	#epochs = new Map();
	#proofWindows = new Map();

	acquire(taskId, scope, cwd, options = {}) {
		const roots = normalizeScope(scope, cwd, { allowDefault: false });
		if (!roots.length) return { allowed: false, reason: "write_scope_required" };
		for (const lease of this.#leases.values()) {
			if (lease.taskId === taskId) continue;
			if (roots.some((root) => lease.scope.some((other) => isWithin(root, other) || isWithin(other, root)))) return { allowed: false, reason: "writer_lease_conflict", ownerTaskId: lease.taskId };
		}
		const epoch = (this.#epochs.get(taskId) || 0) + 1;
		this.#epochs.set(taskId, epoch);
		const token = `${taskId}:${epoch}:${crypto.randomUUID()}`;
		const lease = { taskId, scope: roots, cwd, epoch, token, expectedMutationScope: options.expectedMutationScope };
		this.#leases.set(token, lease);
		return { allowed: true, lease };
	}

	release(token) {
		for (const [key, window] of this.#proofWindows) if (window.token === token) this.#proofWindows.delete(key);
		return this.#leases.delete(token);
	}

	park(token, taskId) {
		const lease = this.#leases.get(token);
		if (!lease || lease.taskId !== taskId) return { allowed: false, reason: "writer_lease_required" };
		for (const [key, window] of this.#proofWindows) if (window.token === token) this.#proofWindows.delete(key);
		this.#leases.delete(token);
		return { allowed: true, lease };
	}

	reacquire(lease, taskId) {
		if (!lease || lease.taskId !== taskId) return { allowed: false, reason: "writer_lease_required" };
		return this.acquire(taskId, lease.scope, lease.cwd, { expectedMutationScope: lease.expectedMutationScope });
	}

	ownerForPath(candidate, cwd) {
		const normalized = canonicalPath(candidate, cwd);
		return [...this.#leases.values()].find((lease) => lease.scope.some((root) => isWithin(normalized, root))) || null;
	}

	overlapping(scope, cwd, taskId) {
		const roots = normalizeScope(scope, cwd, { allowDefault: false });
		return [...this.#leases.values()].filter((lease) => {
			if (taskId && lease.taskId === taskId) return false;
			return roots.some((root) => lease.scope.some((other) => isWithin(root, other) || isWithin(other, root)));
		});
	}

	canWrite(taskId, candidate, cwd, token) {
		const lease = token ? this.#leases.get(token) : null;
		if (!lease || lease.taskId !== taskId || lease.token !== token) return { allowed: false, reason: "writer_lease_required" };
		const normalizedCwd = canonicalPath(cwd, cwd);
		const normalizedCandidate = canonicalPath(candidate, cwd);
		const proofWindow = [...this.#proofWindows.values()].find((window) => window.taskId !== taskId && (isWithin(normalizedCwd, window.cwd) || isWithin(window.cwd, normalizedCwd)));
		if (proofWindow) return { allowed: false, reason: "blocked_writer_proof_window_conflict", ownerTaskId: proofWindow.taskId };
		if (!lease.scope.some((root) => isWithin(normalizedCandidate, root))) return { allowed: false, reason: "blocked_write_scope" };
		return { allowed: true, lease };
	}

	beginProofWindow(taskId, cwd, token, options = {}) {
		if (token) {
			const lease = this.#leases.get(token);
			if (!lease || lease.taskId !== taskId || lease.token !== token) return { allowed: false, reason: "writer_lease_required" };
		}
		const normalizedCwd = canonicalPath(cwd, cwd);
		const mutating = options.mutating === true;
		const conflict = [...this.#proofWindows.values()].find((window) => window.taskId !== taskId && (mutating || window.mutating) && (isWithin(normalizedCwd, window.cwd) || isWithin(window.cwd, normalizedCwd)));
		if (conflict) return { allowed: false, reason: "blocked_writer_proof_window_conflict", ownerTaskId: conflict.taskId };
		const key = `${taskId}\u0000${normalizedCwd}`;
		this.#proofWindows.set(key, { taskId, cwd: normalizedCwd, token, mutating });
		return { allowed: true };
	}

	endProofWindow(taskId, cwd, token) {
		const normalizedCwd = canonicalPath(cwd, cwd);
		const key = `${taskId}\u0000${normalizedCwd}`;
		const window = this.#proofWindows.get(key);
		if (!window || (token && window.token !== token)) return false;
		return this.#proofWindows.delete(key);
	}

	forTask(taskId) {
		return [...this.#leases.values()].filter((lease) => lease.taskId === taskId);
	}

	clear() {
		this.#leases.clear();
		this.#epochs.clear();
		this.#proofWindows.clear();
	}
}

export function decideAuthorityAction(input = {}) {
	return decideLocalExecution({
		...input,
		scopeAllowed: input.pathAllowed !== false,
		commandGranted: input.commandGranted !== false,
		writerLease: input.writerLease !== false,
	});
}

export async function createOnlyFile(filePath, content) {
	const handle = await fs.open(filePath, "wx");
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

export async function editWithPrecondition(filePath, oldText, newText) {
	const current = await fs.readFile(filePath, "utf8");
	if (current !== oldText) throw new Error("edit_precondition_failed");
	await fs.writeFile(filePath, newText, "utf8");
}

export function isMutationCommand(grant) {
	return Boolean(grant?.expectedMutationScope);
}

export { path };
