(async function () {
  const container = document.getElementById("contact-form");
  if (!container) return;

  const scriptEl = document.currentScript;
  const formUrl = scriptEl.getAttribute("data-form-url");

  // 送信先の既定はこのスクリプトの配信元にする。LP 側に URL を持たせない。
  // 末尾のスラッシュは落とす。付けて書かれると URL に `//` が生まれる。
  const apiBase = (scriptEl.getAttribute("data-api-url")
    || new URL(scriptEl.src).origin + "/api/submit").replace(/\/+$/, "");

  // 定義側が maxLength を書いていないフィールドにも効く絶対上限。
  // サーバ側の MAX_FIELD_LENGTH と揃える。
  const MAX_FIELD_LENGTH = 8000;

  let formDef = [];
  let formSlug = null;
  let messages = {
    success: "送信が完了しました。ありがとうございます！",
    error: "送信に失敗しました。",
    validation: "必須項目をすべて入力してください。"
  };

  try {
    const res = await fetch(formUrl);
    if (!res.ok) throw new Error("フォーム定義が取得できません");
    const json = await res.json();
    // fields が配列でなければ描画に進まない。オブジェクトを代入してしまうと、
    // この try の外で配列メソッドが投げてフォームが無言で消える。
    if (!Array.isArray(json.fields)) throw new Error("フォーム定義に fields がありません");
    formDef = json.fields;
    formSlug = json.slug;
    if (json.messages) messages = { ...messages, ...json.messages };
  } catch (err) {
    container.innerHTML = `<div class="fp-error">フォーム定義の読み込みに失敗しました。</div>`;
    console.error(err);
    return;
  }

  // 送信先が組めないなら描画もしない。送信時に気付く形にすると、
  // 全項目を入力して Turnstile を解いた後で失敗し、入力内容が失われる。
  if (!formSlug) {
    container.innerHTML = `<div class="fp-error">フォームの設定が不足しています。</div>`;
    console.error("フォーム定義に slug がありません");
    return;
  }

  if (formDef.some(f => f.type === "turnstile")) loadTurnstileScript();

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

    const apiUrl = `${apiBase}/${encodeURIComponent(formSlug)}`;

    // 連打すると同じ内容のメールが複数届く。送信中はボタンを止める。
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
        window.turnstile?.reset();
        statusDiv.textContent = messages.success;
        statusDiv.classList.remove("fp-status-error");
        statusDiv.classList.add("fp-status-success");
      } else {
        // サーバのエラー文には SES など内部の事情が混じることがある。
        // 画面に出すのは、保存された定義から出た検証エラーの詳細だけに限る。
        const data = res.status === 422 ? await res.json().catch(() => null) : null;
        statusDiv.textContent = data?.details?.[0] || messages.error;
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
      const rules = field.validation || {};

      // 長さの検査を先に済ませる。パターンを先に走らせると、マッチしない長い入力で
      // 破滅的バックトラッキングが起きる。ブラウザには CPU 制限が無いので、
      // 訪問者のタブがそのまま固まる。
      if (value.length > MAX_FIELD_LENGTH) {
        return `${field.label} は最大 ${MAX_FIELD_LENGTH} 文字です`;
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        return rules.message || `${field.label} は最大 ${rules.maxLength} 文字です`;
      }
      if (rules.minLength && value.length < rules.minLength) {
        return rules.message || `${field.label} は最低 ${rules.minLength} 文字です`;
      }

      if (rules.pattern) {
        // サーバ側と同じ完全一致にする（HTML の pattern 属性と同じ意味）。
        // アンカー無しのままだと、部分一致で通ってしまう。
        let regex = null;
        try {
          regex = new RegExp(`^(?:${rules.pattern})$`);
        } catch (err) {
          console.error(`フィールド ${field.name} の pattern が不正です`, err);
        }
        if (regex && !regex.test(value)) {
          return rules.message || `${field.label} の形式が正しくありません`;
        }
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
