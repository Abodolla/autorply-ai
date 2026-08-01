const APP_PREFIX = "/autorply-ai";
const TEST_ACCOUNT_ID = "178461";

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let chatHistory = [
	{
		role: "assistant",
		content: "مرحبًا 👋\nأنا مساعد Autorply. كيف أقدر أخدمك اليوم؟",
	},
];

let isProcessing = false;

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

async function sendMessage() {
	const message = userInput.value.trim();

	if (!message || isProcessing) return;

	setProcessing(true);
	addMessageToChat("user", message);

	userInput.value = "";
	userInput.style.height = "auto";
	chatHistory.push({ role: "user", content: message });

	try {
		if (isRevalidateCommand(message)) {
			await runRevalidateTool();
			return;
		}

		await requestAssistantResponse();
	} catch (error) {
		console.error(error);
		addMessageToChat(
			"assistant",
			`❌ تعذر تنفيذ الطلب: ${error.message || "حدث خطأ غير متوقع"}`,
		);
	} finally {
		setProcessing(false);
	}
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

async function runRevalidateTool() {
	addMessageToChat(
		"assistant",
		"جاري إعادة التحقق من حساب واتساب ومزامنته...",
	);

	const token = getXsrfToken();

	if (!token) {
		throw new Error("لم أجد رمز جلسة المنصة. تأكد أنك مسجل دخول.");
	}

	const startedAt = performance.now();

	const response = await fetch("/whatsapp/bot/revalidate", {
		method: "POST",
		credentials: "same-origin",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			"X-Requested-With": "XMLHttpRequest",
			"X-CSRF-TOKEN": token,
			"X-XSRF-TOKEN": token,
		},
		body: new URLSearchParams({
			id: TEST_ACCOUNT_ID,
		}),
	});

	const text = await response.text();

	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new Error(`استجابة غير صالحة من المنصة: ${text}`);
	}

	if (!response.ok || result.status !== "1") {
		throw new Error(result.message || `فشل التنفيذ برمز ${response.status}`);
	}

	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	const successMessage = `✅ ${result.message}\nمدة التنفيذ: ${seconds} ثانية`;

	addMessageToChat("assistant", successMessage);
	chatHistory.push({
		role: "assistant",
		content: successMessage,
	});
}

function getXsrfToken() {
	const cookie = document.cookie
		.split("; ")
		.find((item) => item.startsWith("XSRF-TOKEN="));

	if (!cookie) return null;

	const value = cookie.substring("XSRF-TOKEN=".length);
	return decodeURIComponent(value);
}

async function requestAssistantResponse() {
	const assistantMessageEl = createMessageElement("assistant", "");
	const assistantTextEl = assistantMessageEl.querySelector("p");

	const response = await fetch(`${APP_PREFIX}/api/chat`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messages: chatHistory,
		}),
	});

	if (!response.ok) {
		throw new Error(`فشل الحصول على الرد (${response.status})`);
	}

	if (!response.body) {
		throw new Error("لم تصل بيانات الرد");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	let responseText = "";
	let buffer = "";
	let finished = false;

	while (!finished) {
		const { done, value } = await reader.read();

		if (value) {
			buffer += decoder.decode(value, { stream: !done });
		}

		const parsed = consumeSseEvents(done ? `${buffer}\n\n` : buffer);
		buffer = parsed.buffer;

		for (const data of parsed.events) {
			if (data === "[DONE]") {
				finished = true;
				break;
			}

			try {
				const jsonData = JSON.parse(data);

				const content =
					typeof jsonData.response === "string"
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

	if (responseText) {
		chatHistory.push({
			role: "assistant",
			content: responseText,
		});
	}
}

function setProcessing(processing) {
	isProcessing = processing;
	userInput.disabled = processing;
	sendButton.disabled = processing;
	typingIndicator.classList.toggle("visible", processing);

	if (!processing) {
		userInput.focus();
	}
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

function scrollToBottom() {
	chatMessages.scrollTop = chatMessages.scrollHeight;
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

		if (dataLines.length) {
			events.push(dataLines.join("\n"));
		}
	}

	return {
		events,
		buffer: normalized,
	};
}
