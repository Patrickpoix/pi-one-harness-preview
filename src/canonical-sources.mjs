import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const SKILL_FILE = "SKILL.md";
// Keep project-owned skill systems visible without copying them into Pi's user library.
const PROJECT_SKILL_DIRS = [".pi/skills", ".agents/skills", ".kimi-code/skills", "skills"];
const skillRootIndexCache = new Map();
const skillMetadataCache = new Map();
const menuTextCache = new Map();
const sourceResolutionCache = new Map();
const agentSectionCache = new Map();
const skillBodyCache = new Map();
const CACHE_LIMITS = Object.freeze({
	skillRootIndex: 64,
	skillMetadata: 1024,
	menuText: 64,
	sourceResolution: 64,
	agentSections: 128,
	skillBody: 256,
});

function cacheGet(cache, key) {
	const value = cache.get(key);
	if (value === undefined) return undefined;
	cache.delete(key);
	cache.set(key, value);
	return value;
}

function cacheSet(cache, key, value, limit) {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > limit) cache.delete(cache.keys().next().value);
	return value;
}

function asText(value) {
	return typeof value === "string" ? value : "";
}

function absolute(value, fallback) {
	const raw = asText(value).trim();
	if (!raw) return path.resolve(fallback);
	return path.resolve(raw);
}

/**
 * Filesystem identity is not Skill-name identity. Resolve native aliases when
 * possible, but case-fold only on Windows where the filesystem contract is
 * case-insensitive for our supported paths. POSIX case remains authoritative.
 */
export function canonicalFilesystemPathIdentity(value, platform = process.platform) {
	let resolved = path.resolve(String(value || ""));
	try { resolved = fs.realpathSync.native(resolved); } catch { /* lexical identity is the fallback for not-yet-created paths */ }
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFilesystemPath(left, right, platform = process.platform) {
	return canonicalFilesystemPathIdentity(left, platform) === canonicalFilesystemPathIdentity(right, platform);
}

function sameFilesystemName(left, right, platform = process.platform) {
	return platform === "win32" ? String(left).toLowerCase() === String(right).toLowerCase() : String(left) === String(right);
}

function existingDirectory(value) {
	try {
		return fs.statSync(value).isDirectory() ? value : null;
	} catch {
		return null;
	}
}

function existingFile(value) {
	try {
		return fs.statSync(value).isFile() ? value : null;
	} catch {
		return null;
	}
}

function mtime(value) {
	try {
		return fs.statSync(value).mtimeMs;
	} catch {
		return null;
	}
}

function fileSignature(value) {
	try {
		const stat = fs.statSync(value);
		return [stat.mtimeMs, stat.ctimeMs, stat.size].join(":");
	} catch {
		return null;
	}
}

function ancestorDirectories(start) {
	const result = [];
	let current = path.resolve(start);
	while (true) {
		result.push(current);
		const parent = path.dirname(current);
		if (parent === current) return result;
		current = parent;
	}
}

// A filesystem root is a volume boundary, not a project authority.  Scanning
// `<drive>:\skills` would otherwise make one unrelated drive-level directory
// visible to every checkout on that volume.
export function projectSkillAncestors(start) {
	return ancestorDirectories(start).filter((directory) => path.dirname(directory) !== directory);
}

function readUtf8(filePath) {
	return fs.readFileSync(filePath, "utf8");
}

function frontmatterBlockScalar(lines, startIndex, style, limit) {
	const block = [];
	let index = startIndex;
	while (index < limit) {
		const line = lines[index];
		if (line?.trim() === "---") break;
		if (line && !/^\s/u.test(line)) break;
		block.push(line || "");
		index += 1;
	}
	const indents = block
		.filter((line) => line.trim())
		.map((line) => line.match(/^\s*/u)?.[0].length || 0)
		.filter((indent) => indent > 0);
	const commonIndent = indents.length ? Math.min(...indents) : 0;
	const normalized = block.map((line) => line.trim() ? line.slice(commonIndent) : "");
	const value = style === ">"
		? normalized.join(" ").replace(/\s+/gu, " ").trim()
		: normalized.join("\n").trim();
	return { value, nextIndex: index };
}

function parseFrontmatter(filePath) {
	let text = "";
	try {
		text = readUtf8(filePath);
	} catch {
		return { name: path.basename(path.dirname(filePath)), description: "", text: "" };
	}

	const lines = text.split(/\r?\n/);
	const fields = {};
	if (lines[0]?.trim() === "---") {
		const limit = Math.min(lines.length, 80);
		for (let index = 1; index < limit; index += 1) {
			const line = lines[index];
			if (line.trim() === "---") break;
			const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
			if (!match) continue;
			const rawValue = match[2].trim();
			const blockStyle = rawValue.match(/^([>|])[+-]?$/u)?.[1];
			if (blockStyle) {
				const block = frontmatterBlockScalar(lines, index + 1, blockStyle, limit);
				fields[match[1]] = block.value;
				index = block.nextIndex - 1;
				continue;
			}
			fields[match[1]] = rawValue.replace(/^['"]|['"]$/g, "");
		}
	}
	return {
		name: fields.name || path.basename(path.dirname(filePath)),
		description: fields.description || "",
		explicitOnly: [fields["explicit-only"], fields.explicit_only, fields.explicitOnly, fields["disable-model-invocation"]]
			.some((value) => ["true", "yes", "1"].includes(String(value || "").toLowerCase())),
		text,
	};
}

function scanSkillRoot(root) {
	const paths = [];
	const directories = [];
	const visited = new Set();
	const walk = (directory) => {
		let real;
		try {
			real = canonicalFilesystemPathIdentity(directory);
		} catch {
			return;
		}
		if (visited.has(real)) return;
		visited.add(real);
		directories.push({ path: directory, signature: fileSignature(directory) });
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
				continue;
			}
			if (entry.isFile() && sameFilesystemName(entry.name, SKILL_FILE)) paths.push(entryPath);
		}
	};
	walk(root);
	return { paths, directories };
}

function collectSkillFiles(root) {
	const rootKey = canonicalFilesystemPathIdentity(root);
	let index = cacheGet(skillRootIndexCache, rootKey);
	const directoriesChanged = index?.directories.some((directory) => fileSignature(directory.path) !== directory.signature);
	if (!index || directoriesChanged) {
		index = scanSkillRoot(root);
		cacheSet(skillRootIndexCache, rootKey, index, CACHE_LIMITS.skillRootIndex);
	}
	return index.paths.map((filePath) => {
		const fileKey = canonicalFilesystemPathIdentity(filePath);
		const signature = fileSignature(filePath);
		const cached = cacheGet(skillMetadataCache, fileKey);
		if (!cached || cached.signature !== signature) {
			const meta = parseFrontmatter(filePath);
			const next = { name: meta.name, description: meta.description, explicitOnly: meta.explicitOnly, signature, mtimeMs: mtime(filePath) };
			cacheSet(skillMetadataCache, fileKey, next, CACHE_LIMITS.skillMetadata);
			return { ...next, path: filePath };
		}
		return { ...cached, path: filePath };
	});
}

function readSkillFile(filePath) {
	const meta = parseFrontmatter(filePath);
	return {
		name: meta.name,
		description: meta.description,
		explicitOnly: meta.explicitOnly,
		path: filePath,
		mtimeMs: mtime(filePath),
	};
}

function configuredRootOrder(home, codexHome) {
	const configured = asText(process.env.PI_ONE_SKILL_ROOTS)
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => absolute(entry, home));
	const configuredSet = new Set(configured.map((entry) => canonicalFilesystemPathIdentity(entry)));
	const candidates = [
		{ path: path.join(home, ".agents", "skills"), kind: "user-agents", priority: 300, codexNative: true },
		{ path: path.join(codexHome, "skills"), kind: "codex", priority: 100, codexNative: true },
	];
	const ordered = [];
	for (const configuredPath of configured) {
		const match = candidates.find((candidate) => sameFilesystemPath(candidate.path, configuredPath));
		ordered.push({
			path: configuredPath,
			kind: match?.kind || "configured",
			priority: match?.priority ?? 1000 - ordered.length,
			codexNative: match?.codexNative === true,
		});
	}
	for (const candidate of candidates) {
		if (!configuredSet.has(canonicalFilesystemPathIdentity(candidate.path))) ordered.push(candidate);
	}
	return ordered;
}

function discoverSkillRoots(cwd, home, codexHome) {
	const roots = [];
	const ancestors = projectSkillAncestors(cwd);
	const runtimeHome = path.resolve(process.env.USERPROFILE || os.homedir());
	for (let index = 0; index < ancestors.length; index += 1) {
		const directory = ancestors[index];
		// The user home is a user-level root, not a project-local authority.  Stop
		// before treating ~/.agents or ~/.pi as a project Skill source.
		if (sameFilesystemPath(directory, home) || sameFilesystemPath(directory, runtimeHome)) break;
		const packageSkill = existingFile(path.join(directory, SKILL_FILE));
		if (packageSkill) {
			roots.push({
				path: directory,
				kind: "project",
				projectRoot: directory,
				priority: 1200 - index,
				skillFile: packageSkill,
				codexNative: false,
			});
		}
		for (const relative of PROJECT_SKILL_DIRS) {
			const root = existingDirectory(path.join(directory, relative));
			if (!root) continue;
			roots.push({
				path: root,
				kind: "project",
				projectRoot: directory,
				priority: 1000 - index,
				codexNative: relative === ".agents/skills",
			});
		}
	}
	for (const candidate of configuredRootOrder(home, codexHome)) {
		const root = existingDirectory(candidate.path);
		if (root) roots.push({ ...candidate, path: root });
	}
	return roots;
}

function selectSkillWinners(roots) {
	const candidates = new Map();
	for (const root of roots) {
		const skills = root.skillFile ? [readSkillFile(root.skillFile)] : collectSkillFiles(root.path);
		for (const skill of skills) {
			const key = skill.name.toLowerCase();
			const list = candidates.get(key) || [];
			list.push({ ...skill, root: root.path, rootKind: root.kind, priority: root.priority, codexNative: root.codexNative === true });
			candidates.set(key, list);
		}
	}
	const winners = new Map();
	for (const [key, list] of candidates) {
		const ordered = [...list].sort((left, right) => {
			if (right.priority !== left.priority) return right.priority - left.priority;
			return left.path.localeCompare(right.path);
		});
		winners.set(key, {
			name: ordered[0].name,
			description: ordered[0].description,
			explicitOnly: ordered[0].explicitOnly,
			path: ordered[0].path,
			root: ordered[0].root,
			rootKind: ordered[0].rootKind,
			codexNative: ordered[0].codexNative === true,
			candidates: ordered.map(({ path: candidatePath, root: candidateRoot, rootKind, priority, codexNative }) => ({
				path: candidatePath,
				root: candidateRoot,
				rootKind,
				priority,
				codexNative: codexNative === true,
			})),
		});
	}
	return { candidates, winners };
}

function fileSections(text) {
	const lines = text.split(/\r?\n/);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (heading) {
			if (current) {
				current.text = current.lines.join("\n").trim();
				sections.push(current);
			}
			current = { level: heading[1].length, title: heading[2], lines: [line], text: "" };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) {
		current.text = current.lines.join("\n").trim();
		sections.push(current);
	}
	return sections;
}

function readSections(filePath) {
	const file = existingFile(filePath);
	if (!file) return [];
	const key = canonicalFilesystemPathIdentity(file);
	const signature = fileSignature(file);
	const cached = cacheGet(agentSectionCache, key);
	if (cached?.signature === signature) return cached.sections;
	const sections = fileSections(readUtf8(file));
	cacheSet(agentSectionCache, key, { signature, sections }, CACHE_LIMITS.agentSections);
	return sections;
}

function sourceCacheKey(cwd, home, codexHome) {
	return [cwd, home, codexHome].map((value) => canonicalFilesystemPathIdentity(value)).join("|");
}

function knownSkillFiles(skillRoots) {
	const paths = new Set();
	for (const root of skillRoots) {
		if (root.skillFile) {
			paths.add(canonicalFilesystemPathIdentity(root.skillFile));
			continue;
		}
		// Populate/refresh only the roots that belong to this resolution.  A
		// process-global cache must never make workspace A's fingerprint depend
		// on unrelated workspace B files that happened to be scanned earlier.
		for (const skill of collectSkillFiles(root.path)) paths.add(canonicalFilesystemPathIdentity(skill.path));
	}
	return [...paths].sort();
}

function sourceFingerprint(sources) {
	const files = [
		sources.userAgents,
		...sources.projectAgents,
		sources.liteMenu,
		sources.fullMenu,
		...knownSkillFiles(sources.skillRoots),
	].filter(Boolean).map((filePath) => [canonicalFilesystemPathIdentity(filePath), fileSignature(filePath)]);
	const roots = sources.skillRoots.map((root) => [
		canonicalFilesystemPathIdentity(root.path),
		root.kind,
		root.priority,
		root.codexNative === true,
		fileSignature(root.path),
	]);
	return JSON.stringify({ files, roots });
}

export function resolveCanonicalSources(options = {}) {
	const cwd = absolute(options.cwd, process.cwd());
	const home = absolute(options.home, process.env.USERPROFILE || os.homedir());
	const codexHome = absolute(options.codexHome, process.env.CODEX_HOME || path.join(home, ".codex"));
	// Reuse Pi's canonical project-context discovery so routing/authority identity
	// observes the same AGENTS.override/AGENTS/CLAUDE layering and worktree
	// shadowing that the Worker ResourceLoader will actually deliver.
	const projectAgents = loadProjectContextFiles({
		cwd,
		agentDir: path.join(cwd, ".pi-one", "__project-context-no-global__"),
	}).map((file) => file.path);
	const userAgents = existingFile(path.join(codexHome, "AGENTS.md"));
	const liteMenu = existingFile(path.join(codexHome, "SKILL_MENU_LITE.md"));
	const fullMenu = existingFile(path.join(codexHome, "SKILL_MENU.md"));
	if (!liteMenu) throw new Error(`Pi-One canonical Lite Menu not found under ${codexHome}`);
	const skillRoots = discoverSkillRoots(cwd, home, codexHome);
	const cacheKey = sourceCacheKey(cwd, home, codexHome);
	const base = {
		cwd,
		home,
		codexHome,
		userAgents,
		projectAgents,
		liteMenu,
		fullMenu,
		skillRoots,
	};
	const currentFingerprint = sourceFingerprint(base);
	const cached = cacheGet(sourceResolutionCache, cacheKey);
	if (cached && cached.fingerprint === currentFingerprint) {
		return { ...cached.sources, cache: { state: "hit", reason: "unchanged" } };
	}
	const { candidates, winners } = selectSkillWinners(skillRoots);
	const sources = {
		...base,
		skillCandidates: candidates,
		skillWinners: winners,
		mtimes: {
			userAgents: userAgents ? mtime(userAgents) : null,
			projectAgents: projectAgents.map((file) => ({ path: file, mtimeMs: mtime(file) })),
			liteMenu: mtime(liteMenu),
			fullMenu: fullMenu ? mtime(fullMenu) : null,
		},
	};
	const fingerprint = sourceFingerprint(sources);
	cacheSet(sourceResolutionCache, cacheKey, { fingerprint, sources }, CACHE_LIMITS.sourceResolution);
	return {
		...sources,
		cache: {
			state: cached ? "invalidated" : "fresh",
			reason: cached ? "authority-or-skill-fingerprint-changed" : "initial",
		},
	};
}

export function readCanonicalText(filePath) {
	const file = existingFile(filePath);
	if (!file) throw new Error(`Canonical file not found: ${filePath}`);
	return readUtf8(file);
}

function readMenuText(filePath) {
	const signature = fileSignature(filePath);
	const key = canonicalFilesystemPathIdentity(filePath);
	const cached = cacheGet(menuTextCache, key);
	if (cached && cached.signature === signature) return cached.text;
	const text = readCanonicalText(filePath);
	cacheSet(menuTextCache, key, { signature, text }, CACHE_LIMITS.menuText);
	return text;
}

function menuTerms(value) {
	return [...new Set((String(value || "").toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z][a-z0-9+.-]{2,}/gu) || []))];
}

/**
 * Index only Skill mentions from the canonical menu. The menu body remains
 * source data; this small metadata shape is what the router consumes.
 */
export function parseMenuText(text) {
	const mentionedSkills = new Set();
	const rules = [];
	for (const [index, line] of String(text || "").split(/\r?\n/).entries()) {
		for (const clause of line.split(/[；;]/)) {
			const skills = [...clause.matchAll(/`([^`\r\n]+)`/g)]
				.map((match) => match[1].trim().toLowerCase())
				.filter(Boolean);
			if (!skills.length) continue;
			for (const skill of skills) mentionedSkills.add(skill);
			const entry = clause.trim();
			const keywords = menuTerms(entry.replace(/`[^`\r\n]+`/g, " "));
			if (keywords.length) rules.push({ keywords, skills, entry, line: index + 1 });
		}
	}
	return { mentionedSkills: [...mentionedSkills], rules };
}

export function readMenuRules(sources, includeFull = false) {
	const lite = parseMenuText(readMenuText(sources.liteMenu));
	const liteRules = lite.rules.map((rule) => ({ ...rule, source: sources.liteMenu }));
	if (!includeFull || !sources.fullMenu) return { ...lite, rules: liteRules, fullLoaded: false };
	const full = parseMenuText(readMenuText(sources.fullMenu));
	return {
		mentionedSkills: [...new Set([...lite.mentionedSkills, ...full.mentionedSkills])],
		rules: [...liteRules, ...full.rules.map((rule) => ({ ...rule, source: sources.fullMenu }))],
		fullLoaded: true,
	};
}

export function clearCanonicalCaches() {
	skillRootIndexCache.clear();
	skillMetadataCache.clear();
	menuTextCache.clear();
	sourceResolutionCache.clear();
	agentSectionCache.clear();
	skillBodyCache.clear();
}

export function readWinningSkill(skill) {
	const signature = fileSignature(skill.path);
	const key = canonicalFilesystemPathIdentity(skill.path);
	const cached = cacheGet(skillBodyCache, key);
	if (cached?.signature === signature) return { ...skill, text: cached.text };
	const text = readCanonicalText(skill.path);
	cacheSet(skillBodyCache, key, { signature, text }, CACHE_LIMITS.skillBody);
	return { ...skill, text };
}

// Routing only needs the canonical winner identity and frontmatter.  Keep the
// body behind the explicit hydration seam above so a normal root turn does not
// pay the cost of loading an entire Skill into its prompt projection.
export function readWinningSkillMetadata(skill) {
	return {
		name: skill.name,
		description: skill.description,
		explicitOnly: skill.explicitOnly,
		path: skill.path,
		root: skill.root,
		rootKind: skill.rootKind,
		codexNative: skill.codexNative === true,
		candidates: skill.candidates,
	};
}

export function readMenuProjection(sources, includeFull = false) {
	return {
		lite: readMenuText(sources.liteMenu),
		full: includeFull && sources.fullMenu ? readMenuText(sources.fullMenu) : null,
	};
}

export function readAgentSections(sources, titles = []) {
	const wanted = new Set(titles.map((title) => title.toLowerCase()));
	const files = [
		...(sources.userAgents ? [{ path: sources.userAgents, scope: "user" }] : []),
		...sources.projectAgents.map((file) => ({ path: file, scope: "project" })),
	];
	const result = [];
	for (const file of files) {
		for (const section of readSections(file.path)) {
			if (section.level < 2 || section.level > 3) continue;
			if (wanted.size > 0 && !wanted.has(section.title.toLowerCase())) continue;
			if (/^codex-specific\b/i.test(section.title)) continue;
			const text = section.text
				.split(/\r?\n/)
				.filter((line) => !/^\s*(?:[-*]\s*)?\*\*Codex-specific adapter:\*\*/i.test(line))
				.join("\n")
				.trim();
			if (text) result.push({ ...section, text, path: file.path, scope: file.scope });
		}
	}
	return result;
}

export function sourceSummary(sources) {
	return {
		cwd: sources.cwd,
		codexHome: sources.codexHome,
		cache: sources.cache || { state: "fresh", reason: "unreported" },
		userAgents: sources.userAgents,
		projectAgents: [...sources.projectAgents],
		liteMenu: sources.liteMenu,
		fullMenu: sources.fullMenu,
		skillRoots: sources.skillRoots.map(({ path: root, kind, priority }) => ({ path: root, kind, priority })),
		skillCount: sources.skillWinners.size,
		collisionCount: [...sources.skillCandidates.values()].filter((list) => list.length > 1).length,
	};
}
