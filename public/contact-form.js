(async function () {
  const container = document.getElementById("contact-form");
  if (!container) return;

  const scriptEl = document.currentScript;
  const formUrl = scriptEl.getAttribute("data-form-url");
  const lpCode = scriptEl.getAttribute("data-lp") || "unknown";

  let formDef = [];
  let messages = {
    success: "送信が完了しました。ありがとうございます！",
    error: "送信に失敗しました。",
    validation: "必須項目をすべて入力してください。"
  };

  try {
    const res = await fetch(formUrl);
    if (!res.ok) throw new Error("フォーム定義が取得できません");
    const json = await res.json();
    formDef = json.fields || json;
    if (json.messages) messages = { ...messages, ...json.messages };
  } catch (err) {
    container.innerHTML = `<div class="fp-error">フォーム定義の読み込みに失敗しました。</div>`;
    console.error(err);
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

    const payload = { lp_code: lpCode };
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

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        form.reset();
        statusDiv.textContent = messages.success;
        statusDiv.classList.remove("fp-status-error");
        statusDiv.classList.add("fp-status-success");
      } else {
        const data = await res.json().catch(() => null);
        statusDiv.textContent = data?.error || messages.error;
        statusDiv.classList.add("fp-status-error");
      }
    } catch (err) {
      console.error(err);
      statusDiv.textContent = messages.error;
      statusDiv.classList.add("fp-status-error");
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
        const regex = new RegExp(field.validation.pattern);
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
