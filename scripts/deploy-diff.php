<?php
/**
 * 前回デプロイ以降に変更されたファイルから、FTP アップロード対象リストを生成する。
 *
 * 運用:
 *   1. デプロイ前に実行してアップロード対象を確認
 *        php scripts/deploy-diff.php
 *   2. FTP アップロードが完了したら、デプロイ済みの印として HEAD にタグを打つ
 *        php scripts/deploy-diff.php --mark
 *      （過去のコミットに初期タグを打つ場合: php scripts/deploy-diff.php --mark <commit>）
 *
 * タグ形式: deploy-YYYYMMDD-HHMM（最新の deploy-* タグとの diff を取る）
 */

if (PHP_SAPI !== 'cli') {
    exit('This script is CLI only.');
}

chdir(dirname(__DIR__));

/** git をシェルを介さず実行し、出力行の配列を返す（失敗時は exit 1） */
function git(array $args): array {
    $proc = proc_open(
        array_merge(['git'], $args),
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    if (!is_resource($proc)) {
        fwrite(STDERR, "エラー: git を起動できませんでした。\n");
        exit(1);
    }
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    if (proc_close($proc) !== 0) {
        fwrite(STDERR, 'エラー: git ' . implode(' ', $args) . " が失敗しました:\n$err\n");
        exit(1);
    }
    return $out === '' ? [] : explode("\n", trim($out));
}

// ─── --mark: デプロイ済みタグを作成 ──────────────────────────────
if (($argv[1] ?? '') === '--mark') {
    $target = $argv[2] ?? 'HEAD';
    $tag = 'deploy-' . date('Ymd-Hi');
    git(['tag', $tag, $target]);
    echo "タグ $tag を $target に作成しました。\n";
    exit(0);
}

// ─── 最新の deploy タグを特定 ────────────────────────────────────
$tags = git(['tag', '--list', 'deploy-*', '--sort=-creatordate']);
if (!$tags) {
    fwrite(STDERR, "deploy-* タグがありません。最後にデプロイしたコミットに初期タグを打ってください:\n");
    fwrite(STDERR, "  php scripts/deploy-diff.php --mark <コミットハッシュ>\n");
    exit(1);
}
$lastTag = $tags[0];

// ─── 差分ファイルを分類 ──────────────────────────────────────────
$changed = git(['diff', '--name-only', "$lastTag..HEAD"]);

$upload  = []; // FTP アップロード対象
$skipped = []; // サーバーに不要（ドキュメント・開発ツール類）
$notes   = []; // 注意事項

foreach ($changed as $path) {
    if (str_starts_with($path, 'frontend/')) {
        $upload[] = $path;
    } elseif (str_starts_with($path, 'backend/') && str_ends_with($path, '.php')) {
        $upload[] = $path;
    } elseif ($path === 'words.txt' || $path === 'words_addition.txt') {
        $skipped[] = $path;
        $notes[] = "$path が変更されています → `php backend/import.php` で words.db を再構築し、words.db をアップロードしてください";
    } else {
        $skipped[] = $path;
    }
}

// ─── 出力 ────────────────────────────────────────────────────────
echo "前回デプロイ: $lastTag\n";
echo "比較範囲: $lastTag..HEAD（" . count($changed) . " ファイル変更）\n\n";

if ($upload) {
    echo "■ FTP アップロード対象（" . count($upload) . " ファイル）\n";
    foreach ($upload as $p) {
        echo "  $p\n";
    }
    // backend を先に上げると安全（API は後方互換を保つ運用のため）
    $hasBackend  = (bool)array_filter($upload, fn($p) => str_starts_with($p, 'backend/'));
    $hasFrontend = (bool)array_filter($upload, fn($p) => str_starts_with($p, 'frontend/'));
    if ($hasBackend && $hasFrontend) {
        $notes[] = 'backend → frontend の順でアップロードすると安全です';
    }
} else {
    echo "■ FTP アップロード対象はありません。\n";
}

if ($skipped) {
    echo "\n■ アップロード不要（ドキュメント・開発ツール類）\n";
    foreach ($skipped as $p) {
        echo "  $p\n";
    }
}

if ($notes) {
    echo "\n■ 注意\n";
    foreach (array_unique($notes) as $n) {
        echo "  - $n\n";
    }
}

echo "\nアップロード完了後: php scripts/deploy-diff.php --mark\n";
