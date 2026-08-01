const APP_PREFIX = "/autorply-ai";
const ACCOUNT_ERROR =
	"❌ تعذر الوصول إلى حساب واتساب المرتبط.\nتأكد أنك مسجل الدخول إلى منصة Autorply من نفس المتصفح، ثم أعد المحاولة.";

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const newChatButton = document.getElementById("new-chat-button");
const conversationList = document.getElementById("conversation-list");
const conversationCount = document.getElementById("conversation-count");
const conversationTitle = document.getElementById("conversation-title");
const connectionStatus = document.getElementById("connection-status");
const limitNotice = document.getElementById("limit-notice");

let conversations = [];
let activeConversationId = null;
let isProcessing = false;
let conversationLimit = 20;

userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = `${this.scrollHeight}px`;
});

userInput.addEventListener("keydown", function (event) {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);
newChatButton.addEventListener("click", createConversation);

document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
	try {
		await loadConversations();
		connectionStatus.textContent = "متصل وجاهز";

		if (conversations.length) {
			await openConversation(conversations[0].id);
		} else {
			await createConversation();
		}
	} catch (error) {
		showFatalError(error);
	}
}

async function apiFetch(path, options = {}) {
	const response = await fetch(`${APP_PREFIX}${path}`, {
		credentials: "same-origin",
		...options,
		headers: {
			Accept: "application/json",
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...(options.headers || {}),
		},
	});

	if (!response.ok) {
		let message = `فشل الطلب (${response.status})`;
		try {
			const data = await response.json();
			message = data.error || message;
		} catch {}
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
	} catch (error) {
		if (error.message.includes("الحد الأقصى")) {
			showNotice(error.message);
			return;
		}
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

	if (!data.messages.length) {
		renderWelcome();
	} else {
		for (const message of data.messages) {
			addMessageToChat(message.role, message.content);
		}
	}

	renderConversationList();
	setComposerEnabled(true);
	userInput.focus();
}

async function deleteConversation(id, event) {
	event.stopPropagation();
	if (isProcessing) return;
	if (!confirm("هل تريد حذف هذه المحادثة؟")) return;

	await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
	const wasActive = activeConversationId === id;
	await loadConversations();

	if (wasActive) {
		activeConversationId = null;
		if (conversations.length) {
			await openConversation(conversations[0].id);
		} else {
			await createConversation();
		}
	}
}

function renderConversationList() {
	conversationList.innerHTML = "";
	conversationCount.textContent = `${conversations.length} / ${conversationLimit}`;
	newChatButton.disabled = conversations.length >= conversationLimit || isProcessing;

	if (!conversations.length) {
		conversationList.innerHTML = '<div class="empty-list">لا توجد محادثات محفوظة</div>';
		return;
	}

	for (const conversation of conversations) {
		const item = document.createElement("div");
		item.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;

		const openButton = document.createElement("button");
		openButton.className = "conversation-open";
		openButton.textContent = conversation.title || "محادثة جديدة";
		openButton.title = conversation.title || "محادثة جديدة";
		openButton.addEventListener("click", () => openConversation(conversation.id));

		const deleteButton = document.createElement("button");
		deleteButton.className = "delete-chat";
		deleteButton.textContent = "×";
		deleteButton.title = "حذف المحادثة";
		deleteButton.addEventListener("click", (event) =>
			deleteConversation(conversation.id, event),
		);

		item.append(openButton, deleteButton);
		conversationList.appendChild(item);
	}
}

async function sendMessage() {
	const message = userInput.value.trim();
	if (!message || isProcessing || !activeConversationId) return;

	setProcessing(true);
	removeWelcome();
	addMessageToChat("user", message);
	userInput.value = "";
	userInput.style.height = "auto";

	try {
		if (isRevalidateCommand(message)) {
			await saveConversationMessage("user", message);
			await runRevalidateTool();
		} else {
			await requestAssistantResponse(message);
		}
		await loadConversations();
		const active = conversations.find((item) => item.id === activeConversationId);
		if (active) conversationTitle.textContent = active.title;
	} catch (error) {
		console.error(error);
		const errorMessage = error.message === ACCOUNT_ERROR
			? ACCOUNT_ERROR
			: `❌ تعذر تنفيذ الطلب: ${error.message || "حدث خطأ غير متوقع"}`;
		addMessageToChat("assistant", errorMessage);
	} finally {
		setProcessing(false);
	}
}

async function saveConversationMessage(role, content) {
	await apiFetch(`/api/conversations/${activeConversationId}/messages`, {
		method: "POST",
		body: JSON.stringify({ role, content }),
	});
}

function isRevalidateCommand(message) {
	const normalized = message
		.toLowerCase()
		.replace(/[أإآ]/g, "ا")
		.replace(/\s+/g, " ")
		.trim();

	return [
		"زامن حسابي",
		"زامن حساب الواتساب",
		"مزامنة حسابي",
		"مزامنة حساب الواتساب",
		"حدث حسابي",
		"حدث حساب الواتساب",
		"اعد التحقق من الحساب",
		"اعد التحقق من التوكن",
	].some((command) => normalized.includes(command));
}

async function getCurrentWhatsAppAccount() {
	const response = await fetch("/whatsapp/bot/connect", {
		method: "GET",
		credentials: "same-origin",
		headers: { Accept: "text/html" },
	});

	if (!response.ok) throw new Error(ACCOUNT_ERROR);
	const html = await response.text();
	const doc = new DOMParser().parseFromString(html, "text/html");
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
		method: "POST",
		credentials: "same-origin",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			"X-Requested-With": "XMLHttpRequest",
			"X-CSRF-TOKEN": csrfToken,
			"X-XSRF-TOKEN": csrfToken,
		},
		body: new URLSearchParams({ id: accountId }),
	});

	const text = await response.text();
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new Error("استجابة غير صالحة من المنصة");
	}

	if (!response.ok || result.status !== "1") {
		throw new Error(result.message || `فشل التنفيذ برمز ${response.status}`);
	}

	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	const successMessage = `✅ ${result.message}\nمدة التنفيذ: ${seconds} ثانية`;
	addMessageToChat("assistant", successMessage);
	await saveConversationMessage("assistant", successMessage);
}

async function requestAssistantResponse(message) {
	const assistantMessageEl = createMessageElement("assistant", "");
	const assistantTextEl = assistantMessageEl.querySelector("p");

	const response = await fetch(`${APP_PREFIX}/api/chat`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({
			conversationId: activeConversationId,
			message,
		}),
	});

	if (!response.ok) {
		let messageText = `فشل الحصول على الرد (${response.status})`;
		try {
			const data = await response.json();
			messageText = data.error || messageText;
		} catch {}
		assistantMessageEl.remove();
		throw new Error(messageText);
	}

	if (!response.body) throw new Error("لم تصل بيانات الرد");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let responseText = "";
	let buffer = "";
	let finished = false;

	while (!finished) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: !done });
		const parsed = consumeSseEvents(done ? `${buffer}\n\n` : buffer);
		buffer = parsed.buffer;

		for (const data of parsed.events) {
			if (data === "[DONE]") {
				finished = true;
				break;
			}
			try {
				const jsonData = JSON.parse(data);
				const content = typeof jsonData.response === "string"
					? jsonData.response
					: jsonData.choices?.[0]?.delta?.content || "";
				if (content) {
					responseText += content;
					assistantTextEl.textContent = responseText;
					scrollToBottom();
				}
			} catch (error) {
				console.error("تعذر قراءة جزء من الرد:", error, data);
			}
		}
		if (done) break;
	}

	if (!responseText.trim()) {
		assistantMessageEl.remove();
		throw new Error("وصل رد فارغ من المساعد");
	}
}

function setProcessing(processing) {
	isProcessing = processing;
	setComposerEnabled(!processing && Boolean(activeConversationId));
	typingIndicator.classList.toggle("visible", processing);
	newChatButton.disabled = processing || conversations.length >= conversationLimit;
	if (!processing) userInput.focus();
}

function setComposerEnabled(enabled) {
	userInput.disabled = !enabled;
	sendButton.disabled = !enabled;
}

function createMessageElement(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	const paragraph = document.createElement("p");
	paragraph.textContent = content;
	messageEl.appendChild(paragraph);
	chatMessages.appendChild(messageEl);
	scrollToBottom();
	return messageEl;
}

function addMessageToChat(role, content) {
	createMessageElement(role, content);
}

function renderWelcome() {
	chatMessages.innerHTML = `
		<div class="welcome" id="welcome-message">
			<strong>مرحبًا 👋</strong>
			أنا مساعد Autorply. ابدأ بسؤالك، وستُحفظ المحادثة تلقائيًا.
		</div>`;
}

function removeWelcome() {
	document.getElementById("welcome-message")?.remove();
}

function scrollToBottom() {
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showNotice(message) {
	limitNotice.textContent = message;
	limitNotice.classList.add("visible");
}

function hideNotice() {
	limitNotice.classList.remove("visible");
	limitNotice.textContent = "";
}

function showFatalError(error) {
	console.error(error);
	connectionStatus.textContent = "تعذر الاتصال";
	setComposerEnabled(false);
	newChatButton.disabled = true;
	chatMessages.innerHTML = "";
	addMessageToChat("assistant", error.message === ACCOUNT_ERROR ? ACCOUNT_ERROR : `❌ ${error.message}`);
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;

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
