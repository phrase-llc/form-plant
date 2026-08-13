// SESv2 (REST-JSON) を使う。classic SES は XML を返し、その応答解析が
// @aws-sdk/xml-builder の browser 版（DOMParser 依存）に解決されて workerd で落ちる。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

type Env = {
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    SES_FROM_ADDRESS: string;
    SES_TO_ADDRESS: string;
    TURNSTILE_SECRET_KEY: string;
    ALLOWED_ORIGINS: string;
    SITE_LABEL?: string;
};

export async function onRequest(
    { request, env }: { request: Request; env: Env }
): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim());
    const allowOrigin = allowedOrigins.includes(origin) ? origin : "";

    const corsHeaders = {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        // ACAO を Origin ごとに組み立てているので、キャッシュ層が前に入ったときに備える。
        "Vary": "Origin",
    };

    // 例外が飛ぶと明示的な return を経由しないため、Pages が CORS ヘッダの無い
    // 素の 500 を返し、本文にスタックトレースが載る。
    // ブラウザ側からは原因の分からない CORS エラーになる。
    try {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method !== "POST") {
            return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
        }

        let body: Record<string, unknown>;
        try {
            body = await request.json<Record<string, unknown>>();
        } catch {
            return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
        }

        if (typeof body !== "object" || body === null) {
            return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
        }

        const token = body["cf-turnstile-response"];
        if (typeof token !== "string" || token === "" || !env.TURNSTILE_SECRET_KEY) {
            return jsonResponse({ error: "Missing Turnstile verification" }, 400, corsHeaders);
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
        // そのまま json() に渡すと throw する。
        if (!verifyResp.ok) {
            console.error(`turnstile siteverify returned ${verifyResp.status}`);
            return jsonResponse({ error: "Turnstile verification is unavailable" }, 503, corsHeaders);
        }

        const verifyResult = await verifyResp.json<{ success: boolean; "error-codes"?: string[] }>();
        if (!verifyResult.success) {
            console.warn("Turnstile verification failed:", verifyResult);
            return jsonResponse({ error: "Turnstile verification failed" }, 403, corsHeaders);
        }

        const textBody = Object.entries(body)
            .filter(([key]) => key !== "cf-turnstile-response")
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n");

        // 件名の表示名はサーバが持つ値だけから決める。以前はクライアントが送る
        // lp_code を入れていたので、件名の一部を送信者が決められた。
        //
        // SITE_LABEL が無いときは許可オリジンで代用する。origin はクライアントが
        // 申告する値だが、allowOrigin は ALLOWED_ORIGINS に載っている文字列しか
        // 取らないので、任意の文字列を差し込むことはできない。1つのデプロイが
        // 複数の LP を受けている場合、これが唯一の判別材料になる。
        const label = env.SITE_LABEL || allowOrigin;
        const subject = label
            ? `【FormPlant】お問い合わせ from ${label}`
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
            Destination: { ToAddresses: [env.SES_TO_ADDRESS] },
            Content: {
                Simple: {
                    Subject: { Data: subject, Charset: "UTF-8" },
                    Body: { Text: { Data: textBody, Charset: "UTF-8" } },
                },
            },
        });

        await client.send(command);
        return jsonResponse({ success: true }, 200, corsHeaders);
    } catch (error: unknown) {
        // SES のエラー文は検証済みでないアドレスなど AWS 側の事情を含む。
        // ウィジェットはサーバの文字列を画面に出しうるので、送信者には渡さない。
        console.error("submit failed:", error);
        return jsonResponse({ error: "送信に失敗しました" }, 500, corsHeaders);
    }
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
}
