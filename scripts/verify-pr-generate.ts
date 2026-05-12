// Entry script for the PR verify harness recipe-author generator.
// Usage: bun scripts/verify-pr-generate.ts --pr <number> [--force]
//
// Responsibility: deterministic I/O + prompt-bundle emission ONLY.
// This script does NOT dispatch an agent, does NOT write a final spec,
// and does NOT lint. The `verify-recipe-author` skill (Lane C) consumes
// the emitted prompt bundle and performs those steps under human review.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { buildRunPaths, ensureRunDir, pruneOldRuns } from './verify/core.ts';
import { buildRecipeAuthorPrompt } from './verify/agent-prompt.ts';
import type {
  PromptInput,
  PromptPRFile,
  PromptPRMeta,
  PromptReferenceSpec,
} from './verify/agent-prompt.ts';
import { matchedTriageGlobs, triageReferenceSpecs } from './verify/triage.ts';
import {
  deriveRoutesForFiles,
  type StoryFileRoutes,
} from './verify/derive-story-routes.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const RECIPES_DIR = path.resolve(repoRoot, '.verify-recipes');
const AUTHORING_GUIDE_PATH = path.resolve(RECIPES_DIR, '_recipe-authoring-guide.md');
const CANONICAL_SMOKE_PATH = path.resolve(RECIPES_DIR, 'example-smoke.spec.ts');

const REFERENCE_SPEC_HEAD_CAP = 2;
const DIFF_BYTE_CAP = 5 * 1024 * 1024; // 5 MB
const PER_FILE_LINE_CAP = 500;
const TOTAL_FILE_CAP = 20;
const AGENT_MODEL_HINT = 'claude-opus-4-7[1m]';

const HELP = `
Usage: bun scripts/verify-pr-generate.ts --pr <number> [--force] [--output <path>]

Options:
  --pr <number>     GitHub PR number to generate a recipe author prompt for (required)
  --force           Allow overwriting an existing output spec
  --output <path>   Absolute or repo-relative path the authored spec must land at.
                    Defaults to .verify-recipes/pr-<#>.spec.ts (local-dev path).
                    CI (single-round) passes \$PR_HEAD_DIR/.verify-recipes/pr-<#>.spec.ts
                    so the recipe is materialised directly into the untrusted
                    PR-head workspace without ever being committed.
  --retry-context <text>
                    Append a "Retry guidance" section to the prompt with the
                    given text. Used by the workflow's evidence-missing retry
                    loop to feed the vision-checker's reasoning back to the
                    recipe-author dispatch.
  --help            Show this help

Output:
  Writes a prompt bundle to .verify-output/<runId>/prompt-bundle.json and
  prints the next-step command. Does NOT dispatch the agent or write the
  final spec — invoke the verify-recipe-author skill (local) or
  verify-pr-author --dispatch-mode sdk (CI) on the bundle path.
`.trim();

interface GhPRMetaRaw {
  title?: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: Array<{ path?: string; additions?: number; deletions?: number }>;
}

interface DiffFile {
  path: string;
  additions: number;
  body: string;
  triageMatched: boolean;
  truncated: boolean;
}

interface PromptBundle {
  version: 1;
  prNumber: number;
  runId: string;
  outputSpecPath: string;
  force: boolean;
  prompt: string;
  metadata: {
    agentModel: string;
    referenceSpecs: string[];
    triageGlobs: string[];
    generatedAt: string;
  };
}

function ghJson(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[verify-pr-generate] gh ${args.join(' ')} failed: ${msg}\n` +
        `Hint: ensure the GitHub CLI is installed and authenticated (gh auth login).`
    );
  }
}

function fetchPRMeta(prNumber: number): PromptPRMeta {
  const raw = ghJson([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'title,body,files,additions,deletions,changedFiles',
  ]);
  const parsed = JSON.parse(raw) as GhPRMetaRaw;
  const files: PromptPRFile[] = Array.isArray(parsed.files)
    ? parsed.files.map((f) => ({
        path: String(f.path ?? ''),
        additions: Number(f.additions ?? 0),
        deletions: Number(f.deletions ?? 0),
      }))
    : [];
  return {
    title: String(parsed.title ?? ''),
    body: String(parsed.body ?? ''),
    files,
    additions: Number(parsed.additions ?? 0),
    deletions: Number(parsed.deletions ?? 0),
    changedFiles: Number(parsed.changedFiles ?? files.length),
  };
}

function fetchPRDiff(prNumber: number): string {
  // AC-V3-10: MUST use --patch.
  return ghJson(['pr', 'diff', String(prNumber), '--patch']);
}

/**
 * Split a unified diff into per-file blocks keyed by the `+++ b/<path>`
 * header. Each block includes its `diff --git`/index/`---`/`+++` preamble.
 */
function splitDiffPerFile(rawDiff: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = rawDiff.split('\n');
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentPath !== null) {
      out.set(currentPath, currentLines.join('\n'));
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = null;
      currentLines = [line];
    } else if (currentLines.length > 0 || line.startsWith('+++ ') || line.startsWith('--- ')) {
      currentLines.push(line);
      if (currentPath === null && line.startsWith('+++ b/')) {
        currentPath = line.slice('+++ b/'.length).trim();
      }
    }
  }
  flush();
  return out;
}

function truncateFileBody(body: string): { body: string; truncated: boolean } {
  const lines = body.split('\n');
  if (lines.length <= PER_FILE_LINE_CAP) {
    return { body, truncated: false };
  }
  const elided = lines.length - PER_FILE_LINE_CAP;
  const head = lines.slice(0, PER_FILE_LINE_CAP);
  head.push(`[...${elided} lines elided]`);
  return { body: head.join('\n'), truncated: true };
}

function buildTruncatedDiff(
  rawDiff: string,
  prFiles: PromptPRFile[],
  triageMatchedPaths: Set<string>
): string {
  if (rawDiff.length > DIFF_BYTE_CAP) {
    throw new Error(
      `[verify-pr-generate] raw PR diff exceeds ${DIFF_BYTE_CAP} bytes (got ${rawDiff.length}). ` +
        `Aborting per D5 / R2. A --commit-range variant is planned for v4.`
    );
  }

  const perFile = splitDiffPerFile(rawDiff);
  const additionsByPath = new Map<string, number>();
  for (const f of prFiles) additionsByPath.set(f.path, f.additions);

  const all: DiffFile[] = [];
  for (const [filePath, body] of perFile) {
    const { body: capped, truncated } = truncateFileBody(body);
    all.push({
      path: filePath,
      additions: additionsByPath.get(filePath) ?? 0,
      body: capped,
      triageMatched: triageMatchedPaths.has(filePath),
      truncated,
    });
  }

  const matched = all
    .filter((f) => f.triageMatched)
    .sort((a, b) => b.additions - a.additions || a.path.localeCompare(b.path));
  const unmatched = all
    .filter((f) => !f.triageMatched)
    .sort((a, b) => b.additions - a.additions || a.path.localeCompare(b.path));

  const ordered = [...matched, ...unmatched];
  const kept = ordered.slice(0, TOTAL_FILE_CAP);
  const elided = ordered.slice(TOTAL_FILE_CAP);

  const parts: string[] = kept.map((f) => f.body);
  if (elided.length > 0) {
    const sample = elided.slice(0, 5).map((f) => f.path);
    const suffix = elided.length > sample.length ? `, +${elided.length - sample.length} more` : '';
    parts.push(`[...${elided.length} files elided: ${sample.join(', ')}${suffix}]`);
    console.error(
      `[verify-pr-generate] diff elided ${elided.length} files (cap ${TOTAL_FILE_CAP}): ` +
        `${sample.join(', ')}${suffix}`
    );
  }

  return parts.join('\n');
}

function readReferenceSpec(absPath: string): PromptReferenceSpec {
  const source = fs.readFileSync(absPath, 'utf-8');
  return { path: path.relative(repoRoot, absPath), source };
}

const STORY_EXT = /\.(stories|story)\.(ts|tsx|js|jsx|cjs|mjs)$|\.mdx$/;
const MAIN_CONFIG_PATH = path.resolve(repoRoot, 'code/.storybook/main.ts');
const STORY_ROUTE_FILE_CAP = 8;

/**
 * Resolve the list of *.stories.* files relevant to the diff, deterministically:
 *   - Any story file directly touched by the diff.
 *   - For each non-stories source file under `code/**`, scan its directory
 *     for sibling *.stories.* files (cap at depth=0 to keep scope tight).
 * Result is deduped + sorted; capped at STORY_ROUTE_FILE_CAP to bound prompt growth.
 */
function collectRelevantStoryFiles(diffPaths: readonly string[]): string[] {
  const collected = new Set<string>();
  for (const rel of diffPaths) {
    if (!rel.startsWith('code/')) continue;
    const abs = path.resolve(repoRoot, rel);
    if (STORY_EXT.test(rel)) {
      if (fs.existsSync(abs)) collected.add(abs);
      continue;
    }
    // Non-stories source: look for sibling story files with the SAME basename
    // first (e.g. `Object.tsx` -> `Object.stories.tsx`). If none, fall back to
    // any sibling stories in the directory — capped to one to keep prompt
    // size sane. Avoids dumping every sibling story file when a single
    // utility file in a busy directory changes.
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) continue;
    const baseName = path.basename(rel).replace(/\.(ts|tsx|js|jsx|cjs|mjs)$/, '');
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const sameNameStories = entries.filter(
      (name) => STORY_EXT.test(name) && name.startsWith(`${baseName}.stories.`)
    );
    if (sameNameStories.length > 0) {
      for (const name of sameNameStories) collected.add(path.join(dir, name));
      continue;
    }
    // Otherwise, look for sibling stories that import the changed module by
    // basename — that is a strong signal the story mounts the changed code.
    // Cap at 2 matches per source file. If none import it, emit no fallback
    // (better silent than misleading: random alphabetical siblings have
    // sent past runs to unrelated stories).
    const importPattern = new RegExp(
      `from\\s+['"][^'"]*\\b${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.tsx?)?['"]`
    );
    const importers: string[] = [];
    for (const name of entries) {
      if (!STORY_EXT.test(name)) continue;
      const storyPath = path.join(dir, name);
      try {
        const content = fs.readFileSync(storyPath, 'utf-8');
        if (importPattern.test(content)) importers.push(storyPath);
      } catch {
        /* unreadable — skip */
      }
      if (importers.length >= 2) break;
    }
    for (const p of importers) collected.add(p);
  }
  return [...collected].sort().slice(0, STORY_ROUTE_FILE_CAP);
}

const STORY_FILE_LINE_CAP = 160;
const TOUCHED_SOURCE_FILE_LINE_CAP = 250;
const TOUCHED_SOURCE_FILE_CAP = 4;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|cjs|mjs)$/;
const SKIP_SOURCE = /\.(test|spec)\.|__tests__|__mocks__/;

function collectTouchedSourceFiles(diffPaths: readonly string[]): string[] {
  const matches: string[] = [];
  for (const rel of diffPaths) {
    if (!rel.startsWith('code/')) continue;
    if (STORY_EXT.test(rel)) continue;
    if (!SOURCE_EXT.test(rel)) continue;
    if (SKIP_SOURCE.test(rel)) continue;
    const abs = path.resolve(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    matches.push(abs);
    if (matches.length >= TOUCHED_SOURCE_FILE_CAP) break;
  }
  return matches;
}

function renderTouchedSourceFilesSection(filePaths: string[]): string {
  if (filePaths.length === 0) return '';
  const blocks = filePaths.map((abs) => {
    let source: string;
    try {
      source = fs.readFileSync(abs, 'utf-8');
    } catch {
      return '';
    }
    const lines = source.split('\n');
    const capped = lines.length > TOUCHED_SOURCE_FILE_LINE_CAP;
    const slice = capped
      ? lines.slice(0, TOUCHED_SOURCE_FILE_LINE_CAP).join('\n')
      : source;
    const trailer = capped
      ? `\n// ... (${lines.length - TOUCHED_SOURCE_FILE_LINE_CAP} more lines elided)`
      : '';
    const rel = path.relative(repoRoot, abs);
    const fenceLang = rel.endsWith('.tsx') || rel.endsWith('.jsx') ? 'tsx' : 'ts';
    return `### ${rel}\n\n\`\`\`${fenceLang}\n${slice}${trailer}\n\`\`\``;
  });
  const populated = blocks.filter(Boolean);
  if (populated.length === 0) return '';
  return [
    '## Touched source files (full context for the diff)',
    '',
    'The PR diff hunks alone often miss the surrounding code that determines',
    'how to drive the component at runtime (component definitions, conditional',
    'rendering predicates, aria-labels on toggles, etc). Each file below is the',
    'CURRENT full source on disk (post-diff state), capped at 250 lines per file.',
    'Read these to understand selectors / mount conditions before authoring.',
    '',
    ...populated,
  ].join('\n');
}

function renderStoryRoutesSection(routes: StoryFileRoutes[]): string {
  if (routes.length === 0) return '';
  const blocks = routes.map((r) => {
    const relPath = path.relative(repoRoot, r.filePath);
    const lines: string[] = [];
    lines.push(`- **${relPath}**`);
    lines.push(`  - title: \`${r.title}\``);
    lines.push(`  - autodocs: ${r.autodocs}`);
    if (r.routes.length === 0) {
      if (r.autodocs) {
        lines.push(`  - docs route: \`/?path=/docs/${r.kindId}--docs\``);
      } else {
        lines.push('  - routes: (no exported stories detected)');
      }
    } else {
      const previewRoutes = r.routes.slice(0, 8);
      for (const route of previewRoutes) {
        const docsSuffix = route.docsUrl ? ` | docs: \`${route.docsUrl}\`` : '';
        lines.push(`  - \`${route.exportName}\` → \`${route.storyUrl}\`${docsSuffix}`);
      }
      if (r.routes.length > previewRoutes.length) {
        lines.push(`  - (+${r.routes.length - previewRoutes.length} more exports)`);
      }
    }
    return lines.join('\n');
  });
  return [
    '## Story routes (computed deterministically by the harness)',
    '',
    'These routes are derived from `code/.storybook/main.ts` + the story files themselves using',
    'Storybook’s own auto-title + `toId` algorithms. Use them verbatim — do NOT re-derive kebab-case',
    'kind-ids by hand; that has 404’d in past runs.',
    '',
    ...blocks,
  ].join('\n');
}

function renderStoryFileSourcesSection(routes: StoryFileRoutes[]): string {
  if (routes.length === 0) return '';
  const sections = routes.map((r) => {
    const relPath = path.relative(repoRoot, r.filePath);
    let source: string;
    try {
      source = fs.readFileSync(r.filePath, 'utf-8');
    } catch {
      return '';
    }
    const linesArr = source.split('\n');
    const capped = linesArr.length > STORY_FILE_LINE_CAP;
    const slice = capped ? linesArr.slice(0, STORY_FILE_LINE_CAP).join('\n') : source;
    const trailer = capped
      ? `\n// ... (${linesArr.length - STORY_FILE_LINE_CAP} more lines elided)`
      : '';
    return `### ${relPath}\n\n\`\`\`tsx\n${slice}${trailer}\n\`\`\``;
  });
  const populated = sections.filter(Boolean);
  if (populated.length === 0) return '';
  return [
    '## Story file sources (siblings / direct targets of the diff)',
    '',
    'Read these to understand how the story mounts the component the diff touches —',
    '`meta.args`, `meta.parameters`, and story-level `args` reveal what the rendered',
    'DOM looks like (e.g. `args: { name: "object" }` means the underlying input id /',
    'label text is derived from `"object"`, not from `"value"` or the story export name).',
    '',
    ...populated,
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values: flags } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      force: { type: 'boolean', default: false },
      output: { type: 'string' },
      'retry-context': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  if (!flags.pr) {
    console.error('[verify-pr-generate] --pr <number> is required.\n');
    console.error(HELP);
    return 1;
  }

  const prNumber = Number(flags.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`[verify-pr-generate] --pr must be a positive integer, got: ${flags.pr}`);
    return 1;
  }

  const paths = buildRunPaths();
  await pruneOldRuns();
  await ensureRunDir(paths);

  // D9 spec-name collision pre-flight. --output overrides the default local-dev
  // path (e.g. CI passes an ephemeral path under the PR-head workspace).
  const outputSpecPath = flags.output
    ? path.isAbsolute(flags.output)
      ? flags.output
      : path.resolve(repoRoot, flags.output)
    : path.resolve(RECIPES_DIR, `pr-${prNumber}.spec.ts`);
  if (fs.existsSync(outputSpecPath) && !flags.force) {
    console.error(
      `[verify] ${path.relative(repoRoot, outputSpecPath) || outputSpecPath} already exists. ` +
        `Pass --force to overwrite.`
    );
    return 1;
  }

  console.error(`[verify-pr-generate] fetching PR #${prNumber} metadata via gh ...`);
  const prMeta = fetchPRMeta(prNumber);

  console.error(`[verify-pr-generate] fetching PR #${prNumber} diff via gh pr diff --patch ...`);
  const rawDiff = fetchPRDiff(prNumber);

  const changedPaths = prMeta.files.map((f) => f.path);
  const triageMatched = matchedTriageGlobs(changedPaths);
  const referencePaths = triageReferenceSpecs(changedPaths);

  if (referencePaths.length === 0) {
    console.error('[triage] empty -> canonical smoke only');
  } else {
    console.error(
      `[triage] matched ${triageMatched.length} glob(s); ${referencePaths.length} reference spec(s) resolved`
    );
  }

  const triageMatchedPaths = new Set<string>();
  for (const f of prMeta.files) {
    // Determine triage-matched files for diff ordering: re-run minimatch via the
    // resolver — cheaper to recompute than thread state through.
    if (triageReferenceSpecs([f.path]).length > 0) {
      triageMatchedPaths.add(f.path);
    }
  }
  const truncatedDiff = buildTruncatedDiff(rawDiff, prMeta.files, triageMatchedPaths);

  const authoringGuide = fs.readFileSync(AUTHORING_GUIDE_PATH, 'utf-8');
  const referenceSpecs: PromptReferenceSpec[] = referencePaths
    .slice(0, REFERENCE_SPEC_HEAD_CAP)
    .map(readReferenceSpec);
  const canonicalSmoke = readReferenceSpec(CANONICAL_SMOKE_PATH);

  const promptInput: PromptInput = {
    prNumber,
    prMeta,
    prDiff: truncatedDiff,
    referenceSpecs,
    canonicalSmoke,
    authoringGuide,
  };

  let prompt = buildRecipeAuthorPrompt(promptInput);

  // Pre-compute canonical story routes for files touched by the diff (and
  // siblings of non-stories source files). Storybook auto-title + toId are
  // path-dependent enough that agents have 404'd guessing kind-ids by hand.
  // The harness now derives them deterministically and surfaces the result
  // so the agent uses the real route.
  const { storyRoutesSection, storyFileSourcesSection } = (() => {
    try {
      const candidates = collectRelevantStoryFiles(prMeta.files.map((f) => f.path));
      if (candidates.length === 0) return { storyRoutesSection: '', storyFileSourcesSection: '' };
      const derived = deriveRoutesForFiles(MAIN_CONFIG_PATH, candidates);
      return {
        storyRoutesSection: renderStoryRoutesSection(derived),
        storyFileSourcesSection: renderStoryFileSourcesSection(derived),
      };
    } catch (err) {
      console.error(
        `[verify-pr-generate] derive-story-routes failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { storyRoutesSection: '', storyFileSourcesSection: '' };
    }
  })();
  if (storyRoutesSection) {
    prompt = `${prompt}\n\n---\n\n${storyRoutesSection}`;
  }
  if (storyFileSourcesSection) {
    prompt = `${prompt}\n\n---\n\n${storyFileSourcesSection}`;
  }
  const touchedSourceFiles = collectTouchedSourceFiles(prMeta.files.map((f) => f.path));
  const touchedSourceFilesSection = renderTouchedSourceFilesSection(touchedSourceFiles);
  if (touchedSourceFilesSection) {
    prompt = `${prompt}\n\n---\n\n${touchedSourceFilesSection}`;
  }

  // Retry-loop context: workflow re-invokes verify-pr-generate with
  // --retry-context "<reasoning>" when a prior attempt either (a) had the
  // evidence-checker rule the screenshots 'missing'/'undetermined' OR
  // (b) failed Playwright assertions outright (regression verdict). Both
  // paths feed back useful signal — vision reasoning for case (a), error
  // context + page snapshot for case (b). Append as a final section so the
  // next dispatch knows what the previous spec got wrong.
  if (flags['retry-context']) {
    prompt = `${prompt}\n\n---\n\n## Retry guidance — previous attempt did not verify the diff\n\nThe previous attempt either failed its assertions or did not surface the diff's visible change in its screenshots. Feedback from that run:\n\n${flags['retry-context']}\n\nWhen authoring this attempt, set up the UI state required to make the diff's visible change appear (see authoring-guide §8.1). If a selector/route timed out, prefer the actual DOM names from the feedback (page snapshots show ground truth). If the trigger state genuinely cannot be reached from a Playwright recipe (filesystem mutation or process action recipes cannot perform), say so explicitly in a single-line comment in the spec body and keep the recipe limited to module-resolution + pageerror verification. Do NOT repeat the previous attempt's approach.`;
  }

  const bundle: PromptBundle = {
    version: 1,
    prNumber,
    runId: paths.runId,
    outputSpecPath,
    force: Boolean(flags.force),
    prompt,
    metadata: {
      agentModel: AGENT_MODEL_HINT,
      referenceSpecs: referenceSpecs.map((r) => r.path),
      triageGlobs: triageMatched,
      generatedAt: new Date().toISOString(),
    },
  };

  const bundlePath = path.resolve(paths.runDir, 'prompt-bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');

  console.log(`[verify-pr-generate] prompt bundle: ${bundlePath}`);
  console.log(
    `[verify-pr-generate] Next: invoke the \`verify-recipe-author\` skill on the bundle path above.`
  );
  console.log(
    `[verify-pr-generate] After review, run: yarn verify-pr --recipe-spec .verify-recipes/pr-${prNumber}.spec.ts`
  );

  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[verify-pr-generate] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
