export interface BatchArtifactCliArgs {
  jsonMode: boolean;
  positional: string[];
  progressIssues: string[];
  repo: string | undefined;
}
export function parseBatchArtifactCliArgs(args: string[]): BatchArtifactCliArgs {
  const valueAfter = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const valuesAfter = (flag: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
    }
    return values;
  };

  return {
    jsonMode: args.includes('--json'),
    progressIssues: valuesAfter('--progress-issue'),
    repo: valueAfter('--repo') ?? process.env.GITHUB_REPOSITORY,
    positional: args.filter((arg, idx) => {
      if (arg === '--json' || arg === '--progress-issue' || arg === '--repo') return false;
      return args[idx - 1] !== '--progress-issue' && args[idx - 1] !== '--repo';
    }),
  };
}
