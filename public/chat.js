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

let conversations = [];
let activeConversationId = null;
let pendingDeleteId = null;
let isProcessing = false;
let conversationLimit = 20;

userInput.addEventListener("input", function () { this.style.height = "auto"; this.style.height = `${this.scrollHeight}px`; });
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
		openButton.textContent = conversation.title || "محادثة جديدة";
		openButton.title = openButton.textContent;
		openButton.addEventListener("click", () => openConversation(conversation.id));
		const deleteButton = document.createElement("button");
		deleteButton.className = "delete-chat";
		deleteButton.innerHTML = "&#128465;";
		deleteButton.title = "حذف المحادثة";
		deleteButton.addEventListener("click", (event) => requestDeleteConversation(conversation.id, event));
		item.append(openButton, deleteButton);
		conversationList.appendChild(item);
	}
}

async function sendMessage() {
	const message = userInput.value.trim();
	if (!message || isProcessing || !activeConversationId) return;
	setProcessing(true); removeWelcome(); addMessageToChat("user", message); userInput.value = ""; userInput.style.height = "auto";
	try {
		if (isRevalidateCommand(message)) { await saveConversationMessage("user", message); await runRevalidateTool(); }
		else await requestAssistantResponse(message);
		await loadConversations();
		const active = conversations.find((item) => item.id === activeConversationId);
		if (active) conversationTitle.textContent = active.title;
	} catch (error) {
		console.error(error);
		const errorMessage = error.message === ACCOUNT_ERROR ? ACCOUNT_ERROR : `❌ تعذر تنفيذ الطلب: ${error.message || "حدث خطأ غير متوقع"}`;
		addMessageToChat("assistant", errorMessage);
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
function createMessageElement(role, content) { const el = document.createElement("div"); el.className = `message ${role}-message`; const p = document.createElement("p"); p.textContent = content; el.appendChild(p); chatMessages.appendChild(el); scrollToBottom(); return el; }
function addMessageToChat(role, content) { createMessageElement(role, content); }
function renderWelcome() { chatMessages.innerHTML = '<div class="welcome" id="welcome-message"><strong>مرحبًا 👋</strong>أنا مساعد Autorply. ابدأ بسؤالك، وستُحفظ المحادثة تلقائيًا.</div>'; }
function removeWelcome() { $("welcome-message")?.remove(); }
function scrollToBottom() { chatMessages.scrollTop = chatMessages.scrollHeight; }
function showNotice(message) { limitNotice.textContent = message; limitNotice.classList.add("visible"); }
function hideNotice() { limitNotice.classList.remove("visible"); limitNotice.textContent = ""; }

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
