/**
 * Autorply AI
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

const APP_PREFIX = "/autorply-ai";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const originalUrl = new URL(request.url);

		// إزالة بادئة /autorply-ai داخليًا
		let pathname = originalUrl.pathname;

		if (pathname === APP_PREFIX) {
			pathname = "/";
		} else if (pathname.startsWith(`${APP_PREFIX}/`)) {
			pathname = pathname.slice(APP_PREFIX.length) || "/";
		}

		// API
		if (pathname === "/api/chat") {
			if (request.method !== "POST") {
				return new Response("Method not allowed", { status: 405 });
			}

			return handleChatRequest(request, env);
		}

		// الملفات والواجهة
		const assetUrl = new URL(request.url);
		assetUrl.pathname = pathname;

		const assetRequest = new Request(assetUrl.toString(), request);

		return env.ASSETS.fetch(assetRequest);
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		if (!messages.some((message) => message.role === "system")) {
			messages.unshift({
				role: "system",
				content: SYSTEM_PROMPT,
			});
		}

		const inputs = {
			messages,
			max_tokens: 1024,
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const stream = await env.AI.run<typeof MODEL_ID>(
			MODEL_ID,
			inputs,
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);

		return new Response(
			JSON.stringify({
				error: "Failed to process request",
			}),
			{
				status: 500,
				headers: {
					"content-type": "application/json",
				},
			},
		);
	}
}
