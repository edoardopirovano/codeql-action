import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";

import * as core from "@actions/core";
import * as semver from "semver";

import { getApiClient, GitHubApiDetails } from "./api-client";
import * as apiCompatibility from "./api-compatibility.json";
import { CodeQL } from "./codeql";
import { Config } from "./config-utils";
import { Language } from "./languages";
import { Logger } from "./logging";

/**
 * The URL for github.com.
 */
export const GITHUB_DOTCOM_URL = "https://github.com";

/**
 * Get the extra options for the codeql commands.
 */
export function getExtraOptionsEnvParam(): object {
  const varName = "CODEQL_ACTION_EXTRA_OPTIONS";
  const raw = process.env[varName];
  if (raw === undefined || raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${varName} environment variable is set, but does not contain valid JSON: ${message}`
    );
  }
}

/**
 * Get the array of all the tool names contained in the given sarif contents.
 *
 * Returns an array of unique string tool names.
 */
export function getToolNames(sarifContents: string): string[] {
  const sarif = JSON.parse(sarifContents);
  const toolNames = {};

  for (const run of sarif.runs || []) {
    const tool = run.tool || {};
    const driver = tool.driver || {};
    if (typeof driver.name === "string" && driver.name.length > 0) {
      toolNames[driver.name] = true;
    }
  }

  return Object.keys(toolNames);
}

// Creates a random temporary directory, runs the given body, and then deletes the directory.
// Mostly intended for use within tests.
export async function withTmpDir<T>(
  body: (tmpDir: string) => Promise<T>
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeql-action-"));
  const realSubdir = path.join(tmpDir, "real");
  fs.mkdirSync(realSubdir);
  const symlinkSubdir = path.join(tmpDir, "symlink");
  fs.symlinkSync(realSubdir, symlinkSubdir, "dir");
  const result = await body(symlinkSubdir);
  fs.rmdirSync(tmpDir, { recursive: true });
  return result;
}

/**
 * Gets an OS-specific amount of memory (in MB) to reserve for OS processes
 * when the user doesn't explicitly specify a memory setting.
 * This is a heuristic to avoid OOM errors (exit code 137 / SIGKILL)
 * from committing too much of the available memory to CodeQL.
 * @returns number
 */
function getSystemReservedMemoryMegaBytes(): number {
  // Windows needs more memory for OS processes.
  return 1024 * (process.platform === "win32" ? 1.5 : 1);
}

/**
 * Get the codeql `--ram` flag as configured by the `ram` input. If no value was
 * specified, the total available memory will be used minus a threshold
 * reserved for the OS.
 *
 * @returns string
 */
export function getMemoryFlag(userInput: string | undefined): string {
  let memoryToUseMegaBytes: number;
  if (userInput) {
    memoryToUseMegaBytes = Number(userInput);
    if (Number.isNaN(memoryToUseMegaBytes) || memoryToUseMegaBytes <= 0) {
      throw new Error(`Invalid RAM setting "${userInput}", specified.`);
    }
  } else {
    const totalMemoryBytes = os.totalmem();
    const totalMemoryMegaBytes = totalMemoryBytes / (1024 * 1024);
    const reservedMemoryMegaBytes = getSystemReservedMemoryMegaBytes();
    memoryToUseMegaBytes = totalMemoryMegaBytes - reservedMemoryMegaBytes;
  }
  return `--ram=${Math.floor(memoryToUseMegaBytes)}`;
}

/**
 * Get the codeql flag to specify whether to add code snippets to the sarif file.
 *
 * @returns string
 */
export function getAddSnippetsFlag(
  userInput: string | boolean | undefined
): string {
  if (typeof userInput === "string") {
    // have to process specifically because any non-empty string is truthy
    userInput = userInput.toLowerCase() === "true";
  }
  return userInput ? "--sarif-add-snippets" : "--no-sarif-add-snippets";
}

/**
 * Get the codeql `--threads` value specified for the `threads` input.
 * If no value was specified, all available threads will be used.
 *
 * The value will be capped to the number of available CPUs.
 *
 * @returns string
 */
export function getThreadsFlag(
  userInput: string | undefined,
  logger: Logger
): string {
  let numThreads: number;
  const maxThreads = os.cpus().length;
  if (userInput) {
    numThreads = Number(userInput);
    if (Number.isNaN(numThreads)) {
      throw new Error(`Invalid threads setting "${userInput}", specified.`);
    }
    if (numThreads > maxThreads) {
      logger.info(
        `Clamping desired number of threads (${numThreads}) to max available (${maxThreads}).`
      );
      numThreads = maxThreads;
    }
    const minThreads = -maxThreads;
    if (numThreads < minThreads) {
      logger.info(
        `Clamping desired number of free threads (${numThreads}) to max available (${minThreads}).`
      );
      numThreads = minThreads;
    }
  } else {
    // Default to using all threads
    numThreads = maxThreads;
  }
  return `--threads=${numThreads}`;
}

/**
 * Get the path where the CodeQL database for the given language lives.
 */
export function getCodeQLDatabasePath(config: Config, language: Language) {
  return path.resolve(config.dbLocation, language);
}

/**
 * Parses user input of a github.com or GHES URL to a canonical form.
 * Removes any API prefix or suffix if one is present.
 */
export function parseGitHubUrl(inputUrl: string): string {
  const originalUrl = inputUrl;
  if (inputUrl.indexOf("://") === -1) {
    inputUrl = `https://${inputUrl}`;
  }
  if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
    throw new Error(`"${originalUrl}" is not a http or https URL`);
  }

  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch (e) {
    throw new Error(`"${originalUrl}" is not a valid URL`);
  }

  // If we detect this is trying to be to github.com
  // then return with a fixed canonical URL.
  if (url.hostname === "github.com" || url.hostname === "api.github.com") {
    return GITHUB_DOTCOM_URL;
  }

  // Remove the API prefix if it's present
  if (url.pathname.indexOf("/api/v3") !== -1) {
    url.pathname = url.pathname.substring(0, url.pathname.indexOf("/api/v3"));
  }
  // Also consider subdomain isolation on GHES
  if (url.hostname.startsWith("api.")) {
    url.hostname = url.hostname.substring(4);
  }

  // Normalise path to having a trailing slash for consistency
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url.toString();
}

const GITHUB_ENTERPRISE_VERSION_HEADER = "x-github-enterprise-version";
const CODEQL_ACTION_WARNED_ABOUT_VERSION_ENV_VAR =
  "CODEQL_ACTION_WARNED_ABOUT_VERSION";

let hasBeenWarnedAboutVersion = false;

export enum GitHubVariant {
  DOTCOM,
  GHES,
  GHAE,
}
export type GitHubVersion =
  | { type: GitHubVariant.DOTCOM }
  | { type: GitHubVariant.GHAE }
  | { type: GitHubVariant.GHES; version: string };

export async function getGitHubVersion(
  apiDetails: GitHubApiDetails
): Promise<GitHubVersion> {
  // We can avoid making an API request in the standard dotcom case
  if (parseGitHubUrl(apiDetails.url) === GITHUB_DOTCOM_URL) {
    return { type: GitHubVariant.DOTCOM };
  }

  // Doesn't strictly have to be the meta endpoint as we're only
  // using the response headers which are available on every request.
  const apiClient = getApiClient(apiDetails);
  const response = await apiClient.meta.get();

  // This happens on dotcom, although we expect to have already returned in that
  // case. This can also serve as a fallback in cases we haven't foreseen.
  if (response.headers[GITHUB_ENTERPRISE_VERSION_HEADER] === undefined) {
    return { type: GitHubVariant.DOTCOM };
  }

  if (response.headers[GITHUB_ENTERPRISE_VERSION_HEADER] === "GitHub AE") {
    return { type: GitHubVariant.GHAE };
  }

  const version = response.headers[GITHUB_ENTERPRISE_VERSION_HEADER] as string;
  return { type: GitHubVariant.GHES, version };
}

export function checkGitHubVersionInRange(
  version: GitHubVersion,
  logger: Logger,
  toolName: Mode
) {
  if (hasBeenWarnedAboutVersion || version.type !== GitHubVariant.GHES) {
    return;
  }

  const disallowedAPIVersionReason = apiVersionInRange(
    version.version,
    apiCompatibility.minimumVersion,
    apiCompatibility.maximumVersion
  );

  if (
    disallowedAPIVersionReason === DisallowedAPIVersionReason.ACTION_TOO_OLD
  ) {
    logger.warning(
      `The CodeQL ${toolName} version you are using is too old to be compatible with GitHub Enterprise ${version.version}. If you experience issues, please upgrade to a more recent version of the CodeQL ${toolName}.`
    );
  }
  if (
    disallowedAPIVersionReason === DisallowedAPIVersionReason.ACTION_TOO_NEW
  ) {
    logger.warning(
      `GitHub Enterprise ${version.version} is too old to be compatible with this version of the CodeQL ${toolName}. If you experience issues, please upgrade to a more recent version of GitHub Enterprise or use an older version of the CodeQL ${toolName}.`
    );
  }
  hasBeenWarnedAboutVersion = true;
  if (isActions()) {
    core.exportVariable(CODEQL_ACTION_WARNED_ABOUT_VERSION_ENV_VAR, true);
  }
}

export enum DisallowedAPIVersionReason {
  ACTION_TOO_OLD,
  ACTION_TOO_NEW,
}

export function apiVersionInRange(
  version: string,
  minimumVersion: string,
  maximumVersion: string
): DisallowedAPIVersionReason | undefined {
  if (!semver.satisfies(version, `>=${minimumVersion}`)) {
    return DisallowedAPIVersionReason.ACTION_TOO_NEW;
  }
  if (!semver.satisfies(version, `<=${maximumVersion}`)) {
    return DisallowedAPIVersionReason.ACTION_TOO_OLD;
  }
  return undefined;
}

/**
 * Retrieves the github auth token for use with the runner. There are
 * three possible locations for the token:
 *
 * 1. from the cli (considered insecure)
 * 2. from stdin
 * 3. from the GITHUB_TOKEN environment variable
 *
 * If both 1 & 2 are specified, then an error is thrown.
 * If 1 & 3 or 2 & 3 are specified, then the environment variable is ignored.
 *
 * @param githubAuth a github app token or PAT
 * @param fromStdIn read the github app token or PAT from stdin up to, but excluding the first whitespace
 * @param readable the readable stream to use for getting the token (defaults to stdin)
 *
 * @return a promise resolving to the auth token.
 */
export async function getGitHubAuth(
  logger: Logger,
  githubAuth: string | undefined,
  fromStdIn: boolean | undefined,
  readable = process.stdin as Readable
): Promise<string> {
  if (githubAuth && fromStdIn) {
    throw new Error(
      "Cannot specify both `--github-auth` and `--github-auth-stdin`. Please use `--github-auth-stdin`, which is more secure."
    );
  }

  if (githubAuth) {
    logger.warning(
      "Using `--github-auth` via the CLI is insecure. Use `--github-auth-stdin` instead."
    );
    return githubAuth;
  }

  if (fromStdIn) {
    return new Promise((resolve, reject) => {
      let token = "";
      readable.on("data", (data) => {
        token += data.toString("utf8");
      });
      readable.on("end", () => {
        token = token.split(/\s+/)[0].trim();
        if (token) {
          resolve(token);
        } else {
          reject(new Error("Standard input is empty"));
        }
      });
      readable.on("error", (err) => {
        reject(err);
      });
    });
  }

  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  throw new Error(
    "No GitHub authentication token was specified. Please provide a token via the GITHUB_TOKEN environment variable, or by adding the `--github-auth-stdin` flag and passing the token via standard input."
  );
}

/**
 * This error is used to indicate a runtime failure of an exhaustivity check enforced at compile time.
 */
class ExhaustivityCheckingError extends Error {
  constructor(public expectedExhaustiveValue: never) {
    super("Internal error: exhaustivity checking failure");
  }
}

/**
 * Used to perform compile-time exhaustivity checking on a value.  This function will not be executed at runtime unless
 * the type system has been subverted.
 */
export function assertNever(value: never): never {
  throw new ExhaustivityCheckingError(value);
}

export enum Mode {
  actions = "Action",
  runner = "Runner",
}

/**
 * Environment variables to be set by codeql-action and used by the
 * CLI. These environment variables are relevant for both the runner
 * and the action.
 */
enum EnvVar {
  /**
   * The mode of the codeql-action, either 'actions' or 'runner'.
   */
  RUN_MODE = "CODEQL_ACTION_RUN_MODE",

  /**
   * Semver of the codeql-action as specified in package.json.
   */
  VERSION = "CODEQL_ACTION_VERSION",

  /**
   * If set to a truthy value, then the codeql-action might combine SARIF
   * output from several `interpret-results` runs for the same Language.
   */
  FEATURE_SARIF_COMBINE = "CODEQL_ACTION_FEATURE_SARIF_COMBINE",

  /**
   * If set to the "true" string, then the codeql-action will upload SARIF,
   * not the cli.
   */
  FEATURE_WILL_UPLOAD = "CODEQL_ACTION_FEATURE_WILL_UPLOAD",
}

export function initializeEnvironment(mode: Mode, version: string) {
  const exportVar = (name: string, value: string) => {
    if (mode === Mode.actions) {
      core.exportVariable(name, value);
    } else {
      process.env[name] = value;
    }
  };

  exportVar(EnvVar.RUN_MODE, mode);
  exportVar(EnvVar.VERSION, version);
  exportVar(EnvVar.FEATURE_SARIF_COMBINE, "true");
  exportVar(EnvVar.FEATURE_WILL_UPLOAD, "true");
}

export function getMode(): Mode {
  // Make sure we fail fast if the env var is missing. This should
  // only happen if there is a bug in our code and we neglected
  // to set the mode early in the process.
  const mode = getRequiredEnvParam(EnvVar.RUN_MODE);

  if (mode !== Mode.actions && mode !== Mode.runner) {
    throw new Error(`Unknown mode: ${mode}.`);
  }
  return mode;
}

export function isActions(): boolean {
  return getMode() === Mode.actions;
}

/**
 * Get an environment parameter, but throw an error if it is not set.
 */
export function getRequiredEnvParam(paramName: string): string {
  const value = process.env[paramName];
  if (value === undefined || value.length === 0) {
    throw new Error(`${paramName} environment variable must be set`);
  }
  return value;
}

export class HTTPError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function isHTTPError(arg: any): arg is HTTPError {
  return arg?.status !== undefined && Number.isInteger(arg.status);
}

export async function codeQlVersionAbove(
  codeql: CodeQL,
  requiredVersion: string
): Promise<boolean> {
  return semver.gte(await codeql.getVersion(), requiredVersion);
}
