// 送信の受付。`POST /api/submit/:slug`
//
// 設定は環境変数から、フォーム定義は `public/forms/<slug>.json` から読む。
// 定義はバンドルに焼き込まれているので、実行時に読みに行く先が無い。
//
// 旧 `/api/submit` は移行のあいだ併存させ、LP の差し替えが済んでから消す。
// 違いは、こちらが定義に照らして送信値を検証することだけである。
//
// `ALLOWED_ORIGINS` はブラウザ向けの制御であって認可ではない。`Origin` は
// ブラウザ以外のクライアントが自由に付けられるので、ここで 403 を返しても効果がない。
// 実際の門は Turnstile だけである。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { TURNSTILE_FIELD, buildBody, compilePatterns, validate } from "../../_lib/definition";
import { FORMS } from "../../_lib/forms";
import { first, json } from "../../_lib/http";

// ボディを読む前に見る上限。読んでから捨てるのでは、拒否するリクエストに
// パースの費用を払うことになる。Content-Length が無い場合（chunked）は
// 下の MAX_BODY_BYTES が最後の砦になる。
const MAX_REQUEST_BYTES = 200_000;

// メール本文の上限。定義側の maxLength をすべて満たしても、
// 項目数が多ければ本文は膨らむ。SES に渡す前に頭を押さえる。
const MAX_BODY_BYTES = 100_000;

type Env = {
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    SES_FROM_ADDRESS: string;
    SES_TO_ADDRESS: string;
    TURNSTILE_SECRET_KEY: string;
    ALLOWED_ORIGINS: string;
};

export async function onRequest(
    { request, params, env }: { request: Request; params: Record<string, string | string[]>; env: Env }
): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

    const corsHeaders = {
        "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        // 許可判定は Origin ごとに変わる。前段でキャッシュされたときに
        // 別のオリジン向けの判定が使い回されないようにする。
        "Vary": "Origin",
    };

    try {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method !== "POST") {
            return json({ error: "Method not allowed" }, 405, corsHeaders);
        }

        const slug = first(params.slug);
        const definition = slug ? FORMS[slug] : undefined;
        if (!definition) {
            return json({ error: "Not found" }, 404, corsHeaders);
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
                secret: env.TURNSTILE_SECRET_KEY,
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

        // 使えないパターンは定義の不備なので、送信者に検証エラーを返しても直せない。
        const compiled = compilePatterns(definition.fields);
        if (!compiled.ok) {
            console.error(`unusable pattern in forms/${slug}.json: ${compiled.reason}`);
            return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
        }

        // 保存された定義に照らして検証する。
        // これが無いと、Turnstile を通した相手が任意のキーと値を送り込め、
        // それがそのままメール本文になる（検証済みドメインからの送信を他人に握らせる）。
        const errors = validate(body, definition.fields, compiled.patterns);
        if (errors.length > 0) {
            return json({ error: "Validation failed", details: errors }, 422, corsHeaders);
        }

        const textBody = buildBody(body, definition.fields);
        if (new TextEncoder().encode(textBody).length > MAX_BODY_BYTES) {
            return json({ error: "Submission is too large" }, 413, corsHeaders);
        }

        const subject = definition.label
            ? `【FormPlant】お問い合わせ from ${definition.label}`
            : "【FormPlant】お問い合わせ";

        const client = new SESv2Client({
            region: env.AWS_REGION,
            credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
        });

        const command = new SendEmailCommand({
            FromEmailAddress: env.SES_FROM_ADDRESS,
            Destination: { ToAddresses: [ env.SES_TO_ADDRESS ] },
            Content: {
                Simple: {
                    Subject: { Data: subject, Charset: "UTF-8" },
                    Body: { Text: { Data: textBody, Charset: "UTF-8" } },
                },
            },
        });

        await client.send(command);
        return json({ success: true }, 200, corsHeaders);
    } catch (error: unknown) {
        // SES のエラーは検証済みでないアドレスなど AWS 側の事情を含む。
        // ウィジェットはこの文字列を画面に出すので、送信者には渡さない。
        // 素の 500 にすると CORS ヘッダも付かず、ブラウザ側では原因が分からなくなる。
        console.error("submit failed:", error);
        return json({ error: "Internal error" }, 500, corsHeaders);
    }
}
