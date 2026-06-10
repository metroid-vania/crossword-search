<?php
/**
 * CLI 検索ラッパー（api.php を CLI から呼び出す）
 * 使い方: php search_cli.php <検索パターン> [上限件数] [--exclude=<除外文字>] [--sort=shuffle] [--seed=<数値>]
 */

// CLI 専用（HTTP 経由の実行を禁止）
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('This script is CLI only.');
}

function displayResults(string $json): void {
    $data = json_decode($json, true);
    if (!$data || isset($data['error'])) {
        echo "エラー: " . ($data['error'] ?? 'JSON解析失敗') . "\n";
        return;
    }

    $pattern = $GLOBALS['argv'][1] ?? '';
    $count   = $data['count']   ?? 0;
    $hasMore = $data['hasMore'] ?? false;

    echo "【{$pattern}】の検索結果：" . $count . ($hasMore ? "件以上（200件まで表示）" : "件") . "\n";

    if ($count === 0) {
        echo "該当する単語が見つかりませんでした。\n";
        return;
    }

    echo str_repeat('-', 40) . "\n";
    foreach ($data['words'] as $w) {
        $line = $w['reading'];
        if (!empty($w['variants'])) {
            $line .= '　' . implode('、', $w['variants']);
        }
        echo $line . "\n";
    }
}

// shutdown function で出力を捕捉（api.php が exit を呼んでも確実に実行される）
ob_start();
register_shutdown_function(function () {
    $json = ob_get_clean();
    displayResults($json);
});

// 位置引数（パターン・上限件数）と --key=value オプションを分離
$positional = [];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--(exclude|sort|seed)=(.*)$/u', $arg, $m)) {
        $_GET[$m[1]] = $m[2];
    } else {
        $positional[] = $arg;
    }
}

$_GET['q']      = $positional[0] ?? '';
$_GET['offset'] = 0;
$_GET['limit']  = (int)($positional[1] ?? 200);

chdir(__DIR__);
include __DIR__ . '/api.php';
