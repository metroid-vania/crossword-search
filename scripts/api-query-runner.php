<?php
/**
 * api.php を1リクエスト分だけ実行する内部ランナー（api-snapshot.php から起動される）。
 *
 * stdin から JSON のクエリパラメータを受け取り、$_GET にセットして api.php を include する。
 * api.php は処理後に exit するため、1プロセス1クエリ。引数を stdin で渡すのは
 * Windows での非 ASCII コマンドライン引数の文字化けを避けるため。
 *
 * 使い方（直接実行する場合）:
 *   echo {"q":"？？イロ"} | php scripts/api-query-runner.php
 */

if (PHP_SAPI !== 'cli') {
    exit('This script is CLI only.');
}

$params = json_decode(stream_get_contents(STDIN), true);
if (!is_array($params)) {
    fwrite(STDERR, "エラー: stdin から有効な JSON パラメータを読み取れませんでした。\n");
    exit(1);
}

$_GET = $params;
include dirname(__DIR__) . '/backend/api.php';
