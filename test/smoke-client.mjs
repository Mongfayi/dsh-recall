// Client-half smoke test: stub the browser module loader, document, react,
// and the slots/locale/conversationEvents services; materialize the factory
// and exercise the registrations (the keyed "user" Chat Node override), the
// locale dictionaries, the message content projection, the recall button
// rendering + confirm gate, the fallback user row's image path (through
// renderMessageImages), and the framework-view delegation (copy button and
// image gallery stay framework-owned; the recall control is a separate row).
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

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const factory = new Function('require', src.replace('window.__ModuleLoader__.load({', 'return ({'))
const handoff = factory((spec) => {
	if (spec === 'react') return reactStub
	throw new Error('unexpected require: ' + spec)
})
if (handoff.id !== 'dsh-recall') throw new Error('wrong bundle id: ' + handoff.id)
if (typeof handoff.factory !== 'function') throw new Error('factory missing')

const moduleRec = { exports: {} }
const made = handoff.factory((spec) => {
	if (spec === 'react') return reactStub
	throw new Error('unexpected require: ' + spec)
})
moduleRec.exports = made
const { apply, recallDefinition, contentParts, projectUserText, restoreDraft, restoreDraftImages, isRecalledAnchor, recordRecalledRange, wrapRecalledRowDefinition, installRecalledRowIntercepts } = moduleRec.exports
if (typeof apply !== 'function') throw new Error('exports.apply missing')

const cssTags = styles.filter((t) => t.dataset && t.dataset.plugin === 'dsh-recall')
console.log('css tags injected:', cssTags.length, cssTags[0]?.dataset?.pluginCss)
if (cssTags.length !== 1) throw new Error('expected exactly one owned style tag')
if (cssTags[0].textContent.includes('.dsr-user-row') === false) throw new Error('fallback user bubble styles missing from the injected css')
if (cssTags[0].textContent.includes('.dsr-user-wrap') === false) throw new Error('framework-wrap styles missing from the injected css')
// the recall control is positioned ON the framework row's actions line, LEFT
// of the copy button (right:38px = copy 28px + 10px row gap) — same row,
// never covering the copy button
const wrapCss = cssTags[0].textContent.split('.dsr-user-wrap{')[1]?.split('}')[0] ?? ''
const recallCss = cssTags[0].textContent.split('.dsr-user-recall{')[1]?.split('}')[0] ?? ''
if (!wrapCss.includes('position:relative') || !wrapCss.includes('flex-direction:column')) throw new Error('dsr-user-wrap must stay a column with the framework row full-width: ' + wrapCss)
if (!recallCss.includes('right:38px') || !recallCss.includes('bottom:0')) throw new Error('dsr-user-recall must sit on the actions line, left of the copy button: ' + recallCss)

// definition shape
if (recallDefinition.kind !== 'recall' || recallDefinition.target !== 'chat') throw new Error('recall definition malformed')
const tombstone = {
	type: 'assistant/message',
	seq: 9,
	surfaceOp: { op: 'replace', start: 4, end: 7 },
	sourceEventSeqs: [4, 7],
	data: { turn: 1, recall: { boundary: 4, end: 7 }, message: { id: 'r', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] } },
}
const match = recallDefinition.match(tombstone)
if (!match || match.id !== '9' || match.role !== 'start') throw new Error('recall definition match failed')
if (recallDefinition.match({ type: 'user/message', seq: 1, data: {} }) !== null) throw new Error('recall definition must not match other events')
if (recallDefinition.match({ type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { message: {} } }) !== null) throw new Error('recall definition must not match plain assistant messages')
const start = recallDefinition.start({}, { event: { type: 'assistant/message', seq: 9, time: 1, data: { recall: { boundary: 4, end: 7 } } } })
if (start.boundary !== 4 || start.end !== 7 || start.seq !== 9) throw new Error('recall definition start failed')
console.log('recall definition OK')

// recalled-range membership (inclusive ends)
{
	const ranges = [{ boundary: 20, end: 23 }]
	if (recordRecalledRange(20, 23) !== true) throw new Error('recordRecalledRange(20,23) should record')
	if (isRecalledAnchor(19, ranges) !== false) throw new Error('before boundary must be false')
	if (isRecalledAnchor(20, ranges) !== true) throw new Error('boundary inclusive must be true')
	if (isRecalledAnchor(23, ranges) !== true) throw new Error('end inclusive must be true')
	if (isRecalledAnchor(24, ranges) !== false) throw new Error('after end must be false')
	if (isRecalledAnchor(undefined, ranges) !== false) throw new Error('undefined seq must be false')
	if (recordRecalledRange(20, 23) !== false) throw new Error('duplicate range must not re-record')
	console.log('recalled ranges OK')
}

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
// framework `user` seat entries visible to the plugin's delegation lookup;
// empty = fallback mode, filled = delegation mode
let frameworkUserEntries = []
const slotsStub = {
	inject(key, cb) { cb() },
	entries(key) { return key === 'conversation.chat.node' ? frameworkUserEntries : [] },
	register(options, component) {
		registrations.push({ options, component })
		return () => {}
	},
}
const localeStub = {
	register(ns, dicts) { localeRegistrations.push({ ns, dicts }) },
	bind(ns) {
		if (ns !== 'conversation') throw new Error('unexpected bind namespace: ' + ns)
		return (key) => 'conv:' + key
	},
}
const conversationEventsStub = {
	register(def) {
		registrations.push({ definition: def })
		return () => {
			const index = registrations.lastIndexOf({ definition: def })
			if (index !== -1) registrations.splice(index, 1)
		}
	},
	entries() { return [] },
	subscribe() { return () => {} },
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
if (zhKeys.length !== 6) throw new Error('unexpected dictionary size: ' + zhKeys.length)
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

// an image message must still render its images: the user row renders them
// through the framework's image slot (renderMessageImages), never through a
// plugin-side loader (which received no `loadImage` prop and would break)
{
	const imageCalls = []
	const imgEl = userReg.component({
		node: {
			key: 'chat:user:1',
			kind: 'user',
			id: 'user:1',
			target: 'chat',
			anchorSeq: 40,
			location: { kind: 'turn', turn: { turn: 1 } },
			visibility: 'visible',
			data: { kind: 'user', seq: 40, time: 1, content: [
				{ type: 'text', text: '看图 ' },
				{ type: 'image', attachment: { attachmentId: 'a1', name: 'p.png' } },
			] },
		},
		sessionId: 's1',
		renderMessageImages: (owner) => { imageCalls.push(owner); return 'images' },
		useSession: (selector) => selector({ running: false }),
		t: (k) => k,
	})
	const imgRow = (imgEl.children ?? []).find((c) => c && c.props?.className === 'dsr-user-row') ?? imgEl
	const imgStack = (imgRow.children ?? []).find((c) => c && c.props?.className === 'dsr-user-stack')
	if (!imgStack) throw new Error('image message: user stack missing')
	if (imageCalls.length !== 1) throw new Error('image message must render through renderMessageImages: ' + imageCalls.length)
	if (imageCalls[0].align !== 'end' || imageCalls[0].images.length !== 1) throw new Error('image message must pass the gallery owner through: ' + JSON.stringify(imageCalls[0]))
	console.log('image message renders through the framework image slot (renderMessageImages)')
}

// a recalled user message vanishes from the transcript: the user override
// reads the recorded recalled range and returns null for covered seqs
{
	recordRecalledRange(3, 9)
	const hiddenEl = userReg.component({
		node: {
			key: 'chat:user:1',
			kind: 'user',
			id: 'user:1',
			target: 'chat',
			anchorSeq: 3,
			location: { kind: 'turn', turn: { turn: 1 } },
			visibility: 'visible',
			data: { kind: 'user', seq: 3, time: 1, content: [{ type: 'text', text: '已被撤回的消息' }] },
		},
		sessionId: 's1',
		loadImage: async () => 'data:image/png;base64,',
		useSession: (selector) => selector({ running: false }),
		t: (k) => k,
	})
	if (hiddenEl !== null) throw new Error('recalled user message should render null')
	console.log('recalled user message hidden from the transcript')
}

// definition-level interception: EVERY framework chat-node kind is dropped
// during assembly when its anchor falls inside a recalled range, and passed
// through untouched otherwise. This is what makes long-context recalls hide
// the WHOLE turn — subagent commands, compactions, retries, workflows, … — not
// just the first answer's tool-call/turn-tail rows.
{
	recordRecalledRange(4, 9)
	const makeBuilder = (kind) => (context) => ({
		kind,
		anchorSeq: context.candidateSeq,
		target: 'chat',
		data: {
			seq: context.dataSeq,
			finalNode: { seq: context.finalSeq },
			closing: { finalNode: { seq: context.closingSeq } },
		},
	})
	const kinds = ['steering', 'context', 'assistant-step', 'command', 'manual-compaction', 'compaction', 'model-retry', 'turn-error', 'turn-max-tokens', 'turn-tail', 'unknown', 'command-input', 'tool-call', 'workflow-run']
	const defs = kinds.map((kind) => ({ kind, buildViewNode: makeBuilder(kind) }))
	const unrelatedDef = { kind: 'input-message', buildViewNode: () => 'unrelated' }
	installRecalledRowIntercepts({ entries: () => [...defs, unrelatedDef] })

	const call = (def, candidateSeq, extra = {}) => def.buildViewNode({
		candidateSeq,
		dataSeq: extra.dataSeq ?? candidateSeq,
		finalSeq: extra.finalSeq ?? candidateSeq,
		closingSeq: extra.closingSeq ?? candidateSeq,
	})

	// every wrapped kind: anchor inside the range -> dropped
	for (const def of defs) {
		if (call(def, 5) !== null) throw new Error(`recalled ${def.kind} row must be dropped (anchor inside range)`)
	}
	// boundary/end inclusive
	const toolDef = defs.find((d) => d.kind === 'tool-call')
	if (call(toolDef, 4) !== null) throw new Error('boundary inclusive must drop')
	if (call(toolDef, 9) !== null) throw new Error('end inclusive must drop')
	// turn-tail resolves its anchor from the closing message seq
	const tailDef = defs.find((d) => d.kind === 'turn-tail')
	if (call(tailDef, 7, { closingSeq: 7 }) !== null) throw new Error('recalled turn-tail must drop (closing inside range)')
	// outside the range: framework output passes through untouched
	for (const def of defs) {
		const out = call(def, 12)
		if (out === null || out.kind !== def.kind || out.anchorSeq !== 12) throw new Error(`live ${def.kind} row must pass through`)
	}
	// other (non-conversation) definitions are never wrapped
	if (unrelatedDef.buildViewNode() !== 'unrelated') throw new Error('unrelated definitions must not be wrapped')
	// wrapping is idempotent per definition
	const before = defs[0].buildViewNode
	installRecalledRowIntercepts({ entries: () => [defs[0]] })
	if (defs[0].buildViewNode !== before) throw new Error('wrapping must be idempotent per definition')
	// the plugin's own recall definition and the user kind are never wrapped
	const recallDef = { kind: 'recall', buildViewNode: () => 'recall-node' }
	const userDef = { kind: 'user', buildViewNode: () => 'user-node' }
	installRecalledRowIntercepts({ entries: () => [recallDef, userDef] })
	if (recallDef.buildViewNode() !== 'recall-node') throw new Error('recall definition must not be wrapped')
	if (userDef.buildViewNode() !== 'user-node') throw new Error('user definition must not be wrapped')
	console.log('definition-level intercepts drop recalled rows of EVERY chat-node kind and pass everything else through')
}

// ── restore-to-input behavior: after a successful recall, the recalled user
// message text lands in the session's composer draft (the opencode-style undo
// affordance). The restore must wait for the recall request to settle.
{
	const drafts = []
	const scope = { id: 's1' }
	const inputFacade = { setDraft: (text) => { drafts.push(text) } }
	ctxStub.sessions = {
		scope: (id) => (id === scope.id ? scope : void 0),
	}
	ctxStub.get = (name) => {
		if (name === 'slots') return slotsStub
		if (name === 'locale') return localeStub
		if (name === 'conversationEvents') return conversationEventsStub
		if (name === 'conversation') return { input: { for: (actx) => (actx === scope ? inputFacade : void 0) } }
		return undefined
	}
	const realFetch = globalThis.fetch
	const realConfirm = globalThis.window.confirm
	globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: { boundary: 3 } }) })
	globalThis.window.confirm = () => true

	const el = userReg.component({
		node: {
			key: 'chat:user:1',
			kind: 'user',
			id: 'user:1',
			target: 'chat',
			anchorSeq: 30,
			location: { kind: 'turn', turn: { turn: 1 } },
			visibility: 'visible',
			data: { kind: 'user', seq: 30, time: 1, content: [{ type: 'text', text: '把这段改一改' }] },
		},
		sessionId: 's1',
		loadImage: async () => 'data:image/png;base64,',
		useSession: (selector) => selector({ running: false }),
		t: (k) => k,
	})
	const rowEl = (el.children ?? []).find((c) => c && c.props?.className === 'dsr-user-row') ?? el
	const controlEl = (rowEl.children ?? []).find((c) => c && typeof c.type === 'function')
	const controlTree = controlEl.type(controlEl.props)
	const buttonEl = (controlTree.children ?? []).find((c) => c && c.props?.type === 'button')
	buttonEl.props.onClick()
	await new Promise((resolve) => setTimeout(resolve, 0))
	if (drafts.length !== 1 || drafts[0] !== '把这段改一改') throw new Error('recalled text should restore to the composer draft: ' + JSON.stringify(drafts))
	globalThis.fetch = realFetch
	globalThis.window.confirm = realConfirm
	console.log('recalled message text restores to the input box after a successful recall')
}

// empty / non-text messages must not touch the draft (restoreDraft guard)
if (restoreDraft('s1', '') !== false) throw new Error('restoreDraft must no-op on empty text')
console.log('restoreDraft no-ops on empty text')

// ── image restore: a recalled image message comes back into the composer
// draft image rail — the durable attachment is resolved to a session
// authorized URL, fetched into a File, registered as a draft image, and its
// id appended to the input state (the recalled bytes survive in the
// append-only log, so the restore has real source data).
{
	const addedIds = []
	const created = []
	const filesSeen = []
	const scope = { id: 's1' }
	const facade = {
		setDraft: () => {},
		addImages: (ids) => { addedIds.push(...ids); return true },
	}
	const conversation = {
		input: { for: (actx) => (actx === scope ? facade : void 0) },
		resolveImage: async (sid, attachment) => 'blob:recalled-' + attachment.attachmentId,
		createDraftImages: (files) => files.map((file) => {
			filesSeen.push(file)
			const id = 'draft-' + created.length
			created.push({ id })
			return { id }
		}),
	}
	ctxStub.sessions = { scope: (id) => (id === scope.id ? scope : void 0) }
	ctxStub.get = (name) => {
		if (name === 'slots') return slotsStub
		if (name === 'locale') return localeStub
		if (name === 'conversationEvents') return conversationEventsStub
		if (name === 'conversation') return conversation
		return undefined
	}
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['png-bytes'], { type: 'image/png' }) })
	const restored = await restoreDraftImages('s1', [
		{ attachment: { attachmentId: 'a1', mediaType: 'image/png', name: '截图.png', bytes: 9, width: 1, height: 1 } },
		{ attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', name: 'photo.jpg', bytes: 9, width: 1, height: 1 } },
	])
	globalThis.fetch = realFetch
	if (restored !== true) throw new Error('restoreDraftImages should restore image ids')
	if (addedIds.join(',') !== 'draft-0,draft-1') throw new Error('image ids should land in the draft rail: ' + addedIds.join(','))
	if (filesSeen.length !== 2 || filesSeen[0].name !== '截图.png' || filesSeen[0].type !== 'image/png') throw new Error('restored files must carry the attachment identity: ' + JSON.stringify(filesSeen.map((f) => [f.name, f.type])))
	if (await restoreDraftImages('s1', []) !== false) throw new Error('restoreDraftImages must no-op on no images')
	globalThis.fetch = async () => ({ ok: false })
	if (await restoreDraftImages('s1', [{ attachment: { attachmentId: 'bad' } }]) !== false) throw new Error('a failed image fetch must not report success')
	console.log('recalled images restore into the composer draft rail')
}

// ── framework-view delegation: when the framework's own `user` renderer is
// registered, the plugin shadows it but DELEGATES the whole row to it — the
// bubble, the copy button, the clock, the reference chips and the image
// gallery stay exactly framework-owned — and the recall control renders as a
// SIBLING row under the message, never over the copy button. The framework
// row must translate with the CONVERSATION namespace (copy / copied / …),
// not the recall one.
{
	// the framework wraps every business renderer in react.memo, which yields
	// an OBJECT ({$$typeof: Symbol.for("react.memo"), type}) — not a plain
	// function; delegation must accept both forms
	const FrameworkUserViewStub = { $$typeof: Symbol.for('react.memo'), type: () => 'framework-row' }
	frameworkUserEntries = [
		{ options: { key: 'user', priority: -1, registrant: 'dsh-recall' }, component: userReg.component },
		{ options: { key: 'user', priority: 0, registrant: '@deepseek-ai/dsh-client-ui-conversation' }, component: FrameworkUserViewStub },
	]
	const node = {
		key: 'chat:user:1',
		kind: 'user',
		id: 'user:1',
		target: 'chat',
		anchorSeq: 50,
		location: { kind: 'turn', turn: { turn: 1 } },
		visibility: 'visible',
		data: { kind: 'user', seq: 50, time: 1, content: [
			{ type: 'text', text: '带图 ' },
			{ type: 'image', attachment: { attachmentId: 'a2', name: 'q.png' } },
		] },
	}
	const el = userReg.component({
		node,
		sessionId: 's1',
		renderMessageImages: (owner) => 'gallery:' + owner.images.length,
		useSession: (selector) => selector({ running: false }),
		t: (k) => k,
	})
	if (el.type !== 'div' || el.props?.className !== 'dsr-user-wrap') throw new Error('delegated user row must render inside dsr-user-wrap: ' + JSON.stringify(el))
	const [frameworkEl, recallWrapEl] = el.children
	if (!frameworkEl || frameworkEl.type !== FrameworkUserViewStub) throw new Error('delegation must render the framework user view, not the plugin bubble')
	if (!recallWrapEl || recallWrapEl.props?.className !== 'dsr-user-recall') throw new Error('recall control must sit in its own overlay on the actions line')
	const recallControlEl = (recallWrapEl.children ?? [])[0]
	if (!recallControlEl || typeof recallControlEl.type !== 'function') throw new Error('recall control must be inside the actions-line overlay')
	if (!frameworkEl.props.node || frameworkEl.props.node.data?.seq !== node.data.seq || frameworkEl.props.node.data?.content !== node.data.content) throw new Error('framework view must receive the same node data (clock suppressed only)')
	if (frameworkEl.props.node.data.time !== void 0) throw new Error('the hover clock must be suppressed so the recall occupies the copy line')
	if (frameworkEl.props.t('copy') !== 'conv:copy') throw new Error('framework row must translate with the CONVERSATION namespace: ' + frameworkEl.props.t('copy'))
	if (frameworkEl.props.renderMessageImages === void 0) throw new Error('framework row must keep renderMessageImages (images stay framework-owned)')
	// the framework row (holding the copy button) and the recall control are
	// siblings: the recall overlay is positioned on the same actions line,
	// LEFT of the copy button — it can never cover it
	console.log('delegation keeps the framework row (copy button + images) and places the recall control on the same line, left of the copy button')
}

console.log('\nCLIENT SMOKE OK')
