import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface SelfUpdateCommand {
	command: string;
	args: string[];
	display: string;
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getSelfUpdateCommandForMethod(method: InstallMethod, packageName: string): SelfUpdateCommand | undefined {
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm":
			return {
				command: "pnpm",
				args: ["install", "-g", packageName],
				display: `pnpm install -g ${packageName}`,
			};
		case "yarn":
			return {
				command: "yarn",
				args: ["global", "add", packageName],
				display: `yarn global add ${packageName}`,
			};
		case "bun":
			return {
				command: "bun",
				args: ["install", "-g", packageName],
				display: `bun install -g ${packageName}`,
			};
		case "npm":
			return {
				command: "npm",
				args: ["install", "-g", packageName],
				display: `npm install -g ${packageName}`,
			};
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(command: string, args: string[]): string | undefined {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2000,
		// Windows package managers are commonly .cmd shims. Use the shell so Node can execute them;
		// command and args are fixed literals from getGlobalPackageRoots(), not user input.
		shell: process.platform === "win32",
	});
	if (result.status !== 0) return undefined;
	const stdout = result.stdout.trim();
	return stdout || undefined;
}

function getGlobalPackageRoots(method: InstallMethod): string[] {
	switch (method) {
		case "npm": {
			const root = readCommandOutput("npm", ["root", "-g"]);
			return root ? [root] : [];
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(dirname(bunBin)), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath: string;
	try {
		normalizedPath = realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function isManagedByGlobalPackageManager(method: InstallMethod): boolean {
	const packageDir = normalizeExistingPathForComparison(getPackageDir());
	if (!packageDir) {
		return false;
	}
	return getGlobalPackageRoots(method).some((root) => {
		const normalizedRoot = normalizeExistingPathForComparison(root);
		return (
			normalizedRoot !== undefined &&
			(packageDir === normalizedRoot ||
				packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`))
		);
	});
}

export function getSelfUpdateCommand(packageName: string): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (!command || !isManagedByGlobalPackageManager(method)) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(packageName: string): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
	}
	if (getSelfUpdateCommandForMethod(method, packageName)) {
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${packageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@mariozechner/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/**
 * Get XDG config home directory
 * - Returns $XDG_CONFIG_HOME or ~/.config on Unix (not Windows)
 * - Always expands tilde if present
 */
export function getXdgConfigHome(): string {
	if (process.platform === "win32") return homedir();
	const xdgConfig = process.env.XDG_CONFIG_HOME;
	if (xdgConfig) {
		if (xdgConfig === "~") return homedir();
		if (xdgConfig.startsWith("~/")) return homedir() + xdgConfig.slice(1);
		return xdgConfig;
	}
	return join(homedir(), ".config");
}

/**
 * Get XDG data home directory
 * - Returns $XDG_DATA_HOME or ~/.local/share on Unix (not Windows)
 * - Always expands tilde if present
 */
export function getXdgDataHome(): string {
	if (process.platform === "win32") return homedir();
	const xdgData = process.env.XDG_DATA_HOME;
	if (xdgData) {
		if (xdgData === "~") return homedir();
		if (xdgData.startsWith("~/")) return homedir() + xdgData.slice(1);
		return xdgData;
	}
	return join(homedir(), ".local", "share");
}

/**
 * Check if legacy data exists at ~/.pi/agent/
 * - Returns true if any files/directories exist under the legacy path
 * - Detection only, no creation
 */
export function hasLegacyData(): boolean {
	const legacyDir = join(homedir(), CONFIG_DIR_NAME, "agent");
	try {
		const entries = existsSync(legacyDir) ? readdirSync(legacyDir) : [];
		return entries.length > 0;
	} catch {
		return false;
	}
}

/**
 * Get unified default user home directory for backward compatibility
 * Resolution order:
 * 1. ENV_AGENT_DIR env var (always wins)
 * 2. Legacy data exists (~/.pi/agent/*) -> use legacy
 * 3. Unix with no legacy -> XDG config path
 * 4. Windows or no XDG -> legacy fallback
 */
export function getDefaultUserHomeDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	if (hasLegacyData()) {
		return join(homedir(), CONFIG_DIR_NAME, "agent");
	}
	if (process.platform !== "win32") {
		return join(getXdgConfigHome(), "pi", "agent");
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/**
 * Get config directory (user-authored/configured content)
 * Resolution order:
 * 1. ENV_AGENT_DIR env var -> derive config path from it
 * 2. Legacy data exists -> use legacy config path
 * 3. Unix with no legacy -> XDG config path
 * 4. Windows -> legacy fallback
 */
export function getConfigDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		const resolvedEnv = envDir === "~" ? homedir() : envDir.startsWith("~/") ? homedir() + envDir.slice(1) : envDir;
		return join(resolvedEnv, "config");
	}
	if (hasLegacyData()) {
		return join(homedir(), CONFIG_DIR_NAME, "agent");
	}
	if (process.platform !== "win32") {
		return join(getXdgConfigHome(), "pi", "agent");
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/**
 * Get data directory (persistent runtime state)
 * Resolution order:
 * 1. ENV_AGENT_DIR env var -> derive data path from it
 * 2. Legacy data exists -> use legacy data path
 * 3. Unix with no legacy -> XDG data path
 * 4. Windows -> legacy fallback
 */
export function getDataDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		const resolvedEnv = envDir === "~" ? homedir() : envDir.startsWith("~/") ? homedir() + envDir.slice(1) : envDir;
		return join(resolvedEnv, "data");
	}
	if (hasLegacyData()) {
		return join(homedir(), CONFIG_DIR_NAME, "agent");
	}
	if (process.platform !== "win32") {
		return join(getXdgDataHome(), "pi", "agent");
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	return getDefaultUserHomeDir();
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getConfigDir(), "themes");
}

/** Get path to models.json */
export function getModelRegistryPath(): string {
	return join(getConfigDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getConfigDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getConfigDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getConfigDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getDataDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getConfigDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getDataDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getDataDir(), `${APP_NAME}-debug.log`);
}

/** Get path to extensions directory */
export function getExtensionsDir(): string {
	return join(getConfigDir(), "extensions");
}

/** Get path to keybindings.json */
export function getKeybindingsPath(agentDir?: string): string {
	if (agentDir) {
		// Legacy behavior: derive from provided agentDir
		return join(agentDir, "keybindings.json");
	}
	return join(getConfigDir(), "keybindings.json");
}

/** Get path to skills directory */
export function getSkillsDir(): string {
	return join(getConfigDir(), "skills");
}

/** Get path to SYSTEM.md */
export function getSystemPromptPath(): string {
	return join(getConfigDir(), "SYSTEM.md");
}

/** Get path to APPEND_SYSTEM.md */
export function getAppendSystemPromptPath(): string {
	return join(getConfigDir(), "APPEND_SYSTEM.md");
}
