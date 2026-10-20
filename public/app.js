const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const sendButton = document.querySelector("#send");
const messages = document.querySelector("#messages");

const currencyFormatter = new Intl.NumberFormat("en-SG", {
  style: "currency",
  currency: "SGD",
});

function appendMessage(role, text) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const paragraph = document.createElement("p");
  paragraph.textContent = text;

  message.append(paragraph);
  messages.append(message);
  message.scrollIntoView({ block: "end", behavior: "smooth" });

  return message;
}

function appendLink(parent, text, value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return;
  }

  if (url.origin !== "https://www.fairprice.com.sg") return;

  const link = document.createElement("a");
  link.href = url.href;
  link.textContent = text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.append(link);
}

function appendProducts(parent, products) {
  for (const product of products) {
    const card = document.createElement("section");
    card.className = "product";

    const name = document.createElement("h2");
    name.textContent = product.name;

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = `${currencyFormatter.format(product.price)} SGD`;

    const details = document.createElement("p");
    details.className = "details";

    const availability =
      {
        in_stock: "Listed as in stock",
        out_of_stock: "Listed as out of stock",
        preorder: "Listed for preorder",
        unknown: "Availability not confirmed",
      }[product.availability] || "Availability not confirmed";

    details.textContent =
      `${availability} · Checked ${new Date(product.checkedAt).toLocaleString("en-SG")}`;

    card.append(name, price, details);
    appendLink(card, "View product on FairPrice", product.url);
    parent.append(card);
  }
}

appendMessage(
  "assistant",
  "Hi! Ask me a grocery price question, such as “How much is Meiji fresh milk 2L?” I only show prices I can verify on FairPrice.",
);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = input.value.trim();

  if (!question || sendButton.disabled) return;

  appendMessage("user", question);
  input.value = "";
  sendButton.disabled = true;
  input.disabled = true;

  const pending = appendMessage(
    "assistant",
    "Checking FairPrice… This can take about a minute.",
  );

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({ message: question }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "The request failed.");
    }

    pending.remove();

    const reply = appendMessage("assistant", data.answer);
    appendProducts(reply, data.products || []);

    if (data.note) {
      const note = document.createElement("p");
      note.className = "details";
      note.textContent = data.note;
      reply.append(note);
    }

    if (data.searchUrl) {
      const container = document.createElement("p");
      appendLink(container, "Open FairPrice search", data.searchUrl);
      reply.append(container);
    }

    reply.scrollIntoView({ block: "end", behavior: "smooth" });
  } catch (error) {
    pending.remove();

    appendMessage(
      "assistant",
      error.name === "TimeoutError"
        ? "The lookup took too long. Please try again shortly."
        : error.message || "Something went wrong. Please try again.",
    );
  } finally {
    sendButton.disabled = false;
    input.disabled = false;
    input.focus();
  }
});
