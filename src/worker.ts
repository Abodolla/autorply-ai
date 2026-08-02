import app from "./index";
import { ensureDatabase } from "./database";
import { Env } from "./types";

const APP_PREFIX = "/autorply-ai";
const GATEWAY_ID = "autorply-ai";
const MODEL_ID = "gpt-5.6-luna";
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";
const ACCOUNT_ERROR =
	"❌ تعذر الوصول إلى حساب واتساب المرتبط.\nتأكد أنك مسجل الدخول إلى منصة Autorply من نفس المتصفح، ثم أعد المحاولة.";

type RuntimeEnv = Env & {
	AI_GATEWAY_TOKEN?: string;
};

export default {
	async fetch(
		request: Request,
		env: RuntimeEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const pathname = normalizePath(url.pathname);
		const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
		const isSessionCheck = pathname === "/api/session-check";

		if (isApiRequest && !isSessionCheck) {
			try {
				await ensureDatabase(env);
			} catch (error) {
				console.error("D1 initialization error:", error);
				return jsonError(
					error instanceof Error
						? error.message
						: "تعذر تهيئة قاعدة بيانات المحادثات",
					500,
				);
			}
		}

		if (pathname === "/api/chat" && request.method === "POST") {
			return handleOpenAIChat(request, env, ctx);
		}

		if (pathname === "/api/tools/sync-templates" && request.method === "POST") {
			return handleSyncTemplates(request);
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

async function handleSyncTemplates(request: Request): Promise<Response> {
	try {
		const cookie = request.headers.get("Cookie")?.trim() || "";
		if (!cookie) throw new Error(ACCOUNT_ERROR);

		const origin = new URL(request.url).origin;
		const userAgent = request.headers.get("User-Agent") || "Autorply-AI-Worker";
		const connectResponse = await fetch(
			new URL("/whatsapp/bot/connect", origin).toString(),
			{
				method: "GET",
				headers: { Accept: "text/html", Cookie: cookie, "User-Agent": userAgent },
				redirect: "manual",
			},
		);

		const contentType = connectResponse.headers.get("content-type") || "";
		if (!connectResponse.ok || !contentType.toLowerCase().includes("text/html")) {
			throw new Error(ACCOUNT_ERROR);
		}

		const html = await connectResponse.text();
		const csrfToken = extractCsrfToken(html);
		const whatsappBotId =
			extractElementValue(html, "bm_mobile_bot") ||
			extractElementValue(html, "bm_selected_whatsapp_bot_id") ||
			extractElementValue(html, "bot_id");

		if (!csrfToken) throw new Error("تعذر استخراج CSRF من جلسة Autorply الحالية.");
		if (!whatsappBotId || !/^\d+$/.test(whatsappBotId)) {
			throw new Error("تعذر استخراج رقم بوت واتساب من جلسة Autorply الحالية.");
		}

		const sharedHeaders = {
			Accept: "application/json",
			Cookie: cookie,
			"User-Agent": userAgent,
			"X-Requested-With": "XMLHttpRequest",
			"X-CSRF-TOKEN": csrfToken,
		};
		const statusUrl = new URL(
			"/whatsapp/bot/manager/template/status",
			origin,
		);
		statusUrl.searchParams.set("whatsapp_bot_id", whatsappBotId);
		const statusResponse = await fetch(statusUrl.toString(), {
			method: "GET",
			headers: sharedHeaders,
			redirect: "manual",
		});
		const statusText = await statusResponse.text();
		const statusResult = parseJsonObject(statusText);

		if (!statusResponse.ok || isPlatformFailure(statusResult)) {
			throw new Error(
				getPlatformMessage(statusResult) || `فشل التنفيذ برمز ${statusResponse.status}`,
			);
		}

		const listResponse = await fetch(
			new URL("/whatsapp/bot/manager/template/list", origin).toString(),
			{
				method: "POST",
				headers: {
					...sharedHeaders,
					"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
				},
				body: new URLSearchParams({ whatsapp_bot_id: whatsappBotId }),
				redirect: "manual",
			},
		);

		const responseText = await listResponse.text();
		const result = parseJsonObject(responseText);
		if (!listResponse.ok || isPlatformFailure(result)) {
			throw new Error(getPlatformMessage(result) || `فشل التنفيذ برمز ${listResponse.status}`);
		}

		return new Response(
			JSON.stringify({ success: true, message: "تمت مزامنة القوالب بنجاح." }),
			{
				status: 200,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	} catch (error) {
		console.error("Template sync error:", error);
		const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
		return jsonError(message, message === ACCOUNT_ERROR ? 401 : 502);
	}
}

function getAttribute(tag: string, name: string): string | null {
	const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
	return match?.[2]?.trim() || null;
}

function extractCsrfToken(html: string): string | null {
	const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
	for (const tag of metaTags) {
		if (getAttribute(tag, "name")?.toLowerCase() === "csrf-token") {
			const content = getAttribute(tag, "content");
			if (content) return content;
		}
	}

	const inputTags = html.match(/<input\b[^>]*>/gi) || [];
	for (const tag of inputTags) {
		if (getAttribute(tag, "name") === "_token") {
			const value = getAttribute(tag, "value");
			if (value) return value;
		}
	}
	return null;
}

function extractElementValue(html: string, elementId: string): string | null {
	const tags = html.match(/<(?:select|input)\b[^>]*>/gi) || [];
	const tag = tags.find((candidate) => getAttribute(candidate, "id") === elementId);
	if (!tag) return null;

	const directValue = getAttribute(tag, "value");
	if (directValue) return directValue;

	if (tag?.toLowerCase().startsWith("<select")) {
		const start = html.indexOf(tag);
		const end = html.indexOf("</select>", start);
		const selectHtml = end === -1 ? "" : html.slice(start, end + 9);
		const options = selectHtml.match(/<option\b[^>]*>/gi) || [];
		const selectedOption = options.find((option) => /(?:^|\s)selected(?:\s|=|>)/i.test(option));
		const firstValuedOption = options.find((option) => Boolean(getAttribute(option, "value")));
		return getAttribute(selectedOption || firstValuedOption || "", "value");
	}

	return null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function getPlatformMessage(result: Record<string, unknown> | null): string | null {
	if (!result) return null;
	for (const key of ["message", "error", "msg"]) {
		if (typeof result[key] === "string" && result[key].trim()) return result[key].trim();
	}
	return null;
}

function isPlatformFailure(result: Record<string, unknown> | null): boolean {
	if (!result) return false;
	return result.success === false || result.status === false || result.status === "0";
}

async function handleOpenAIChat(
	request: Request,
	env: RuntimeEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		if (!env.AI_GATEWAY_TOKEN) {
			return jsonError("AI Gateway Token غير مضاف إلى إعدادات Worker", 500);
		}

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

		const input = (history.results || []).reverse().map((item) => ({
			role: item.role,
			content: item.content,
		}));

		const gatewayUrl = await env.AI.gateway(GATEWAY_ID).getUrl("openai");
		const startedAt = Date.now();
		const upstream = await fetch(`${gatewayUrl}/responses`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
				"cf-aig-collect-log-payload": "false",
			},
			body: JSON.stringify({
				model: MODEL_ID,
				instructions: SYSTEM_PROMPT,
				input,
				max_output_tokens: 1024,
				stream: true,
			}),
		});

		if (!upstream.ok || !upstream.body) {
			const details = await upstream.text();
			console.error("OpenAI Gateway error:", upstream.status, details);
			return jsonError(`فشل تشغيل نموذج Luna (${upstream.status})`, 502);
		}

		const transformed = transformOpenAIStream(upstream.body);
		const [clientStream, storageStream] = transformed.tee();
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
		console.error("OpenAI chat error:", error);
		const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
		return jsonError(message, message === ACCOUNT_ERROR ? 401 : 500);
	}
}

function transformOpenAIStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = source.getReader();
			let buffer = "";

			try {
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
							const event = JSON.parse(data) as {
								type?: string;
								delta?: string;
							};
							if (event.type === "response.output_text.delta" && event.delta) {
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify({ response: event.delta })}\n\n`),
								);
							}
						} catch {
							// Ignore non-JSON keepalive events.
						}
					}

					if (done) break;
				}

				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
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
				const parsed = JSON.parse(data) as { response?: string };
				if (parsed.response) responseText += parsed.response;
			} catch {
				// Ignore malformed fragments.
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
