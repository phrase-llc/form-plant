(async function () {
  const container = document.getElementById("contact-form");
  if (!container) return;

  const scriptEl = document.currentScript;
  const formUrl = scriptEl.getAttribute("data-form-url");

  // 既定の送信先はこのスクリプトの配信元。理由は CLAUDE.md。
  // src が空になるのは中身をインラインで貼った場合で、配信元をたどれない。
  // 末尾のスラッシュは落とす。付いていると /api/submit に一致しない。
  const apiUrl = (scriptEl.getAttribute("data-api-url")
    || (scriptEl.src && new URL(scriptEl.src).origin + "/api/submit") || "").replace(/\/+$/, "");

  if (!apiUrl) {
    container.innerHTML = `<div class="fp-error">フォームの設定が不足しています。</div>`;
    console.error("送信先が決まりません。スクリプトをインラインで置く場合は data-api-url が要ります");
    return;
  }

  let formDef;
  let messages = {
    success: "送信が完了しました。ありがとうございます！",
    error: "送信に失敗しました。",
    validation: "必須項目をすべて入力してください。"
  };

  try {
    const res = await fetch(formUrl);
    if (!res.ok) throw new Error("フォーム定義が取得できません");
    const json = await res.json();
    // 配列でないまま進むと、この try の外で配列メソッドが投げ、
    // エラー表示にも到達しないままフォームが消える。
    formDef = Array.isArray(json.fields) ? json.fields : json;
    if (!Array.isArray(formDef)) throw new Error("フォーム定義に fields がありません");
    if (json.messages) messages = { ...messages, ...json.messages };
  } catch (err) {
    container.innerHTML = `<div class="fp-error">フォーム定義の読み込みに失敗しました。</div>`;
    console.error(err);
    return;
  }

  const hasTurnstile = formDef.some(f => f.type === "turnstile");
  if (hasTurnstile) loadTurnstileScript();

  const form = document.createElement("form");
  form.id = "fp-form";
  form.className = "fp-form";

  for (const field of formDef) {
    const fieldEl = renderField(field);
    if (fieldEl) form.appendChild(fieldEl);
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "fp-submit";
  submit.textContent = "送信";
  form.appendChild(submit);

  const statusDiv = document.createElement("div");
  statusDiv.id = "fp-status";
  statusDiv.className = "fp-status";
  form.appendChild(statusDiv);

  container.appendChild(form);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusDiv.textContent = "";
    statusDiv.className = "fp-status";
    clearErrors();

    const payload = {};
    let hasError = false;

    for (const field of formDef) {
      if (field.type === "turnstile") continue;
      const el = form.elements[field.name];
      if (!el) continue;
      const value = field.type === "checkbox" ? el.checked : el.value;
      const error = validateField(field, value);
      if (error) {
        showError(el, error);
        statusDiv.textContent = error;
        statusDiv.classList.add("fp-status-error");
        hasError = true;
      }
      payload[field.name] = value;
    }

    const turnstileToken = form.elements["cf-turnstile-response"]?.value;
    if (turnstileToken) payload["cf-turnstile-response"] = turnstileToken;

    if (hasError) {
      if (!statusDiv.textContent) {
        statusDiv.textContent = messages.validation;
        statusDiv.classList.add("fp-status-error");
      }
      return;
    }

    // 連打すると同じ内容のメールが複数届く。
    submit.disabled = true;
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        form.reset();
        // form.reset() は Turnstile ウィジェットを戻さない。トークンは単回使用なので、
        // ここでリセットしないと2回目の送信が必ずトークン無しで失敗する。
        //
        // セレクタで自分のウィジェットに限定する。引数無しで呼ぶと最初に描画された
        // ウィジェットが対象になり、ホストページが別に Turnstile を使っている場合に
        // そちらを戻してしまう。
        if (hasTurnstile) window.turnstile?.reset("#contact-form .cf-turnstile");
        statusDiv.textContent = messages.success;
        statusDiv.classList.remove("fp-status-error");
        statusDiv.classList.add("fp-status-success");
      } else {
        // サーバのエラー文には SES など内部の事情が混じる。画面には出さない。
        statusDiv.textContent = messages.error;
        statusDiv.classList.add("fp-status-error");
      }
    } catch (err) {
      console.error(err);
      statusDiv.textContent = messages.error;
      statusDiv.classList.add("fp-status-error");
    } finally {
      submit.disabled = false;
    }
  });

  function validateField(field, value) {
    if (field.required) {
      if (field.type === "checkbox" && !value) {
        return field.validation?.message || `${field.label} をチェックしてください`;
      }
      if (typeof value === "string" && value.trim() === "") {
        return field.validation?.message || `${field.label} を入力してください`;
      }
    }

    if (typeof value === "string") {
      if (field.validation?.pattern) {
        // HTML の pattern 属性と同じ完全一致にする。これらの正規表現はその属性から
        // 写されてくるので、アンカー無しのままだと意味が変わる。部分一致になり、
        // `\d{10,11}` を指定したフィールドに任意の長さの文字列が通る。
        const regex = new RegExp(`^(?:${field.validation.pattern})$`);
        if (!regex.test(value)) {
          return field.validation.message || `${field.label} の形式が正しくありません`;
        }
      }
      if (field.validation?.minLength && value.length < field.validation.minLength) {
        return field.validation.message || `${field.label} は最低 ${field.validation.minLength} 文字です`;
      }
      if (field.validation?.maxLength && value.length > field.validation.maxLength) {
        return field.validation.message || `${field.label} は最大 ${field.validation.maxLength} 文字です`;
      }
    }

    return null;
  }

  function showError(el, message) {
    el.classList.add("fp-error-input");
    el.setAttribute("aria-invalid", "true");
  }

  function clearErrors() {
    document.querySelectorAll(".fp-error-input").forEach((el) => {
      el.classList.remove("fp-error-input");
      el.removeAttribute("aria-invalid");
    });
  }

  function renderField(field) {
    if (!field.name || !field.type) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "fp-field";

    if (field.type === "turnstile") {
      const div = document.createElement("div");
      div.className = "cf-turnstile";
      div.setAttribute("data-sitekey", field.sitekey || "");
      if (field.theme) {
        div.setAttribute("data-theme", field.theme);
      }
      wrapper.appendChild(div);
      return wrapper;
    }

    if (field.type === "checkbox") {
      const label = document.createElement("label");
      label.className = "fp-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "fp-checkbox";
      input.id = `fp-${field.name}`;
      input.name = field.name;
      if (field.required) input.required = true;
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + field.label));
      wrapper.appendChild(label);
      return wrapper;
    }

    if (field.type === "radio") {
      const label = document.createElement("div");
      label.className = "fp-label";
      label.textContent = field.label;
      wrapper.appendChild(label);

      const radioGroup = document.createElement("div");
      radioGroup.className = "fp-radio-group";

      if (Array.isArray(field.options)) {
        for (const opt of field.options) {
          const radioWrapper = document.createElement("label");
          radioWrapper.className = "fp-radio-label";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = field.name;
          radio.value = opt.value;
          radio.className = "fp-radio";
          if (field.required) radio.required = true;
          radioWrapper.appendChild(radio);
          radioWrapper.appendChild(document.createTextNode(" " + opt.label));
          radioGroup.appendChild(radioWrapper);
        }
      }

      wrapper.appendChild(radioGroup);
      return wrapper;
    }

    const label = document.createElement("label");
    label.setAttribute("for", `fp-${field.name}`);
    label.className = "fp-label";
    label.textContent = field.label;

    let input;
    if (field.type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 4;
      input.className = "fp-textarea";
    } else if (field.type === "select") {
      input = document.createElement("select");
      input.className = "fp-select";
      if (Array.isArray(field.options)) {
        for (const opt of field.options) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        }
      }
    } else {
      input = document.createElement("input");
      input.type = field.type || "text";
      input.className = "fp-input";
    }

    input.id = `fp-${field.name}`;
    input.name = field.name;
    if (field.required) input.required = true;

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    return wrapper;
  }

  function loadTurnstileScript() {
    if (!document.querySelector('script[src*="challenges.cloudflare.com"]')) {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }
})();
