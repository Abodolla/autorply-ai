import app from "./worker";
import { ensureDatabase } from "./database";
import { Env } from "./types";

const APP_PREFIX = "/autorply-ai";
const MODEL_ID = "ai-search-default";
const ACCOUNT_ERROR =
	"❌ تعذر الوصول إلى حساب واتساب المرتبط.\nتأكد أنك مسجل الدخول إلى منصة Autorply من نفس المتصفح، ثم أعد المحاولة.";
const SYSTEM_PROMPT = `أنت مساعد Autorply الرسمي.
أجب باللغة العربية بوضوح واختصار، واعتمد على المعرفة المفهرسة في مركز مساعدة Autorply.
لا تخترع معلومات غير موجودة في المعرفة. إذا لم تجد إجابة مؤكدة، قل بوضوح إن المعلومة غير متوفرة في مركز المساعدة الحالي.`;

type ChatRole = "system" | "user" | "assistant";
type RuntimeEnv = Env & {
	AUTORPLY_KNOWLEDGE: {
		chatCompletions(input: {
			messages: Array<{ role: ChatRole; content: string }>;
			stream: true;
			ai_search_options?: {
				retrieval?: {
					retrieval_type?: "vector" | "keyword" | "hybrid";
					max_num_results?: number;
					context_expansion?: number;
				};
				query_rewrite?: { enabled: boolean };
				reranking?: {
					enabled: boolean;
					model?: "@cf/baai/bge-reranker-base";
				};
			};
		}): Promise<ReadableStream<Uint8Array>>;
	};
};

export default {
	async fetch(
		request: Request,
		env: RuntimeEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const pathname = normalizePath(new URL(request.url).pathname);

		if (pathname === "/api/chat" && request.method === "POST") {
			return handleKnowledgeChat(request, env, ctx);
		}

		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<RuntimeEnv>;

function normalizePath(pathname: string): string {
	if (pathname === APP_PREFIX) return "/";
	if (pathname.startsWith(`${APP_PREFIX}/`)) {
		return pathname.slice(APP_PREFIX.length) || "/";
	}
	return pathname;
}

async function handleKnowledgeChat(
	request: Request,
	env: RuntimeEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		await ensureDatabase(env);
		const accountDbId = await getAuthenticatedAccountDbId(request, env);
		const body = (await request.json()) as {
			conversationId?: number;
			message?: string;
		};
		const conversationId = Number(body.conversationId);
		const message = body.message?.trim();

		if (!conversationId || !message) {
			return jsonError("المحادثة أو الرسالة غير صالحة", 400);
		}

		const conversation = await env.DB.prepare(
			`SELECT id FROM conversations
			 WHERE id = ? AND account_id = ? AND archived = 0
			 LIMIT 1`,
		)
			.bind(conversationId, accountDbId)
			.first<{ id: number }>();

		if (!conversation) return jsonError("المحادثة غير موجودة", 404);

		await env.DB.prepare(
			`INSERT INTO messages (conversation_id, role, content, created_at)
			 VALUES (?, 'user', ?, datetime('now'))`,
		)
			.bind(conversationId, message)
			.run();

		await updateConversationTitle(conversationId, message, env);

		const history = await env.DB.prepare(
			`SELECT role, content FROM messages
			 WHERE conversation_id = ?
			 ORDER BY id DESC LIMIT 40`,
		)
			.bind(conversationId)
			.all<{ role: "user" | "assistant"; content: string }>();

		const messages: Array<{ role: ChatRole; content: string }> = [
			{ role: "system", content: SYSTEM_PROMPT },
			...(history.results || []).reverse(),
		];

		const startedAt = Date.now();
		const stream = await env.AUTORPLY_KNOWLEDGE.chatCompletions({
			messages,
			stream: true,
			ai_search_options: {
				retrieval: {
					retrieval_type: "hybrid",
					max_num_results: 6,
					context_expansion: 1,
				},
				query_rewrite: { enabled: true },
				reranking: {
					enabled: true,
					model: "@cf/baai/bge-reranker-base",
				},
			},
		});

		const [clientStream, storageStream] = stream.tee();
		ctx.waitUntil(
			storeAssistantResponse(storageStream, conversationId, startedAt, env),
		);

		return new Response(clientStream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("AI Search chat error:", error);
		const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
		return jsonError(message, message === ACCOUNT_ERROR ? 401 : 500);
	}
}

async function storeAssistantResponse(
	stream: ReadableStream<Uint8Array>,
	conversationId: number,
	startedAt: number,
	env: RuntimeEnv,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseText = "";

	while (true) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: !done });

		let boundary: number;
		while ((boundary = buffer.indexOf("\n\n")) !== -1) {
			const rawEvent = buffer.slice(0, boundary).replace(/\r/g, "");
			buffer = buffer.slice(boundary + 2);
			const data = rawEvent
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");

			if (!data || data === "[DONE]") continue;
			try {
				const parsed = JSON.parse(data) as {
					choices?: Array<{ delta?: { content?: string } }>;
				};
				responseText += parsed.choices?.[0]?.delta?.content || "";
			} catch {
				// The first AI Search event contains source chunks, not generated text.
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

async function getAuthenticatedAccountDbId(
	request: Request,
	env: RuntimeEnv,
): Promise<number> {
	const cookie = request.headers.get("Cookie")?.trim() || "";
	if (!cookie) throw new Error(ACCOUNT_ERROR);

	const origin = new URL(request.url).origin;
	const response = await fetch(new URL("/whatsapp/bot/connect", origin).toString(), {
		method: "GET",
		headers: {
			Accept: "text/html",
			Cookie: cookie,
			"User-Agent": request.headers.get("User-Agent") || "Autorply-AI-Worker",
		},
		redirect: "manual",
	});

	if (!response.ok) throw new Error(ACCOUNT_ERROR);
	const html = await response.text();
	const tag = html.match(/<[^>]*class=["'][^"']*revalidate-token[^"']*["'][^>]*>/i)?.[0];
	const accountId = tag?.match(/data-id=["']([^"']+)["']/i)?.[1];
	if (!accountId) throw new Error(ACCOUNT_ERROR);

	let account = await env.DB.prepare(
		"SELECT id FROM accounts WHERE account_id = ? LIMIT 1",
	)
		.bind(accountId)
		.first<{ id: number }>();

	if (!account) {
		await env.DB.prepare(
			"INSERT INTO accounts (account_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
		)
			.bind(accountId, `WhatsApp ${accountId}`)
			.run();
		account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE account_id = ? LIMIT 1",
		)
			.bind(accountId)
			.first<{ id: number }>();
	}

	if (!account) throw new Error(ACCOUNT_ERROR);
	return account.id;
}

async function updateConversationTitle(
	conversationId: number,
	content: string,
	env: RuntimeEnv,
): Promise<void> {
	const count = await env.DB.prepare(
		"SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND role = 'user'",
	)
		.bind(conversationId)
		.first<{ total: number }>();

	const title = content.replace(/\s+/g, " ").trim();
	if ((count?.total || 0) === 1) {
		await env.DB.prepare(
			"UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
		)
			.bind(title.length > 42 ? `${title.slice(0, 42)}…` : title, conversationId)
			.run();
		return;
	}

	await env.DB.prepare(
		"UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
	)
		.bind(conversationId)
		.run();
}

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}
