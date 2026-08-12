// このデプロイが受け付けるフォームの一覧。
//
// 定義は `public/forms/*.json` に置き、ここで import する。import した JSON は
// バンドルに焼き込まれるので、送信の受付は実行時に何も読まずに定義を持っている。
// 同じファイルが `/forms/<slug>.json` として静的配信され、ウィジェットはそちらを読む。
//
// フォームを増やすときは JSON を足して、ここに1行足す。
// 動的に走査しないのは、バンドルに何が入るかがファイルを見て分かるほうがよいのと、
// 型検査が定義の形を見てくれるためである（`FormDefinition` に合わない JSON は
// `npm run typecheck` で落ちる）。
import type { FormDefinition } from "./definition";
import contact from "../../public/forms/contact.json";

export const FORMS: Record<string, FormDefinition> = { contact };
