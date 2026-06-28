import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTsxBin as resolveTsxBinFromRoot,
  resolveTypeScriptHookRunner as resolveTypeScriptHookRunnerFromRoot,
  type TypeScriptHookRunner,
} from "../lib/typescript-runner.js";

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

export const KAIZEN_ROOT = resolve(typeof __dirname !== "undefined" ? __dirname : __dirname_esm, "../..");

export function resolveTsxBin(repoRoot = KAIZEN_ROOT): string | undefined {
  return resolveTsxBinFromRoot(repoRoot);
}

export function resolveTypeScriptHookRunner(options: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): TypeScriptHookRunner | null {
  return resolveTypeScriptHookRunnerFromRoot({
    repoRoot: options.repoRoot ?? KAIZEN_ROOT,
    env: options.env,
  });
}
