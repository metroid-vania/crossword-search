<?php
/**
 * キャッシュバスター（?v=YYYYMMDDXX）と Service Worker の VERSION を一括更新する。
 *
 * 対象:
 *   frontend/index.html   … style.css?v= / app.js?v=
 *   frontend/help.html    … style.css?v=
 *   frontend/privacy.html … style.css?v=
 *   frontend/sw.js        … const VERSION = '...'
 *
 * 使い方:
 *   php scripts/bump-version.php              # 今日の日付で連番を自動採番して更新
 *   php scripts/bump-version.php --dry-run    # 変更内容の表示のみ（書き込みなし）
 *   php scripts/bump-version.php --set 2026061009  # 指定バージョンに設定（巻き戻し用）
 */

if (PHP_SAPI !== 'cli') {
    exit('This script is CLI only.');
}

$root = dirname(__DIR__);
$swPath = "$root/frontend/sw.js";

$targets = [
    "$root/frontend/index.html",
    "$root/frontend/help.html",
    "$root/frontend/privacy.html",
];

// ─── オプション解析 ──────────────────────────────────────────────
$dryRun = in_array('--dry-run', $argv, true);
$setVersion = null;
$setIdx = array_search('--set', $argv, true);
if ($setIdx !== false) {
    $setVersion = $argv[$setIdx + 1] ?? null;
    if (!preg_match('/^\d{10}$/', (string)$setVersion)) {
        fwrite(STDERR, "エラー: --set には10桁のバージョン（例: 2026061001）を指定してください。\n");
        exit(1);
    }
}

// ─── 現在のバージョンを sw.js から取得 ───────────────────────────
$sw = file_get_contents($swPath);
if ($sw === false || !preg_match("/const VERSION = '(\d{10})';/", $sw, $m)) {
    fwrite(STDERR, "エラー: $swPath から VERSION を読み取れませんでした。\n");
    exit(1);
}
$current = $m[1];

// ─── 新バージョンを決定 ──────────────────────────────────────────
if ($setVersion !== null) {
    $next = $setVersion;
} else {
    $today = date('Ymd');
    // 同日の更新なら連番をインクリメント、日付が変わっていれば 01 から
    $seq = (substr($current, 0, 8) === $today) ? (int)substr($current, 8, 2) + 1 : 1;
    if ($seq > 99) {
        fwrite(STDERR, "エラー: 連番が99を超えました。--set で明示指定してください。\n");
        exit(1);
    }
    $next = $today . str_pad((string)$seq, 2, '0', STR_PAD_LEFT);
}

echo ($dryRun ? '[dry-run] ' : '') . "バージョン: $current → $next\n";

// ─── 置換実行 ────────────────────────────────────────────────────
$ok = true;

// HTML: ?v=XXXXXXXXXX をすべて置換（style.css / app.js 両方を拾う）
foreach ($targets as $path) {
    $body = file_get_contents($path);
    if ($body === false) {
        fwrite(STDERR, "エラー: $path を読み込めません。\n");
        $ok = false;
        continue;
    }
    $replaced = preg_replace('/\?v=\d{10}/', "?v=$next", $body, -1, $count);
    if ($count === 0) {
        fwrite(STDERR, "エラー: $path に ?v= パターンが見つかりません。\n");
        $ok = false;
        continue;
    }
    if (!$dryRun) {
        file_put_contents($path, $replaced);
    }
    printf("  %-28s %d 箇所\n", basename($path), $count);
}

// sw.js: VERSION 定数を置換
$swReplaced = preg_replace("/const VERSION = '\d{10}';/", "const VERSION = '$next';", $sw, -1, $count);
if ($count !== 1) {
    fwrite(STDERR, "エラー: sw.js の VERSION 置換に失敗しました（{$count}箇所）。\n");
    $ok = false;
} else {
    if (!$dryRun) {
        file_put_contents($swPath, $swReplaced);
    }
    printf("  %-28s VERSION 更新\n", 'sw.js');
}

if (!$ok) {
    fwrite(STDERR, "一部の置換に失敗しました。ファイルを確認してください。\n");
    exit(1);
}
echo $dryRun ? "（dry-run のため書き込みは行っていません）\n" : "完了。\n";
