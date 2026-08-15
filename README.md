# FormPlant

FormPlant は、ランディングページへ埋め込める問い合わせフォームです。

Cloudflare Pages から JavaScript と CSS を配信し、JSON の定義に従ってブラウザ上でフォームを生成します。
送信時は Cloudflare Turnstile でリクエストを検証し、Pages Functions から AWS SES を使って問い合わせ内容をメール送信します。
一つのデプロイで送信元と送信先を一組だけ設定する、単一メールボックス向けの構成です。

## 構成

```text
埋め込み先のページ
  ├─ contact-form.js ── フォーム定義 JSON を取得して UI を生成
  ├─ contact-form.css ─ 表示スタイル
  └─ POST /api/submit
        ├─ Cloudflare Turnstile Siteverify
        └─ AWS SESv2
```

主要なファイルは次のとおりです。

| パス | 役割 |
| --- | --- |
| `public/contact-form.js` | フォームの生成、ブラウザ側の入力検証、送信処理 |
| `public/contact-form.css` | 埋め込みフォームのスタイル |
| `public/test.html` | ローカル確認用ページ |
| `public/test.json` | フォーム定義の例 |
| `functions/api/submit.ts` | Turnstile の検証と SESv2 によるメール送信 |
| `scripts/check-worker-bundle.mjs` | workerd で使えない API が Functions のバンドルへ混入していないか検査 |

## 必要な環境

- `.node-version` に記載された Node.js
- npm
- Cloudflare Pages のプロジェクト
- Cloudflare Turnstile のサイトキーとシークレットキー
- 対象リージョンで送信元IDを検証済みの AWS SES

SES が sandbox 内にある場合は、`SES_TO_ADDRESS` に指定する送信先IDも検証する必要があります。
未検証の送信先へ送る場合は、SES の production access を取得してください。

## ローカル開発

依存関係をインストールします。

```bash
npm ci
```

ローカル用の Wrangler 設定を作成します。

```bash
cp wrangler.toml.sample wrangler.toml
```

`wrangler.toml` の値を開発環境用に変更してから、Pages の開発サーバーを起動します。

```bash
npm run dev
```

ブラウザで <http://localhost:8788/test.html> を開くと、`public/test.json` を使ったフォームを確認できます。
サンプルには Turnstile の常時成功テスト用サイトキーが含まれています。
Cloudflare が提供するテスト用キーは機密情報ではありませんが、本番環境では本番用キーへ置き換えます。
送信まで確認する場合は、対応する常時成功テスト用シークレットキーをローカルの `wrangler.toml` に設定します。

`wrangler.toml` は Git の追跡対象外です。
実値を含むファイルをコミットしないでください。

## 環境変数

Pages Functions は次の値を参照します。

| 変数 | 用途 | 機密情報 |
| --- | --- | --- |
| `AWS_REGION` | SES のリージョン | いいえ |
| `AWS_ACCESS_KEY_ID` | SES を呼び出す IAM アクセスキーID | はい |
| `AWS_SECRET_ACCESS_KEY` | SES を呼び出す IAM シークレットアクセスキー | はい |
| `SES_FROM_ADDRESS` | SES の送信元アドレス | いいえ |
| `SES_TO_ADDRESS` | 問い合わせの送信先アドレス | いいえ |
| `TURNSTILE_SECRET_KEY` | Turnstile Siteverify のシークレットキー | はい |
| `ALLOWED_ORIGINS` | CORS で許可する Origin のカンマ区切り一覧 | いいえ |

本番用の認証情報とシークレットは、Cloudflare Pages の設定画面から暗号化されたシークレットとして登録します。
AWS の IAM ポリシーは、対象リージョンと送信元に必要な SES 送信権限だけへ制限してください。

`ALLOWED_ORIGINS` には、フォームを埋め込むページの Origin をスキーム付きで指定します。

```text
https://www.example.com,https://campaign.example.com
```

CORS はブラウザによる応答の読み取りを制御する仕組みであり、API の認証やレート制限の代わりにはなりません。

## ページへの埋め込み

フォームを表示する要素、CSS、JavaScript を埋め込み先の HTML に追加します。

```html
<link rel="stylesheet" href="https://form.example.com/contact-form.css">

<div id="contact-form"></div>

<script
  src="https://form.example.com/contact-form.js"
  data-form-url="https://form.example.com/forms/contact.json"
  data-lp="campaign-2026"
></script>
```

スクリプトは `document.currentScript` から設定を読み取るため、通常のクラシックスクリプトとして読み込みます。
`type="module"` は指定しないでください。

### スクリプト属性

| 属性 | 必須 | 説明 |
| --- | --- | --- |
| `data-form-url` | はい | フォーム定義 JSON の URL |
| `data-lp` | いいえ | メール件名と本文へ送る LP 識別ラベル。省略時は `unknown` |
| `data-api-url` | いいえ | 送信先 API。省略時はスクリプト配信元の `/api/submit` |

埋め込み先には `id="contact-form"` の要素が必要です。
現在の実装は、1ページにつき1フォームを前提としています。
`data-lp` は送信先の選択や認可には使われず、クライアントから変更できます。

## フォーム定義

フォーム定義は、`fields` 配列と任意の `messages` を持つ JSON です。
`public/test.json` にすべての対応フィールドを含む例があります。

```json
{
  "messages": {
    "success": "お問い合わせを受け付けました。",
    "error": "送信に失敗しました。",
    "validation": "入力内容を確認してください。"
  },
  "fields": [
    {
      "type": "turnstile",
      "name": "cf-turnstile-response",
      "sitekey": "YOUR_TURNSTILE_SITE_KEY"
    },
    {
      "name": "email",
      "label": "メールアドレス",
      "type": "email",
      "required": true,
      "validation": {
        "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
        "maxLength": 256,
        "message": "正しいメールアドレスを入力してください"
      }
    },
    {
      "name": "message",
      "label": "お問い合わせ内容",
      "type": "textarea",
      "required": true,
      "validation": {
        "maxLength": 1000
      }
    }
  ]
}
```

対応するフィールド型は次のとおりです。

- `text`
- `email`
- `textarea`
- `select`
- `radio`
- `checkbox`
- `turnstile`

`select` と `radio` は `options` 配列を受け取ります。
各選択肢には `value` と `label` を指定します。

`validation` には `pattern`、`minLength`、`maxLength`、`message` を指定できます。
これらはブラウザ側の入力補助であり、サーバー側の検証ではありません。

## API

`POST /api/submit` は JSON を受け取ります。
Turnstile ウィジェットが発行したトークンを `cf-turnstile-response` に含める必要があります。

```json
{
  "lp_code": "campaign-2026",
  "email": "person@example.com",
  "message": "資料を希望します。",
  "cf-turnstile-response": "TURNSTILE_TOKEN"
}
```

成功時は次のレスポンスを返します。

```json
{ "success": true }
```

サーバーは `cf-turnstile-response` を除く受信フィールドを `キー: 値` の形式でメール本文へ並べます。
`lp_code` と `cf-turnstile-response` は予約キーであり、通常のフォーム項目名には使用できません。
その他のフィールドは、フォーム定義を変更してもサーバーのスキーマ変更を不要にするため、名前や値の型をサーバー側で限定しない設計です。
送信先は `SES_TO_ADDRESS` に固定され、クライアントから変更できません。

## 検証

```bash
npm run typecheck
npm run check:bundle
npm run check:client
```

- `typecheck` は `functions/` の TypeScript を検査します。
- `check:bundle` は Pages Functions をバンドルし、workerd に存在しない API の混入を検査します。
- `check:client` は配信する JavaScript の構文と `public/test.json` の JSON 構文を検査します。

CI は pull request と `main` ブランチへの push で三つの検査を実行します。
自動テスト、リンター、フォーマッターはまだ導入されていません。

## デプロイ

検証を通した後、Cloudflare Pages へデプロイします。
本番デプロイには、開発用の `wrangler.toml` が存在しないクリーンな作業ディレクトリを使用してください。
Pages では、作業ディレクトリの Wrangler 設定がデプロイ設定の正本になるため、開発用の変数を含む `wrangler.toml` から本番デプロイしてはいけません。
本番用の環境変数とシークレットは、あらかじめ Cloudflare Pages の設定画面へ登録します。

```bash
npm run typecheck
npm run check:bundle
npm run check:client
npx wrangler pages deploy public --project-name form-plant --branch main
```

デプロイ前に `ALLOWED_ORIGINS` へ本番の埋め込み先 Origin を追加してください。

## 設計上の特性と制約

- サーバーは予約キーを除く任意のフォーム項目を受け取り、Turnstile トークンを除いてメール本文へ変換します。
- アプリケーション固有の本文サイズ制限とレート制限は設けず、Turnstile、Cloudflare、AWS SES の制限を利用します。
- すべての埋め込み先が、同じ SES 送信元と送信先を共有します。
- 自動テストはなく、ブラウザでの送信確認は手動です。
- 送信成功後は二重送信を避けるためボタンを無効のままにします。再送信にはページの再読み込みが必要です。

## ライセンス

[MIT License](LICENSE)
