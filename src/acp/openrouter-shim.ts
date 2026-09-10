import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_SHIM_CODE } from "../config/openrouter-shim-code.js";
import type { RoutingPolicyWarning } from "./openrouter-provider-policy.js";

export type ShimHandle = {
  port: number;
  pid: number;
  stop: () => void;
  /**
   * Where the shim appends one NDJSON line per upstream response, naming the
   * provider that ACTUALLY served it (brick 4c272cab §8). `undefined` when the
   * caller asked for no attribution.
   *
   * ⚠️ IT IS CARRIED ON THE HANDLE, NOT IN A MODULE-LEVEL VARIABLE. The handle
   * is already the session's own object — held by the client that spawned it and
   * re-used on reconnect — so the reader cannot cross-attribute one session's
   * responses to another the way a process-scoped pointer could.
   */
  attributionLogPath?: string;
  /**
   * Set when the box's settings file EXISTS and was rejected, so the whole
   * policy was dropped (TE finding F-1). Carried on the handle because that is
   * what the shim starter already returns to the client, and the client is what
   * puts it on the lifecycle snapshot → the session record. Absent is the
   * normal state, including on a box with no settings file at all.
   */
  routingPolicyWarning?: RoutingPolicyWarning;
};

export type ShimOptions = {
  reasoningEffort?: string;
  /**
   * The box's resolved OpenRouter `provider` object
   * (`src/acp/openrouter-provider-policy.ts`). Serialised onto the shim child's
   * env as `OR_PROVIDER`.
   *
   * ⚠️ **ENV, NOT ARGV.** The shim's whole configuration is already env, and
   * argv is world-readable through `/proc` — the same rule that keeps the API
   * key out of the command line.
   *
   * ⚠️ **`undefined` MUST STAY `undefined`.** An unconfigured box emits no
   * variable at all, so the forwarded body is byte-identical to before this
   * brick (acceptance A8). `{}` would be truthy in the shim and would put
   * `"provider": {}` on every request.
   */
  providerObject?: object;
  /** Absolute path for the attribution NDJSON; omitted ⇒ nothing is recorded. */
  attributionLogPath?: string;
  timeoutMs?: number;
};

// Ensure the shim file exists on disk (idempotent; no-op if already written).
// Written once per process run to a fixed path so concurrent sessions share
// a single copy rather than thrashing the FS with per-session writes.
let shimPath: string | undefined;

function ensureShimFile(): string {
  if (shimPath) {
    return shimPath;
  }
  const dir = join(tmpdir(), "acpx-or-shim");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "shim.mjs");
  writeFileSync(p, OPENROUTER_SHIM_CODE, { mode: 0o644 });
  shimPath = p;
  return p;
}

/**
 * Start the OpenRouter model-rewrite shim as a child process.
 * Returns a handle with the bound port and a `stop()` function.
 * Rejects if the shim doesn't write PORT= within `timeoutMs` milliseconds.
 */
export function spawnOpenRouterShim(
  apiKey: string,
  model: string,
  options: ShimOptions = {},
): Promise<ShimHandle> {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const path = ensureShimFile();
    const shimEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENROUTER_API_KEY: apiKey,
      OR_MODEL: model,
      PORT: "0",
    };
    if (options.reasoningEffort) {
      shimEnv.OR_REASONING_EFFORT = options.reasoningEffort;
    }
    if (options.providerObject) {
      shimEnv.OR_PROVIDER = JSON.stringify(options.providerObject);
    }
    if (options.attributionLogPath) {
      shimEnv.OR_ATTRIBUTION_LOG = options.attributionLogPath;
    }
    const child = spawn(process.execPath, [path], {
      env: shimEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdout = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`[or-shim] timed out waiting for PORT= (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const m = stdout.match(/PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number.parseInt(m[1], 10);
        const pid = child.pid!;
        resolve({
          port,
          pid,
          attributionLogPath: options.attributionLogPath,
          stop: () => {
            try {
              child.kill();
            } catch {
              /* already dead */
            }
          },
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[or-shim] ${chunk.toString("utf8")}`);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[or-shim] exited early with code ${String(code)}`));
      }
    });
  });
}
