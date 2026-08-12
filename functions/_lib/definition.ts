// KV に置かれたサイト設定とフォーム定義の契約、および定義に基づく検証。
//
// 送信の受付と定義の配信の両方がこれを読む。バージョンと型をルートごとに持つと、
// 片方だけ上げたときに「配信は新スキーマ、送信は 500」という最も気付きにくい
// 壊れ方をするので、1箇所に置く。
//
// この定数は console 側の `SiteProjection::SCHEMA_VERSION` と対になっている。
// 形を変えるときは3点（配信・受付・console）を揃える。
//
// なお `functions/` 配下にあってもリクエストハンドラを export しないファイルは
// ルートにならない（`/_lib/definition` は 404）。実測で確認している。

export const SUPPORTED_SCHEMA_VERSION = 1;

// 定義側が maxLength を書いていないフィールドにも効く絶対上限。
// メール本文の総量を抑えるためのもので、ReDoS の対策にはならない（unsafePattern を参照）。
export const MAX_FIELD_LENGTH = 8_000;

export const TURNSTILE_FIELD = "cf-turnstile-response";

export type FieldOption = { value: string; label?: string };

export type FieldDefinition = {
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    options?: FieldOption[];
    validation?: { pattern?: string; minLength?: number; maxLength?: number; message?: string };
};

export type FormDefinition = { v: number; fields: FieldDefinition[] };

// ingest だけが読む。公開レスポンスには載らない。
export type SiteConfig = {
    v: number;
    label: string;
    allowed_origins: string[];
    turnstile_secret: string;
    mail_from: string;
    mail_to: string;
    forms: string[];
};

export type CompileResult =
    | { ok: true; patterns: Map<string, RegExp> }
    | { ok: false; reason: string };

// 定義側の正規表現を、値を見る前にまとめてコンパイルする。
// 使えないものが1つでもあれば定義ごと失敗させる。個別に飛ばすと、
// 検証されていないフィールドがあることに誰も気付かない。
export function compilePatterns(fields: FieldDefinition[]): CompileResult {
    const patterns = new Map<string, RegExp>();

    for (const field of fields) {
        const source = field.validation?.pattern;
        if (!source) continue;

        if (unsafePattern(source)) {
            return { ok: false, reason: `field ${field.name}: pattern may backtrack catastrophically: ${source}` };
        }

        try {
            // HTML の pattern 属性と同じ完全一致にする。アンカー無しのままだと
            // `\d{10,11}` を指定したフィールドに任意の長い文字列を通せる。
            patterns.set(field.name, new RegExp(`^(?:${source})$`));
        } catch {
            return { ok: false, reason: `field ${field.name}: pattern is not a valid regular expression` };
        }
    }

    return { ok: true, patterns };
}

// 正規表現が破滅的バックトラッキングを起こしうるかを見る。
//
// これは判定ではなく検知の試みである。ReDoS を一般に判定することはできないので、
// 実害のほぼ全てを占める形――量指定子を含むグループに、上限の無い量指定子が
// さらに付いている形（`(a+)+`、`(\d+)*`、`(a+){2,}`）――だけを弾く。
// 選択肢の重なりによるもの（`(a|a)*`）は検知できない。
//
// 長さで縛れば済む話ではない。増加が指数的なので、35文字で既に数十秒かかる。
// 上限をどこに置いてもその手前で破綻する。
//
// 根治は `pattern` に任意の正規表現を書かせるのをやめて、名前付きの書式から
// 選ばせる形にすることで、これは console 側の設計変更になる。
//
// 同じ判定を public/contact-form.js にも置いている。あちらはビルド無しの素の
// スクリプトなので共有できない。片方だけ直すと、もう片方でタブが固まる。
export function unsafePattern(source: string): boolean {
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

// 定義に無いキーは拒否する。緩めると任意の内容がメール本文に載る。
export function validate(
    body: Record<string, unknown>,
    fields: FieldDefinition[],
    patterns: Map<string, RegExp>
): string[] {
    const errors: string[] = [];
    const known = new Set(fields.map((f) => f.name));
    // 定義側が turnstile フィールドに別の name を付けていても、
    // ウィジェットが送るトークンのキーは常にこれ。
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
export function buildBody(body: Record<string, unknown>, fields: FieldDefinition[]): string {
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
