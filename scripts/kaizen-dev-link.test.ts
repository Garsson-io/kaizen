import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkDevLinkStatus,
  resolvePluginInstall,
  runDevLink,
} from './kaizen-dev-link.ts';

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeInstalled(home: string, projectRoot: string, installPath: string): void {
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'kaizen@kaizen': [
          {
            scope: 'project',
            projectPath: projectRoot,
            installPath,
            version: '1.2.3',
          },
        ],
      },
    }),
  );
}

function writeHook(root: string, text: string): string {
  const hook = join(root, '.claude/hooks/foo.sh');
  mkdirSync(join(root, '.claude/hooks'), { recursive: true });
  writeFileSync(hook, `#!/bin/bash\nprintf '${text}\\n'\n`);
  chmodSync(hook, 0o755);
  return hook;
}

describe('kaizen-dev-link install resolution', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = makeTemp('kai-devlink-home-');
    project = makeTemp('kai-devlink-project-');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('resolves the kaizen install path for the current project', () => {
    const installPath = join(home, '.claude/plugins/cache/kaizen/kaizen/1.2.3');
    mkdirSync(installPath, { recursive: true });
    writeInstalled(home, project, installPath);

    const resolved = resolvePluginInstall({ homeDir: home, projectRoot: project });

    expect(resolved).toMatchObject({
      plugin: 'kaizen@kaizen',
      installPath,
      projectPath: project,
    });
  });

  it('rejects install paths outside the kaizen plugin cache', () => {
    const outside = makeTemp('kai-devlink-outside-');
    writeInstalled(home, project, outside);

    expect(() => resolvePluginInstall({ homeDir: home, projectRoot: project }))
      .toThrow(/outside the kaizen plugin cache/);

    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects the cache versions root itself as an install path', () => {
    const versionsRoot = join(home, '.claude/plugins/cache/kaizen/kaizen');
    mkdirSync(versionsRoot, { recursive: true });
    writeInstalled(home, project, versionsRoot);

    expect(() => resolvePluginInstall({ homeDir: home, projectRoot: project }))
      .toThrow(/outside the kaizen plugin cache/);
  });
});

describe('kaizen-dev-link enable/disable', () => {
  let home: string;
  let project: string;
  let installPath: string;

  beforeEach(() => {
    home = makeTemp('kai-devlink-home-');
    project = makeTemp('kai-devlink-project-');
    installPath = join(home, '.claude/plugins/cache/kaizen/kaizen/1.2.3');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, 'CACHE_SENTINEL'), 'cache\n');
    writeInstalled(home, project, installPath);
    writeHook(project, 'one');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('enables a symlink from active plugin install path to the worktree and restores it on disable', () => {
    const enabled = runDevLink({ command: 'enable', homeDir: home, projectRoot: project });

    expect(enabled.status).toBe('enabled');
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(installPath)).toBe(project);

    const status = checkDevLinkStatus({ homeDir: home, projectRoot: project });
    expect(status.active).toBe(true);
    expect(status.targetPath).toBe(project);

    const disabled = runDevLink({ command: 'disable', homeDir: home, projectRoot: project });

    expect(disabled.status).toBe('disabled');
    expect(lstatSync(installPath).isDirectory()).toBe(true);
    expect(existsSync(join(installPath, 'CACHE_SENTINEL'))).toBe(true);
  });

  it('makes a fixed cache hook path observe edited worktree hook content without changing the command path', () => {
    const cacheHook = join(installPath, '.claude/hooks/foo.sh');

    runDevLink({ command: 'enable', homeDir: home, projectRoot: project });
    expect(execFileSync(cacheHook, { encoding: 'utf8' })).toBe('one\n');

    writeHook(project, 'two');

    expect(execFileSync(cacheHook, { encoding: 'utf8' })).toBe('two\n');
    expect(resolve(cacheHook)).toBe(join(installPath, '.claude/hooks/foo.sh'));
  });

  it('the shell wrapper delegates to the TypeScript CLI', () => {
    const out = execFileSync(
      'bash',
      [
        join(process.cwd(), 'scripts/kaizen-dev-link.sh'),
        'status',
        '--home',
        home,
        '--project',
        project,
      ],
      { encoding: 'utf8' },
    );

    expect(out).toContain('kaizen-dev-link');
    expect(out).toContain('inactive');
  });
});
