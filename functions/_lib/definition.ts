// フォーム定義の形と、定義に基づく送信値の検証。
//
// 定義そのものは `public/forms/*.json` にあり、2つの経路で使われる。
// ウィジェットは静的配信されたものを fetch して描画に使い、送信の受付は
// 同じファイルを import してバンドルしたものを検証に使う。
// 1つのファイルなので、描画と検証がずれることがない。
//
// スキーマのバージョン番号は持たない。定義はコードと同じデプロイに乗るので、
// 両者が食い違う状態が作れない。実行時に設定を書き換える経路が無いことの利点である。
//
// なお `functions/` 配下にあってもリクエストハンドラを export しないファイルは
// ルートにならない（`/_lib/definition` は 404）。実測で確認している。

// 定義側が maxLength を書いていないフィールドにも効く絶対上限。
// メール本文の総量を抑えるためのもの。正規表現の実行時間の対策にはならない
// （増加が指数的なので、上限をどこに置いてもその手前で破綻する）。
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

export type FormDefinition = {
    // ウィジェットが送信先のパスを組むのに使う。
    slug: string;
    // メールの件名に入る表示名。このファイルは静的配信されるので、秘密は置かない。
    label?: string;
    messages?: Record<string, string>;
    fields: FieldDefinition[];
};

export type CompileResult =
    | { ok: true; patterns: Map<string, RegExp> }
    | { ok: false; reason: string };

// 定義側の正規表現を、値を見る前にまとめてコンパイルする。
// 使えないものが1つでもあれば定義ごと失敗させる。個別に飛ばすと、
// 検証されていないフィールドがあることに誰も気付かない。
//
// 正規表現が破滅的バックトラッキングを起こさないかは、ここでは見ない。
// 定義を書くのはこのリポジトリにコミットする人なので、検証は書く側に置く。
// 実行時に弾いても、訪問者に 500 が出るだけで、書いた本人には届かない。
export function compilePatterns(fields: FieldDefinition[]): CompileResult {
    const patterns = new Map<string, RegExp>();

    for (const field of fields) {
        const source = field.validation?.pattern;
        if (!source) continue;

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
