/** Seed one closed Dashboard conversation through the real Session persistence APIs. */

import { pathToFileURL } from 'node:url'

const load = name => import(pathToFileURL(process.env[name]).href)
const [{ Context }, sessionModule, persistenceModule, llm] = await Promise.all([
  load('HARNESS_DESKTOP_CORDIS_MODULE'),
  load('HARNESS_DESKTOP_SESSION_MODULE'),
  load('HARNESS_DESKTOP_PERSISTENCE_MODULE'),
  load('HARNESS_DESKTOP_LLM_MODULE'),
])
const { default: SessionStore, Session, SessionId, SESSION_FORMAT_VERSION } = sessionModule
const { default: JsonlSessionPersistence } = persistenceModule
const { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } = llm
const sessionId = SessionId('desktop-history-session')
const session = Session.create(sessionId)
session.append('turn/start', { turn: 1 })
const user = session.append('user/message', createUserMessage({
  content: [{ type: 'text', text: 'Run the Desktop history tool.' }], source: { kind: 'user' },
}), { surfaceOp: 'append' })
session.append('session/title', {
  title: 'Desktop tool history', messageSeqs: [user.seq], source: { kind: 'fallback' },
})
session.append('step/start', { turn: 1, step: 1 })
const callId = CallId('desktop-history-call')
session.append('assistant/message', {
  turn: 1,
  step: 1,
  message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pnpm test"}' }],
    source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }),
}, { surfaceOp: 'append' })
const call = session.append('tool/call', {
  turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pnpm test"}',
})
session.append('tool/result', {
  turn: 1,
  step: 1,
  message: createToolResultMessage({
    callId, content: [{ type: 'text', text: '21 tests passed' }], isError: false,
  }),
}, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
session.append('step/end', { turn: 1, step: 1 })
session.append('step/start', { turn: 1, step: 2 })
session.append('assistant/message', {
  turn: 1,
  step: 2,
  message: createAssistantMessage({
    content: [{ type: 'text', text: 'DONE' }],
    source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }),
}, { surfaceOp: 'append' })
session.append('step/end', { turn: 1, step: 2 })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

const ctx = new Context()
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: process.env.HARNESS_DESKTOP_SESSIONS_ROOT })
  await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now() - 60_000,
    cwd: process.env.HARNESS_DESKTOP_WORKSPACE,
    delegationDepth: 0,
    agentPreset: 'standard',
  })
  await ctx.sessionPersistence.append(sessionId, session.events)
} finally {
  await ctx.fiber.dispose()
}
