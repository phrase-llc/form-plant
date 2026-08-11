// Pages Functions のバンドルに、workerd に存在しない API が混入していないか検査する。
//
// 動機: @aws-sdk/client-ses を 3.806.0 -> 3.1106.0 に上げた際、XML パーサが
// fast-xml-parser から @aws-sdk/xml-builder に替わった。後者は package.json の
// browser フィールドで xml-parser.browser.js にマップされ、その実装が DOMParser に
// 依存する。esbuild は browser 向けに解決するためこれが選ばれ、送信リクエスト自体は
// 成功するのに応答の解析だけが実行時に失敗した。
// 型チェックもバンドルも通るため、静的検査では検出できなかった。
//
// window / navigator は検査しない。AWS SDK に
//   typeof window !== "undefined" ? window.navigator : void 0
// のようなガード済みの feature detection が含まれており、除外しないと必ず落ちる。
// （defaultsMode: "auto" のときだけ通る window?.navigator も残っているが、
//   既定の legacy では実行されない。ここを検査したいなら実行経路の調査が先。）

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** バンドルに現れてはいけない文字列。理由を添えること。 */
const FORBIDDEN = [
    { pattern: 'DOMParser', reason: 'workerd に DOM パーサは無い（AWS SDK の browser 版 XML パーサが混入すると出る）' },
    { pattern: 'XMLHttpRequest', reason: 'workerd に XHR は無い。fetch に解決されるべき' },
    { pattern: 'localStorage', reason: 'workerd に Web Storage は無い' },
    { pattern: 'sessionStorage', reason: 'workerd に Web Storage は無い' },
    { pattern: 'document.', reason: 'workerd に DOM は無い' },
    { pattern: 'from"node:', reason: 'node ビルトインの import。nodejs_compat が未設定なので実行時に失敗する' },
    { pattern: 'require("node:', reason: 'node ビルトインの require。nodejs_compat が未設定なので実行時に失敗する' },
];

const outdir = process.argv[2];
if (!outdir) {
    console.error('usage: node scripts/check-worker-bundle.mjs <outdir>');
    process.exit(2);
}

const files = readdirSync(outdir, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.js'));

if (files.length === 0) {
    console.error(`✘ ${outdir} に .js が無い。バンドルが生成されていない`);
    process.exit(2);
}

let failed = false;

for (const file of files) {
    const source = readFileSync(join(outdir, file), 'utf8');
    for (const { pattern, reason } of FORBIDDEN) {
        // 出現位置を数えるだけでなく、最初の1件の周辺を出して原因を追えるようにする
        const index = source.indexOf(pattern);
        if (index === -1) continue;
        failed = true;
        const count = source.split(pattern).length - 1;
        console.error(`✘ ${file}: ${pattern} が ${count} 件`);
        console.error(`  理由: ${reason}`);
        console.error(`  周辺: ...${source.slice(Math.max(0, index - 120), index + 80).replace(/\s+/g, ' ')}...`);
        console.error('');
    }
}

if (failed) {
    console.error('バンドルに workerd で動かない API が含まれている。');
    process.exit(1);
}

console.log(`✓ ${files.length} 個の JS を検査。禁止 API の混入なし（${FORBIDDEN.length} 項目）`);
