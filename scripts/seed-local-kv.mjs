// ローカル開発用に KV を埋める。
//
// public/test.html は本番の埋め込みと同じ経路で定義を取る（`/api/form/...` 経由）ので、
// KV が空だと定義取得に失敗してフォームが出ない。このリポジトリにはテストスイートが無く、
// ローカルのテストページが唯一の検証手段なので、投入する手段を同梱しておく。
//
// フィールド定義は public/test.json をそのまま使う。定義の参照実装を1箇所に保つため、
// ここで足すのは `v` と `slug` だけにする（console 側の SiteProjection と同じ扱い）。

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SITE_KEY = "fp_localtest";
const SLUG = "contact";

// functions 側の SUPPORTED_SCHEMA_VERSION と対応する。
const SCHEMA_VERSION = 1;

// Turnstile の「常に成功する」テスト用シークレット。
// public/test.json 側のテスト用 sitekey（1x00000000000000000000AA）と対になる。
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";

const definition = JSON.parse(readFileSync("public/test.json", "utf8"));

const siteRecord = {
    v: SCHEMA_VERSION,
    label: "ローカルテスト",
    allowed_origins: ["http://localhost:8788"],
    turnstile_secret: process.env.TURNSTILE_SECRET_KEY || TEST_TURNSTILE_SECRET,
    mail_from: process.env.SES_FROM_ADDRESS || "from@example.com",
    mail_to: process.env.SES_TO_ADDRESS || "to@example.com",
    forms: [ SLUG ],
};

const formRecord = { v: SCHEMA_VERSION, slug: SLUG, ...definition };

function put(key, value) {
    // pages dev は preview_id 側の namespace を使うので、--preview を付ける。
    const result = spawnSync("npx", [
        "wrangler", "kv", "key", "put",
        "--binding", "CONFIG", "--local", "--preview",
        key, JSON.stringify(value),
    ], { encoding: "utf8" });

    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout || "");
        console.error(`\n✘ KV への書き込みに失敗しました: ${key}`);
        console.error("  wrangler.toml に CONFIG の kv_namespaces（id と preview_id）があるか確認してください。");
        process.exit(1);
    }

    console.log(`  ${key}`);
}

console.log("ローカルの preview KV に投入します。");
put(`site:${SITE_KEY}`, siteRecord);
put(`form:${SITE_KEY}:${SLUG}`, formRecord);

console.log("\n完了。npm run dev のうえで http://localhost:8788/test.html を開いてください。");

if (!process.env.SES_FROM_ADDRESS || !process.env.SES_TO_ADDRESS) {
    console.log("\n注意: SES_FROM_ADDRESS / SES_TO_ADDRESS が未設定なので example.com を入れました。");
    console.log("Turnstile の検証までは通りますが、SES 送信は失敗します。");
    console.log("実際に送るなら、wrangler.toml と同じ値を環境変数で渡して再実行してください。");
}
