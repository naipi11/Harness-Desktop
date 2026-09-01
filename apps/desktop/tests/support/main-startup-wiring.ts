/** TypeScript AST checks for Desktop Main startup settlement ownership. */

import ts from 'typescript'

type DashboardLoadMethod = 'open' | 'retryAfterUserAction'

const recoveryBlockedTitle = 'Harness Desktop update recovery is blocked'
const recoveryBlockedMessage = 'The local update recovery record cannot be validated. Reinstall the last stable signed installer before reopening Harness Desktop.'

const wiring = [
  {
    functionName: 'startDesktopWindow',
    method: 'open',
    problem: 'startDesktopWindow must own complete controller.open settlement',
  },
  {
    functionName: 'retryDesktopWindow',
    method: 'retryAfterUserAction',
    problem: 'retryDesktopWindow must own complete existing-owner retry settlement',
  },
] as const

/**
 * Inspect the shipped Electron Main entry for complete initial and retry settlement ownership.
 * @param source - TypeScript source of `apps/desktop/src/main/index.ts`.
 * @returns one stable diagnostic for each missing owned startup path.
 */
export function desktopMainStartupWiringProblems(source: string): string[] {
  const sourceFile = parse(source)
  const problems: string[] = []
  for (const expectation of wiring) {
    const declaration = functionDeclaration(sourceFile, expectation.functionName)
    if (declaration === undefined || ownedStartupCall(declaration, expectation.method) === undefined) {
      problems.push(expectation.problem)
    }
  }
  return problems
}

/**
 * Inspect the shipped Electron Main entry for fixed recovery-blocked guidance on both health-check outcomes.
 * @param source - TypeScript source of `apps/desktop/src/main/index.ts`.
 * @returns stable diagnostics for missing, duplicated, or dynamic recovery guidance.
 */
export function nativeRecoveryBlockedStartupProblems(source: string): string[] {
  const sourceFile = parse(source)
  const problems: string[] = []
  const initializeNativeUpdates = functionDeclaration(sourceFile, 'initializeNativeUpdates')
  const recoveryDialog = functionDeclaration(sourceFile, 'showNativeRecoveryBlocked')
  if (recoveryDialog === undefined || !isFixedRecoveryDialog(recoveryDialog)) {
    problems.push('showNativeRecoveryBlocked must show the fixed safe recovery guidance once')
  }
  if (initializeNativeUpdates === undefined
    || !recoveryBlockedExceptionShowsRecoveryDialog(initializeNativeUpdates)
    || !recoveryBlockedResultShowsRecoveryDialog(initializeNativeUpdates)) {
    problems.push('initializeNativeUpdates must show recovery guidance before a recovery-blocked result exits')
  }
  return problems
}

/**
 * Remove the settlement-ownership wrapper from one AST-located production path.
 * @param source - valid Desktop Main TypeScript source.
 * @param method - controller load operation whose ownership is removed.
 * @returns valid source that preserves the completion call but bypasses controller ownership.
 */
export function removeOwnedStartupWiring(source: string, method: DashboardLoadMethod): string {
  const sourceFile = parse(source)
  const expectation = wiring.find(entry => entry.method === method)
  if (expectation === undefined) throw new Error(`unsupported Dashboard load method: ${method}`)
  const declaration = functionDeclaration(sourceFile, expectation.functionName)
  const call = declaration === undefined ? undefined : ownedStartupCall(declaration, method)
  if (call === undefined) throw new Error(`${expectation.functionName} owned startup call is missing`)
  const completion = call.arguments[0]
  if (completion === undefined) throw new Error(`${expectation.functionName} completion argument is missing`)
  return source.slice(0, call.getStart(sourceFile)) + completion.getText(sourceFile) + source.slice(call.getEnd())
}

/**
 * Keep controller ownership while bypassing one complete startup helper call.
 * @param source - valid Desktop Main TypeScript source.
 * @param method - controller load operation invoked without complete settlement.
 * @returns valid source that owns only the raw controller load promise.
 */
export function removeCompleteStartupWiring(source: string, method: DashboardLoadMethod): string {
  const sourceFile = parse(source)
  const expectation = wiring.find(entry => entry.method === method)
  if (expectation === undefined) throw new Error(`unsupported Dashboard load method: ${method}`)
  const declaration = functionDeclaration(sourceFile, expectation.functionName)
  const call = declaration === undefined ? undefined : ownedStartupCall(declaration, method)
  if (call === undefined) throw new Error(`${expectation.functionName} owned startup call is missing`)
  const completion = call.arguments[0] === undefined ? undefined : unwrap(call.arguments[0])
  if (completion === undefined || !ts.isCallExpression(completion)) {
    throw new Error(`${expectation.functionName} completion call is missing`)
  }
  const load = completion.arguments[2]
  if (load === undefined) throw new Error(`${expectation.functionName} load callback is missing`)
  const replacement = `${call.expression.getText(sourceFile)}((${load.getText(sourceFile)})())`
  return source.slice(0, call.getStart(sourceFile)) + replacement + source.slice(call.getEnd())
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function functionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
}

function ownedStartupCall(
  declaration: ts.FunctionDeclaration,
  method: DashboardLoadMethod,
): ts.CallExpression | undefined {
  let match: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (match !== undefined) return
    if (ts.isCallExpression(node) && isOwnedCompletion(node, method)) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return match
}

function isOwnedCompletion(call: ts.CallExpression, method: DashboardLoadMethod): boolean {
  if (!isControllerMethod(call.expression, 'ownStartupSettlement')) return false
  const completion = call.arguments[0]
  if (completion === undefined) return false
  const unwrapped = unwrap(completion)
  if (!ts.isCallExpression(unwrapped) || !ts.isIdentifier(unwrapped.expression)
    || unwrapped.expression.text !== 'completeDesktopWindowStartup') return false
  const load = unwrapped.arguments[2]
  if (load === undefined || (!ts.isArrowFunction(load) && !ts.isFunctionExpression(load))) return false
  return callbackContainsControllerMethod(load.body, method)
}

function callbackContainsControllerMethod(body: ts.ConciseBody, method: DashboardLoadMethod): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && isControllerMethod(node.expression, method)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

function isControllerMethod(expression: ts.LeftHandSideExpression, method: string): boolean {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'controller'
    && expression.name.text === method
}

function recoveryBlockedResultShowsRecoveryDialog(declaration: ts.FunctionDeclaration): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIfStatement(node)
      && isRecoveryBlockedHealthCheck(node.expression)
      && statementCallsRecoveryDialogBeforeReturn(node.thenStatement)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return found
}

function recoveryBlockedExceptionShowsRecoveryDialog(declaration: ts.FunctionDeclaration): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isTryStatement(node)
      && containsCall(node.tryBlock, 'beginDashboardHealthCheck')
      && node.catchClause !== undefined
      && statementCallsRecoveryDialogBeforeReturn(node.catchClause.block)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return found
}

function isFixedRecoveryDialog(declaration: ts.FunctionDeclaration): boolean {
  if (declaration.body === undefined) return false
  const calls = declaration.body.statements.filter((statement): statement is ts.ExpressionStatement =>
    ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression)
      && ts.isPropertyAccessExpression(statement.expression.expression)
      && ts.isIdentifier(statement.expression.expression.expression)
      && statement.expression.expression.expression.text === 'dialog'
      && statement.expression.expression.name.text === 'showErrorBox')
  if (calls.length !== 1) return false
  const call = calls[0]?.expression
  if (call === undefined || !ts.isCallExpression(call)) return false
  const [title, message] = call.arguments
  return title !== undefined
    && message !== undefined
    && ts.isStringLiteral(title)
    && title.text === recoveryBlockedTitle
    && ts.isStringLiteral(message)
    && message.text === recoveryBlockedMessage
}

function containsCall(node: ts.Node, method: string): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(child)
      && ts.isPropertyAccessExpression(child.expression)
      && child.expression.name.text === method) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function isRecoveryBlockedHealthCheck(expression: ts.Expression): boolean {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return false
  }
  return ts.isPropertyAccessExpression(expression.left)
    && ts.isIdentifier(expression.left.expression)
    && expression.left.expression.text === 'startupNativeUpdateHealth'
    && expression.left.name.text === 'kind'
    && ts.isStringLiteral(expression.right)
    && expression.right.text === 'recovery-blocked'
}

function statementCallsRecoveryDialogBeforeReturn(statement: ts.Statement): boolean {
  if (!ts.isBlock(statement)) return false
  let recoveryDialogCalls = 0
  for (const child of statement.statements) {
    if (ts.isExpressionStatement(child)
      && ts.isCallExpression(child.expression)
      && ts.isIdentifier(child.expression.expression)
      && child.expression.expression.text === 'showNativeRecoveryBlocked') {
      recoveryDialogCalls += 1
      continue
    }
    if (ts.isReturnStatement(child)
      && child.expression !== undefined
      && ts.isStringLiteral(child.expression)
      && child.expression.text === 'recovery-blocked') return recoveryDialogCalls === 1
  }
  return false
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression
  return current
}
