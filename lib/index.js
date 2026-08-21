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

import { deriveEventMessage, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";
import { hasApiRemoteSubagentOwner } from "@deepseek-ai/dsh-api-remotes";

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
	const events = session.events;
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
		const message = deriveEventMessage(event);
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

/**
 * Recall one boundary and everything after it, implemented entirely on the
 * shipped session protocol (no core `Session.recall` — rc.8 has none):
 *
 *   1. The boundary must still be a LIVE surface node — a message the model
 *      currently sees. A boundary that was already recalled or shadowed by an
 *      earlier replacement is rejected.
 *   2. ONE durable tombstone event is appended: an `assistant/message` with
 *      EMPTY content whose `surfaceOp` replaces the recalled surface range
 *      (`{op:"replace", start: boundary, end}` + `sourceEventSeqs` covering
 *      every shadowed node). Empty assistant messages project to no derived
 *      message, so the model-visible history shrinks to everything before
 *      `boundary` — the recalled range leaves derived history without a
 *      single log record being deleted.
 *   3. `data.recall = {boundary, end}` marks the tombstone for the client
 *      ("recalled message" notice) and survives restarts via the regular
 *      flush path.
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
	const events = session.events;
	const target = events[boundary];
	const turn = typeof target?.data?.turn === "number" ? target.data.turn : turnOf(events, boundary);
	const step = typeof target?.data?.step === "number" ? target.data.step : void 0;
	const seq = session.seq;
	return session.append("assistant/message", {
		...turn === void 0 ? {} : { turn },
		...step === void 0 ? {} : { step },
		recall: { boundary, end },
		message: {
			id: `recall-${seq}-${boundary}`,
			role: "assistant",
			source: { kind: "model", provider: "dsh-recall", model: "recall" },
			content: []
		}
	}, {
		surfaceOp: { op: "replace", start: boundary, end },
		sourceEventSeqs: shadowed
	});
}

/** The recall plugin body: register the /recall POST route. */
function apply(ctx) {
	const { webServer, sessions, agents } = ctx;
	webServer.register({
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
			if (hasApiRemoteSubagentOwner(ctx, agent.session, agent)) {
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
}

export { apply, inject, name };
