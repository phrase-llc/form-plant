export async function onRequest({ request }: { request: Request }): Promise<Response> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*", // 必要に応じてオリジン制限
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    // OPTIONSプリフライト対応
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

    // 任意の必須項目（lp_code 以外）
    if (!body.lp_code) {
        return new Response(JSON.stringify({ error: "Missing lp_code" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    // 任意ログ出力（LP識別・送信内容）
    console.log(`[FormPlant] Submission from "${body.lp_code}":`, JSON.stringify(body));

    // この先に AWS SES などの送信処理を挿入可能

    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
    });
}
