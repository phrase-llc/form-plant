(function () {
  const container = document.getElementById("contact-form");
  if (!container) return;

  const lpCode = document.currentScript.getAttribute("data-lp") || "unknown";

  container.innerHTML = `
  <form id="fp-form" class="fp-form">
    <div class="fp-field">
      <label for="fp-name" class="fp-label">お名前</label><br>
      <input type="text" id="fp-name" name="name" class="fp-input" required>
    </div>
    <div class="fp-field">
      <label for="fp-email" class="fp-label">メールアドレス</label><br>
      <input type="email" id="fp-email" name="email" class="fp-input" required>
    </div>
    <div class="fp-field">
      <label for="fp-message" class="fp-label">お問い合わせ内容</label><br>
      <textarea id="fp-message" name="message" rows="4" class="fp-textarea" required></textarea>
    </div>
    <button type="submit" class="fp-submit">送信</button>
    <div id="fp-status" class="fp-status"></div>
  </form>
`;

  const form = document.getElementById("fp-form");
  const status = document.getElementById("fp-status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "送信中…";

    const payload = {
      name: form.name.value,
      email: form.email.value,
      message: form.message.value,
      lp_code: lpCode,
    };

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        form.reset();
        status.textContent = "送信が完了しました。ありがとうございます！";
      } else {
        const data = await res.json().catch(() => null);
        status.textContent = data?.error || "送信に失敗しました。しばらくしてから再度お試しください。";
      }
    } catch (err) {
      console.error(err);
      status.textContent = "通信エラーが発生しました。";
    }
  });
})();
