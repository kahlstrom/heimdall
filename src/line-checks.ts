/**
 * Mechanical checks on added lines: rule-gaming patterns that hide unused
 * code or silence the typechecker/linter instead of fixing the cause.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { matchesAnyGlob } from './glob.js';
import {
  NO_SILENCING_FILE_EXT_RE,
  SOURCE_FILE_EXT_RE,
  err,
  errorMessage,
  ok,
  type DiffScope,
  type Finding,
  type Result,
} from './types.js';

const SUPPRESSION_RE = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|secretlint-disable|gitleaks:allow/;
const SECRET_SUPPRESSION_KINDS = new Set(['secretlint-disable', 'gitleaks:allow']);

export type ScanAddedSourceOptions = {
  readonly extras?: boolean;
  readonly noSilencing?: boolean;
  /** When true, also flag new secretlint-disable / gitleaks:allow comments. */
  readonly secrets?: boolean;
  /** Compiled patterns checked against added comment lines in JS/TS files. */
  readonly commentPatterns?: readonly RegExp[];
};

export type LineCheckOptions = {
  readonly extras?: boolean;
  readonly allowSilencing?: readonly string[];
  readonly secrets?: boolean;
  readonly commentPatterns?: readonly RegExp[];
};

function suppressionKind(commentText: string, secrets: boolean): string | undefined {
  const kinds = [...commentText.matchAll(new RegExp(SUPPRESSION_RE, 'g'))].map((match) => match[0]);
  if (secrets) {
    const secretKind = kinds.find((kind) => SECRET_SUPPRESSION_KINDS.has(kind));
    if (secretKind !== undefined) {
      return secretKind;
    }
  }
  return kinds.find((kind) => !SECRET_SUPPRESSION_KINDS.has(kind));
}

function suppressionMessage(kind: string, line: string): string {
  // Secret-scanner comments may sit on a line that still holds a secret.
  return SECRET_SUPPRESSION_KINDS.has(kind) ? kind : line.trim();
}

function scriptKindForPath(filePath: string): ts.ScriptKind | undefined {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return undefined;
}

function isConstAssertion(node: ts.Node): boolean {
  if (!ts.isAsExpression(node) || !ts.isTypeReferenceNode(node.type)) {
    return false;
  }
  return ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const';
}

function isFlaggedCast(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  if (ts.isAsExpression(node) && !isConstAssertion(node)) {
    return true;
  }
  return ts.isTypeAssertionExpression(node);
}

/**
 * Line of the `as` keyword / asserted type, not the whole expression. Adding a
 * property inside a pre-existing multi-line `as Config` must not flag the old cast.
 */
function castAnchorLine(sourceFile: ts.SourceFile, node: ts.AsExpression | ts.TypeAssertion): number {
  return sourceFile.getLineAndCharacterOfPosition(node.type.getStart(sourceFile)).line + 1;
}

function firstAddedLineInNode(sourceFile: ts.SourceFile, node: ts.Node, addedLines: ReadonlySet<number>): number {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  for (let line = start; line <= end; line += 1) {
    if (addedLines.has(line)) {
      return line;
    }
  }
  return 0;
}

/**
 * Plain-text comment slice of a line. Quote-aware so `'// token'` in a string
 * is not treated as a comment.
 */
export function commentTextOfLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return trimmed;
  }
  let inSingle = false;
  let inDouble = false;
  let inTick = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line.charAt(index);
    const next = line.charAt(index + 1);
    if ((inSingle || inDouble || inTick) && ch === '\\') {
      index += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTick) {
      if (ch === '`') inTick = false;
      continue;
    }
    if (ch === '/' && next === '/') return line.slice(index);
    if (ch === '/' && next === '*') return line.slice(index);
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTick = true;
  }
  return '';
}

function push(
  hits: Finding[],
  filePath: string,
  line: number,
  rule: string,
  message: string,
): void {
  hits.push({ step: 'line-checks', file: filePath, line, rule, message });
}

function unwrapParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * `void unused;` — a statement whose operand is an identifier. Not `void foo()`,
 * `void promise.then(...)`, or `const x = void 0`.
 */
function isBareVoidIdentifierStatement(node: ts.Node): node is ts.ExpressionStatement {
  if (!ts.isExpressionStatement(node) || !ts.isVoidExpression(node.expression)) {
    return false;
  }
  return ts.isIdentifier(unwrapParens(node.expression.expression));
}

function isUnderscoreName(name: string): boolean {
  return name.startsWith('_');
}

/**
 * Underscore names that look like unused-warning dodges, kept conservative:
 *
 * Flagged: function/method/arrow/constructor parameters; `const`/`let`/`var`
 * identifiers; `function _name` declarations; `catch (_e)`; array destructuring
 * bindings; object destructuring *renames* (`{ used: _unused }`).
 *
 * Not flagged: object shorthand (`{ _id }`, a real property); class members
 * (`_private` visibility convention); import bindings (`import _ from 'lodash'`);
 * object literal keys; type parameters.
 */
function isSilencingUnderscoreBinding(node: ts.Node): string | undefined {
  if (ts.isParameter(node) && ts.isIdentifier(node.name) && isUnderscoreName(node.name.text)) {
    return node.name.text;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isIdentifier(node.name) &&
    isUnderscoreName(node.name.text)
  ) {
    return node.name.text;
  }
  if (
    ts.isFunctionDeclaration(node) &&
    node.name !== undefined &&
    isUnderscoreName(node.name.text)
  ) {
    return node.name.text;
  }
  if (
    ts.isCatchClause(node) &&
    node.variableDeclaration !== undefined &&
    ts.isIdentifier(node.variableDeclaration.name) &&
    isUnderscoreName(node.variableDeclaration.name.text)
  ) {
    return node.variableDeclaration.name.text;
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && isUnderscoreName(node.name.text)) {
    if (ts.isObjectBindingPattern(node.parent) && node.propertyName === undefined) {
      return undefined;
    }
    return node.name.text;
  }
  return undefined;
}

function commentPatternMessage(pattern: RegExp, commentText: string): string {
  return `matches /${pattern.source}/: ${commentText.trim()}`;
}

/**
 * Scan one file's added lines for rule-gaming hits.
 */
export function scanAddedSource(
  filePath: string,
  sourceText: string,
  addedLines: ReadonlySet<number>,
  options: ScanAddedSourceOptions = {},
): Finding[] {
  const extras = options.extras !== false;
  const noSilencing = options.noSilencing !== false;
  const secrets = options.secrets === true;
  const commentPatterns = options.commentPatterns ?? [];
  const hits: Finding[] = [];
  const sourceLines = sourceText.split('\n');
  for (const lineNumber of addedLines) {
    const line = sourceLines[lineNumber - 1] ?? '';
    const commentText = commentTextOfLine(line);
    if (commentText === '') {
      continue;
    }
    const suppression = suppressionKind(commentText, secrets);
    if (suppression !== undefined) {
      const message = suppressionMessage(suppression, line);
      if (extras) {
        push(hits, filePath, lineNumber, 'suppression', message);
      }
      if (noSilencing) {
        push(hits, filePath, lineNumber, 'no-silencing', message);
      }
    }
    const matchedPattern = commentPatterns.find((pattern) => commentText.search(pattern) !== -1);
    if (matchedPattern !== undefined) {
      push(hits, filePath, lineNumber, 'comment-pattern', commentPatternMessage(matchedPattern, commentText));
    }
  }

  if (!extras && !noSilencing) {
    return hits;
  }

  const kind = scriptKindForPath(filePath);
  if (kind === undefined) {
    return hits;
  }
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, kind);
  const visit = (node: ts.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const onAdded = addedLines.has(line);
    if (extras) {
      if (isFlaggedCast(node)) {
        const castLine = castAnchorLine(sourceFile, node);
        if (addedLines.has(castLine)) {
          push(hits, filePath, castLine, 'as-cast', node.getText(sourceFile));
        }
      }
      const nonNullLine = ts.isNonNullExpression(node)
        ? firstAddedLineInNode(sourceFile, node, addedLines)
        : 0;
      if (nonNullLine > 0) {
        push(hits, filePath, nonNullLine, 'non-null', node.getText(sourceFile));
      }
      if (onAdded && ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression)) {
        push(hits, filePath, line, 'void-statement', node.getText(sourceFile));
      }
      if (onAdded && ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text.startsWith('_')) {
        push(hits, filePath, line, 'underscore-param', node.name.text);
      }
    }
    if (noSilencing && onAdded) {
      if (isBareVoidIdentifierStatement(node)) {
        push(hits, filePath, line, 'no-silencing', node.getText(sourceFile));
      }
      const underscore = isSilencingUnderscoreBinding(node);
      if (underscore !== undefined) {
        push(hits, filePath, line, 'no-silencing', underscore);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export function runLineChecks(
  repoRoot: string,
  scope: DiffScope,
  options: LineCheckOptions = {},
): Result<Finding[]> {
  const extras = options.extras !== false;
  const allowSilencing = options.allowSilencing ?? [];
  const secrets = options.secrets === true;
  const commentPatterns = options.commentPatterns ?? [];
  const hits: Finding[] = [];
  for (const [filePath, addedLines] of scope.addedLines) {
    if (addedLines.size === 0) {
      continue;
    }
    const isSource = SOURCE_FILE_EXT_RE.test(filePath);
    const extrasOn = extras && isSource;
    const noSilencingOn =
      NO_SILENCING_FILE_EXT_RE.test(filePath) && !matchesAnyGlob(filePath, allowSilencing);
    const commentPatternsOn = commentPatterns.length > 0 && isSource;
    if (!extrasOn && !noSilencingOn && !commentPatternsOn) {
      continue;
    }
    const abs = path.join(repoRoot, filePath);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(abs, 'utf8');
    } catch (cause) {
      return err(`cannot read ${filePath}: ${errorMessage(cause)}`);
    }
    hits.push(...scanAddedSource(filePath, sourceText, addedLines, {
      extras: extrasOn,
      noSilencing: noSilencingOn,
      secrets,
      commentPatterns,
    }));
  }
  return ok(hits);
}
