/**
 * Deterministic story-route derivation for the PR verify harness.
 *
 * Mirrors the canonical Storybook auto-title pipeline:
 *   - `sanitize` + `pathJoin` from preview-api/modules/store/autoTitle.ts
 *   - `toId` + `storyNameFromExport` + `toStartCaseStr` from csf/index.ts
 *
 * The implementation is inlined (rather than imported from
 * `storybook/internal/csf`) so the harness can compute routes from the
 * trusted base checkout BEFORE `nx compile core` runs — recipe-author
 * dispatch happens before the runner-side compile step.
 *
 * Inputs: an internal Storybook `.storybook/main.ts` file + a `*.stories.*`
 * file path. Output: the canonical title + story IDs + URLs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

// ---------------------------------------------------------------------------
// Inlined Storybook helpers (sourced from code/core/src/{csf, preview-api}).
// Kept verbatim so route output matches what the indexer would compute at
// runtime. If you change any of these, mirror the source.
// ---------------------------------------------------------------------------

const sanitize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

const toId = (kind: string, name?: string): string =>
  `${sanitize(kind)}${name ? `--${sanitize(name)}` : ''}`;

const toStartCaseStr = (str: string): string =>
  str
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\./g, ' ')
    .replace(/([^\n])([A-Z])([a-z])/g, (_, $1, $2, $3) => `${$1} ${$2}${$3}`)
    .replace(/([a-z])([A-Z])/g, (_, $1, $2) => `${$1} ${$2}`)
    .replace(/([a-z])([0-9])/gi, (_, $1, $2) => `${$1} ${$2}`)
    .replace(/([0-9])([a-z])/gi, (_, $1, $2) => `${$1} ${$2}`)
    .replace(/(\s|^)(\w)/g, (_, $1, $2) => `${$1}${$2.toUpperCase()}`)
    .replace(/ +/g, ' ')
    .trim();

const storyNameFromExport = (key: string): string => toStartCaseStr(key);

const pathJoin = (parts: string[]): string =>
  parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

const sanitizeAutoTitleParts = (parts: string[]): string[] => {
  if (parts.length === 0) {
    return parts;
  }
  const last = parts[parts.length - 1];
  const lastStripped = last?.replace(/(?:[.](?:story|stories))?([.][^.]+)$/i, '');
  if (parts.length === 1) {
    return [lastStripped ?? ''];
  }
  const nextToLast = parts[parts.length - 2];
  if (lastStripped && nextToLast && lastStripped.toLowerCase() === nextToLast.toLowerCase()) {
    return [...parts.slice(0, -2), lastStripped];
  }
  return lastStripped &&
    (/^(story|stories)([.][^.]+)$/i.test(last as string) || /^index$/i.test(lastStripped))
    ? parts.slice(0, -1)
    : [...parts.slice(0, -1), lastStripped];
};

// ---------------------------------------------------------------------------
// Specifier loader: parse main.ts via TypeScript AST.
// ---------------------------------------------------------------------------

export interface StorySpecifier {
  directory: string; // resolved absolute path
  files?: string; // glob pattern, defaults to '**/*.stories.@(js|jsx|ts|tsx|mdx)'
  titlePrefix?: string;
}

const DEFAULT_FILES_GLOB = '**/*.stories.@(js|jsx|ts|tsx|mdx)';

/** Parse a main.ts file and return the `stories` config as resolved specifiers. */
export function loadStorySpecifiersFromMain(mainConfigPath: string): StorySpecifier[] {
  if (!existsSync(mainConfigPath)) {
    throw new Error(`main config not found: ${mainConfigPath}`);
  }
  const source = readFileSync(mainConfigPath, 'utf-8');
  const sf = ts.createSourceFile(mainConfigPath, source, ts.ScriptTarget.Latest, true);
  const baseDir = dirname(resolve(mainConfigPath));

  const specifiers: StorySpecifier[] = [];

  const visit = (node: ts.Node): void => {
    // Look for the `stories: [...]` property anywhere in the file. Tolerates
    // either `export default { stories: [...] }` or `defineMain({ stories: [...] })`.
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'stories') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'stories')) &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        const spec = elementToSpecifier(element, baseDir);
        if (spec) specifiers.push(spec);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return specifiers;
}

const elementToSpecifier = (node: ts.Expression, baseDir: string): StorySpecifier | null => {
  if (ts.isStringLiteral(node)) {
    return { directory: resolve(baseDir, node.text) };
  }
  if (ts.isObjectLiteralExpression(node)) {
    let directory: string | undefined;
    let files: string | undefined;
    let titlePrefix: string | undefined;
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (!ts.isIdentifier(prop.name)) continue;
      const value = prop.initializer;
      if (!ts.isStringLiteral(value)) continue;
      if (prop.name.text === 'directory') directory = value.text;
      else if (prop.name.text === 'files') files = value.text;
      else if (prop.name.text === 'titlePrefix') titlePrefix = value.text;
    }
    if (!directory) return null;
    return {
      directory: resolve(baseDir, directory),
      ...(files ? { files } : {}),
      ...(titlePrefix ? { titlePrefix } : {}),
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Route derivation.
// ---------------------------------------------------------------------------

export interface RouteEntry {
  exportName: string;
  storyName: string;
  storyId: string;
  storyUrl: string;
  docsUrl?: string;
}

export interface StoryFileRoutes {
  filePath: string; // absolute path to the *.stories.* file
  title: string; // canonical Storybook title (autotitle or explicit)
  kindId: string; // sanitize(title) — matches what toId would emit
  autodocs: boolean;
  routes: RouteEntry[];
}

/**
 * Test whether the given file matches the specifier's directory + files glob.
 * `files` is a Storybook-flavoured glob. We only need to know whether the file
 * lives under `directory` AND has a recognised `.stories.*` extension — the
 * exact glob semantics don't matter for our purposes.
 */
const matchesSpecifier = (filePath: string, spec: StorySpecifier): boolean => {
  if (!isAbsolute(filePath)) return false;
  const rel = relative(spec.directory, filePath);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel === '') return false;

  const filesGlob = spec.files ?? DEFAULT_FILES_GLOB;

  // If the spec pins a specific file name (e.g. `'stories.tsx'`), require the
  // file basename to match it exactly. Otherwise fall through to the default
  // `.stories.{ext}` / `.mdx` extension check.
  if (filesGlob && !filesGlob.includes('*')) {
    return filePath.endsWith(`/${filesGlob}`) || filePath.endsWith(filesGlob);
  }

  return /\.(stories|story)\.(ts|tsx|js|jsx|cjs|mjs)$|\.mdx$/.test(filePath);
};

/** Compute the auto-title (Storybook's canonical path-based title). */
const autoTitleFor = (filePath: string, spec: StorySpecifier): string => {
  const rel = relative(spec.directory, filePath).split(sep).join('/');
  const parts = sanitizeAutoTitleParts(pathJoin([spec.titlePrefix ?? '', rel]).split('/'));
  return parts.join('/');
};

interface StoryFileMeta {
  titleOverride?: string;
  autodocs: boolean;
  exportNames: string[];
}

/** Parse a story file via TS AST to extract `meta.title`, `meta.tags`, exports. */
const parseStoryFile = (filePath: string): StoryFileMeta => {
  // MDX is not parseable as TypeScript. Treat as autodocs-only (no story
  // exports surfaced through this path); the caller can still emit a docs
  // route for the auto-titled kind.
  if (filePath.endsWith('.mdx')) {
    return { autodocs: true, exportNames: [] };
  }
  const source = readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  let titleOverride: string | undefined;
  let autodocs = false;
  const exportNames: string[] = [];

  // Track the identifier of the default-exported variable (e.g.
  // `const meta = {...}; export default meta;`) so we can resolve its
  // initializer when title/tags live on the variable.
  const variableInitializers = new Map<string, ts.Expression>();

  ts.forEachChild(sf, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          variableInitializers.set(decl.name.text, decl.initializer);
        }
      }
      // Top-level const/let exports: `export const Primary = {...}`
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exportNames.push(decl.name.text);
        }
      }
    }
    if (ts.isExportAssignment(node)) {
      // `export default <expr>`
      const expr = unwrapSatisfies(node.expression);
      const resolved = ts.isIdentifier(expr) ? variableInitializers.get(expr.text) : expr;
      const obj = resolved ? unwrapSatisfies(resolved) : undefined;
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          if (!ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === 'title' && ts.isStringLiteral(prop.initializer)) {
            titleOverride = prop.initializer.text;
          } else if (
            prop.name.text === 'tags' &&
            ts.isArrayLiteralExpression(prop.initializer)
          ) {
            autodocs = prop.initializer.elements.some(
              (e) => ts.isStringLiteral(e) && e.text === 'autodocs'
            );
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) exportNames.push(spec.name.text);
    }
  });

  const filtered = exportNames.filter((n) => n !== 'default' && n !== 'meta');
  return { titleOverride, autodocs, exportNames: filtered };
};

const unwrapSatisfies = (expr: ts.Expression): ts.Expression =>
  ts.isSatisfiesExpression(expr) || ts.isAsExpression(expr) ? unwrapSatisfies(expr.expression) : expr;

/** Compute all routes for a story file given the loaded specifiers. */
export function deriveStoryRoutes(
  filePath: string,
  specifiers: StorySpecifier[]
): StoryFileRoutes | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  const matched = specifiers.find((s) => matchesSpecifier(abs, s));
  if (!matched) return null;
  const meta = parseStoryFile(abs);
  const userTitle = meta.titleOverride;
  const autoTitle = autoTitleFor(abs, matched);

  let title: string;
  if (userTitle) {
    title = matched.titlePrefix ? pathJoin([matched.titlePrefix, userTitle]) : userTitle;
  } else {
    title = autoTitle;
  }

  const kindId = sanitize(title);

  const routes: RouteEntry[] = meta.exportNames.map((exportName) => {
    const storyName = storyNameFromExport(exportName);
    const storyId = toId(title, storyName);
    return {
      exportName,
      storyName,
      storyId,
      storyUrl: `/?path=/story/${storyId}`,
      ...(meta.autodocs ? { docsUrl: `/?path=/docs/${kindId}--docs` } : {}),
    };
  });

  return {
    filePath: abs,
    title,
    kindId,
    autodocs: meta.autodocs,
    routes,
  };
}

/** Convenience: load main.ts specifiers then derive routes for one or more story files. */
export function deriveRoutesForFiles(
  mainConfigPath: string,
  filePaths: string[]
): StoryFileRoutes[] {
  const specifiers = loadStorySpecifiersFromMain(mainConfigPath);
  const results: StoryFileRoutes[] = [];
  for (const fp of filePaths) {
    const routes = deriveStoryRoutes(fp, specifiers);
    if (routes) results.push(routes);
  }
  return results;
}
