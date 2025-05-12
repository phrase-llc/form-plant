import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export async function onRequest({ request, env }: { request: Request; env: Record<string, string> }): Promise<Response> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
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

    if (!body.lp_code) {
        return new Response(JSON.stringify({ error: "Missing lp_code" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const lpCode = body.lp_code;
    const textBody = Object.entries(body)
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
