export async function onRequest(context: any): Promise<Response> {
    const request = context.request;

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*", // セキュリティ強化するなら特定ドメインに限定
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    // CORS プリフライト対応
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

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    const { name, email, message, lp_code } = body;

    if (!name || !email || !message) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // ここでログ記録やバリデーション、SES連携などを今後追加
    console.log(`[FormPlant] from ${lp_code}:`, { name, email, message });

    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
    });
}
