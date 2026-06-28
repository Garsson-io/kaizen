import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface TypeScriptSubprocess {
  command: string;
  args: string[];
  runtime: 'bun' | 'tsx';
}

export interface TypeScriptSubprocessOptions {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}

export function findAncestorFile(startDir: string, relativePath: string): string {
  let dir = startDir;

  while (true) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Unable to find ${relativePath} from ${startDir}`);
    }
    dir = parent;
  }
}

export function findExecutableOnPath(
  name: string,
  pathValue: string | undefined,
): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function executableFile(path: string | undefined): string | null {
  if (!path) return null;
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

export function findBunExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  return (
    findExecutableOnPath(bunName, env.PATH) ??
    executableFile(env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin', bunName) : undefined) ??
    executableFile(env.HOME ? join(env.HOME, '.bun', 'bin', bunName) : undefined)
  );
}

export function buildTypeScriptSubprocess(
  scriptPath: string,
  options: TypeScriptSubprocessOptions = {},
): TypeScriptSubprocess {
  const env = options.env ?? process.env;
  const bun = findBunExecutable(env);
  if (bun) {
    return { command: bun, args: [scriptPath], runtime: 'bun' };
  }

  const tsxCli = findAncestorFile(
    options.startDir ?? process.cwd(),
    'node_modules/tsx/dist/cli.mjs',
  );
  return {
    command: process.execPath,
    args: [tsxCli, scriptPath],
    runtime: 'tsx',
  };
}
