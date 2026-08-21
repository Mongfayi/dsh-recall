/**
 * dsh-recall — Browser half.
 *
 * Message recall (撤回) UI for the DSH Web UI:
 *   - one undo button beside EVERY user message (this is the only entry
 *     point): clicking it recalls the current turn — the user message itself
 *     and everything after it up to the recall operation.
 *   - a "recalled message" notice rendered at each durable recall tombstone
 *     (chat node kind "recall").
 *   - recalled rows are hidden from the transcript. Two mechanisms, split by
 *     what rc.8's slot ledger permits: the recalled user message (this
 *     bundle's own renderer) and the recalled steering/context/assistant rows
 *     (thin filters that shadow the framework renderers and delegate to them
 *     for anything outside a recalled range — those framework renderers
 *     declare no child slots, so the shadowing is legal), while the recalled
 *     tool rows and turn-tail footers are dropped at the CONVERSATION
 *     DEFINITION level: this bundle wraps the framework's `tool-call` and
 *     `turn-tail` `buildViewNode` (they are the only two whose renderers
 *     render child slots — `tool.call.toolview`, `conversation.chat.turnTail`
 *     and `conversation.chat.assistant-actions` — and the slot core forbids a
 *     shadowing entry from re-declaring children that a live framework entry
 *     already declared, so they cannot be shadowed with delegation).
 *
 * The button lives on the user message by overriding the keyed Chat Node
 * seat for kind "user" (priority -1 shadows the framework's default
 * renderer). The user node's `data.seq` IS the durable seq of the user
 * message, so it doubles as the recall boundary directly — no turn lookup
 * needed. The override DELEGATES to the framework's own user renderer
 * (captured from the seat entries) so the message keeps its shipped look
 * byte-for-byte: bubble, copy button, reference chips and the image
 * gallery all stay framework-owned. The recall control is positioned ON the
 * framework's actions line, immediately LEFT of the copy button (the hover
 * clock is suppressed so the line holds exactly the copy button) — same
 * row, never covering it. Should the framework renderer ever be
 * unresolvable, the bundle falls back to a plugin-owned bubble whose images
 * still render through the framework's image slot (`renderMessageImages`),
 * never through a plugin-side gallery loader.
 *
 * The recall request goes to the plugin's own host route (POST /recall) — no
 * custom RPC plumbing. The host appends ONE durable tombstone: an empty
 * `assistant/message` whose surfaceOp REPLACES the recalled range, so the
 * model-visible history drops the recalled messages. This bundle matches
 * that tombstone (`data.recall`) for the notice and hides every chat row
 * whose seq falls inside a recalled range. Recall NEVER reverts filesystem
 * changes: the host appends a tombstone to the append-only log and nothing
 * else.
 *
 * Recalled ranges are tracked from the tombstone events THEMSELVES as they
 * stream through the conversation assembler (`data.recall = {boundary, end}`
 * recorded by this bundle's own `recall` definition's `match` — the
 * tombstone always arrives in the same assembly pass as the recalled events,
 * and view nodes are built only after the pass completes, so the range table
 * is complete by build time). The `tool-call`/`turn-tail` `buildViewNode`
 * wraps read that table and return null for rows anchored inside a recalled
 * range. When a tombstone lands on a LIVE session the assembler does not
 * re-evaluate already-materialized rows, so the bundle re-registers its own
 * recall definition once per new range — a low-frequency registry change
 * that triggers the runtime's conversation rebuild, which re-runs the
 * wrapped builders and drops the stale rows immediately (the same rebuild a
 * page reload would produce).
 *
 * After a recall commits, the recalled user message's text is restored into
 * the session's composer draft (input box) so the user can edit and resend it
 * — the same recovery affordance opencode's undo has — and its image
 * attachments are resolved back into the draft image rail (the recalled
 * attachment bytes stay in the append-only log, so the restore has real
 * source data). The restore happens only AFTER the recall request settles,
 * never before, so a fast re-submit cannot race the tombstone.
 */
window.__ModuleLoader__.load({
	id: "dsh-recall",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── live client root context (captured at apply time) ────────────────
		/** The client root ctx, used to reach the session composer draft. */
		let recallCtx = null;
		/**
		 * The framework's CONVERSATION-namespace translator. The delegated user
		 * row must translate with the framework's own dictionary (copy / copied /
		 * message.extraBlock / json.truncated / …), so the plugin re-binds the
		 * `t` it hands to the framework component.
		 */
		let conversationT = null;
		/** The slots service, captured at apply time (used by the delegation lookup). */
		let recallSlots = null;

		// ── styles (injected once at materialization) ─────────────────────────
		const css = [
			// recall action button
			".dsr-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".dsr-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsr-action:disabled{cursor:default;opacity:.4}",
			".dsr-failure{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:28px}",
			// wrapper around the delegated framework user row + the recall
			// control: the framework row keeps its exact framework layout
			// (bubble, actions row), and the recall control is positioned ON
			// the actions row, left of the copy button — same line, never
			// covering it (the row is right-aligned; the copy button is the
			// rightmost element, and the recall sits 10px left of it)
			".dsr-user-wrap{position:relative;flex-direction:column;align-items:flex-end;display:flex}",
			".dsr-user-recall{position:absolute;right:38px;bottom:0;align-items:center;flex-direction:row-reverse;display:flex}",
			// fallback user message bubble — mirrors the framework's user row so
			// the overridden renderer keeps the same look (CSS vars stay intact)
			".dsr-user-row{flex-direction:column;align-items:flex-end;gap:6px;display:flex}",
			".dsr-user-stack{flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%);display:flex}",
			".dsr-user-bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px}",
			".dsr-ref-chip{color:var(--dsw-alias-label-primary);white-space:nowrap;vertical-align:baseline;background:#6187d838;border-radius:6px;margin:0 2px;padding:0 8px;font-size:.85em;line-height:1.6;display:inline-block}",
			// fallback JSON block for non-text/non-image user content
			".dsr-json-block{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-line-strong, rgba(128,128,128,.25));border-radius:8px;padding:6px 10px;font-size:12px;line-height:18px;max-width:100%;overflow:auto}",
			".dsr-json-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-bottom:2px}",
			// recalled-message notice
			".dsr-notice-row{align-items:center;justify-content:center;display:flex}",
			".dsr-notice{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover-solid);border-radius:14px;padding:2px 12px;font-size:12px;line-height:20px}"
		].join("");
		const CSS_TAG = "dsh-recall/Recall.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-recall";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── undo icon (inline; no icon dependency) ────────────────────────────
		const UNDO_SVG = react.createElement("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": true
		},
			react.createElement("polyline", { points: "1 4 1 10 7 10" }),
			react.createElement("path", { d: "M3.51 15a9 9 0 1 0 2.13-9.36L1 10" })
		);

		// ── locales ───────────────────────────────────────────────────────────
		/** `recall` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"action": "撤回本轮对话",
			"confirmTurn": "撤回本轮对话及其后的全部内容？该消息会恢复到输入框，可修改后重新发送。已产生的代码/文件改动不会回退。",
			"notice": "已撤回的消息",
			"errorBusy": "智能体正在运行，请先停止当前回合再撤回",
			"error": "撤回失败：{reason}",
			"extraBlock": "附加内容"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"action": "Recall this turn",
			"confirmTurn": "Recall this turn and everything after it? The message will be restored to the input box for editing and resending. Any code or file changes it produced will NOT be reverted.",
			"notice": "Recalled message",
			"errorBusy": "The agent is running; stop the current turn before recalling",
			"error": "Recall failed: {reason}",
			"extraBlock": "Additional content"
		};

		// ── recall request (plugin's own host route) ──────────────────────────
		/** POST one recall request; settles to the host envelope `{ok, value|error}`. */
		async function recallRequest(payload) {
			try {
				const response = await fetch("/recall", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
				let body = null;
				try {
					body = await response.json();
				} catch {}
				if (body === null || typeof body !== "object") {
					return { ok: false, error: { code: "transport", message: "HTTP " + response.status } };
				}
				return body;
			} catch (error) {
				return { ok: false, error: { code: "transport", message: error instanceof Error ? error.message : String(error) } };
			}
		}

		// ── recalled-range bookkeeping ────────────────────────────────────────
		/**
		 * Recalled seq ranges known to this page. Fed from the tombstone events
		 * THEMSELVES as they stream through the conversation assembler (the
		 * `recall` definition's `match` records every `data.recall` it sees), so
		 * the table is complete before the assembler's flush builds any view node
		 * — including on window installs and registry rebuilds, where the recalled
		 * events are re-matched alongside their tombstones. Ranges are inclusive
		 * on both ends: `{boundary, end}` are the first and last recalled message
		 * seqs (the tombstone itself sits at `end + 1`).
		 */
		const RECALL_RANGES = [];

		/** Record one recalled range; returns whether it was new. */
		function recordRecalledRange(boundary, end) {
			if (RECALL_RANGES.some((range) => range.boundary === boundary && range.end === end)) return false;
			RECALL_RANGES.push({ boundary, end });
			RECALL_RANGES.sort((left, right) => left.boundary - right.boundary);
			return true;
		}

		/** Whether a row anchor/seq falls inside a recalled range (inclusive ends). */
		function isRecalledAnchor(seq, ranges) {
			if (typeof seq !== "number") return false;
			return ranges.some((range) => seq >= range.boundary && seq <= range.end);
		}

		// ── restore the recalled text into the composer draft ────────────────
		/**
		 * Write `text` back into the session's composer draft — the "back to the
		 * input box" half of recall (the opencode undo affordance). Resolved
		 * lazily through the client root ctx: `sessions.scope(sessionId)` hands
		 * the agent-scoped ctx the conversation service's `input.for` ticket
		 * needs. Degrades to a logged no-op when the services are unavailable,
		 * never a crash.
		 * @param sessionId - the session whose composer receives the text.
		 * @param text - the recalled message's plain text (empty = no-op).
		 * @returns whether the draft write was attempted.
		 */
		function restoreDraft(sessionId, text) {
			if (typeof text !== "string" || text === "") return false;
			const ctx = recallCtx;
			if (ctx === null) return false;
			try {
				const actx = typeof ctx.sessions?.scope === "function" ? ctx.sessions.scope(sessionId) : void 0;
				if (actx === void 0) return false;
				const conversation = ctx.get("conversation");
				const input = conversation?.input;
				if (input === void 0 || typeof input.for !== "function") return false;
				const facade = input.for(actx);
				if (typeof facade?.setDraft !== "function") return false;
				facade.setDraft(text);
				return true;
			} catch (error) {
				console.warn("[dsh-recall] draft restore failed:", error);
				return false;
			}
		}

		/**
		 * Restore the recalled message's IMAGES into the composer draft image
		 * rail: each durable attachment is resolved to a session-authorized URL
		 * (`conversation.resolveImage`), fetched into a File, registered as a
		 * browser-owned draft image (`conversation.createDraftImages`) and its
		 * id appended to the input state (`facade.addImages`). The recalled
		 * attachment stays in the append-only log, so the bytes are still
		 * available after the recall. Degrades to a no-op per image on failure.
		 * @param sessionId - the session whose composer receives the images.
		 * @param images - the `contentParts` image entries (`{attachment}`).
		 * @returns whether at least one image id was restored.
		 */
		async function restoreDraftImages(sessionId, images) {
			const list = Array.isArray(images) ? images : [];
			if (list.length === 0) return false;
			const ctx = recallCtx;
			if (ctx === null) return false;
			try {
				const actx = typeof ctx.sessions?.scope === "function" ? ctx.sessions.scope(sessionId) : void 0;
				if (actx === void 0) return false;
				const conversation = typeof ctx.get === "function" ? ctx.get("conversation") : void 0;
				if (conversation === void 0 || typeof conversation.resolveImage !== "function" || typeof conversation.createDraftImages !== "function") return false;
				const facade = conversation.input?.for?.(actx);
				if (facade === void 0 || typeof facade.addImages !== "function") return false;
				const ids = [];
				for (const entry of list) {
					const attachment = entry?.attachment;
					if (attachment === void 0 || attachment === null) continue;
					try {
						const url = await conversation.resolveImage(sessionId, attachment);
						const response = await fetch(url);
						if (!response.ok) continue;
						const blob = await response.blob();
						const file = new File([blob], attachment.name ?? "image.png", {
							type: attachment.mediaType ?? blob.type ?? "image/png"
						});
						const created = conversation.createDraftImages([file]);
						if (created.length === 1) ids.push(created[0].id);
					} catch (error) {
						console.warn("[dsh-recall] image restore failed for attachment", attachment.attachmentId, error);
					}
				}
				if (ids.length === 0) return false;
				return facade.addImages(ids) === true;
			} catch (error) {
				console.warn("[dsh-recall] image restore failed:", error);
				return false;
			}
		}

		// ── user message rendering helpers (mirror of the framework's own) ─────
		/** Split a message content block list into text, images, and other blocks. */
		function contentParts(content) {
			const texts = [];
			const images = [];
			const rest = [];
			for (const block of Array.isArray(content) ? content : []) {
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
				else if (block?.type === "image" && block.attachment !== void 0) images.push({ attachment: block.attachment });
				else rest.push(block);
			}
			return {
				text: texts.join(""),
				images,
				rest
			};
		}

		/** Project user text, highlighting /skill and @subagent mentions as chips. */
		function projectUserText(text) {
			if (typeof text !== "string" || text === "") return null;
			const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
			const parts = [];
			let cursor = 0;
			let m;
			while ((m = re.exec(text)) !== null) {
				const tokenStart = m.index + (m[1]?.length ?? 0);
				const label = m[2] ?? "";
				if (tokenStart > cursor) parts.push(react.createElement("span", { key: cursor }, text.slice(cursor, tokenStart)));
				parts.push(react.createElement("span", {
					key: tokenStart,
					className: "dsr-ref-chip",
					"data-ref-chip": label.startsWith("@") ? "subagent" : "skill"
				}, label));
				cursor = tokenStart + label.length;
			}
			if (parts.length === 0) return react.createElement("span", null, text);
			if (cursor < text.length) parts.push(react.createElement("span", { key: cursor }, text.slice(cursor)));
			return react.createElement(react.Fragment, null, parts);
		}

		/** Compact JSON display for non-text, non-image user blocks. */
		function JsonBlockFallback({ label, payload }) {
			return react.createElement("div", { className: "dsr-json-block", role: "status" },
				react.createElement("div", { className: "dsr-json-label" }, label),
				react.createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, JSON.stringify(payload))
			);
		}

		// ── components ─────────────────────────────────────────────────────────
		/**
		* One recall control: an undo button with mandatory confirmation and an
		* inline failure note. The action never reverts filesystem changes.
		*/
		function RecallControl({ ariaLabel, confirmMessage, doRecall, disabled = false, t }) {
			const [pending, setPending] = react.useState(false);
			const [failure, setFailure] = react.useState(null);
			const alive = react.useRef(true);
			react.useEffect(() => () => {
				alive.current = false;
			}, []);
			const onClick = () => {
				if (!window.confirm(confirmMessage)) return;
				setPending(true);
				setFailure(null);
				Promise.resolve(doRecall()).then((result) => {
					if (!alive.current) return;
					setPending(false);
					if (result?.ok === true) return;
					const code = result?.error?.code;
					setFailure(code === "agent-busy" ? t("errorBusy") : t("error", {
						reason: result?.error?.message ?? code ?? ""
					}));
				});
			};
			return react.createElement(react.Fragment, null,
				react.createElement("button", {
					type: "button",
					className: "dsr-action",
					"aria-label": ariaLabel,
					title: ariaLabel,
					disabled: pending || disabled,
					onClick
				}, UNDO_SVG),
				failure !== null ? react.createElement("span", { className: "dsr-failure", role: "status" }, failure) : null
			);
		}

		// ── framework user-view delegation ────────────────────────────────────
		/**
		 * The framework's own user-message renderer (`UserMessageNodeView`),
		 * resolved from the keyed Chat Node seat entries. The plugin shadows that
		 * seat at priority -1 to add the recall button; delegating to the
		 * original component keeps the shipped bubble, copy button, reference
		 * chips and image gallery exactly as the framework renders them — the
		 * recall control is overlaid on the framework's own actions line, LEFT
		 * of the copy button, so it can never cover it. Cached on first
		 * success (the framework always registers before any user row renders).
		 */
		let frameworkUserComponentCache = null;

		/** Whether a value is renderable as a React component type: a plain
		 * function, or a `react.memo` / `forwardRef` object (the framework
		 * wraps every business renderer in `memo`, which yields an object). */
		function isRenderableComponent(value) {
			if (typeof value === "function") return true;
			if (value === null || typeof value !== "object") return false;
			const tag = value.$$typeof;
			return tag === Symbol.for("react.memo") || tag === Symbol.for("react.forward_ref");
		}

		/** Clone a chat node with the message clock suppressed (`data.time`
		 * cleared), so the framework's actions row renders the copy button
		 * alone — the recall control then occupies the line to its left. */
		function suppressNodeClock(node) {
			if (node === void 0 || node === null || typeof node !== "object" || node.data === void 0 || node.data === null) return node;
			return { ...node, data: { ...node.data, time: void 0 } };
		}

		/** Resolve the original `user` entry component (null until found). */
		function frameworkUserViewComponent() {
			if (frameworkUserComponentCache !== null) return frameworkUserComponentCache;
			const slots = recallSlots;
			if (slots === void 0 || typeof slots.entries !== "function") return null;
			let found = null;
			try {
				for (const entry of slots.entries("conversation.chat.node")) {
					// skip this bundle's own shadow entry; take the framework's
					if (entry?.options?.key === "user" && isRenderableComponent(entry.component) && entry.component !== UserRecallNodeView) {
						found = entry.component;
						break;
					}
				}
			} catch {}
			frameworkUserComponentCache = found;
			return found;
		}

		/**
		 * The user-message renderer (shadows the framework default at priority
		 * -1): the framework's own user row, plus one undo button that recalls
		 * this turn and everything after it. The user message seq is the recall
		 * boundary — the host removes that event and every later one.
		 *
		 * The framework row (bubble, copy button, images) is rendered by the
		 * framework's own component with the framework's own locale translator;
		 * the recall control is overlaid on the same actions line, left of the
		 * copy button.
		 */
		function UserRecallNodeView(props) {
			const { node, sessionId, useSession, t } = props;
			const data = node?.data;
			if (data === void 0 || sessionId === void 0) return null;
			const boundary = data.seq;
			const running = typeof useSession === "function" ? useSession((snapshot) => snapshot.running) : false;
			// a recalled user message is gone from the transcript: the "recalled
			// message" notice (its own chat node) marks the position instead
			if (isRecalledAnchor(boundary, RECALL_RANGES)) return null;
			const { text, images } = contentParts(data.content);
			const recallControl = react.createElement(RecallControl, {
				ariaLabel: t("action"),
				confirmMessage: t("confirmTurn"),
				doRecall: () => recallRequest({ sessionId, boundary }).then((result) => {
					// restore only AFTER the recall commits — never before, so a
					// fast re-submit cannot race the tombstone (the opencode
					// undo-restore race)
					if (result?.ok === true) {
						restoreDraft(sessionId, text);
						restoreDraftImages(sessionId, images);
					}
					return result;
				}),
				disabled: running === true,
				t
			});
			const FrameworkUserView = frameworkUserViewComponent();
			if (isRenderableComponent(FrameworkUserView)) {
				// the framework row must translate with the CONVERSATION
				// namespace (copy / copied / extraBlock / …), not the recall one.
				// The hover clock is suppressed (node.time cleared) so the
				// actions row holds exactly the copy button — the recall control
				// then sits on the same line, left of it, without collision.
				const frameworkProps = conversationT === null ? props : { ...props, t: conversationT, node: suppressNodeClock(props.node) };
				return react.createElement("div", { className: "dsr-user-wrap" },
					react.createElement(FrameworkUserView, frameworkProps),
					react.createElement("div", { className: "dsr-user-recall" }, recallControl)
				);
			}
			// fallback (framework renderer unresolvable — never expected on a
			// live DSH): plugin-owned bubble, images through the framework's
			// image slot, same recall row. The warning carries the seat
			// diagnostics so a framework-contract drift is actionable.
			try {
				const slots = recallSlots;
				const seen = slots !== void 0 && typeof slots.entries === "function" ? slots.entries("conversation.chat.node").map((entry) => `${entry?.options?.key ?? "?"}@${entry?.options?.priority ?? 0}(${typeof entry?.component})`) : "unavailable";
				console.warn("[dsh-recall] framework user renderer not found in the chat node seat entries; using the plugin fallback bubble (copy button will be missing). seat entries:", seen);
			} catch (error) {
				console.warn("[dsh-recall] framework user renderer not found (seat introspection failed):", error);
			}
			return userFallbackRow({
				node,
				renderMessageImages: props.renderMessageImages,
				t,
				recallControl
			});
		}

		/**
		 * Fallback user row used only when the framework's own renderer cannot
		 * be resolved: the same right-aligned bubble and image gallery (through
		 * the framework's `renderMessageImages` slot — never a plugin-side
		 * loader, which would break image display), plus the recall control.
		 */
		function userFallbackRow({ node, renderMessageImages, t, recallControl }) {
			const { text, images, rest } = contentParts(node?.data?.content);
			const showBubble = text !== "" || rest.length > 0;
			return react.createElement("div", { className: "dsr-user-row", "data-time-hover-root": true },
				react.createElement("div", { className: "dsr-user-stack" },
					images.length > 0 && typeof renderMessageImages === "function" ? renderMessageImages({ images, align: "end" }) : null,
					showBubble ? react.createElement("div", { className: "dsr-user-bubble" },
						projectUserText(text),
						rest.map((block, i) => react.createElement(JsonBlockFallback, {
							key: i,
							label: t("extraBlock"),
							payload: block
						}))
					) : null
				),
				recallControl
			);
		}

		/** Recalled-message notice rendered at the recall tombstone's position. */
		function RecallNotice(props) {
			const { t } = props;
			return react.createElement("div", { className: "dsr-notice-row", "data-recall": true },
				react.createElement("span", { className: "dsr-notice" }, t("notice"))
			);
		}

		// ── conversation definition: the recall notice node ────────────────────
		/** Build one final Chat target Node (the shape the chat view builder expects). */
		function chatNode(context, kind, anchorSeq, data) {
			return {
				key: context.key,
				kind,
				id: context.id,
				target: "chat",
				anchorSeq,
				location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
				visibility: "visible",
				data
			};
		}

		/**
		* One durable message recall: a system notice anchored at the recall
		* tombstone's seq. The tombstone is the empty `assistant/message` surface
		* replacement the host appends (carrying `data.recall`); its replacement
		* range never reaches the assembler's message definitions, so this node
		* is the only trace of the recall in the chat flow.
		*/
		const recallDefinition = {
			kind: "recall",
			target: "chat",
			match: (event) => {
				if (event.type === "assistant/message" && event.data?.recall !== void 0) {
					const { boundary, end } = event.data.recall;
					if (typeof boundary === "number" && typeof end === "number") {
						if (recordRecalledRange(boundary, end)) scheduleRecallRebuild();
					}
					return {
						id: String(event.seq),
						role: "start"
					};
				}
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "assistant/message" || match.event.data?.recall === void 0) throw new Error("recall start requires a recall tombstone (assistant/message with data.recall)");
				return {
					kind: "recall",
					seq: match.event.seq,
					time: match.event.time,
					boundary: match.event.data.recall.boundary,
					end: match.event.data.recall.end
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => context.state === void 0 ? null : chatNode(context, "recall", context.state.seq, context.state)
		};

		// ── recalled-row interception (every framework chat node) ─────────────
		/**
		 * Every conversation chat-node kind is hidden at the CONVERSATION
		 * DEFINITION level by wrapping `buildViewNode`. A shadowing renderer
		 * entry cannot be used for kinds that declare child slots (the slot
		 * ledger forbids re-declaring a child slot already declared by a live
		 * framework entry, rc.8), and the set of kinds is large and grows with
		 * subagents, workflows, compactions and retries — so a per-kind filter
		 * list would always miss some. Wrapping the framework definitions'
		 * `buildViewNode` instead is the legal, exhaustive equivalent: it drops
		 * the row during assembly (before any renderer seat is consulted) for
		 * every kind whose anchor falls inside a recalled range, while leaving
		 * all other rows byte-identical to the framework's own output.
		 */
		/** Wrapped framework definitions (identity -> original buildViewNode). */
		const interceptedDefinitions = new Map();

		/**
		 * The seqs a chat node can represent, across every framework kind. The
		 * node anchor (`anchorSeq`) is the projected message seq for most kinds;
		 * assistant steps carry the message in `data.finalNode.seq`; turn-tail
		 * footers in `data.closing.finalNode.seq`; a few kinds (steering,
		 * context) in `data.seq`. Any of these falling inside a recalled range
		 * marks the row as part of a recalled message.
		 * @param node - the framework-built chat node.
		 * @returns the candidate seqs (numbers only).
		 */
		function nodeSeqCandidates(node) {
			const data = node?.data;
			return [
				node?.anchorSeq,
				data?.seq,
				data?.finalNode?.seq,
				data?.closing?.finalNode?.seq
			].filter((seq) => typeof seq === "number");
		}

		/**
		 * Wrap one framework definition's `buildViewNode` so it returns null for
		 * rows whose anchor falls inside a recalled range. The original builder
		 * runs first — recalled rows are filtered, everything else is
		 * byte-identical to the framework's own output.
		 */
		function wrapRecalledRowDefinition(definition) {
			const original = definition.buildViewNode;
			if (typeof original !== "function" || interceptedDefinitions.has(definition)) return;
			interceptedDefinitions.set(definition, original);
			definition.buildViewNode = (context) => {
				const node = original(context);
				if (node === null) return null;
				if (nodeSeqCandidates(node).some((seq) => isRecalledAnchor(seq, RECALL_RANGES))) return null;
				return node;
			};
		}

		/**
		 * Install the wraps over every framework conversation definition. The
		 * plugin's own `recall` definition and the `user` kind (shadowed by the
		 * plugin's own renderer) are excluded; everything else — steering,
		 * context, assistant-step, command, compaction, manual-compaction,
		 * model-retry, turn-error, turn-max-tokens, turn-tail, unknown,
		 * command-input, tool-call, workflow-run, … — is intercepted so a
		 * recalled message of ANY kind disappears from the transcript.
		 */
		function installRecalledRowIntercepts(conversationEvents) {
			if (conversationEvents === void 0 || typeof conversationEvents.entries !== "function") return;
			for (const definition of conversationEvents.entries()) {
				if (definition.kind === "recall" || definition.kind === "user") continue;
				if (typeof definition.buildViewNode === "function") wrapRecalledRowDefinition(definition);
			}
		}

		/** The conversationEvents service face (captured at apply time). */
		let recallEvents = null;
		/** Disposer of this bundle's own recall definition registration. */
		let recallDisposer = null;
		/** One rebuild per new range: re-registering the definition is a low-frequency registry change the runtime answers with a conversation rebuild. */
		let recallRebuildScheduled = false;

		/**
		 * Request one conversation registry rebuild after a NEW recalled range is
		 * recorded. The assembler does not re-evaluate already-materialized rows
		 * when a tombstone lands on a live session, so the tool/turn-tail rows
		 * of a just-recalled turn would linger until the next reload; disposing
		 * and re-registering this bundle's own recall definition is a registry
		 * change that triggers the runtime's `rebuildConversationRegistry`, which
		 * re-runs every definition builder — including the wraps — over the full
		 * window and drops the stale rows immediately. Idempotent per range: the
		 * rebuilt window re-matches the same tombstone, the range is already
		 * known, and no second rebuild is scheduled.
		 */
		function scheduleRecallRebuild() {
			if (recallRebuildScheduled) return;
			recallRebuildScheduled = true;
			queueMicrotask(() => {
				recallRebuildScheduled = false;
				if (recallEvents === null || typeof recallDisposer !== "function") return;
				try {
					recallDisposer();
					recallDisposer = recallEvents.register(recallDefinition);
				} catch (error) {
					console.warn("[dsh-recall] recall definition re-registration failed:", error);
				}
			});
		}

		// ── plugin body ─────────────────────────────────────────────────────────
		/** Dictionary namespace owned by this plugin. */
		const NS = "recall";
		/** Required services. */
		const inject = ["slots", "locale", "sessions", "conversationEvents"];

		/**
		* Client plugin body: the user-message recall button (keyed Chat Node
		* seat override, key "user", priority -1) plus the recalled-message
		* notice, plus a definition-level intercept that hides EVERY framework
		* chat-node kind inside a recalled range. The intercept wraps each
		* framework definition's `buildViewNode` and returns null when the row's
		* anchor falls in a recalled range — covering user/steering/context/
		* assistant-step/command/compaction/model-retry/turn-error/turn-max-tokens/
		* turn-tail/unknown/command-input/tool-call/workflow-run, … (rc.8 forbids
		* shadowing entries from re-declaring child slots, so a renderer-level
		* filter cannot cover the slot-bearing kinds — the buildViewNode wrap is
		* the legal, exhaustive equivalent). The user override and the recall
		* definition are excluded from the wrap. The user override delegates to
		* the framework's own renderer (copy button, clock, reference chips and
		* image gallery stay framework-owned) and adds the recall control as its
		* own row under the message — it never covers the copy button, and images
		* always render through the framework's image slot.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			recallCtx = ctx;
			const slots = ctx.get("slots");
			const locale = ctx.get("locale");
			const conversationEvents = ctx.get("conversationEvents");
			if (slots === void 0 || locale === void 0 || conversationEvents === void 0) return;
			recallSlots = slots;
			if (typeof ctx.effect === "function") ctx.effect(() => locale.register(NS, {
				zh,
				en
			}), "dsh-recall: dictionaries");
			else locale.register(NS, { zh, en });
			conversationT = typeof locale.bind === "function" ? locale.bind("conversation") : null;
			recallEvents = conversationEvents;
			recallDisposer = conversationEvents.register(recallDefinition);
			installRecalledRowIntercepts(conversationEvents);
			if (typeof conversationEvents.subscribe === "function") {
				conversationEvents.subscribe(() => installRecalledRowIntercepts(conversationEvents));
			}
			slots.inject("conversation.chat.node", () => slots.register({
				name: "conversation.chat.node",
				key: "user",
				priority: -1,
				locale: NS
			}, UserRecallNodeView));
			slots.inject("conversation.chat.node", () => slots.register({
				name: "conversation.chat.node",
				key: "recall",
				locale: NS
			}, RecallNotice));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.recallDefinition = recallDefinition;
		exports.contentParts = contentParts;
		exports.projectUserText = projectUserText;
		exports.recallRequest = recallRequest;
		exports.restoreDraft = restoreDraft;
		exports.restoreDraftImages = restoreDraftImages;
		exports.recordRecalledRange = recordRecalledRange;
		exports.isRecalledAnchor = isRecalledAnchor;
		exports.wrapRecalledRowDefinition = wrapRecalledRowDefinition;
		exports.installRecalledRowIntercepts = installRecalledRowIntercepts;
		return module.exports;
	}
});
