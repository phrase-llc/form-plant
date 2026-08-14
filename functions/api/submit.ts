// SESv2 (REST-JSON) を使う。classic SES は XML を返し、その応答解析が
// @aws-sdk/xml-builder の browser 版（DOMParser 依存）に解決されて workerd で落ちる。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// 例外は return を経由しないので、return 側に corsHeaders を撒くだけでは足りない。
export async function onRequest(
    ctx: { request: Request; env: Record<string, string> }
): Promise<Response> {
    try {
        return await handleSubmit(ctx);
    } catch (error) {
        console.error("Submit failed:", error);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeadersFor(ctx.request, ctx.env) },
        });
    }
}

function corsHeadersFor(request: Request, env: Record<string, string>): Record<string, string> {
    const origin = request.headers.get("Origin") || "";
    // catch から呼ぶので投げてはいけない。TOML では配列や数値も書ける。
    const allowedOrigins = String(env?.ALLOWED_ORIGINS ?? "").split(",").map(o => o.trim());
    const allowOrigin = allowedOrigins.includes(origin) ? origin : "";

    return {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

async function handleSubmit(
    { request, env }: { request: Request; env: Record<string, string> }
): Promise<Response> {
    const corsHeaders = corsHeadersFor(request, env);

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    let body: Record<string, any>;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // ✅ Turnstile 検証
    const token = body["cf-turnstile-response"];
    if (!token || !env.TURNSTILE_SECRET_KEY) {
        return new Response(JSON.stringify({ error: "Missing Turnstile verification" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const verifyResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET_KEY,
            response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || "",
        }),
    });

    // 上流の障害を、検証が NG だった 403 と混同しないよう分ける。
    if (!verifyResp.ok) {
        console.error("Turnstile siteverify error:", verifyResp.status);
        return new Response(JSON.stringify({ error: "Turnstile verification unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const verifyResult = await verifyResp.json<{ success: boolean; "error-codes"?: string[] }>();
    if (!verifyResult.success) {
        console.warn("Turnstile verification failed:", verifyResult);
        return new Response(JSON.stringify({ error: "Turnstile verification failed" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // ✅ メール送信
    const lpCode = body.lp_code || "unknown";
    const textBody = Object.entries(body)
        .filter(([key]) => key !== "cf-turnstile-response")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");

    const subject = `【FormPlant】お問い合わせ from ${lpCode}`;

    const client = new SESv2Client({
        region: env.AWS_REGION,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
    });

    const command = new SendEmailCommand({
        FromEmailAddress: env.SES_FROM_ADDRESS,
        Destination: {
            ToAddresses: [env.SES_TO_ADDRESS],
        },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: {
                    Text: { Data: textBody, Charset: "UTF-8" },
                },
            },
        },
    });

    try {
        await client.send(command);
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    } catch (error) {
        console.error("SES send error:", error);
        return new Response(JSON.stringify({ error: "Email delivery failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
}
