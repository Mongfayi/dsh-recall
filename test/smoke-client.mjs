// Client-half smoke test: stub the browser module loader, document, react,
// the attachment seed module, and the slots/locale/conversationEvents
// services; materialize the factory and exercise the registrations (the
// keyed "user" Chat Node override), the locale dictionaries, the message
// content projection, and the recall button rendering + confirm gate.
import { readFileSync } from 'node:fs'

const registered = []
const styles = []
globalThis.window = {}
globalThis.__ModuleLoader__ = {
	load(handoff) { registered.push(handoff) },
}

globalThis.document = {
	querySelector: () => null,
	createElement: (name) => {
		if (name === 'style') {
			const tag = { dataset: {}, textContent: '', id: 'style' + styles.length }
			styles.push(tag)
			return tag
		}
		return { dataset: {}, style: {} }
	},
	head: { appendChild: (tag) => { if (!styles.includes(tag)) styles.push(tag) } },
}

// minimal react stub (createElement + the hooks RecallControl uses)
const effects = []
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: (fn) => { effects.push(fn) },
	useRef: (init) => ({ current: init }),
	Fragment: Symbol('Fragment'),
}
// the static-modules seed the loader would hand to the plugin
const attachmentStub = { ImageGallery: () => null }

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const factory = new Function('require', src.replace('window.__ModuleLoader__.load({', 'return ({'))
const handoff = factory((spec) => {
	if (spec === 'react') return reactStub
	if (spec === '@deepseek-ai/dsh-client-ui-attachment') return attachmentStub
	throw new Error('unexpected require: ' + spec)
})
if (handoff.id !== 'dsh-recall') throw new Error('wrong bundle id: ' + handoff.id)
if (typeof handoff.factory !== 'function') throw new Error('factory missing')

const moduleRec = { exports: {} }
const made = handoff.factory((spec) => {
	if (spec === 'react') return reactStub
	if (spec === '@deepseek-ai/dsh-client-ui-attachment') return attachmentStub
	throw new Error('unexpected require: ' + spec)
})
moduleRec.exports = made
const { apply, recallDefinition, contentParts, projectUserText } = moduleRec.exports
if (typeof apply !== 'function') throw new Error('exports.apply missing')

const cssTags = styles.filter((t) => t.dataset && t.dataset.plugin === 'dsh-recall')
console.log('css tags injected:', cssTags.length, cssTags[0]?.dataset?.pluginCss)
if (cssTags.length !== 1) throw new Error('expected exactly one owned style tag')
if (cssTags[0].textContent.includes('.dsr-user-row') === false) throw new Error('user bubble styles missing from the injected css')

// definition shape
if (recallDefinition.kind !== 'recall' || recallDefinition.target !== 'chat') throw new Error('recall definition malformed')
const match = recallDefinition.match({ type: 'session/recall', seq: 9, data: { boundary: 4 } })
if (!match || match.id !== '9' || match.role !== 'start') throw new Error('recall definition match failed')
if (recallDefinition.match({ type: 'user/message', seq: 1, data: {} }) !== null) throw new Error('recall definition must not match other events')
const start = recallDefinition.start({}, { event: { type: 'session/recall', seq: 9, time: 1, data: { boundary: 4 } } })
if (start.boundary !== 4 || start.seq !== 9) throw new Error('recall definition start failed')
console.log('recall definition OK')

// contentParts projection
const parts = contentParts([
	{ type: 'text', text: 'hello ' },
	{ type: 'image', attachment: { kind: 'image' } },
	{ type: 'tool', payload: 1 },
	{ type: 'text', text: 'world' },
])
if (parts.text !== 'hello world') throw new Error('contentParts should join text blocks: ' + JSON.stringify(parts.text))
if (parts.images.length !== 1) throw new Error('contentParts should collect images')
if (parts.rest.length !== 1) throw new Error('contentParts should collect other blocks')
if (contentParts(undefined).text !== '') throw new Error('contentParts(undefined) must be safe')
console.log('contentParts OK')

// projectUserText renders skill/subagent mentions as chips
// (the react stub wraps a spread array into one child — unwrap one level)
const projected = projectUserText('run /build now @agent')
if (projected === null) throw new Error('projectUserText should render text')
const projectedChildren = Array.isArray(projected.children?.[0]) ? projected.children[0] : (projected.children ?? [])
const chip = projectedChildren.find((c) => c && c.props?.['data-ref-chip'])
if (!chip) throw new Error('projectUserText should project a ref chip')
if (chip.props['data-ref-chip'] !== 'skill') throw new Error('chip should be a skill mention')
if (projectUserText('') !== null) throw new Error('projectUserText("") must be null')
console.log('projectUserText OK')

// locale dictionaries (parity check through the materialized bundle state)
const locales = made.locales ?? null
console.log('locales exposed:', locales === null ? '(not exported; verified via apply stub below)' : 'yes')

// stub services and drive apply()
const registrations = []
const localeRegistrations = []
const slotsStub = {
	inject(key, cb) { cb() },
	register(options, component) {
		registrations.push({ options, component })
		return () => {}
	},
}
const localeStub = {
	register(ns, dicts) { localeRegistrations.push({ ns, dicts }) },
}
const conversationEventsStub = {
	register(def) { registrations.push({ definition: def }) },
}
const ctxStub = {
	get(name) {
		if (name === 'slots') return slotsStub
		if (name === 'locale') return localeStub
		if (name === 'conversationEvents') return conversationEventsStub
		return undefined
	},
	effect(fn) { fn() }, // cordis runs effect callbacks immediately
}
apply(ctxStub)

const noticeReg = registrations.find((r) => r.options?.name === 'conversation.chat.node' && r.options?.key === 'recall')
if (!noticeReg) throw new Error('recall notice renderer not registered')
const userReg = registrations.find((r) => r.options?.name === 'conversation.chat.node' && r.options?.key === 'user')
if (!userReg) throw new Error('user Chat Node renderer not registered')
if (userReg.options.priority !== -1) throw new Error('user renderer should shadow the framework default at priority -1')
if (registrations.some((r) => r.options?.name === 'conversation.chat.assistant-actions')) throw new Error('assistant-actions registrations should have been removed')
if (registrations.filter((r) => r.definition === recallDefinition).length !== 1) throw new Error('recall definition not registered through conversationEvents')
const dict = localeRegistrations.find((r) => r.ns === 'recall')
if (!dict) throw new Error('recall locale namespace not registered')
const zhKeys = Object.keys(dict.dicts.zh).sort()
const enKeys = Object.keys(dict.dicts.en).sort()
if (zhKeys.join(',') !== enKeys.join(',')) throw new Error(`zh/en key sets differ: zh=${zhKeys} en=${enKeys}`)
if (zhKeys.length !== 14) throw new Error('unexpected dictionary size: ' + zhKeys.length)
console.log('registrations OK:', registrations.map((r) => r.options?.id ?? r.options?.key ?? 'definition').join(', '))
console.log('locale keys OK:', zhKeys.join(', '))

// render the user recall node: bubble + undo button with confirm gate
let confirmed = false
const realConfirm = globalThis.window.confirm
globalThis.window.confirm = () => { confirmed = true; return false }
const userEl = userReg.component({
	node: {
		key: 'chat:user:1',
		kind: 'user',
		id: 'user:1',
		target: 'chat',
		anchorSeq: 3,
		location: { kind: 'turn', turn: { turn: 1 } },
		visibility: 'visible',
		data: { kind: 'user', seq: 3, time: 1, content: [{ type: 'text', text: '请帮我写代码' }] },
	},
	sessionId: 's1',
	loadImage: async () => 'data:image/png;base64,',
	useSession: (selector) => selector({ running: false }),
	t: (k) => k,
})
const rendered = userEl // userReg.component IS UserRecallNodeView — its result is the rendered row tree
const row = (rendered.children ?? []).find((c) => c && c.props?.className === 'dsr-user-row') ?? rendered
if (!row) throw new Error('user row missing')
const stack = (row.children ?? []).find((c) => c && c.props?.className === 'dsr-user-stack')
if (!stack) throw new Error('user stack missing')
const bubble = (stack.children ?? []).find((c) => c && c.props?.className === 'dsr-user-bubble')
if (!bubble) throw new Error('user bubble missing')
const recallControl = (row.children ?? []).find((c) => c && typeof c.type === 'function')
if (!recallControl) throw new Error('recall control missing')
const controlRendered = recallControl.type(recallControl.props) // render RecallControl by hand
const button = (controlRendered.children ?? []).find((c) => c && c.props?.type === 'button')
if (!button) throw new Error('recall button missing')
if (button.props.disabled !== false) throw new Error('recall button should be enabled while idle')
const icon = (button.children ?? [])[0]
if (!icon || icon.type !== 'svg') throw new Error('recall button should render the undo icon')
button.props.onClick()
if (!confirmed) throw new Error('confirm dialog not triggered')
globalThis.window.confirm = realConfirm
console.log('user recall node renders bubble + undo button with confirm gate')

// the button must be disabled while the agent is running
const busyEl = userReg.component({
	node: {
		key: 'chat:user:1',
		kind: 'user',
		id: 'user:1',
		target: 'chat',
		anchorSeq: 3,
		location: { kind: 'turn', turn: { turn: 1 } },
		visibility: 'visible',
		data: { kind: 'user', seq: 3, time: 1, content: [{ type: 'text', text: 'hi' }] },
	},
	sessionId: 's1',
	useSession: (selector) => selector({ running: true }),
	t: (k) => k,
})
const busyRendered = busyEl // UserRecallNodeView rendered tree
const busyRow = (busyRendered.children ?? []).find((c) => c && c.props?.className === 'dsr-user-row') ?? busyRendered
const busyControl = (busyRow.children ?? []).find((c) => c && typeof c.type === 'function')
const busyControlRendered = busyControl.type(busyControl.props)
const busyButton = (busyControlRendered.children ?? []).find((c) => c && c.props?.type === 'button')
if (!busyButton || busyButton.props.disabled !== true) throw new Error('recall button should be disabled while the agent is running')
console.log('recall button disabled while running')

console.log('\nCLIENT SMOKE OK')
