/**
 * Smoke test for derive-story-routes against real internal-ui story files.
 * Run: `node ./scripts/verify/derive-story-routes.test.ts`.
 */
import { resolve } from 'node:path';

import { deriveRoutesForFiles, loadStorySpecifiersFromMain } from './derive-story-routes.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const mainPath = resolve(repoRoot, 'code/.storybook/main.ts');

interface ExpectedRoute {
  filePath: string;
  expectTitle: string;
  expectKindId: string;
  expectAutodocs: boolean;
  expectExports: string[];
  expectFirstStoryId?: string;
  expectFirstStoryUrl?: string;
  expectFirstDocsUrl?: string;
}

const cases: ExpectedRoute[] = [
  {
    // Auto-title under titlePrefix 'addons/docs'; meta has tags: ['autodocs'].
    filePath: resolve(repoRoot, 'code/addons/docs/src/blocks/controls/Object.stories.tsx'),
    expectTitle: 'addons/docs/blocks/controls/Object',
    expectKindId: 'addons-docs-blocks-controls-object',
    expectAutodocs: true,
    expectExports: ['Object', 'Array', 'EmptyObject'],
    expectFirstStoryId: 'addons-docs-blocks-controls-object--object',
    expectFirstStoryUrl: '/?path=/story/addons-docs-blocks-controls-object--object',
    expectFirstDocsUrl: '/?path=/docs/addons-docs-blocks-controls-object--docs',
  },
  {
    // Auto-title under titlePrefix 'components'; expects leaf/dir dedup
    // ('Button/Button' -> 'Button').
    filePath: resolve(repoRoot, 'code/core/src/components/components/Button/Button.stories.tsx'),
    expectTitle: 'components/Button',
    expectKindId: 'components-button',
    expectAutodocs: false,
    expectExports: [],
    expectFirstStoryId: undefined,
  },
];

const specifiers = loadStorySpecifiersFromMain(mainPath);
console.log(`loaded ${specifiers.length} specifiers from ${mainPath}`);
if (specifiers.length === 0) {
  console.error('ERROR: no specifiers parsed — TS AST extractor broken');
  process.exit(1);
}

let failures = 0;
const printable = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const assertEq = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${label}: ${printable(actual)} ${ok ? '==' : '!='} ${printable(expected)}`);
  if (!ok) failures += 1;
};

const results = deriveRoutesForFiles(mainPath, cases.map((c) => c.filePath));

for (const c of cases) {
  console.log(`\n# ${c.filePath}`);
  const actual = results.find((r) => r.filePath === c.filePath);
  if (!actual) {
    console.log('  FAIL  no route produced');
    failures += 1;
    continue;
  }
  assertEq('title', actual.title, c.expectTitle);
  assertEq('kindId', actual.kindId, c.expectKindId);
  assertEq('autodocs', actual.autodocs, c.expectAutodocs);
  if (c.expectExports.length > 0) {
    // Only check that the first few expected exports are present, in order.
    const first = actual.routes.slice(0, c.expectExports.length).map((r) => r.exportName);
    assertEq('exports[0..n]', first, c.expectExports);
  }
  if (c.expectFirstStoryId) {
    assertEq('routes[0].storyId', actual.routes[0]?.storyId, c.expectFirstStoryId);
    assertEq('routes[0].storyUrl', actual.routes[0]?.storyUrl, c.expectFirstStoryUrl);
    if (c.expectFirstDocsUrl) {
      assertEq('routes[0].docsUrl', actual.routes[0]?.docsUrl, c.expectFirstDocsUrl);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall assertions passed');
