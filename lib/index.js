/**
 * dsh-recall — Host half.
 *
 * Message recall (撤回) for the DSH Web UI. Serves one same-origin HTTP route:
 *
 *   POST /recall   { sessionId, messageId }  → recall one message by its
 *                                              durable id (user or assistant)
 *                  { sessionId, boundary }   → recall the event at `boundary`
 *                                              (seq of a user/assistant message)
 *
 * Semantics: the recalled message AND everything after it up to the recall
 * operation are removed from the model-visible history — without any core
 * `Session.recall` API (rc.8 has none) and without ever deleting a log record.
 * The plugin appends ONE durable tombstone through the shipped session
 * protocol: an `assistant/message` with EMPTY content whose `surfaceOp`
 * REPLACES the recalled surface range (`{op:"replace", start: boundary, end}`
 * plus `sourceEventSeqs` covering every shadowed node). Empty-content
 * assistant messages project to no derived message, so `deriveMessages()`
 * shrinks to everything before `boundary`: the model never sees the recalled
 * range again, and the tombstone itself stays in the append-only log as the
 * durable, restart-safe record of the recall (the regular flush path
 * persists it; `data.recall = {boundary, end}` marks it for the client).
 *
 * NO filesystem state is ever reverted: code changes produced by the recalled
 * turn stay in place by design.
 *
 * Refusals (with explicit error codes):
 *   - the session is not attached (live agent missing)     → session-not-found
 *   - the session is owned by subagent routing              → subagent-owned
 *   - the agent is currently running a turn                → agent-busy
 *   - no recallable message matches the request            → message-not-found
 *   - the boundary is not a live surface node anymore
 *     (already recalled, shadowed, non-message boundary, …) → recall-rejected
 *
 * Trust boundary: same as the filetree/scm plugins — any same-origin browser
 * client can recall messages in live sessions.
 */

/**
 * The surface-eligible event types, mirrored from the shipped session protocol
 * (`@deepseek-ai/dsh-session/surface`).
 *
 * Inlined on purpose. The launcher would resolve a bare
 * `@deepseek-ai/dsh-session` import for a profile-installed plugin, but taking
 * that import would couple the plugin to one framework line (and to whatever
 * version the profile happens to resolve), for a check that is two property
 * reads on an event the host already handed us. The plugin therefore carries
 * no framework imports at all: `session.surface` / `session.log` /
 * `session.append` are the whole host contract it needs.
 */
const SURFACE_EVENT_TYPES = new Set([
	"system/message",
	"developer/message",
	"user/message",
	"assistant/message",
	"tool/result"
]);

/**
 * Whether an event appended to the surface tail (never itself a replacement
 * copy). Mirrors the framework's `isAppendSurfaceEvent` without importing it.
 */
function isAppendSurfaceEvent(event) {
	return SURFACE_EVENT_TYPES.has(event.type) && event.surfaceOp === "append";
}

/**
 * Project one event into the message it derives to (null when it produces
 * none). Prefers the LIVE surface manager, which applies this session's
 * message projections; falls back to the shipped projection rules for the
 * message-producing types a recall boundary can address.
 */
function deriveMessageOf(session, event) {
	const surface = session.surface;
	if (surface !== void 0 && typeof surface.deriveEventMessage === "function") {
		return surface.deriveEventMessage(event);
	}
	if (event.type === "user/message") return event.data;
	if (event.type === "assistant/message") {
		return event.data.message.content.length === 0 ? null : event.data.message;
	}
	return null;
}

/**
 * Whether the session identity belongs to subagent routing (never recallable).
 * Inlined here: the check moved from `@deepseek-ai/dsh-api-remotes` (removed in
 * 0.1.2-alpha.1) to `@deepseek-ai/dsh-api-session-controller`
 * (`hasApiSessionSubagentOwner`), and it only touches stable host services
 * (`session.header`, `ctx.agents.get/isOwnedBy`), so the plugin carries its own
 * copy instead of binding to a framework-internal export.
 */
function hasSubagentOwner(ctx, session, agent) {
	if (session.header.origin === "subagent") return true;
	const parentId = session.header.parentSession;
	if (parentId === void 0 || agent === void 0) return false;
	const parent = ctx.agents.get(parentId);
	return parent !== void 0 && ctx.agents.isOwnedBy(agent.id, parent);
}

const name = "recall";

/** Services required by the recall host half. */
const inject = ["webServer", "sessions", "agents"];

/** Write a JSON response with no-store caching. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

/** Build one structured failure branch. */
function errorBody(code, message, details) {
	return {
		ok: false,
		error: {
			code,
			message,
			...details === void 0 ? {} : { details }
		}
	};
}

/** Read a bounded JSON request body. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * Resolve the recall boundary from the request: either an explicit event seq
 * (must address a user/assistant message event) or the first append-origin
 * user/assistant message whose durable id matches. Returns null when no
 * recallable message matches.
 */
function resolveBoundary(session, payload) {
	const events = session.log;
	if (typeof payload.boundary === "number" && Number.isSafeInteger(payload.boundary)) {
		const boundary = payload.boundary;
		if (boundary < 0 || boundary >= events.length) return null;
		const target = events[boundary];
		if (target.type !== "user/message" && target.type !== "assistant/message") return null;
		if (!isAppendSurfaceEvent(target)) return null;
		return boundary;
	}
	const messageId = payload.messageId;
	if (typeof messageId !== "string" || messageId === "") return null;
	for (const event of events) {
		if (!isAppendSurfaceEvent(event)) continue;
		const message = deriveMessageOf(session, event);
		if (message !== null && message.id === messageId) return event.seq;
	}
	return null;
}

/** Walk back from `seq` to the enclosing `turn/start` (when one exists). */
function turnOf(events, seq) {
	for (let index = seq; index >= 0; index--) {
		const event = events[index];
		if (event?.type === "turn/start") return event.data.turn;
	}
	return void 0;
}

/** A positive integer, or undefined — the only shape the durable format accepts. */
function positiveInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}

/**
 * Recall one boundary and everything after it, implemented entirely on the
 * shipped session protocol (no core `Session.recall` — there is none):
 *
 *   1. The boundary must still be a LIVE surface node — a message the model
 *      currently sees. A boundary that was already recalled or shadowed by an
 *      earlier replacement is rejected.
 *   2. ONE durable tombstone event is appended: a `system/message` with EMPTY
 *      content whose `surfaceOp` replaces the recalled surface range. Empty
 *      system/developer/assistant messages project to no derived message
 *      (`deriveEventMessage` returns null for them), so the model-visible
 *      history shrinks to everything before `boundary` — the recalled range
 *      leaves derived history without a single log record being deleted.
 *
 *      0.2.0-rc.2 pins the exact shape this tombstone must take:
 *        - the replace op is positional and now spells its bounds
 *          `startSeq`/`endSeq`; `{op:"replace", start, end}` is rejected as an
 *          "invalid replace surfaceOp";
 *        - every shadowed surface node must be listed in `sourceEventSeqs`;
 *        - `assistant/message` may NOT carry `sourceEventSeqs` at all ("embeds
 *          its source stream and cannot carry sourceEventSeqs"), so the old
 *          empty-assistant tombstone is no longer expressible at all — a
 *          `system/message` is the message-producing type that both projects
 *          to nothing when empty and may cite its sources.
 *   3. `data.recall = {boundary, end}` marks the tombstone for the client
 *      ("recalled message" notice) and survives restarts via the regular
 *      flush path.
 *
 * The tombstone deliberately carries no `turn`/`step`: it is appended between
 * turns (the route refuses to run while the agent is busy), so naming the
 * already-closed turn of the recalled message would misreport the log's
 * structure. Its empty `source: {kind:"system-prompt"}` mirrors the shipped
 * `createSystemMessage("")` — the framework's own representation of "no
 * system prompt", the one system-message shape that derives to no message.
 *
 * @param session - the live session whose surface receives the recall.
 * @param boundary - seq of the first message to recall (user or assistant).
 * @returns the logged tombstone event.
 * @throws Error with a recall-rejected reason when the boundary is not a
 *   live surface node (already recalled or shadowed).
 */
function appendRecall(session, boundary) {
	const nodes = session.surface.nodes;
	const startIdx = nodes.indexOf(boundary);
	if (startIdx === -1) {
		throw new Error(`message at seq ${boundary} is no longer part of the conversation (already recalled or shadowed)`);
	}
	const shadowed = nodes.slice(startIdx);
	const end = shadowed[shadowed.length - 1];
	const events = session.log;
	const target = events[boundary];
	// The durable v4 format requires POSITIVE integers on every system/message
	// (`assertV4SystemMessageFields`), so the tombstone reuses the recalled
	// message's own turn/step coordinates, falling back to its enclosing turn
	// and that turn's first step. The tombstone has no step semantics of its
	// own — it carries no tool calls — but the row must still be admissible.
	const turn = positiveInteger(target?.data?.turn) ?? turnOf(events, boundary) ?? 1;
	const step = positiveInteger(target?.data?.step) ?? 1;
	const seq = session.seq;
	return session.append("system/message", {
		turn,
		step,
		recall: { boundary, end },
		message: {
			id: `recall-${seq}-${boundary}`,
			role: "system",
			source: { kind: "system-prompt" },
			content: []
		}
	}, {
		surfaceOp: { op: "replace", startSeq: boundary, endSeq: end },
		sourceEventSeqs: shadowed
	});
}

/** The recall plugin body: register the /recall POST route. */
function apply(ctx) {
	const { webServer, sessions, agents } = ctx;
	const registered = webServer.register({
		kind: "prefix",
		path: "/recall",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			let payload;
			try {
				payload = JSON.parse(await readBody(req) || "{}");
			} catch {
				sendJson(res, 400, errorBody("BAD_REQUEST", "request body must be JSON"));
				return;
			}
			const sessionId = typeof payload?.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : null;
			if (sessionId === null) {
				sendJson(res, 400, errorBody("BAD_REQUEST", "missing sessionId"));
				return;
			}
			const agent = agents.get(sessionId);
			if (agent === void 0) {
				sendJson(res, 404, errorBody("session-not-found", `session "${sessionId}" not found (not attached)`));
				return;
			}
			if (hasSubagentOwner(ctx, agent.session, agent)) {
				sendJson(res, 403, errorBody("subagent-owned", "session is owned by subagent routing"));
				return;
			}
			if (agent.status === "running") {
				sendJson(res, 409, errorBody("agent-busy", `session "${sessionId}" is running; stop the current turn before recalling a message`, { sessionId }));
				return;
			}
			const boundary = resolveBoundary(agent.session, payload);
			if (boundary === null) {
				sendJson(res, 404, errorBody("message-not-found", `session "${sessionId}" has no recallable message matching the request`, { sessionId }));
				return;
			}
			try {
				const logged = appendRecall(agent.session, boundary);
				await sessions.flush(agent.session);
				sendJson(res, 200, { ok: true, value: { boundary, seq: logged.seq } });
			} catch (error) {
				sendJson(res, 422, errorBody("recall-rejected", error instanceof Error ? error.message : String(error), { sessionId, boundary }));
			}
		}
	});
	// Register the route through the plugin's effect scope so unloading or
	// hot-reloading the bundle removes it, instead of leaving a stale handler
	// (and a duplicate-path refusal) behind.
	if (typeof ctx.effect === "function") ctx.effect(() => registered, "dsh-recall: /recall route");
}

export { apply, inject, name };
