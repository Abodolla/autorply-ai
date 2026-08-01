/**
 * Autorply AI
 */

import {
	AccountRecord,
	ChatMessage,
	ConversationRecord,
	Env,
	MessageRecord,
} from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";
const APP_PREFIX = "/autorply-ai";
const MAX_CONVERSATIONS = 20;
const ACCOUNT_ERROR =
	"❌ تعذر الوصول إلى حساب واتساب المرتبط.\nتأكد أنك مسجل الدخول إلى منصة Autorply من نفس المتصفح، ثم أعد المحاولة.";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const originalUrl = new URL(request.url);
		let pathname = originalUrl.pathname;

		if (pathname === APP_PREFIX) {
			pathname = "/";
		} else if (pathname.startsWith(`${APP_PREFIX}/`)) {
			pathname = pathname.slice(APP_PREFIX.length) || "/";
		}

		if (pathname.startsWith("/api/")) {
			return handleApiRequest(request, pathname, env, ctx);
		}

		const assetUrl = new URL(request.url);
		assetUrl.pathname = pathname;
		return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
	},
} satisfies ExportedHandler<Env>;

async function handleApiRequest(
	request: Request,
	pathname: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		const account = await getAuthenticatedAccount(request, env);

		if (pathname === "/api/conversations") {
			if (request.method === "GET") {
				return listConversations(account.id, env);
			}

			if (request.method === "POST") {
				return createConversation(account.id, env);
			}
		}

		const messagesMatch = pathname.match(
			/^\/api\/conversations\/(\d+)\/messages$/,
		);

		if (messagesMatch) {
			const conversationId = Number(messagesMatch[1]);

			if (request.method === "GET") {
				return getConversationMessages(
					conversationId,
					account.id,
					env,
				);
			}

			if (request.method === "POST") {
				return appendConversationMessage(
					request,
					conversationId,
					account.id,
					env,
				);
			}
		}

		const conversationMatch = pathname.match(
			/^\/api\/conversations\/(\d+)$/,
		);

		if (conversationMatch && request.method === "DELETE") {
			return deleteConversation(
				Number(conversationMatch[1]),
				account.id,
				env,
			);
		}

		if (pathname === "/api/chat" && request.method === "POST") {
			return handleChatRequest(request, account.id, env, ctx);
		}

		return json({ error: "Not found" }, 404);
	} catch (error) {
		console.error("API error:", error);
		const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
		const status = message === ACCOUNT_ERROR ? 401 : 500;
		return json({ error: message }, status);
	}
}

async function getAuthenticatedAccount(
	request: Request,
	env: Env,
): Promise<AccountRecord> {
	const cookie = request.headers.get("Cookie") || "";
	const connectUrl = new URL("/whatsapp/bot/connect", request.url);
	const response = await fetch(connectUrl.toString(), {
		headers: {
			Accept: "text/html",
			Cookie: cookie,
		},
		redirect: "manual",
	});

	if (!response.ok) {
		throw new Error(ACCOUNT_ERROR);
	}

	const html = await response.text();
	const accountId = extractAccountId(html);

	if (!accountId) {
		throw new Error(ACCOUNT_ERROR);
	}

	let account = await env.DB.prepare(
		"SELECT id, account_id, name FROM accounts WHERE account_id = ? LIMIT 1",
	)
		.bind(accountId)
		.first<AccountRecord>();

	if (!account) {
		await env.DB.prepare(
			"INSERT INTO accounts (account_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
		)
			.bind(accountId, `WhatsApp ${accountId}`)
			.run();

		account = await env.DB.prepare(
			"SELECT id, account_id, name FROM accounts WHERE account_id = ? LIMIT 1",
		)
			.bind(accountId)
			.first<AccountRecord>();
	}

	if (!account) {
		throw new Error(ACCOUNT_ERROR);
	}

	return account;
}

function extractAccountId(html: string): string | null {
	const tags = html.match(/<[^>]*class=["'][^"']*revalidate-token[^"']*["'][^>]*>/gi) || [];

	for (const tag of tags) {
		const match = tag.match(/data-id=["']([^"']+)["']/i);
		if (match?.[1]) return match[1];
	}

	return null;
}

async function listConversations(accountId: number, env: Env): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id, account_id, title, pinned, archived, created_at, updated_at
		 FROM conversations
		 WHERE account_id = ? AND archived = 0
		 ORDER BY pinned DESC, updated_at DESC
		 LIMIT ?`,
	)
		.bind(accountId, MAX_CONVERSATIONS)
		.all<ConversationRecord>();

	return json({ conversations: result.results || [], limit: MAX_CONVERSATIONS });
}

async function createConversation(accountId: number, env: Env): Promise<Response> {
	const countRow = await env.DB.prepare(
		"SELECT COUNT(*) AS total FROM conversations WHERE account_id = ? AND archived = 0",
	)
		.bind(accountId)
		.first<{ total: number }>();

	if ((countRow?.total || 0) >= MAX_CONVERSATIONS) {
		return json(
			{
				error:
					"وصلت للحد الأقصى من المحادثات المحفوظة. احذف محادثة قديمة لإنشاء محادثة جديدة.",
			},
			409,
		);
	}

	const result = await env.DB.prepare(
		`INSERT INTO conversations
		 (account_id, title, pinned, archived, created_at, updated_at)
		 VALUES (?, 'محادثة جديدة', 0, 0, datetime('now'), datetime('now'))`,
	)
		.bind(accountId)
		.run();

	return json(
		{
			conversation: {
				id: Number(result.meta.last_row_id),
				title: "محادثة جديدة",
			},
		},
		201,
	);
}

async function getOwnedConversation(
	conversationId: number,
	accountId: number,
	env: Env,
): Promise<ConversationRecord | null> {
	return env.DB.prepare(
		`SELECT id, account_id, title, pinned, archived, created_at, updated_at
		 FROM conversations
		 WHERE id = ? AND account_id = ? AND archived = 0
		 LIMIT 1`,
	)
		.bind(conversationId, accountId)
		.first<ConversationRecord>();
}

async function getConversationMessages(
	conversationId: number,
	accountId: number,
	env: Env,
): Promise<Response> {
	const conversation = await getOwnedConversation(conversationId, accountId, env);
	if (!conversation) return json({ error: "المحادثة غير موجودة" }, 404);

	const result = await env.DB.prepare(
		`SELECT id, conversation_id, role, content, model, created_at
		 FROM messages
		 WHERE conversation_id = ?
		 ORDER BY id ASC`,
	)
		.bind(conversationId)
		.all<MessageRecord>();

	return json({ conversation, messages: result.results || [] });
}

async function appendConversationMessage(
	request: Request,
	conversationId: number,
	accountId: number,
	env: Env,
): Promise<Response> {
	const conversation = await getOwnedConversation(conversationId, accountId, env);
	if (!conversation) return json({ error: "المحادثة غير موجودة" }, 404);

	const body = (await request.json()) as { role?: string; content?: string };
	const role = body.role === "assistant" ? "assistant" : body.role === "user" ? "user" : null;
	const content = body.content?.trim();

	if (!role || !content) return json({ error: "بيانات الرسالة غير صالحة" }, 400);

	await saveMessage(conversationId, role, content, env);
	await updateConversationAfterMessage(conversationId, role, content, env);
	return json({ success: true }, 201);
}

async function deleteConversation(
	conversationId: number,
	accountId: number,
	env: Env,
): Promise<Response> {
	const conversation = await getOwnedConversation(conversationId, accountId, env);
	if (!conversation) return json({ error: "المحادثة غير موجودة" }, 404);

	await env.DB.batch([
		env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversationId),
		env.DB.prepare("DELETE FROM conversations WHERE id = ? AND account_id = ?").bind(
			conversationId,
			accountId,
		),
	]);

	return json({ success: true });
}

async function handleChatRequest(
	request: Request,
	accountId: number,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const body = (await request.json()) as {
		conversationId?: number;
		message?: string;
	};
	const conversationId = Number(body.conversationId);
	const message = body.message?.trim();

	if (!conversationId || !message) {
		return json({ error: "المحادثة أو الرسالة غير صالحة" }, 400);
	}

	const conversation = await getOwnedConversation(conversationId, accountId, env);
	if (!conversation) return json({ error: "المحادثة غير موجودة" }, 404);

	await saveMessage(conversationId, "user", message, env);
	await updateConversationAfterMessage(conversationId, "user", message, env);

	const history = await env.DB.prepare(
		`SELECT role, content
		 FROM messages
		 WHERE conversation_id = ?
		 ORDER BY id DESC
		 LIMIT 40`,
	)
		.bind(conversationId)
		.all<ChatMessage>();

	const messages: ChatMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		...(history.results || []).reverse(),
	];

	const startedAt = Date.now();
	const stream = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
		messages,
		max_tokens: 1024,
		stream: true,
	} satisfies AiTextGenerationInput & { stream: true });

	const [clientStream, storageStream] = stream.tee();
	ctx.waitUntil(
		storeAssistantStream(storageStream, conversationId, startedAt, env),
	);

	return new Response(clientStream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

async function storeAssistantStream(
	stream: ReadableStream,
	conversationId: number,
	startedAt: number,
	env: Env,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseText = "";

	while (true) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: !done });

		const parsed = consumeSseEvents(done ? `${buffer}\n\n` : buffer);
		buffer = parsed.buffer;

		for (const data of parsed.events) {
			if (data === "[DONE]") continue;
			try {
				const jsonData = JSON.parse(data) as {
					response?: string;
					choices?: Array<{ delta?: { content?: string } }>;
				};
				responseText +=
					typeof jsonData.response === "string"
						? jsonData.response
						: jsonData.choices?.[0]?.delta?.content || "";
			} catch {
				// Ignore malformed stream fragments.
			}
		}

		if (done) break;
	}

	if (!responseText.trim()) return;

	await env.DB.prepare(
		`INSERT INTO messages
		 (conversation_id, role, content, model, latency_ms, created_at)
		 VALUES (?, 'assistant', ?, ?, ?, datetime('now'))`,
	)
		.bind(conversationId, responseText, MODEL_ID, Date.now() - startedAt)
		.run();

	await env.DB.prepare(
		"UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
	)
		.bind(conversationId)
		.run();
}

async function saveMessage(
	conversationId: number,
	role: "user" | "assistant",
	content: string,
	env: Env,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO messages (conversation_id, role, content, created_at)
		 VALUES (?, ?, ?, datetime('now'))`,
	)
		.bind(conversationId, role, content)
		.run();
}

async function updateConversationAfterMessage(
	conversationId: number,
	role: "user" | "assistant",
	content: string,
	env: Env,
): Promise<void> {
	if (role === "user") {
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND role = 'user'",
		)
			.bind(conversationId)
			.first<{ total: number }>();

		if ((count?.total || 0) === 1) {
			await env.DB.prepare(
				"UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
			)
				.bind(makeConversationTitle(content), conversationId)
				.run();
			return;
		}
	}

	await env.DB.prepare(
		"UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
	)
		.bind(conversationId)
		.run();
}

function makeConversationTitle(content: string): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
}

function consumeSseEvents(buffer: string): { events: string[]; buffer: string } {
	let normalized = buffer.replace(/\r/g, "");
	const events: string[] = [];
	let eventEndIndex: number;

	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);
		const dataLines = rawEvent
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trimStart());

		if (dataLines.length) events.push(dataLines.join("\n"));
	}

	return { events, buffer: normalized };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
