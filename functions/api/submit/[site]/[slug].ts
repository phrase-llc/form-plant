// 送信の受付。`POST /api/submit/:site_key/:slug`
//
// 設定は KV の `site:<site_key>` から読む。環境変数のグローバル設定は使わない。
// 旧 `/api/submit`（環境変数版）は移行のあいだ併存させ、LP の差し替えが済んでから消す。
//
// site_key をパスに置いているのは CORS の都合である。
// preflight（OPTIONS）はリクエストボディを持たないため、body に site_key を入れると
// どのオリジンを許可すべきか preflight の時点で判定できない。
//
// クライアントが送るのは「どの設定を引くか」だけで、送信先も検証内容も
// サーバが保持する値だけを使う。
//
// なお `allowed_origins` はブラウザ向けの制御であって認可ではない。
// `Origin` はブラウザ以外のクライアントが自由に付けられるので、ここで 403 を返しても
// 効果がない。実際の門は Turnstile だけである。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// console 側の SiteProjection::SCHEMA_VERSION と対応する。
const SUPPORTED_SCHEMA_VERSION = 1;

// ボディを読む前に見る上限。読んでから捨てるのでは、拒否するリクエストに
// パースの費用を払うことになる。Content-Length が無い場合（chunked）は
// 下の MAX_BODY_BYTES が最後の砦になる。
const MAX_REQUEST_BYTES = 200_000;

// メール本文の上限。定義側の maxLength をすべて満たしても、
// 項目数が多ければ本文は膨らむ。SES に渡す前に頭を押さえる。
const MAX_BODY_BYTES = 100_000;

// 定義側が maxLength を書いていないフィールドにも効く絶対上限。
// メール本文の総量を抑えるためのもので、これは ReDoS の対策にはならない。
// 破滅的バックトラッキングは入力長に対して指数的なので、35文字で既に数十秒かかる。
// 上限をどこに置いてもその手前で破綻する。危険なパターンは unsafePattern() で弾く。
const MAX_FIELD_LENGTH = 8_000;

const TURNSTILE_FIELD = "cf-turnstile-response";

type Env = {
    CONFIG: KVNamespace;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
};

type SiteConfig = {
    v: number;
    label: string;
    allowed_origins: string[];
    turnstile_secret: string;
    mail_from: string;
    mail_to: string;
    forms: string[];
};

type FieldOption = { value: string; label?: string };

type FieldDefinition = {
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    options?: FieldOption[];
    validation?: { pattern?: string; minLength?: number; maxLength?: number; message?: string };
};

type FormDefinition = { v: number; fields: FieldDefinition[] };

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

        // 定義側の正規表現は、値を見る前にまとめてコンパイルする。
        // 壊れていればサーバ設定の不具合なので、送信者に検証エラーを返しても直せない。
        const patterns = new Map<string, RegExp>();
        for (const field of definition.fields) {
            const source = field.validation?.pattern;
            if (!source) continue;

            if (unsafePattern(source)) {
                console.error(`pattern may backtrack catastrophically, field ${field.name}: ${source}`);
                return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
            }

            try {
                // HTML の pattern 属性と同じ完全一致にする。アンカー無しのままだと
                // `\d{10,11}` を指定したフィールドに任意の長い文字列を通せる。
                patterns.set(field.name, new RegExp(`^(?:${source})$`));
            } catch {
                console.error(`invalid pattern in definition for field ${field.name}`);
                return json({ error: "Configuration is unavailable" }, 500, corsHeaders);
            }
        }

        // 保存された定義に照らして検証する。
        // これが無いと、Turnstile を通した相手が任意のキーと値を送り込め、
        // それがそのままメール本文になる（検証済みドメインからの送信を他人に握らせる）。
        const errors = validate(body, definition.fields, patterns);
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

// 定義側の正規表現が破滅的バックトラッキングを起こしうるかを見る。
//
// これは判定ではなく検知の試みである。ReDoS を一般に判定することはできないので、
// ここでは実害のほぼ全てを占める形――量指定子を含むグループに、上限の無い量指定子が
// さらに付いている形（`(a+)+`、`(\d+)*`、`(a+){2,}`）――だけを弾く。
// 選択肢の重なりによるもの（`(a|a)*`）は検知できない。
//
// 根治は `pattern` に任意の正規表現を書かせるのをやめて、名前付きの書式から
// 選ばせる形にすることで、これは console 側の設計変更になる。
// それまでのあいだ、この関数が既知の形を止める。
//
// 同じ判定を public/contact-form.js にも置いている。あちらはビルド無しの
// 素のスクリプトなので共有できない。片方だけ直すと、もう片方で固まる。
function unsafePattern(source: string): boolean {
    const enclosing: boolean[] = [];
    let quantifierInScope: boolean = false;
    let inClass: boolean = false;

    for (let i = 0; i < source.length; i++) {
        const c = source[i];

        if (c === "\\") { i++; continue; }
        if (inClass) { if (c === "]") inClass = false; continue; }

        if (c === "[") { inClass = true; continue; }

        if (c === "(") {
            enclosing.push(quantifierInScope);
            quantifierInScope = false;
            continue;
        }

        if (c === ")") {
            const bodyHadQuantifier: boolean = quantifierInScope;
            // 入れ子のグループの中で見た量指定子も、外側から見れば「中にある」ことになる。
            // 伝播させないと `((a+))+` を見逃す。
            quantifierInScope = (enclosing.pop() ?? false) || bodyHadQuantifier;
            const quantifier = quantifierAt(source, i + 1);
            if (quantifier === "open" && bodyHadQuantifier) return true;
            if (quantifier !== "none") quantifierInScope = true;
            continue;
        }

        if (c === "*" || c === "+") { quantifierInScope = true; continue; }
        if (c === "{" && quantifierAt(source, i) !== "none") { quantifierInScope = true; continue; }
    }

    return false;
}

// i の位置から始まる量指定子を見る。上限の無いもの（`*` `+` `{n,}`）を open とする。
// 上限があれば繰り返しは有限なので、組み合わせは多項式にとどまる。
function quantifierAt(source: string, i: number): "none" | "open" | "bounded" {
    const c = source[i];
    if (c === "*" || c === "+") return "open";
    if (c === "?") return "bounded";
    if (c !== "{") return "none";

    const end = source.indexOf("}", i);
    if (end === -1) return "none";

    const body = source.slice(i + 1, end);
    if (body === "" || !/^\d*(,\d*)?$/.test(body)) return "none";
    return body.endsWith(",") ? "open" : "bounded";
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

// 定義に無いキーは拒否する。緩めると任意の内容がメール本文に載る。
function validate(
    body: Record<string, unknown>,
    fields: FieldDefinition[],
    patterns: Map<string, RegExp>
): string[] {
    const errors: string[] = [];
    const known = new Set(fields.map((f) => f.name));
    known.add(TURNSTILE_FIELD);

    for (const key of Object.keys(body)) {
        if (!known.has(key)) errors.push(`${key} は定義にありません`);
    }

    for (const field of fields) {
        if (field.type === "turnstile") continue;

        const value = body[field.name];
        const label = field.label || field.name;

        if (field.type === "checkbox") {
            if (typeof value !== "boolean" && value !== undefined) {
                errors.push(`${label} の形式が正しくありません`);
            } else if (field.required && value !== true) {
                errors.push(`${label} をチェックしてください`);
            }
            continue;
        }

        if (value === undefined || value === null) {
            if (field.required) errors.push(`${label} を入力してください`);
            continue;
        }

        if (typeof value !== "string") {
            errors.push(`${label} の形式が正しくありません`);
            continue;
        }

        if (field.required && value.trim() === "") {
            errors.push(`${label} を入力してください`);
            continue;
        }

        if (value === "") continue;

        // 長さの検査を先に済ませ、超えていたらパターンまで進めない。
        // 正規表現は入力長に対して指数的に時間を食うことがあるため、
        // 長さで縛る前に走らせるわけにはいかない。
        const rules = field.validation;
        if (value.length > MAX_FIELD_LENGTH) {
            errors.push(`${label} は最大 ${MAX_FIELD_LENGTH} 文字です`);
            continue;
        }
        if (rules?.maxLength !== undefined && value.length > rules.maxLength) {
            errors.push(rules.message || `${label} は最大 ${rules.maxLength} 文字です`);
            continue;
        }
        if (rules?.minLength !== undefined && value.length < rules.minLength) {
            errors.push(rules.message || `${label} は最低 ${rules.minLength} 文字です`);
            continue;
        }

        const pattern = patterns.get(field.name);
        if (pattern && !pattern.test(value)) {
            errors.push(rules?.message || `${label} の形式が正しくありません`);
        }

        // select と radio は定義された選択肢だけを許す。
        if (field.options && !field.options.some((option) => option.value === value)) {
            errors.push(`${label} の選択が正しくありません`);
        }
    }

    return errors;
}

// 定義の順序とラベルで本文を組む。定義に無いキーは validate が弾いている。
function buildBody(body: Record<string, unknown>, fields: FieldDefinition[]): string {
    return fields
        .filter((field) => field.type !== "turnstile")
        .map((field) => {
            const raw = body[field.name];
            const value = typeof raw === "boolean" ? (raw ? "はい" : "いいえ") : String(raw ?? "");
            const label = field.label || field.name;
            // 値の改行をそのまま流すと、`お名前: 別人` と書いた本文が
            // 受信者には別のフィールドとして届いたように見える。
            // 複数行の値は字下げしてラベル行と区別する。
            if (!value.includes("\n")) return `${label}: ${value}`;
            return `${label}:\n  ${value.split("\n").join("\n  ")}`;
        })
        .join("\n");
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

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
}
