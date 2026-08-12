// 送信の受付。`POST /api/submit/:site_key/:slug`
//
// 設定は KV の `site:<site_key>` から読む。環境変数のグローバル設定は使わない。
// 旧 `/api/submit`（環境変数版）は移行のあいだ併存させ、LP の差し替えが済んでから消す。
//
// site_key をパスに置いているのは CORS の都合である。
// preflight（OPTIONS）はリクエストボディを持たないため、body に site_key を入れると
// どのオリジンを許可すべきか preflight の時点で判定できない。
//
// クライアントが送るのは「どの設定を引くか」だけで、送信先も検証内容も
// サーバが保持する値だけを使う。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// console 側の SiteProjection::SCHEMA_VERSION と対応する。
const SUPPORTED_SCHEMA_VERSION = 1;

// メール本文の上限。定義側の maxLength をすべて満たしても、
// 項目数が多ければ本文は膨らむ。SES に渡す前に頭を押さえる。
const MAX_BODY_BYTES = 100_000;

const TURNSTILE_FIELD = "cf-turnstile-response";

type Env = {
    CONFIG: KVNamespace;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
};

type SiteConfig = {
    v: number;
    label: string;
    allowed_origins: string[];
    turnstile_secret: string;
    mail_from: string;
    mail_to: string;
    forms: string[];
};

type FieldOption = { value: string; label?: string };

type FieldDefinition = {
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    options?: FieldOption[];
    validation?: { pattern?: string; minLength?: number; maxLength?: number; message?: string };
};

type FormDefinition = { v: number; fields: FieldDefinition[] };

export async function onRequest(
    { request, params, env }: { request: Request; params: Record<string, string | string[]>; env: Env }
): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const siteKey = first(params.site);
    const slug = first(params.slug);

    // 設定を引く前は、どのオリジンを許可すべきか分からない。
    // 未知のサイトに対しては許可を出さない。
    const config = siteKey ? await readJson<SiteConfig>(env.CONFIG, `site:${siteKey}`) : null;

    const allowOrigin = config && config.allowed_origins.includes(origin) ? origin : "";
    const corsHeaders = {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    if (!config || !slug) {
        return json({ error: "Unknown site" }, 404, corsHeaders);
    }

    if (config.v !== SUPPORTED_SCHEMA_VERSION) {
        console.error(`unsupported site schema version ${config.v} for site:${siteKey}`);
        return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
    }

    if (!config.forms.includes(slug)) {
        return json({ error: "Unknown form" }, 404, corsHeaders);
    }

    const definition = await readJson<FormDefinition>(env.CONFIG, `form:${siteKey}:${slug}`);
    if (!definition || definition.v !== SUPPORTED_SCHEMA_VERSION) {
        console.error(`form definition missing or unsupported: form:${siteKey}:${slug}`);
        return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json<Record<string, unknown>>();
    } catch {
        return json({ error: "Invalid JSON" }, 400, corsHeaders);
    }

    const token = body[TURNSTILE_FIELD];
    if (typeof token !== "string" || token === "" || !config.turnstile_secret) {
        return json({ error: "Missing Turnstile verification" }, 400, corsHeaders);
    }

    const verifyResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
            secret: config.turnstile_secret,
            response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || "",
        }),
    });
    const verifyResult = await verifyResp.json<{ success: boolean; "error-codes"?: string[] }>();
    if (!verifyResult.success) {
        console.warn("Turnstile verification failed:", verifyResult);
        return json({ error: "Turnstile verification failed" }, 403, corsHeaders);
    }

    // 保存された定義に照らして検証する。
    // これが無いと、Turnstile を通した相手が任意のキーと値を送り込め、
    // それがそのままメール本文になる（検証済みドメインからの送信を他人に握らせる）。
    const errors = validate(body, definition.fields);
    if (errors.length > 0) {
        return json({ error: "Validation failed", details: errors }, 422, corsHeaders);
    }

    const textBody = buildBody(body, definition.fields);
    if (new TextEncoder().encode(textBody).length > MAX_BODY_BYTES) {
        return json({ error: "Submission is too large" }, 413, corsHeaders);
    }

    // 件名の表示名はサーバが保持する値を使う。クライアントの申告値は使わない。
    const subject = `【FormPlant】お問い合わせ from ${config.label}`;

    const client = new SESv2Client({
        region: env.AWS_REGION,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
    });

    const command = new SendEmailCommand({
        FromEmailAddress: config.mail_from,
        Destination: { ToAddresses: [ config.mail_to ] },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: { Text: { Data: textBody, Charset: "UTF-8" } },
            },
        },
    });

    try {
        await client.send(command);
        return json({ success: true }, 200, corsHeaders);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "SES送信に失敗しました";
        console.error("SES send error:", error);
        return json({ error: message }, 500, corsHeaders);
    }
}

// 定義に無いキーは拒否する。緩めると任意の内容がメール本文に載る。
function validate(body: Record<string, unknown>, fields: FieldDefinition[]): string[] {
    const errors: string[] = [];
    const known = new Set(fields.map((f) => f.name));
    known.add(TURNSTILE_FIELD);

    for (const key of Object.keys(body)) {
        if (!known.has(key)) errors.push(`${key} は定義にありません`);
    }

    for (const field of fields) {
        if (field.type === "turnstile") continue;

        const value = body[field.name];
        const label = field.label || field.name;

        if (field.type === "checkbox") {
            if (typeof value !== "boolean" && value !== undefined) {
                errors.push(`${label} の形式が正しくありません`);
            } else if (field.required && value !== true) {
                errors.push(`${label} をチェックしてください`);
            }
            continue;
        }

        if (value === undefined || value === null) {
            if (field.required) errors.push(`${label} を入力してください`);
            continue;
        }

        if (typeof value !== "string") {
            errors.push(`${label} の形式が正しくありません`);
            continue;
        }

        if (field.required && value.trim() === "") {
            errors.push(`${label} を入力してください`);
            continue;
        }

        if (value === "") continue;

        const rules = field.validation;
        if (rules?.minLength !== undefined && value.length < rules.minLength) {
            errors.push(rules.message || `${label} は最低 ${rules.minLength} 文字です`);
        }
        if (rules?.maxLength !== undefined && value.length > rules.maxLength) {
            errors.push(rules.message || `${label} は最大 ${rules.maxLength} 文字です`);
        }
        if (rules?.pattern) {
            let matches = false;
            try {
                matches = new RegExp(rules.pattern).test(value);
            } catch {
                // 定義側の正規表現が壊れている。通してしまうと検証が骨抜きになる。
                console.error(`invalid pattern in definition for field ${field.name}`);
            }
            if (!matches) errors.push(rules.message || `${label} の形式が正しくありません`);
        }

        // select と radio は定義された選択肢だけを許す。
        if (field.options && !field.options.some((option) => option.value === value)) {
            errors.push(`${label} の選択が正しくありません`);
        }
    }

    return errors;
}

// 定義の順序とラベルで本文を組む。定義に無いキーは validate が弾いている。
function buildBody(body: Record<string, unknown>, fields: FieldDefinition[]): string {
    return fields
        .filter((field) => field.type !== "turnstile")
        .map((field) => {
            const raw = body[field.name];
            const value = typeof raw === "boolean" ? (raw ? "はい" : "いいえ") : String(raw ?? "");
            return `${field.label || field.name}: ${value}`;
        })
        .join("\n");
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
    const raw = await kv.get(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        console.error(`value is not valid JSON: ${key}`);
        return null;
    }
}

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
}
