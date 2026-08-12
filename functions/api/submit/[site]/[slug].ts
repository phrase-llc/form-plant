// 送信の受付。`POST /api/submit/:site_key/:slug`
//
// 設定は KV の `site:<site_key>` から読む。旧 `/api/submit`（環境変数版）は
// 移行のあいだ併存させ、LP の差し替えが済んでから消す。
//
// site_key をパスに置いているのは CORS の都合である。
// preflight（OPTIONS）はリクエストボディを持たないため、body に site_key を入れると
// どのオリジンを許可すべきか preflight の時点で判定できない。
//
// `allowed_origins` はブラウザ向けの制御であって認可ではない。`Origin` は
// ブラウザ以外のクライアントが自由に付けられるので、ここで 403 を返しても効果がない。
// 実際の門は Turnstile だけである。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
    SUPPORTED_SCHEMA_VERSION,
    TURNSTILE_FIELD,
    buildBody,
    compilePatterns,
    validate,
    type FormDefinition,
    type SiteConfig,
} from "../../../_lib/definition";
import { first, json } from "../../../_lib/http";

// ボディを読む前に見る上限。読んでから捨てるのでは、拒否するリクエストに
// パースの費用を払うことになる。Content-Length が無い場合（chunked）は
// 下の MAX_BODY_BYTES が最後の砦になる。
const MAX_REQUEST_BYTES = 200_000;

// メール本文の上限。定義側の maxLength をすべて満たしても、
// 項目数が多ければ本文は膨らむ。SES に渡す前に頭を押さえる。
const MAX_BODY_BYTES = 100_000;

type Env = {
    CONFIG: KVNamespace;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
};

export async function onRequest(
    { request, params, env }: { request: Request; params: Record<string, string | string[]>; env: Env }
): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const siteKey = first(params.site);
    const slug = first(params.slug);

    // 設定を読む前は、どのオリジンを許可すべきか分からない。
    // 例外が飛んだときもこの値で返す。ヘッダを落とすと、実際のエラーが
    // ブラウザには不透明な CORS 失敗として見えてしまう。
    let corsHeaders = corsFor("");

    try {
        const config = siteKey ? await readJson<SiteConfig>(env.CONFIG, `site:${siteKey}`) : null;

        // バージョンと形の検査は allowed_origins を使う前に済ませる。
        // 知らないバージョンのレコードを CORS 判定に使うと、構造が変わっていれば
        // 落ちるし、意味が拡張されていれば古い解釈が黙って適用される。
        const usable = usableSiteConfig(config, siteKey);
        if (usable && usable.allowed_origins.includes(origin)) {
            corsHeaders = corsFor(origin);
        }

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method !== "POST") {
            return json({ error: "Method not allowed" }, 405, corsHeaders);
        }

        // site_key の有無と slug の有無を出し分けない。どちらも同じ 404 にする。
        if (!config || !slug) {
            return json({ error: "Not found" }, 404, corsHeaders);
        }

        if (!usable) {
            return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
        }

        if (!usable.forms.includes(slug)) {
            return json({ error: "Not found" }, 404, corsHeaders);
        }

        const definition = await readJson<FormDefinition>(env.CONFIG, `form:${siteKey}:${slug}`);
        if (!definition || definition.v !== SUPPORTED_SCHEMA_VERSION || !Array.isArray(definition.fields)) {
            console.error(`form definition missing or unusable: form:${siteKey}:${slug}`);
            return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
        }

        const declaredLength = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
            return json({ error: "Submission is too large" }, 413, corsHeaders);
        }

        let body: Record<string, unknown>;
        try {
            body = await request.json<Record<string, unknown>>();
        } catch {
            return json({ error: "Invalid JSON" }, 400, corsHeaders);
        }

        const token = body[TURNSTILE_FIELD];
        if (typeof token !== "string" || token === "") {
            return json({ error: "Missing Turnstile verification" }, 400, corsHeaders);
        }

        const verifyResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            body: new URLSearchParams({
                secret: usable.turnstile_secret,
                response: token,
                remoteip: request.headers.get("CF-Connecting-IP") || "",
            }),
        });
        // siteverify が 5xx や HTML のエラーページを返すことがある。
        // json() に渡すと throw するので、先に見る。
        if (!verifyResp.ok) {
            console.error(`turnstile siteverify returned ${verifyResp.status}`);
            return json({ error: "Turnstile verification is unavailable" }, 503, corsHeaders);
        }
        const verifyResult = await verifyResp.json<{ success: boolean; "error-codes"?: string[] }>();
        if (!verifyResult.success) {
            console.warn("Turnstile verification failed:", verifyResult);
            return json({ error: "Turnstile verification failed" }, 403, corsHeaders);
        }

        // 使えないパターンは設定の不備なので、送信者に検証エラーを返しても直せない。
        const compiled = compilePatterns(definition.fields);
        if (!compiled.ok) {
            console.error(`unusable pattern in form:${siteKey}:${slug}: ${compiled.reason}`);
            return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
        }

        const errors = validate(body, definition.fields, compiled.patterns);
        if (errors.length > 0) {
            return json({ error: "Validation failed", details: errors }, 422, corsHeaders);
        }

        const textBody = buildBody(body, definition.fields);
        if (new TextEncoder().encode(textBody).length > MAX_BODY_BYTES) {
            return json({ error: "Submission is too large" }, 413, corsHeaders);
        }

        // 件名の表示名はサーバが保持する値を使う。クライアントの申告値は使わない。
        const subject = `【FormPlant】お問い合わせ from ${usable.label}`;

        const client = new SESv2Client({
            region: env.AWS_REGION,
            credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
        });

        const command = new SendEmailCommand({
            FromEmailAddress: usable.mail_from,
            Destination: { ToAddresses: [ usable.mail_to ] },
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
            // SES のエラーは検証済みでないアドレスなど AWS 側の事情を含む。
            // ウィジェットはこの文字列を画面に出すので、送信者には渡さない。
            console.error("SES send error:", error);
            return json({ error: "Internal error" }, 500, corsHeaders);
        }
    } catch (error: unknown) {
        // KV のレコードが想定外の形だと、上の検査を抜けた先で TypeError が飛ぶ。
        // 素の 500 にすると CORS ヘッダが付かず、ブラウザ側では原因が分からなくなる。
        console.error("unhandled error in submit handler:", error);
        return json({ error: "Internal error" }, 500, corsHeaders);
    }
}

// レコードが使える形かを検査する。使えなければ null を返す。
// KV の中身は console が書いたものだが、ここで信用すると
// 形の崩れが CORS ヘッダ無しの 500 になって現れる。
function usableSiteConfig(config: SiteConfig | null, siteKey: string | undefined): SiteConfig | null {
    if (!config) return null;

    if (config.v !== SUPPORTED_SCHEMA_VERSION) {
        console.error(`unsupported site schema version ${config.v} for site:${siteKey}`);
        return null;
    }

    // 文字列だと String.prototype.includes が働いてしまい、部分文字列のオリジンまで
    // 許可される。配列であることを確かめる。
    if (!Array.isArray(config.allowed_origins) || !Array.isArray(config.forms)) {
        console.error(`site config has unexpected shape: site:${siteKey}`);
        return null;
    }

    if (typeof config.turnstile_secret !== "string" || config.turnstile_secret === "") {
        console.error(`site config has no turnstile secret: site:${siteKey}`);
        return null;
    }

    return config;
}

function corsFor(allowOrigin: string): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        // 許可判定は Origin ごとに変わる。前段でキャッシュされたときに
        // 別のオリジン向けの判定が使い回されないようにする。
        "Vary": "Origin",
    };
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
