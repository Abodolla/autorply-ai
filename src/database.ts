import { Env } from "./types";

let schemaPromise: Promise<void> | null = null;

export function ensureDatabase(env: Env): Promise<void> {
	if (!env.DB) {
		return Promise.reject(
			new Error("D1 binding DB is not available in the deployed Worker."),
		);
	}

	if (!schemaPromise) {
		schemaPromise = initializeSchema(env.DB).catch((error) => {
			schemaPromise = null;
			throw error;
		});
	}

	return schemaPromise;
}

async function initializeSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL UNIQUE,
			name TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS conversations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL,
			title TEXT NOT NULL DEFAULT 'محادثة جديدة',
			pinned INTEGER NOT NULL DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
			content TEXT NOT NULL,
			model TEXT,
			prompt_tokens INTEGER,
			completion_tokens INTEGER,
			latency_ms INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS account_settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL UNIQUE,
			settings TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS actions_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL,
			action TEXT NOT NULL,
			details TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_sources (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL,
			title TEXT NOT NULL,
			source_type TEXT,
			content TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)`),
		db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_account_updated ON conversations(account_id, archived, updated_at DESC)"),
		db.prepare("CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, id)"),
		db.prepare("CREATE INDEX IF NOT EXISTS idx_actions_log_account_id ON actions_log(account_id, created_at DESC)"),
		db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_sources_account_id ON knowledge_sources(account_id, updated_at DESC)"),
	]);
}
