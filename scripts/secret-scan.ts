import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: 'openai-project-api-key' | 'openai-api-key' | 'slack-api-token';
}

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.ini', '.js', '.json', '.md', '.mjs', '.ps1',
  '.sh', '.sql', '.toml', '.ts', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.cache', 'build', 'coverage', 'dist', 'node_modules',
]);
const GENERATED_FIXTURE_DIRECTORY = 'tests/fixtures/generated';
const PATTERNS = [
  { kind: 'openai-project-api-key', source: String.raw`\bsk-proj-[A-Za-z0-9_-]{40,}\b` },
  { kind: 'openai-api-key', source: String.raw`\bsk-(?!proj-)[A-Za-z0-9_-]{40,}\b` },
  { kind: 'slack-api-token', source: String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}\b` },
] as const;

/** Detect only high-confidence key shapes; never return the matched value. */
export function findSecretPatterns(text: string): readonly Omit<SecretFinding, 'file'>[] {
  const findings: Omit<SecretFinding, 'file'>[] = [];
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    const matcher = new RegExp(pattern.source, 'g');
    for (const match of text.matchAll(matcher)) {
      const offset = match.index ?? 0;
      const line = text.slice(0, offset).split('\n').length;
      const key = `${pattern.kind}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: pattern.kind, line });
    }
  }

  return findings;
}

function isTextFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Scan the working tree, excluding dependency/build artifacts and symlinks. */
export function scanWorkspace(root: string): readonly SecretFinding[] {
  const absoluteRoot = path.resolve(root);
  const findings: SecretFinding[] = [];
  const ignoredUntrackedRootEnv = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--', '.env'],
    { cwd: absoluteRoot, stdio: 'ignore', windowsHide: true },
  ).status === 0;
  const ignoredGeneratedFixtureOutput = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--', GENERATED_FIXTURE_DIRECTORY],
    { cwd: absoluteRoot, stdio: 'ignore', windowsHide: true },
  ).status === 0;
  const trackedGeneratedFixtureOutput = (spawnSync(
    'git',
    ['ls-files', '--', GENERATED_FIXTURE_DIRECTORY],
    { cwd: absoluteRoot, encoding: 'utf8', windowsHide: true },
  ).stdout ?? '').trim().length > 0;
  const skipGeneratedFixtureOutput = ignoredGeneratedFixtureOutput && !trackedGeneratedFixtureOutput;

  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const relativeDirectory = path.relative(absoluteRoot, absolutePath).split(path.sep).join('/');
        if (
          !EXCLUDED_DIRECTORIES.has(entry.name) &&
          !(relativeDirectory === GENERATED_FIXTURE_DIRECTORY && skipGeneratedFixtureOutput)
        ) {
          visit(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || !isTextFile(entry.name)) continue;
      const relative = path.relative(absoluteRoot, absolutePath).split(path.sep).join('/');
      // Local runtime credentials belong in a gitignored, untracked root .env.
      // `git check-ignore` deliberately does not classify tracked files as ignored,
      // so accidentally committing .env still gets scanned and fails closed.
      if (relative === '.env' && ignoredUntrackedRootEnv) continue;
      if (statSync(absolutePath).size > 2 * 1024 * 1024) continue;

      const content = readFileSync(absolutePath, 'utf8');
      for (const finding of findSecretPatterns(content)) findings.push({ file: relative, ...finding });
    }
  };

  visit(absoluteRoot);
  return findings;
}
