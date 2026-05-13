// CI helper: aggregates per-dispatch token usage across every Claude call
// in a verify run and POSTs a single telemetry row to the configured
// webhook. NO USD math — emits raw token counts + model only. The sink
// (Google Apps Script) computes cost in a derived column so price-table
// drift never blocks the workflow.
//
// Replaces the inline 175-line bash + jq block in
// `.github/workflows/verify-pr.yml`. Uses curl with `--config <tempfile>`
// so the webhook URL and bearer token stay off argv / process listings.
//
// Invocation:
//   node ./scripts/verify/ci/append-telemetry.ts \
//     --result <path-to-verify-result.json> \
//     --pr <pr-number> \
//     --run-id <github-run-id> \
//     --dispatch-dir <dir-to-scan>... \
//     [--curl-cfg <tempfile-path>]
//
// Reads `TELEMETRY_AGENTIC_VERIFICATION_WEBHOOK_URL` and
// `TELEMETRY_AGENTIC_VERIFICATION_WEBHOOK_TOKEN` (or `TELEMETRY_URL` and
// `TELEMETRY_TOKEN` for legacy parity) from env.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

interface Args {
  result: string;
  pr: string;
  runId: string;
  dispatchDirs: string[];
  curlCfg?: string;
}

function parseCliArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      result: { type: 'string' },
      pr: { type: 'string' },
      'run-id': { type: 'string' },
      'dispatch-dir': { type: 'string', multiple: true },
      'curl-cfg': { type: 'string' },
    },
    strict: true,
  });
  const dispatchDirs = (values['dispatch-dir'] as string[] | undefined) ?? [];
  if (!values.result || !values.pr || !values['run-id'] || dispatchDirs.length === 0) {
    throw new Error(
      'usage: append-telemetry --result <path> --pr <num> --run-id <id> --dispatch-dir <dir> [--dispatch-dir <dir>...]'
    );
  }
  return {
    result: values.result,
    pr: values.pr,
    runId: values['run-id'],
    dispatchDirs,
    curlCfg: values['curl-cfg'],
  };
}

function walkFiles(root: string, filter: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: any[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && filter(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function num(x: any): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

interface DispatchSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function summarizeDispatch(payload: any): DispatchSummary {
  const usage = payload?.usage ?? {};
  const cacheCreationLegacy = num(usage.cache_creation_input_tokens);
  const cacheCreation5m = num(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheCreation1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  // Prefer the SDK breakdown when present; fall back to the legacy single field.
  const cacheCreation =
    cacheCreation5m + cacheCreation1h > 0
      ? cacheCreation5m + cacheCreation1h
      : cacheCreationLegacy;
  return {
    model: typeof payload?.model === 'string' ? payload.model : '',
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

// Posts the telemetry payload through a `curl --config <tempfile>` so the
// webhook URL + bearer token never appear on argv. The receiver (Apps Script
// at `TELEMETRY_AGENTIC_VERIFICATION_WEBHOOK_URL`) must accept the
// `Authorization: Bearer …` header for auth.
function curlPost(url: string, token: string, body: string, curlCfgPath: string): string {
  writeFileSync(
    curlCfgPath,
    `url = "${url}"\nheader = "Authorization: Bearer ${token}"\n`,
    'utf-8'
  );
  chmodSync(curlCfgPath, 0o600);
  try {
    const res = spawnSync(
      'curl',
      [
        '-sS',
        '-fL',
        '--max-time',
        '30',
        '--config',
        curlCfgPath,
        '-H',
        'Content-Type: application/json',
        '--data-binary',
        body,
      ],
      { encoding: 'utf-8' }
    );
    if (res.status !== 0) {
      throw new Error(`curl exited ${res.status}: ${res.stderr || res.stdout}`);
    }
    return (res.stdout ?? '').trim();
  } finally {
    try {
      // shred → unlink fallback. Best-effort.
      const shred = spawnSync('shred', ['-u', curlCfgPath], { encoding: 'utf-8' });
      if (shred.status !== 0 && existsSync(curlCfgPath)) unlinkSync(curlCfgPath);
    } catch {
      try {
        if (existsSync(curlCfgPath)) unlinkSync(curlCfgPath);
      } catch {
        /* ignore */
      }
    }
  }
}

function main(args: Args): void {
  const telemetryUrl =
    process.env.TELEMETRY_AGENTIC_VERIFICATION_WEBHOOK_URL ?? process.env.TELEMETRY_URL ?? '';
  const telemetryToken =
    process.env.TELEMETRY_AGENTIC_VERIFICATION_WEBHOOK_TOKEN ?? process.env.TELEMETRY_TOKEN ?? '';
  if (!telemetryUrl || !telemetryToken) {
    console.log('telemetry webhook not configured — skipping');
    return;
  }

  const resultPath = resolve(args.result);
  if (!existsSync(resultPath)) {
    console.log('no verify-result.json — skipping telemetry');
    return;
  }

  let result: any;
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf-8'));
  } catch (err: any) {
    console.error('[append-telemetry] invalid verify-result.json:', err?.message ?? err);
    return;
  }

  // Scan all dispatch-response.json / evidence-check-response.json under the
  // provided dispatch dirs.
  const dispatches: DispatchSummary[] = [];
  for (const dir of args.dispatchDirs) {
    const resolved = resolve(dir);
    if (!existsSync(resolved)) continue;
    const files = walkFiles(
      resolved,
      (name) => name === 'dispatch-response.json' || name === 'evidence-check-response.json'
    );
    files.sort();
    for (const f of files) {
      try {
        const payload = JSON.parse(readFileSync(f, 'utf-8'));
        dispatches.push(summarizeDispatch(payload));
      } catch {
        /* ignore malformed dispatch file */
      }
    }
  }

  const totals = dispatches.reduce(
    (acc, d) => ({
      input_tokens: acc.input_tokens + d.inputTokens,
      output_tokens: acc.output_tokens + d.outputTokens,
      cache_read_tokens: acc.cache_read_tokens + d.cacheReadTokens,
      cache_write_tokens: acc.cache_write_tokens + d.cacheCreationTokens,
      dispatch_count: acc.dispatch_count + 1,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      dispatch_count: 0,
    }
  );

  const payload = {
    run_id: args.runId,
    pr_number: args.pr,
    verdict: String(result.verdict ?? ''),
    target: String(result.template ?? 'n/a'),
    evidence_verdict: String(result.evidenceVerdict ?? 'n/a'),
    evidence_retry: String(result.evidenceRetry ?? false),
    unit_tests_ran: String(result.unitTests?.ran ?? false),
    unit_tests_passed: String(result.unitTests?.passed ?? 'n/a'),
    duration_ms: String(result.durations?.totalMs ?? 0),
    input_tokens: String(totals.input_tokens),
    output_tokens: String(totals.output_tokens),
    cache_read_tokens: String(totals.cache_read_tokens),
    cache_creation_tokens: String(totals.cache_write_tokens),
    dispatch_count: String(totals.dispatch_count),
    dispatches: dispatches.map((d) => ({
      model: d.model,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
    })),
    timestamp: String(result.createdAt ?? new Date().toISOString()),
  };

  console.log('telemetry payload:', JSON.stringify(payload));

  const cfgDir = args.curlCfg
    ? resolve(args.curlCfg).split(sep).slice(0, -1).join(sep)
    : mkdtempSync(join(tmpdir(), 'verify-telemetry-'));
  const cfgPath = args.curlCfg ? resolve(args.curlCfg) : join(cfgDir, 'curl-cfg');

  const response = curlPost(telemetryUrl, telemetryToken, JSON.stringify(payload), cfgPath);
  console.log('telemetry response:', response);
  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    console.error('[append-telemetry] non-JSON response:', response);
    process.exit(1);
  }
  if (parsed?.ok !== true) {
    console.error('[append-telemetry] telemetry rejected:', response);
    process.exit(1);
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main(parseCliArgs(process.argv.slice(2)));
  } catch (err: any) {
    console.error('[append-telemetry] error:', err?.message ?? err);
    process.exit(1);
  }
}
