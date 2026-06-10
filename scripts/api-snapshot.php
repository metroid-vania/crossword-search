<?php
/**
 * 検索 API（backend/api.php）の後方互換スナップショットテスト。
 *
 * 代表クエリ（4つの検索パス・exclude・shuffle・エラー系）の応答を
 * scripts/api_snapshots/ に保存し、api.php 変更後に差分がないか検証する。
 *
 * 使い方:
 *   php scripts/api-snapshot.php           # check: 保存済みスナップショットと比較（差分があれば exit 1）
 *   php scripts/api-snapshot.php update    # スナップショットを再生成
 *
 * 注意:
 *   - words.db が必要（php backend/import.php で生成）
 *   - 辞書データ（words.txt / words_addition.txt）を更新したら応答が変わるため
 *     `update` で再生成してからコミットすること
 */

if (PHP_SAPI !== 'cli') {
    exit('This script is CLI only.');
}

$root = dirname(__DIR__);
$snapshotDir = __DIR__ . '/api_snapshots';
$runner = __DIR__ . '/api-query-runner.php';
$mode = $argv[1] ?? 'check';
if (!in_array($mode, ['check', 'update'], true)) {
    fwrite(STDERR, "使い方: php scripts/api-snapshot.php [check|update]\n");
    exit(1);
}

// ─── テストケース（4つの検索パスと付加機能・エラー系を網羅） ─────────
$cases = [
    // 検索パス1: 完全一致
    'exact_match'         => ['q' => 'アイアン'],
    // 検索パス2: ? のみ（len 固定 + LIKE）
    'question_only'       => ['q' => '？？イロ'],
    'hiragana_input'      => ['q' => '？？いろ'],  // ひらがな正規化（question_only と同応答のはず）
    // 検索パス3: * あり（LIKE + 可変長）
    'star'                => ['q' => '＊イロ'],
    'star_len'            => ['q' => '＊イロ', 'len' => '4'],
    'star_minlen'         => ['q' => '＊イロ', 'minLen' => '8'],
    // 検索パス4a: 数字あり・* なし（substr push-down）
    'digits_no_star'      => ['q' => '１２１２', 'limit' => '50'],
    // 検索パス4b: 数字あり・* あり（PHP チャンク走査）
    'digits_star_chunk'   => ['q' => '１＊１', 'limit' => '50'],
    // 除外文字（ひらがな正規化込み）
    'exclude_question'    => ['q' => '？？イロ', 'exclude' => 'し'],
    'exclude_chunk'       => ['q' => '１＊１', 'exclude' => 'ん', 'limit' => '50'],
    // 必須文字
    'include_question'    => ['q' => '？？イロ', 'include' => 'か'],
    'include_chunk'       => ['q' => '１＊１', 'include' => 'ん', 'limit' => '50'],
    'include_exclude_conflict' => ['q' => '？？イロ', 'include' => 'カ', 'exclude' => 'カ'],
    // シャッフル（シード固定で決定的・2ページ目でページング整合も固定化）
    'shuffle_page1'       => ['q' => '＊イロ', 'sort' => 'shuffle', 'seed' => '42'],
    'shuffle_page2'       => ['q' => '＊イロ', 'sort' => 'shuffle', 'seed' => '42', 'offset' => '100'],
    // ページング
    'offset_paging'       => ['q' => '？？イロ', 'offset' => '50', 'limit' => '10'],
    // 空クエリ
    'empty_query'         => ['q' => ''],
    // エラー系（CLI では HTTP ステータスは取れないためボディのみ比較）
    'err_query_too_long'  => ['q' => str_repeat('ア', 51)],
    'err_too_many_stars'  => ['q' => '＊ア＊イ＊ウ＊エ＊オ＊カ＊'],
    'err_exclude_too_long' => ['q' => '？？', 'exclude' => 'アイウエオカキクケコサ'],
    'err_include_too_long' => ['q' => '？？', 'include' => 'アイウエオカキクケコサ'],
];

/** ランナーを子プロセスで実行し、API 応答（JSON 文字列）を返す */
function runQuery(string $runner, array $params): string {
    $proc = proc_open(
        [PHP_BINARY, $runner],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    if (!is_resource($proc)) {
        fwrite(STDERR, "エラー: ランナーを起動できませんでした。\n");
        exit(1);
    }
    fwrite($pipes[0], json_encode($params, JSON_UNESCAPED_UNICODE));
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    if ($code !== 0) {
        fwrite(STDERR, "エラー: ランナーが異常終了しました（exit $code）: $err\n");
        exit(1);
    }
    return $out;
}

/** 応答を比較しやすい正規化テキスト（pretty JSON）にする */
function normalize(string $rawResponse, array $params): string {
    $decoded = json_decode($rawResponse, true);
    $payload = [
        'params'   => $params,
        'response' => $decoded ?? ['_raw' => $rawResponse],
    ];
    return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
}

// ─── 実行 ────────────────────────────────────────────────────────
if (!is_dir($snapshotDir)) {
    mkdir($snapshotDir, 0777, true);
}

$failures = [];
foreach ($cases as $name => $params) {
    $actual = normalize(runQuery($runner, $params), $params);
    $file = "$snapshotDir/$name.json";

    if ($mode === 'update') {
        file_put_contents($file, $actual);
        echo "  wrote $name.json\n";
        continue;
    }

    if (!file_exists($file)) {
        $failures[$name] = 'スナップショットが存在しません（update を実行してください）';
        continue;
    }
    $expected = file_get_contents($file);
    if ($expected === $actual) {
        echo "  PASS $name\n";
    } else {
        // 最初に食い違った行を表示
        $expLines = explode("\n", $expected);
        $actLines = explode("\n", $actual);
        $detail = '応答が一致しません';
        foreach ($actLines as $i => $line) {
            if (($expLines[$i] ?? null) !== $line) {
                $detail = sprintf(
                    "%d行目で不一致:\n      期待: %s\n      実際: %s",
                    $i + 1, trim($expLines[$i] ?? '(なし)'), trim($line)
                );
                break;
            }
        }
        $failures[$name] = $detail;
        echo "  FAIL $name\n";
    }
}

if ($mode === 'update') {
    echo count($cases) . " 件のスナップショットを生成しました。\n";
    exit(0);
}

if ($failures) {
    echo "\n" . count($failures) . " 件のケースで差分が検出されました:\n";
    foreach ($failures as $name => $detail) {
        echo "  ✗ $name: $detail\n";
    }
    echo "意図した変更なら `php scripts/api-snapshot.php update` で再生成してください。\n";
    exit(1);
}
echo "全 " . count($cases) . " ケース PASS。\n";
