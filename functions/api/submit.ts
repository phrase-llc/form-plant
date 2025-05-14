import {SendEmailCommand, SESClient} from "@aws-sdk/client-ses";

function isAllowedOrigin(origin: string | null, allowedList: string[]): boolean {
    return origin !== null && allowedList.includes(origin);
}

export async function onRequest(
    { request, env }: { request: Request; env: Record<string, any> }
): Promise<Response> {
    const origin = request.headers.get("Origin") || "";

    // 初期ヘッダー（仮、あとで上書き）
    const corsHeaders = {
        "Access-Control-Allow-Origin": "",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
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

    const lpCode = body.lp_code;

    if (!lpCode) {
        return new Response(JSON.stringify({ error: "Missing lp_code" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // 🔑 KVから origins と Turnstile 秘密キーを取得
    const [originsRaw, turnstileSecret] = await Promise.all([
        env.CORS.get(`formplant:${lpCode}:origins`),
        env.CORS.get(`formplant:${lpCode}:turnstile`)
    ]);

    if (!originsRaw || !turnstileSecret) {
        return new Response(JSON.stringify({ error: "Unknown lp_code or missing configuration" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const allowedOrigins: string[] = JSON.parse(originsRaw);
    corsHeaders["Access-Control-Allow-Origin"] = isAllowedOrigin(origin, allowedOrigins) ? origin : "";

    // ✅ Turnstile トークン検証
    const token = body["cf-turnstile-response"];
    if (!token) {
        return new Response(JSON.stringify({ error: "Missing Turnstile token" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const verifyResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
            secret: turnstileSecret,
            response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || "",
        }),
    });

    const verifyResult = await verifyResp.json();
    if (!verifyResult.success) {
        console.warn("Turnstile verification failed:", verifyResult);
        return new Response(JSON.stringify({ error: "Turnstile verification failed" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // ✅ メール本文生成
    const textBody = Object.entries(body)
        .filter(([key]) => key !== "cf-turnstile-response")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");

    const subject = `【FormPlant】お問い合わせ from ${lpCode}`;

    const client = new SESClient({
        region: env.AWS_REGION,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
    });

    const command = new SendEmailCommand({
        Source: env.SES_FROM_ADDRESS,
        Destination: {
            ToAddresses: [env.SES_TO_ADDRESS],
        },
        Message: {
            Subject: { Data: subject },
            Body: {
                Text: { Data: textBody },
            },
        },
    });

    try {
        await client.send(command);
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    } catch (error: any) {
        console.error("SES send error:", error);
        return new Response(JSON.stringify({ error: error.message || "SES送信に失敗しました" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
}
