import app from "./index";
import { ensureDatabase } from "./database";
import { Env } from "./types";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const isApiRequest =
			url.pathname === "/autorply-ai/api" ||
			url.pathname.startsWith("/autorply-ai/api/") ||
			url.pathname === "/api" ||
			url.pathname.startsWith("/api/");
		const isSessionCheck = url.pathname.endsWith("/api/session-check");

		if (isApiRequest && !isSessionCheck) {
			try {
				await ensureDatabase(env);
			} catch (error) {
				console.error("D1 initialization error:", error);
				const message =
					error instanceof Error
						? error.message
						: "تعذر تهيئة قاعدة بيانات المحادثات";

				return new Response(JSON.stringify({ error: message }), {
					status: 500,
					headers: {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			}
		}

		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
