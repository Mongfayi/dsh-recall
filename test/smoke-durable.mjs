// Durability smoke test: prove that a recall tombstone survives the DURABLE
// read path, not just the in-memory one.
//
// The shipped JSONL backend writes every event through the v4 catalog encoder
// and re-admits it on load (`assertV4RowAdmission`), then re-validates the whole
// stored batch (`validateStoredEvents`) before a Session is rebuilt. A tombstone
// whose shape this path refuses would live in memory, render its notice, and
// silently vanish after a restart — so this test drives exactly that path:
//
//   append (through the plugin's own route)  →  encodeCurrentEvent
//     →  JSON round-trip  →  assertV4RowAdmission  →  validateStoredEvents
//     →  Session rebuild  →  derived history must still exclude the recall
import { Context } from '@deepseek-ai/cordis'
import { Session, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import * as plugin from '../lib/index.js'

// ── a real session holding one complete turn ────────────────────────────────
const s = Session.create('session-durable')
s.append('turn/start', { turn: 1 })
const user = s.append('user/message', {
	turn: 1,
	id: 'durable-user-1',
	role: 'user',
	source: { kind: 'user' },
	content: [{ type: 'text', text: 'please rename the file' }],
}, { surfaceOp: 'append' })
s.append('step/start', { turn: 1, step: 1 })
const assistant = s.append('assistant/message', {
	turn: 1,
	step: 1,
	message: {
		id: 'durable-assistant-1',
		role: 'assistant',
		source: { kind: 'model', provider: 'p', model: 'm' },
		content: [{ type: 'text', text: 'done' }],
	},
	stream: [],
}, { surfaceOp: 'append' })
s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

// ── recall the whole turn through the plugin's own route ────────────────────
const ctx = new Context()
let captured = null
ctx.provide('webServer', { register(route) { captured = route } })
ctx.provide('sessions', { flush: async () => true })
ctx.provide('agents', { get: (id) => (id === s.id ? { session: s, status: 'idle' } : void 0) })
await ctx.plugin(plugin)
if (captured === null) throw new Error('route not registered')

const res = { writeHead() {}, end() {} }
const payload = JSON.stringify({ sessionId: s.id, boundary: user.seq })
await captured.handler({
	method: 'POST',
	on(ev, cb) {
		if (ev === 'data') cb(Buffer.from(payload))
		if (ev === 'end') cb()
		if (ev === 'error') { /* never */ }
	},
	destroy() {},
}, res)

if (s.deriveMessages().length !== 0) throw new Error('in-memory derived history should be empty after the recall')

// ── the durable write path: encode every event exactly as JSONL stores it ───
const encoded = s.log.map((event) => JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))

// every row must pass the v4 durable admission gate (this is where a message
// source kind the format refuses would throw and lose the whole batch)
for (const row of encoded) assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)

const tombstoneRow = encoded.find((row) => row.data?.recall !== void 0)
if (tombstoneRow === undefined) throw new Error('tombstone did not survive encoding')
if (tombstoneRow.type !== 'system/message') throw new Error(`tombstone encoded as ${tombstoneRow.type}`)

// ── the durable read path: re-validate the stored batch, then rebuild ───────
const meta = { id: s.id, version: SESSION_FORMAT_VERSION, cwd: process.cwd() }
const stored = validateStoredEvents(meta, encoded, { kind: 'jsonl', path: '(memory)' })
const restored = Session.create(s.id, stored)
const restoredMessages = restored.deriveMessages()
if (restoredMessages.length !== 0) {
	throw new Error(`restored derived history should be empty, got ${restoredMessages.map((m) => m.id).join(',')}`)
}
if (restored.surface.nodes.length !== 1 || restored.surface.nodes[0] !== tombstoneRow.seq) {
	throw new Error('restored surface should hold exactly the tombstone node')
}
// the append-only prefix must come back untouched (a seeded Session appends its
// own `session/end-seed` marker, so the restored log may only ever grow)
if (restored.log.length < s.log.length) throw new Error('restore dropped append-only records')
for (const [index, event] of s.log.entries()) {
	const back = restored.log[index]
	if (back.seq !== event.seq || back.type !== event.type) throw new Error(`restored event ${index} drifted: ${back.type}@${back.seq}`)
}
for (const event of restored.log.slice(s.log.length)) {
	if (event.type !== 'session/end-seed') throw new Error(`unexpected extra restored event: ${event.type}`)
}

// the recall marker must round-trip verbatim: the client keys its notice and
// its row-hiding on exactly these numbers
const restoredTombstone = restored.log[tombstoneRow.seq]
if (restoredTombstone.data.recall.boundary !== user.seq) throw new Error('recall boundary did not survive the durable round-trip')
if (restoredTombstone.data.recall.end !== assistant.seq) throw new Error('recall end did not survive the durable round-trip')

console.log('DURABLE SMOKE OK — tombstone survives v4 admission + stored-batch validation')
