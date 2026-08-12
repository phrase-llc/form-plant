// フォーム定義の配信。`GET /api/form/:site/:slug`
//
// console が KV に投影した `form:<site_key>:<slug>` をそのまま返す。
// このレスポンスは公開なので、secret を含むレコード（`site:<site_key>`）は
// 絶対に読まない。キーを2種類に分けているのはそのためである。
//
// 取得は LP のページビューごとに発生する。送信の回数ではなくページビューに
// 比例するので、この経路が最もトラフィックが多い。キャッシュを効かせる。

// console 側の SiteProjection::SCHEMA_VERSION と対応する。
// 知らないバージョンは黙って通さず、明示的に失敗させる。
const SUPPORTED_SCHEMA_VERSION = 1;

// console で定義を編集してから反映されるまでの最大の遅れ。
const CACHE_MAX_AGE_SECONDS = 60;

type Env = { CONFIG: KVNamespace };

export async function onRequest(
    { request, params, env }: { request: Request; params: Record<string, string | string[]>; env: Env }
): Promise<Response> {
    // 定義は公開情報なので、どのオリジンからでも取得できてよい。
    // 送信の許可判定は /api/submit 側が Origin と allowed_origins で行う。
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    const site = first(params.site);
    const slug = first(params.slug);
    if (!site || !slug) {
        return json({ error: "Not found" }, 404, corsHeaders);
    }

    const raw = await env.CONFIG.get(`form:${site}:${slug}`);
    if (raw === null) {
        return json({ error: "Not found" }, 404, corsHeaders);
    }

    let definition: { v?: number };
    try {
        definition = JSON.parse(raw);
    } catch {
        // KV に壊れた値が入っている。呼び出し側には内部事情を出さない。
        console.error(`form definition is not valid JSON: form:${site}:${slug}`);
        return json({ error: "Form definition is unavailable" }, 500, corsHeaders);
    }

    if (definition.v !== SUPPORTED_SCHEMA_VERSION) {
        // console 側が先にスキーマを上げた場合。古い解釈で配信すると
        // 気付かないまま挙動が変わるので、明示的に失敗させる。
        console.error(`unsupported schema version ${definition.v} for form:${site}:${slug}`);
        return json({ error: "Form definition is unavailable" }, 500, corsHeaders);
    }

    return new Response(raw, {
        status: 200,
        headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
        },
    });
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
