// Pages Functions のバンドルに、workerd に存在しない API が混入していないか検査する。
//
// 動機: @aws-sdk/client-ses を 3.806.0 -> 3.1106.0 に上げた際、XML パーサが
// fast-xml-parser から @aws-sdk/xml-builder に替わった。後者は package.json の
// browser フィールドで xml-parser.browser.js にマップされ、その実装が DOMParser に
// 依存する。esbuild は browser 向けに解決するためこれが選ばれ、送信リクエスト自体は
// 成功するのに応答の解析だけが実行時に失敗した。
// 型チェックもバンドルも通るため、静的検査では検出できなかった。
//
// 検査は2段構え。
//   1. wrangler 自身の警告を拾う（nodejs_compat 未設定での node ビルトイン import 等）
//      ビルダの診断は文字列マッチより確実で、出力形式が変わっても壊れない。
//   2. バンドル本体の走査（wrangler が警告しない DOM API 等はこちらで拾う）

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * バンドルに現れてはいけないもの。
 *
 * pattern は必ず正規表現にすること。単純な部分一致だと以下の両方で事故る。
 *   - 見逃し: `from"node:` は minify 済み出力にしか一致せず、wrangler の
 *     出力は minify されないため（`from "node:crypto"`）永久に 0 件になる。実際に踏んだ。
 *   - 誤検知: `Buffer` は ArrayBuffer / hashBuffer 等に部分一致する（実測 70 件）。
 *
 * allow は「この文脈なら許す」正規表現。マッチ位置の周辺 WINDOW 文字に対して評価する。
 * AWS SDK には typeof ガード済みの feature detection が入っており、
 * それを理由に検査項目ごと消すと守備範囲を失うので、文脈で許す方に倒す。
 */
const FORBIDDEN = [
    { pattern: /\bDOMParser\b/g, reason: 'workerd に DOM パーサは無い（AWS SDK の browser 版 XML パーサが混入すると出る）' },
    { pattern: /\bXMLHttpRequest\b/g, reason: 'workerd に XHR は無い。fetch に解決されるべき' },
    { pattern: /\b(?:local|session)Storage\b/g, reason: 'workerd に Web Storage は無い', allow: [/typeof\s+(?:local|session)Storage\s*[!=]==/] },
    { pattern: /\bdocument\b/g, reason: 'workerd に DOM は無い', allow: [/typeof\s+document\s*[!=]==/] },
    { pattern: /["']node:/g, reason: 'node ビルトインの import。nodejs_compat が未設定なので実行時に失敗する' },
    { pattern: /\bprocess\.exit\b/g, reason: 'workerd に process.exit は無い' },
    { pattern: /\bsetImmediate\b/g, reason: 'node 固有。setTimeout に置き換えるべき' },
    { pattern: /\b__(?:dirname|filename)\b/g, reason: 'CommonJS 固有。バンドル後の実行環境には無い' },
    { pattern: /\beval\s*\(/g, reason: 'workerd は eval を許可しない' },
];

// Buffer は検査しない。実測で 9 件あり、すべて typeof ガード済みか
// ArrayBuffer 等への部分一致。境界付き正規表現にしても残るため、
// 足すなら allow の設計を先に詰めること。

/** マッチ周辺のうち allow を評価する範囲（文字数） */
const WINDOW = 120;

const OUTDIR = '.bundle-check';

function build() {
    // wrangler は node ビルトイン混入時に警告を出すが exit 0 で終わる。
    // `&&` で繋ぐと素通りするので、出力を捕捉して自分で判定する。
    //
    // 警告は stderr に出る。execFileSync は stdout しか返さないため、
    // それを使うとこの検査自体が永久に発火しない（実際に一度そう書いて踏んだ）。
    // spawnSync で両方受け取ること。
    const result = spawnSync(
        'npx',
        ['wrangler', 'pages', 'functions', 'build', `--outdir=${OUTDIR}`],
        { encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 0) {
        console.error('✘ wrangler のビルドが失敗した');
        console.error(output);
        process.exit(2);
    }
    return output;
}

/** ANSI エスケープを落として素の文字列にする */
function plain(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\[[0-9;]*m/g, '');
}

rmSync(OUTDIR, { recursive: true, force: true });

const buildOutput = plain(build());
let failed = false;

// 1. wrangler の診断
if (/nodejs_compat/.test(buildOutput)) {
    failed = true;
    console.error('✘ wrangler が nodejs_compat に関する警告を出している');
    for (const line of buildOutput.split('\n')) {
        if (/node:|nodejs_compat|Imported from|^\s+-\s/.test(line)) console.error(`  ${line.trim()}`);
    }
    console.error('');
}

// 2. バンドル本体
const files = readdirSync(OUTDIR, { recursive: true })
    .filter((f) => typeof f === 'string' && /\.(?:js|mjs|cjs)$/.test(f));

if (files.length === 0) {
    console.error(`✘ ${OUTDIR} に JS が無い。バンドルが生成されていない`);
    process.exit(2);
}

for (const file of files) {
    const source = readFileSync(join(OUTDIR, file), 'utf8');
    for (const { pattern, reason, allow = [] } of FORBIDDEN) {
        pattern.lastIndex = 0;
        const hits = [];
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const context = source.slice(Math.max(0, match.index - WINDOW), match.index + WINDOW);
            if (allow.some((a) => a.test(context))) continue;
            hits.push(match.index);
        }
        if (hits.length === 0) continue;

        failed = true;
        console.error(`✘ ${file}: ${pattern.source} が ${hits.length} 件`);
        console.error(`  理由: ${reason}`);
        console.error(`  周辺: ...${source.slice(Math.max(0, hits[0] - WINDOW), hits[0] + 80).replace(/\s+/g, ' ')}...`);
        console.error('');
    }
}

if (failed) {
    console.error('バンドルに workerd で動かない API が含まれている。');
    process.exit(1);
}

console.log(`✓ ${files.length} 個の JS を検査。禁止 API の混入なし（${FORBIDDEN.length} 項目）`);
