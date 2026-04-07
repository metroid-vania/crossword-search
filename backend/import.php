<?php
/**
 * words.txt を SQLite データベースに取り込むインポートスクリプト
 * CLI から一度だけ実行: php import.php
 */

set_time_limit(0);

$hasSqlite3 = class_exists('SQLite3');
$hasPdoSqlite = extension_loaded('pdo_sqlite');
if (!$hasSqlite3 && !$hasPdoSqlite) {
    fwrite(STDERR, "ERROR: SQLite が使えません（SQLite3 / pdo_sqlite が無効）\n");
    fwrite(STDERR, "       現在の PHP は設定ファイル(php.ini)を読み込んでいない可能性があります。\n");
    fwrite(STDERR, "       対応: sqlite3 / pdo_sqlite を有効化した PHP を用意してください。\n");
    fwrite(STDERR, "       例: php.ini を作成し、extension_dir と extension=sqlite3 / extension=pdo_sqlite を有効化\n");
    exit(1);
}

$dbPath = __DIR__ . '/words.db';

if (file_exists($dbPath)) {
    echo "既存のデータベースを削除します...\n";
    unlink($dbPath);
}

$db = new SQLite3($dbPath);
$db->exec("PRAGMA journal_mode = WAL");
$db->exec("PRAGMA synchronous = NORMAL");

$db->exec('CREATE TABLE words (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    reading  TEXT    NOT NULL,
    normalized TEXT  NOT NULL,
    len      INTEGER NOT NULL,
    variants TEXT    NOT NULL
)');

$db->exec('CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
)');

function utf8_ord(string $ch): ?int {
    if ($ch === '') return null;
    $b = array_values(unpack('C*', $ch));
    $c0 = $b[0];
    if ($c0 < 0x80) return $c0;
    if (($c0 & 0xE0) === 0xC0 && isset($b[1])) {
        return (($c0 & 0x1F) << 6) | ($b[1] & 0x3F);
    }
    if (($c0 & 0xF0) === 0xE0 && isset($b[2])) {
        return (($c0 & 0x0F) << 12) | (($b[1] & 0x3F) << 6) | ($b[2] & 0x3F);
    }
    if (($c0 & 0xF8) === 0xF0 && isset($b[3])) {
        return (($c0 & 0x07) << 18) | (($b[1] & 0x3F) << 12) | (($b[2] & 0x3F) << 6) | ($b[3] & 0x3F);
    }
    return null;
}

function utf8_chr(int $codepoint): string {
    if ($codepoint < 0x80) {
        return chr($codepoint);
    }
    if ($codepoint < 0x800) {
        return chr(0xC0 | ($codepoint >> 6)) .
               chr(0x80 | ($codepoint & 0x3F));
    }
    if ($codepoint < 0x10000) {
        return chr(0xE0 | ($codepoint >> 12)) .
               chr(0x80 | (($codepoint >> 6) & 0x3F)) .
               chr(0x80 | ($codepoint & 0x3F));
    }
    return chr(0xF0 | ($codepoint >> 18)) .
           chr(0x80 | (($codepoint >> 12) & 0x3F)) .
           chr(0x80 | (($codepoint >> 6) & 0x3F)) .
           chr(0x80 | ($codepoint & 0x3F));
}

function hiraToKata(string $str): string {
    // U+3041..U+3096 (ぁ..ゖ) → +0x60 で U+30A1..U+30F6 (ァ..ヶ)
    return preg_replace_callback('/[\x{3041}-\x{3096}]/u', function ($m) {
        $cp = utf8_ord($m[0]);
        if ($cp === null) return $m[0];
        return utf8_chr($cp + 0x60);
    }, $str) ?? $str;
}

function u_strlen(string $str): int {
    if (preg_match_all('/./u', $str, $m) === false) {
        return strlen($str);
    }
    return count($m[0]);
}

function normalizeReading(string $str): string {
    // ひらがな → カタカナ（mbstring 非依存）
    $str = hiraToKata($str);
    // 拗音・促音を正規化（検索用）
    static $map = [
        'ァ' => 'ア', 'ィ' => 'イ', 'ゥ' => 'ウ', 'ェ' => 'エ', 'ォ' => 'オ',
        'ッ' => 'ツ',
        'ャ' => 'ヤ', 'ュ' => 'ユ', 'ョ' => 'ヨ',
    ];
    return strtr($str, $map);
}

$inputFiles = [__DIR__ . '/../words.txt'];
foreach (glob(__DIR__ . '/../words_*.txt') as $f) {
    $inputFiles[] = $f;
}

$db->exec('BEGIN');
$stmt = $db->prepare(
    'INSERT INTO words (reading, normalized, len, variants) VALUES (:r, :n, :l, :v)'
);

$count   = 0;
$skipped = 0;

foreach ($inputFiles as $wordsFile) {
    if (!file_exists($wordsFile)) {
        echo "スキップ（見つかりません）: {$wordsFile}\n";
        continue;
    }

    $fp = fopen($wordsFile, 'r');
    if (!$fp) {
        fwrite(STDERR, "ERROR: ファイルを開けません: {$wordsFile}\n");
        continue;
    }

    echo "読み込み中: {$wordsFile}\n";

    while (($line = fgets($fp)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line === '' || ($line[0] ?? '') === ';') {
            continue; // 空行・コメント行をスキップ
        }

        // フォーマット: カタカナ /variant1/variant2/.../  （バリアントなし // も許容）
        if (!preg_match('/^(\S+)\s+\/(.*)\//', $line, $m)) {
            $skipped++;
            continue;
        }

        $reading = $m[1];

        // 2〜13文字のみ取り込む（1文字以下・14文字以上は除外）
        $readingLen = u_strlen($reading);
        if ($readingLen < 2 || $readingLen >= 14) {
            $skipped++;
            continue;
        }

        // バリエーション（最大10件）
        $parts    = explode('/', $m[2]);
        $variants = array_values(array_filter(
            array_slice($parts, 0, 10),
            fn($v) => $v !== ''
        ));

        $normalized = normalizeReading($reading);
        $len        = u_strlen($normalized);

        $stmt->bindValue(':r', $reading,                                    SQLITE3_TEXT);
        $stmt->bindValue(':n', $normalized,                                 SQLITE3_TEXT);
        $stmt->bindValue(':l', $len,                                        SQLITE3_INTEGER);
        $stmt->bindValue(':v', json_encode($variants, JSON_UNESCAPED_UNICODE), SQLITE3_TEXT);
        $stmt->execute();
        $stmt->reset();

        $count++;
        if ($count % 10000 === 0) {
            $db->exec('COMMIT');
            $db->exec('BEGIN');
            echo "インポート中: {$count} 件...\n";
        }
    }

    fclose($fp);
}

$db->exec('COMMIT');

// インデックス作成
echo "インデックスを作成中...\n";
$db->exec('CREATE INDEX idx_normalized      ON words(normalized)');
$db->exec('CREATE INDEX idx_len_normalized  ON words(len, normalized)');

// 総件数をメタ情報として保存
$db->exec("INSERT INTO meta VALUES ('total_words', '{$count}')");

echo "完了: {$count} 件インポート（スキップ: {$skipped} 件）\n";
