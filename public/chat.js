const APP_PREFIX = "/autorply-ai";
const ACCOUNT_ERROR = "❌ تعذر الوصول إلى حساب واتساب المرتبط.\nتأكد أنك مسجل الدخول إلى منصة Autorply من نفس المتصفح، ثم أعد المحاولة.";

const $ = (id) => document.getElementById(id);
const chatMessages = $("chat-messages");
const userInput = $("user-input");
const sendButton = $("send-button");
const typingIndicator = $("typing-indicator");
const newChatButton = $("new-chat-button");
const conversationList = $("conversation-list");
const conversationCount = $("conversation-count");
const conversationTitle = $("conversation-title");
const connectionStatus = $("connection-status");
const connectionStatusText = $("connection-status-text");
const limitNotice = $("limit-notice");
const toastStack = $("toast-stack");
const deleteModal = $("delete-modal");
const confirmDeleteButton = $("confirm-delete-button");
const cancelDeleteButton = $("cancel-delete-button");
const saveState = $("save-state");

let conversations = [];
let activeConversationId = null;
let pendingDeleteId = null;
let isProcessing = false;
let conversationLimit = 20;

userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = `${Math.min(this.scrollHeight, 150)}px`;
	saveDraft();
});
userInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
sendButton.addEventListener("click", sendMessage);
newChatButton.addEventListener("click", createConversation);
confirmDeleteButton.addEventListener("click", confirmDeleteConversation);
cancelDeleteButton.addEventListener("click", closeDeleteModal);
deleteModal.addEventListener("click", (event) => { if (event.target === deleteModal) closeDeleteModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDeleteModal(); });
document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
	setConnectionStatus("connecting");
	try {
		await loadConversations();
		setConnectionStatus("connected");
		if (conversations.length) await openConversation(conversations[0].id);
		else await createConversation();
	} catch (error) { showFatalError(error); }
}

function setConnectionStatus(state) {
	connectionStatus.classList.remove("connected", "disconnected");
	if (state === "connected") { connectionStatus.classList.add("connected"); connectionStatusText.textContent = "متصل"; }
	else if (state === "disconnected") { connectionStatus.classList.add("disconnected"); connectionStatusText.textContent = "غير متصل"; }
	else connectionStatusText.textContent = "جاري الاتصال";
}

async function apiFetch(path, options = {}) {
	const response = await fetch(`${APP_PREFIX}${path}`, {
		credentials: "same-origin", ...options,
		headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
	});
	if (!response.ok) {
		let message = `فشل الطلب (${response.status})`;
		try { const data = await response.json(); message = data.error || message; } catch {}
		throw new Error(message);
	}
	return response;
}

async function loadConversations() {
	const response = await apiFetch("/api/conversations");
	const data = await response.json();
	conversations = data.conversations || [];
	conversationLimit = data.limit || 20;
	renderConversationList();
}

async function createConversation() {
	if (isProcessing) return;
	hideNotice();
	try {
		const response = await apiFetch("/api/conversations", { method: "POST" });
		const data = await response.json();
		await loadConversations();
		await openConversation(data.conversation.id);
		showToast("تم إنشاء محادثة جديدة", "success");
	} catch (error) {
		if (error.message.includes("الحد الأقصى")) { showNotice(error.message); showToast(error.message, "error"); return; }
		showToast(error.message, "error");
		throw error;
	}
}

async function openConversation(id) {
	if (isProcessing) return;
	const response = await apiFetch(`/api/conversations/${id}/messages`);
	const data = await response.json();
	activeConversationId = id;
	conversationTitle.textContent = data.conversation.title || "محادثة جديدة";
	chatMessages.innerHTML = "";
	if (!data.messages.length) renderWelcome();
	else data.messages.forEach((message) => addMessageToChat(message.role, message.content));
	restoreDraft();
	renderConversationList();
	setComposerEnabled(true);
	userInput.focus();
}

function requestDeleteConversation(id, event) {
	event.stopPropagation();
	if (isProcessing) return;
	pendingDeleteId = id;
	deleteModal.hidden = false;
	requestAnimationFrame(() => deleteModal.classList.add("visible"));
	confirmDeleteButton.focus();
}

function closeDeleteModal() {
	deleteModal.classList.remove("visible");
	pendingDeleteId = null;
	setTimeout(() => { deleteModal.hidden = true; }, 150);
}

async function confirmDeleteConversation() {
	if (!pendingDeleteId || isProcessing) return;
	const id = pendingDeleteId;
	confirmDeleteButton.disabled = true;
	try {
		await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
		const wasActive = activeConversationId === id;
		closeDeleteModal();
		await loadConversations();
		if (wasActive) {
			activeConversationId = null;
			if (conversations.length) await openConversation(conversations[0].id);
			else await createConversation();
		}
		showToast("تم حذف المحادثة", "success");
	} catch (error) { showToast(error.message, "error"); }
	finally { confirmDeleteButton.disabled = false; }
}

function renderConversationList() {
	conversationList.innerHTML = "";
	conversationCount.textContent = `${conversations.length} / ${conversationLimit}`;
	newChatButton.disabled = conversations.length >= conversationLimit || isProcessing;
	if (!conversations.length) { conversationList.innerHTML = '<div class="empty-list">لا توجد محادثات محفوظة</div>'; return; }
	for (const conversation of conversations) {
		const item = document.createElement("div");
		item.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;
		const openButton = document.createElement("button");
		openButton.className = "conversation-open";
		openButton.title = conversation.title || "محادثة جديدة";
		openButton.innerHTML = `<svg class="conversation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 10h8M8 14h5" stroke-linecap="round"/><path d="M20 11.5a8 8 0 1 1-3.1-6.3L20 4v7.5Z" stroke-linejoin="round"/></svg><span class="conversation-copy"><span class="conversation-name">${escapeHtml(conversation.title || "محادثة جديدة")}</span><span class="conversation-date">${formatConversationDate(conversation.updated_at)}</span></span>`;
		openButton.addEventListener("click", () => openConversation(conversation.id));
		const deleteButton = document.createElement("button");
		deleteButton.className = "delete-chat";
		deleteButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5M14 11v5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		deleteButton.title = "حذف المحادثة";
		deleteButton.addEventListener("click", (event) => requestDeleteConversation(conversation.id, event));
		item.append(openButton, deleteButton);
		conversationList.appendChild(item);
	}
}

async function sendMessage() {
	const message = userInput.value.trim();
	if (!message || isProcessing || !activeConversationId) return;
	setProcessing(true); setSaveState("saving"); removeWelcome(); addMessageToChat("user", message); userInput.value = ""; userInput.style.height = "auto"; clearDraft();
	try {
		if (isSyncTemplatesCommand(message)) { await saveConversationMessage("user", message); await runSyncTemplatesTool(); }
		else if (isRevalidateCommand(message)) { await saveConversationMessage("user", message); await runRevalidateTool(); }
		else await requestAssistantResponse(message);
		await loadConversations();
		const active = conversations.find((item) => item.id === activeConversationId);
		if (active) conversationTitle.textContent = active.title;
		setSaveState("saved");
	} catch (error) {
		console.error(error);
		const errorMessage = error.message === ACCOUNT_ERROR ? ACCOUNT_ERROR : `❌ تعذر تنفيذ الطلب: ${error.message || "حدث خطأ غير متوقع"}`;
		addMessageToChat("assistant", errorMessage);
		try { await saveConversationMessage("assistant", errorMessage); } catch (saveError) { console.error("تعذر حفظ رسالة الخطأ:", saveError); }
		setSaveState("error");
		showToast(error.message || "تعذر تنفيذ الطلب", "error");
	} finally { setProcessing(false); }
}

async function saveConversationMessage(role, content) {
	await apiFetch(`/api/conversations/${activeConversationId}/messages`, { method: "POST", body: JSON.stringify({ role, content }) });
}

function isRevalidateCommand(message) {
	const normalized = message.toLowerCase().replace(/[أإآ]/g, "ا").replace(/\s+/g, " ").trim();
	return ["زامن حسابي","زامن حساب الواتساب","مزامنة حسابي","مزامنة حساب الواتساب","حدث حسابي","حدث حساب الواتساب","اعد التحقق من الحساب","اعد التحقق من التوكن"].some((command) => normalized.includes(command));
}

function isSyncTemplatesCommand(message) {
	const normalized = message.toLowerCase().replace(/[أإآ]/g, "ا").replace(/\s+/g, " ").trim();
	return ["زامن القوالب", "مزامنة القوالب", "حدث القوالب", "تحديث القوالب"].some((command) => normalized.includes(command));
}

async function runSyncTemplatesTool() {
	addMessageToChat("assistant", "جاري مزامنة القوالب...");
	const response = await apiFetch("/api/tools/sync-templates", { method: "POST" });
	const result = await response.json();
	const successMessage = result.message || "تمت مزامنة القوالب بنجاح.";
	addMessageToChat("assistant", successMessage);
	await saveConversationMessage("assistant", successMessage);
	showToast("اكتملت مزامنة القوالب", "success");
}

async function getCurrentWhatsAppAccount() {
	const response = await fetch("/whatsapp/bot/connect", { method: "GET", credentials: "same-origin", headers: { Accept: "text/html" } });
	if (!response.ok) throw new Error(ACCOUNT_ERROR);
	const doc = new DOMParser().parseFromString(await response.text(), "text/html");
	const accountId = doc.querySelector(".revalidate-token")?.dataset.id || null;
	const csrfToken = doc.querySelector('meta[name="csrf-token"]')?.content || null;
	if (!accountId || !csrfToken) throw new Error(ACCOUNT_ERROR);
	return { accountId, csrfToken };
}

async function runRevalidateTool() {
	addMessageToChat("assistant", "جاري إعادة التحقق من حساب واتساب ومزامنته...");
	const { accountId, csrfToken } = await getCurrentWhatsAppAccount();
	const startedAt = performance.now();
	const response = await fetch("/whatsapp/bot/revalidate", {
		method: "POST", credentials: "same-origin",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": csrfToken, "X-XSRF-TOKEN": csrfToken },
		body: new URLSearchParams({ id: accountId }),
	});
	let result;
	try { result = JSON.parse(await response.text()); } catch { throw new Error("استجابة غير صالحة من المنصة"); }
	if (!response.ok || result.status !== "1") throw new Error(result.message || `فشل التنفيذ برمز ${response.status}`);
	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	const successMessage = `✅ ${result.message}\nمدة التنفيذ: ${seconds} ثانية`;
	addMessageToChat("assistant", successMessage);
	await saveConversationMessage("assistant", successMessage);
	showToast("اكتملت مزامنة الحساب", "success");
}

async function requestAssistantResponse(message) {
	const assistantMessageEl = createMessageElement("assistant", "");
	const assistantTextEl = assistantMessageEl.querySelector("p");
	const response = await fetch(`${APP_PREFIX}/api/chat`, {
		method: "POST", credentials: "same-origin",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ conversationId: activeConversationId, message }),
	});
	if (!response.ok) {
		let messageText = `فشل الحصول على الرد (${response.status})`;
		try { const data = await response.json(); messageText = data.error || messageText; } catch {}
		assistantMessageEl.remove(); throw new Error(messageText);
	}
	if (!response.body) throw new Error("لم تصل بيانات الرد");
	const reader = response.body.getReader(); const decoder = new TextDecoder();
	let responseText = "", buffer = "", finished = false;
	while (!finished) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: !done });
		const parsed = consumeSseEvents(done ? `${buffer}\n\n` : buffer); buffer = parsed.buffer;
		for (const data of parsed.events) {
			if (data === "[DONE]") { finished = true; break; }
			try {
				const jsonData = JSON.parse(data);
				const content = typeof jsonData.response === "string" ? jsonData.response : jsonData.choices?.[0]?.delta?.content || "";
				if (content) { responseText += content; assistantTextEl.textContent = responseText; scrollToBottom(); }
			} catch (error) { console.error("تعذر قراءة جزء من الرد:", error, data); }
		}
		if (done) break;
	}
	if (!responseText.trim()) { assistantMessageEl.remove(); throw new Error("وصل رد فارغ من المساعد"); }
}

function setProcessing(processing) {
	isProcessing = processing;
	setComposerEnabled(!processing && Boolean(activeConversationId));
	typingIndicator.classList.toggle("visible", processing);
	newChatButton.disabled = processing || conversations.length >= conversationLimit;
	if (!processing) userInput.focus();
}
function setComposerEnabled(enabled) { userInput.disabled = !enabled; sendButton.disabled = !enabled; }
function createMessageElement(role, content) {
	const el = document.createElement("div");
	el.className = `message ${role}-message`;
	const avatar = document.createElement("div");
	avatar.className = "message-avatar";
	avatar.textContent = role === "assistant" ? "AI" : "أنت";
	const body = document.createElement("div");
	body.className = "message-body";
	const label = document.createElement("span");
	label.className = "message-label";
	label.textContent = role === "assistant" ? "مساعد Autorply" : "أنت";
	const p = document.createElement("p");
	p.textContent = content;
	body.append(label, p);
	el.append(avatar, body);
	chatMessages.appendChild(el);
	scrollToBottom();
	return el;
}
function addMessageToChat(role, content) { createMessageElement(role, content); }
function renderWelcome() {
	chatMessages.innerHTML = `<div class="welcome" id="welcome-message"><div class="welcome-mark">AI</div><h3>كيف أقدر أساعدك اليوم؟</h3><p>اسأل عن حسابك أو استخدم أحد الإجراءات السريعة.</p><div class="suggestions"><button class="suggestion" data-command="زامن حسابي"><span class="suggestion-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 7h-7V4M4 17h7v3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 7.5A7 7 0 0 1 18.7 7M17.5 16.5A7 7 0 0 1 5.3 17" stroke-linecap="round"/></svg></span><span><strong>زامن حسابي</strong><small>إعادة التحقق من حساب واتساب</small></span><span class="suggestion-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 7-5 5 5 5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button><button class="suggestion" data-command="زامن القوالب"><span class="suggestion-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v14H4zM8 9h8M8 13h5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><strong>زامن القوالب</strong><small>تحديث حالات قوالب واتساب</small></span><span class="suggestion-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 7-5 5 5 5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button></div></div>`;
	chatMessages.querySelectorAll("[data-command]").forEach((button) => {
		button.addEventListener("click", () => submitSuggestion(button.dataset.command));
	});
}
function removeWelcome() { $("welcome-message")?.remove(); }
function scrollToBottom() { chatMessages.scrollTop = chatMessages.scrollHeight; }
function showNotice(message) { limitNotice.textContent = message; limitNotice.classList.add("visible"); }
function hideNotice() { limitNotice.classList.remove("visible"); limitNotice.textContent = ""; }

function submitSuggestion(command) {
	if (!command || isProcessing) return;
	userInput.value = command;
	userInput.dispatchEvent(new Event("input"));
	sendMessage();
}

function draftKey() { return activeConversationId ? `autorply-ai:draft:${activeConversationId}` : null; }
function saveDraft() {
	const key = draftKey();
	if (!key) return;
	const value = userInput.value;
	if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
}
function restoreDraft() {
	const key = draftKey();
	userInput.value = key ? localStorage.getItem(key) || "" : "";
	userInput.style.height = "auto";
	if (userInput.value) userInput.style.height = `${Math.min(userInput.scrollHeight, 150)}px`;
}
function clearDraft() { const key = draftKey(); if (key) localStorage.removeItem(key); }

function setSaveState(state) {
	saveState.className = `save-state ${state}`;
	saveState.textContent = state === "saving" ? "جاري الحفظ..." : state === "error" ? "تعذر الحفظ" : "محفوظ تلقائيًا";
}

function formatConversationDate(value) {
	if (!value) return "";
	const date = new Date(value.endsWith?.("Z") ? value : `${value.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) return "";
	const diff = Date.now() - date.getTime();
	if (diff < 60000) return "الآن";
	if (diff < 3600000) return `منذ ${Math.floor(diff / 60000)} د`;
	if (diff < 86400000) return `منذ ${Math.floor(diff / 3600000)} س`;
	return new Intl.DateTimeFormat("ar-SA", { month: "short", day: "numeric" }).format(date);
}

function showToast(message, type = "info") {
	const toast = document.createElement("div");
	toast.className = `app-toast ${type}`;
	toast.setAttribute("role", "status");
	toast.innerHTML = `<span>${type === "success" ? "✓" : type === "error" ? "!" : "i"}</span><span>${escapeHtml(message)}</span>`;
	toastStack.appendChild(toast);
	setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateY(-8px)"; setTimeout(() => toast.remove(), 200); }, 3500);
}
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value); return div.innerHTML; }

function showFatalError(error) {
	console.error(error); setConnectionStatus("disconnected"); setComposerEnabled(false); newChatButton.disabled = true;
	chatMessages.innerHTML = "";
	addMessageToChat("assistant", error.message === ACCOUNT_ERROR ? ACCOUNT_ERROR : `❌ ${error.message}`);
	showToast(error.message || "تعذر الاتصال", "error");
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, ""); const events = []; let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex); normalized = normalized.slice(eventEndIndex + 2);
		const dataLines = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trimStart());
		if (dataLines.length) events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}
