// 送信値の検証は、検証済みドメインから出るメールの内容を他人に握らせないための
// 境界である（CLAUDE.md の「validates every submitted value」の節）。
// typecheck もバンドル検査もこの論理の退行を検出しないので、ここで固定する。
//
// ランナーは Node 組み込みの `node --test`。依存は増やしていない。
// Node は型注釈を落として .ts をそのまま実行するので、ビルド手順も要らない。
//
// このファイルは tsc の対象外である（tsconfig の include は functions のみ）。
// 型を付けるには @types/node が要り、それを types に入れると functions/ 側でも
// process や Buffer が型として通ってしまう。workerd に無いものを型で許すのは、
// このリポジトリが DOM を外している理由と同じ理由で避けたい。
// テストは実行して自己検証するので、型検査の網は要らない。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_FIELD_LENGTH,
    TURNSTILE_FIELD,
    buildBody,
    compilePatterns,
    validate,
    type FieldDefinition,
} from "../functions/_lib/definition.ts";

// 検証は「定義に照らして」行うので、テストも定義から組む。
function check(fields: FieldDefinition[], body: Record<string, unknown>): string[] {
    const compiled = compilePatterns(fields);
    if (!compiled.ok) throw new Error(`パターンがコンパイルできない: ${compiled.reason}`);
    return validate(body, fields, compiled.patterns);
}

const text: FieldDefinition = { name: "name", label: "お名前", type: "text", required: true };
const tel: FieldDefinition = {
    name: "tel", label: "電話番号", type: "text",
    validation: { pattern: "\\d{10,11}" },
};
const choice: FieldDefinition = {
    name: "plan", label: "プラン", type: "select",
    options: [ { value: "free" }, { value: "pro" } ],
};
const agree: FieldDefinition = { name: "agree", label: "同意", type: "checkbox" };

test("定義に無いキーを拒否する", () => {
    const errors = check([ text ], { name: "佐藤", evil: "任意の内容" });
    assert.deepEqual(errors, [ "evil は定義にありません" ]);
});

test("__proto__ も定義に無いキーとして拒否する", () => {
    // JSON.parse は __proto__ を own プロパティとして作るので Object.keys に現れる。
    const body = JSON.parse('{"name":"佐藤","__proto__":{"polluted":true}}');
    assert.deepEqual(check([ text ], body), [ "__proto__ は定義にありません" ]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("Turnstile のトークンは定義に無くても通す", () => {
    assert.deepEqual(check([ text ], { name: "佐藤", [TURNSTILE_FIELD]: "token" }), []);
});

test("options に無い値を拒否する", () => {
    assert.deepEqual(check([ choice ], { plan: "enterprise" }), [ "プラン の選択が正しくありません" ]);
    assert.deepEqual(check([ choice ], { plan: "pro" }), []);
});

test("checkbox は boolean 以外を拒否し、任意なら省略を許す", () => {
    assert.deepEqual(check([ agree ], { agree: "on" }), [ "同意 の形式が正しくありません" ]);
    assert.deepEqual(check([ agree ], {}), []);
    assert.deepEqual(check([ agree ], { agree: false }), []);
});

test("required な checkbox は false を拒否する", () => {
    const required = { ...agree, required: true };
    assert.deepEqual(check([ required ], { agree: false }), [ "同意 をチェックしてください" ]);
    assert.deepEqual(check([ required ], { agree: true }), []);
});

test("required で空白のみの値を拒否する", () => {
    assert.deepEqual(check([ text ], { name: "   " }), [ "お名前 を入力してください" ]);
    assert.deepEqual(check([ text ], {}), [ "お名前 を入力してください" ]);
});

test("文字列でない値を拒否する", () => {
    for (const value of [ 123, [ "a" ], { a: 1 }, true ]) {
        assert.deepEqual(check([ text ], { name: value }), [ "お名前 の形式が正しくありません" ]);
    }
});

test("pattern は完全一致で見る", () => {
    // アンカー無しのままだと部分一致で通り、`\d{10,11}` に任意の長さの文字列が入る。
    assert.deepEqual(check([ tel ], { tel: "09012345678" }), []);
    assert.deepEqual(check([ tel ], { tel: "あいう09012345678あいう" }), [ "電話番号 の形式が正しくありません" ]);
});

test("長さの検査は pattern より先に走る", () => {
    // 逆順だと、maxLength を超えた長い値が正規表現に渡ってしまう。
    const bounded: FieldDefinition = { ...tel, validation: { pattern: "\\d{10,11}", maxLength: 11 } };
    assert.deepEqual(check([ bounded ], { tel: "0".repeat(40) }), [ "電話番号 は最大 11 文字です" ]);
});

test("maxLength が無いフィールドにも絶対上限が効く", () => {
    const errors = check([ { name: "memo", label: "メモ", type: "textarea" } ], {
        memo: "あ".repeat(MAX_FIELD_LENGTH + 1),
    });
    assert.deepEqual(errors, [ `メモ は最大 ${MAX_FIELD_LENGTH} 文字です` ]);
});

test("壊れた pattern は定義ごと失敗させる", () => {
    // 個別に飛ばすと、検証されていないフィールドがあることに誰も気付かない。
    const result = compilePatterns([ { name: "x", type: "text", validation: { pattern: "([" } } ]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /valid regular expression/);
});

test("実務で書かれる pattern がそのまま使える", () => {
    const sources = [
        "\\d{10,11}",
        "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
        "^\\d{3}-\\d{4}$",
        "^(090|080|070)\\d{8}$",
        "\\((\\d+)\\)",
    ];
    for (const source of sources) {
        const result = compilePatterns([ { name: "x", type: "text", validation: { pattern: source } } ]);
        assert.equal(result.ok, true, `コンパイルできるべき: ${source}`);
    }
});

test("本文は定義の順序とラベルで組む", () => {
    const fields: FieldDefinition[] = [
        { name: "turnstile", type: "turnstile" },
        text,
        agree,
    ];
    assert.equal(buildBody({ name: "佐藤", agree: true }, fields), "お名前: 佐藤\n同意: はい");
});

test("複数行の値は字下げしてラベル行と区別する", () => {
    // 字下げしないと、値に書いた `お名前: 別人` が別フィールドとして届いたように見える。
    const fields: FieldDefinition[] = [ { name: "memo", label: "メモ", type: "textarea" }, text ];
    const body = { memo: "1行目\nお名前: 別人", name: "佐藤" };
    assert.equal(buildBody(body, fields), "メモ:\n  1行目\n  お名前: 別人\nお名前: 佐藤");
});
