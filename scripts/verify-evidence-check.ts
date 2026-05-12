// PR Verify Harness — evidence-check step (single-round v6).
//
// After the Playwright recipe lands a `verdict: 'verified'` in result.json,
// this script asks a vision-capable model whether the screenshots produced
// by the recipe actually show the diff's visible effect. The goal is to
// stop "smoke-shaped verified" — a recipe that passed assertions on an
// unrelated story while never exercising the changed UI.
//
// Inputs:
//   --result <path>   verify-result.json (rewritten in-place with evidence fields)
//   --diff   <path>   the PR's unified diff (typically /tmp/pr.diff)
//   --recipe <path>   the authored .spec.ts the runner just executed
//
// Output (writes back to --result):
//   {
//     ...existing verify-result fields...
//     evidenceVerdict: 'found' | 'missing' | 'undetermined',
//     evidenceReasoning: string,
//     evidenceModel: string,
//     verdict: <original> | 'evidence-missing' (if original was 'verified'
//              and evidenceVerdict came back 'missing')
//   }
//
// Exit codes:
//   Always 0. Downstream (workflow step ordering, label gate, retry-loop)
//   reads the rewritten verify-result.json to branch — the script does NOT
//   drive workflow control flow via process exit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const MAX_SCREENSHOTS = 6;
const DIFF_TRUNCATE_BYTES = 64 * 1024;

const HELP = `
Usage: node scripts/verify-evidence-check.ts --result <path> --diff <path> --recipe <path>

Reads verify-result.json + PR diff + authored spec, asks Claude vision whether
the screenshots produced by the recipe visibly demonstrate the diff's change.
Rewrites verify-result.json in place with evidence fields.

Exit 1 only when evidenceVerdict === 'missing' (label step then skips).
`.trim();

interface Argv {
  result?: string;
  diff?: string;
  recipe?: string;
  help?: boolean;
}

interface EvidenceFields {
  evidenceVerdict: 'found' | 'missing' | 'undetermined';
  evidenceReasoning: string;
  evidenceModel: string;
}

function collectScreenshots(rootDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.png')) {
        out.push(p);
      }
    }
  }
  walk(rootDir);
  // Stable ordering so two runs with the same screenshots produce
  // identical prompts (helps debugging + observation continuity).
  out.sort();
  return out;
}

function truncateDiff(raw: string): string {
  if (Buffer.byteLength(raw, 'utf-8') <= DIFF_TRUNCATE_BYTES) return raw;
  return raw.slice(0, DIFF_TRUNCATE_BYTES) + '\n[...diff truncated]\n';
}

function writeResult(
  resultPath: string,
  original: Record<string, unknown>,
  evidence: EvidenceFields
): void {
  const finalVerdict =
    original.verdict === 'verified' && evidence.evidenceVerdict === 'missing'
      ? 'evidence-missing'
      : original.verdict;
  const merged = {
    ...original,
    ...evidence,
    verdict: finalVerdict,
  };
  fs.writeFileSync(resultPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

const SYSTEM_PROMPT = `You evaluate whether a PR's UI change is observable in screenshots produced by an automated verify-harness Playwright run.

You will receive:
- The PR's unified diff
- The Playwright recipe that produced the screenshots (so you can see what the test actually asserted on)
- One or more PNG screenshots taken by that recipe

Your task: decide whether the diff's user-visible change is present in at least one of the screenshots.

Respond with strict JSON ONLY (no prose, no code fences):
{
  "verdict": "found" | "missing" | "undetermined",
  "reasoning": "<2-3 sentences>"
}

Definitions:
- "found"        — at least one screenshot clearly contains the changed UI state (e.g. the new icon, the new label, the new focus ring, the toggled dark-mode appearance, the new addon panel item).
- "missing"      — the diff IS user-visible, but none of the screenshots show the changed UI (e.g. the diff swaps an icon inside a conditionally-rendered button, and every screenshot is of an unrelated story).
- "undetermined" — the diff is NOT user-visible (pure type/logic/test/docs/build/CI change), OR the screenshots are too cropped / too low-resolution to make a confident call.

Bias toward "undetermined" rather than "missing" when the diff has no clear user-visible component (e.g. internal refactors, type narrowing, test-only changes). Reserve "missing" for diffs whose visible effect should plausibly appear in a screenshot taken during the recipe.`;

async function main(rawArgv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rawArgv,
    options: {
      result: { type: 'string' },
      diff: { type: 'string' },
      recipe: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const flags = values as Argv;

  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  if (!flags.result || !flags.diff || !flags.recipe) {
    console.error(HELP);
    return 1;
  }

  const resultPath = flags.result;
  const original = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;

  if (original.verdict !== 'verified') {
    console.error(
      `[evidence-check] initial verdict is '${String(original.verdict)}', skipping evidence check`
    );
    return 0;
  }

  const diff = truncateDiff(fs.readFileSync(flags.diff, 'utf-8'));
  const recipe = fs.readFileSync(flags.recipe, 'utf-8');

  const resultDir = path.dirname(resultPath);
  const screenshots = collectScreenshots(resultDir).slice(0, MAX_SCREENSHOTS);

  if (screenshots.length === 0) {
    writeResult(resultPath, original, {
      evidenceVerdict: 'missing',
      evidenceReasoning: 'Recipe produced no screenshots — cannot verify visible evidence.',
      evidenceModel: MODEL,
    });
    return 0;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[evidence-check] ANTHROPIC_API_KEY is required for the vision dispatch.');
    return 1;
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
    maxRetries: 1,
  });

  const imageBlocks: Anthropic.ImageBlockParam[] = screenshots.map((p) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: fs.readFileSync(p).toString('base64'),
    },
  }));

  const userText = [
    'PR DIFF:',
    '```',
    diff,
    '```',
    '',
    'PLAYWRIGHT RECIPE (executed and passed):',
    '```ts',
    recipe,
    '```',
    '',
    'SCREENSHOTS (attached above as images, listed by relative path):',
    ...screenshots.map((p) => `- ${path.relative(resultDir, p)}`),
    '',
    'Review the screenshots against the diff and answer.',
  ].join('\n');

  let reply: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: userText }],
        },
      ],
    });
    reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[evidence-check] vision dispatch failed: ${msg}`);
    writeResult(resultPath, original, {
      evidenceVerdict: 'undetermined',
      evidenceReasoning: `Vision dispatch error: ${msg.slice(0, 200)}`,
      evidenceModel: MODEL,
    });
    return 0;
  }

  let parsed: { verdict?: unknown; reasoning?: unknown };
  try {
    const stripped = reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(stripped) as { verdict?: unknown; reasoning?: unknown };
  } catch {
    writeResult(resultPath, original, {
      evidenceVerdict: 'undetermined',
      evidenceReasoning: `Could not parse vision JSON; raw reply head: ${reply.slice(0, 200)}`,
      evidenceModel: MODEL,
    });
    return 0;
  }

  const v = parsed.verdict;
  const verdict: EvidenceFields['evidenceVerdict'] =
    v === 'found' || v === 'missing' || v === 'undetermined' ? v : 'undetermined';
  const reasoning =
    typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 600) : '(no reasoning)';

  writeResult(resultPath, original, {
    evidenceVerdict: verdict,
    evidenceReasoning: reasoning,
    evidenceModel: MODEL,
  });

  console.error(`[evidence-check] verdict=${verdict} reasoning="${reasoning}"`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[evidence-check] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
