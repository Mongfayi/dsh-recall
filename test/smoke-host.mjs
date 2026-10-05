// Host-half smoke test: mount the recall plugin against a real Session and
// stubbed agents/sessions/webServer services, then drive the captured /recall
// handler through success and refusal paths.
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import * as plugin from '../lib/index.js'

// ── build a real session with one complete turn ──────────────────────────
function buildSession() {
	const s = Session.create('session-smoke')
	s.append('turn/start', { turn: 1 })
	const user = s.append('user/message', {
		turn: 1,
		id: 'smoke-user-1',
		role: 'user',
		source: { kind: 'user' },
		content: [{ type: 'text', text: 'hello' }],
	}, { surfaceOp: 'append' })
	s.append('step/start', { turn: 1, step: 1 })
	const assistant = s.append('assistant/message', {
		turn: 1,
		step: 1,
		message: {
			id: 'smoke-assistant-1',
			role: 'assistant',
			source: { kind: 'model', provider: 'p', model: 'm' },
			content: [{ type: 'text', text: 'hi' }],
		},
		// 0.2.x restore contract (`assertAssistantSettlementShape`): an
		// assistant/message must carry numeric turn/step AND an array `stream`
		stream: [],
	}, { surfaceOp: 'append' })
	s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
	return { s, user, assistant }
}

// ── mount the plugin with stubbed services ───────────────────────────────
const ctx = new Context()
let captured = null
let flushed = 0
const { s, user, assistant } = buildSession()
const agent = { session: s, status: 'idle' }
ctx.provide('webServer', {
	register(route) { captured = route },
})
ctx.provide('sessions', {
	flush: async () => { flushed += 1; return true },
})
ctx.provide('agents', {
	get: (id) => (id === s.id ? agent : void 0),
})
await ctx.plugin(plugin)

if (!captured) throw new Error('webServer.register was never called')
if (captured.kind !== 'prefix' || captured.path !== '/recall') throw new Error('route misregistered: ' + JSON.stringify(captured))

// tiny fake res
function fakeRes() {
	let status = 0
	let body = null
	return {
		res: {
			writeHead(s, h) { status = s; this.headers = h },
			end(b) { body = b },
		},
		get status() { return status },
		get body() { return body },
		json() { return JSON.parse(body) },
	}
}
const post = (payload) => {
	const r = fakeRes()
	const body = JSON.stringify(payload)
	const req = {
		method: 'POST',
		on(ev, cb) {
			if (ev === 'data' && body !== '') cb(Buffer.from(body))
			if (ev === 'end') cb()
			if (ev === 'error') { /* never */ }
		},
		destroy() {},
	}
	return captured.handler(req, r.res).then(() => r)
}

// 1) success by messageId (recall the assistant reply)
let r = await post({ sessionId: s.id, messageId: assistant.data.message.id })
console.log('by messageId:', r.status, JSON.stringify(r.json()))
if (r.status !== 200 || r.json().ok !== true || r.json().value.boundary !== assistant.seq) throw new Error('recall by messageId failed')
if (flushed !== 1) throw new Error('flush not called')

// 2) duplicate recall of the same message -> recall-rejected / 422
r = await post({ sessionId: s.id, messageId: assistant.data.message.id })
console.log('double recall:', r.status, JSON.stringify(r.json()))
if (r.status !== 422 || r.json().error.code !== 'recall-rejected') throw new Error('double recall not rejected')

// 3) success by boundary (recall the user message -> whole turn removed)
r = await post({ sessionId: s.id, boundary: user.seq })
console.log('by boundary:', r.status, JSON.stringify(r.json()))
if (r.status !== 200 || r.json().value.boundary !== user.seq) throw new Error('recall by boundary failed')

// 4) unknown message id -> message-not-found / 404
r = await post({ sessionId: s.id, messageId: 'no-such-id' })
console.log('unknown message:', r.status, JSON.stringify(r.json()))
if (r.status !== 404 || r.json().error.code !== 'message-not-found') throw new Error('unknown message mapping failed')

// 5) unknown session -> session-not-found / 404
r = await post({ sessionId: 'session-ghost', messageId: 'x' })
console.log('unknown session:', r.status, JSON.stringify(r.json()))
if (r.status !== 404 || r.json().error.code !== 'session-not-found') throw new Error('unknown session mapping failed')

// 6) agent busy -> agent-busy / 409
agent.status = 'running'
r = await post({ sessionId: s.id, boundary: user.seq })
console.log('agent busy:', r.status, JSON.stringify(r.json()))
if (r.status !== 409 || r.json().error.code !== 'agent-busy') throw new Error('busy mapping failed')
agent.status = 'idle'

// 7) missing sessionId -> BAD_REQUEST / 400
r = await post({})
console.log('missing sessionId:', r.status, JSON.stringify(r.json()))
if (r.status !== 400 || r.json().error.code !== 'BAD_REQUEST') throw new Error('bad request mapping failed')

// 8) non-message boundary -> message-not-found / 404
r = await post({ sessionId: s.id, boundary: 0 })
console.log('non-message boundary:', r.status, JSON.stringify(r.json()))
if (r.status !== 404) throw new Error('non-message boundary mapping failed')

// 9) GET -> 405
const g = fakeRes()
await captured.handler({ method: 'GET', url: '/recall' }, g.res)
console.log('GET status:', g.status)
if (g.status !== 405) throw new Error('method not allowed failed')

// 10) derived history excludes the recalled range
console.log('derived after recalls:', s.deriveMessages().map((m) => m.id).join(',') || '(empty)')
if (s.deriveMessages().length !== 0) throw new Error('derived history should be empty after both recalls')

// 11) the recall is a durable, append-only tombstone: an empty `system/message`
// surface replacement carrying data.recall — the log keeps every original event
// (`session.log` is the 0.2.x log field; the old `session.events` accessor is gone)
const log = s.log
const tombstone = log.find((e) => e.data?.recall !== void 0)
if (!tombstone) throw new Error('no recall tombstone in the log')
if (tombstone.type !== 'system/message' || tombstone.surfaceOp?.op !== 'replace') throw new Error('tombstone must be a system/message surface replacement')
if (tombstone.data.message.content.length !== 0) throw new Error('tombstone must carry empty content')
// 0.2.0-rc.2 renamed the positional bounds to startSeq/endSeq and requires the
// tombstone's source list to cover every shadowed surface node
if (typeof tombstone.surfaceOp.startSeq !== 'number' || typeof tombstone.surfaceOp.endSeq !== 'number') throw new Error('tombstone must use the startSeq/endSeq replace shape')
if (!Array.isArray(tombstone.sourceEventSeqs) || tombstone.sourceEventSeqs.length === 0) throw new Error('tombstone must cite its shadowed source events')
// an assistant/message may not carry sourceEventSeqs on 0.2.x, which is exactly
// why the tombstone is a system/message
if (tombstone.type === 'assistant/message') throw new Error('assistant/message cannot be a surface replacement on 0.2.x')
if (log.length !== 7) throw new Error(`log must stay append-only; expected 7 events, got ${log.length}`)
// 12) the durable log is still self-consistent: replaying it through the shipped
// seed validator (Session.create) must accept every event we appended
const replayed = Session.create('session-smoke-replay', [...log])
if (replayed.deriveMessages().length !== 0) throw new Error('replayed history should be empty after both recalls')
// the second recall swallowed the first tombstone's position too, so the
// replayed surface holds exactly the LAST tombstone node
const lastTombstone = log.filter((e) => e.data?.recall !== void 0).at(-1)
if (replayed.surface.nodes.length !== 1 || replayed.surface.nodes[0] !== lastTombstone.seq) throw new Error('replayed surface should hold exactly the last tombstone')

console.log('\nHOST SMOKE OK')
