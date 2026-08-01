/**
 * Type definitions for the Autorply AI application.
 */

export interface Env {
	AI: Ai;
	DB: D1Database;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface AccountRecord {
	id: number;
	account_id: string;
	name: string | null;
}

export interface ConversationRecord {
	id: number;
	account_id: number;
	title: string;
	pinned: number;
	archived: number;
	created_at: string;
	updated_at: string;
}

export interface MessageRecord {
	id: number;
	conversation_id: number;
	role: "user" | "assistant";
	content: string;
	model: string | null;
	created_at: string;
}
