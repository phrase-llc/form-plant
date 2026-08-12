// ルートが共通で使うレスポンスの組み立て。
//
// `json()` が1箇所にあるのは、CORS ヘッダを必ず spread するという規約を
// 守れる場所を1つに絞るためである。spread の漏れが実際に事故になっている
// （CLAUDE.md の corsHeaders の節）。

export function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
}
