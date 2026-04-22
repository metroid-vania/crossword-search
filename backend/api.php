<?php
/**
 * 単語検索 API
 * GET /api.php?q=<検索クエリ>
 * Response: {"count":N, "total":N, "words":[{"reading":"...","variants":["..."]}], "limited":bool}
 */

mb_internal_encoding('UTF-8');
ignore_user_abort(false);      // クライアント切断時に処理を中断
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET');
header('Vary: Accept-Encoding');
// 既定はキャッシュさせない（400/500 などエラー応答はキャッシュを残したくない）。
// 成功応答の直前で public キャッシュに上書きする。
header('Cache-Control: no-store');

$query = trim($_GET['q'] ?? '');

// 入力長制限（DoS 対策：長大クエリによる重い LIKE や再帰爆発を防ぐ）
if (mb_strlen($query) > 50) {
    http_response_code(400);
    echo json_encode(
        ['error' => 'クエリが長すぎます（最大50文字）。'],
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

// ワイルドカード `*` / `＊` の個数制限（バックトラッキング爆発対策）
$starCount = preg_match_all('/[\*＊]/u', $query);
if ($starCount > 5) {
    http_response_code(400);
    echo json_encode(
        ['error' => 'ワイルドカード（*）が多すぎます（最大5個）。'],
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

$offset = max(0, min(10000, (int)($_GET['offset'] ?? 0))); // 上限 10000（深ページング抑制）
$limit  = (int)($_GET['limit'] ?? 100);
if ($limit <= 0) $limit = 100;
if ($limit > 200) $limit = 200; // 過負荷防止

$dbPath = __DIR__ . '/words.db';
if (!file_exists($dbPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'データベースが見つかりません。import.php を実行してください。']);
    exit;
}

$db    = new SQLite3($dbPath, SQLITE3_OPEN_READONLY);
$total = (int) $db->querySingle("SELECT value FROM meta WHERE key='total_words'");

if ($query === '') {
    echo json_encode(['count' => 0, 'total' => $total, 'words' => [], 'hasMore' => false],
                     JSON_UNESCAPED_UNICODE);
    exit;
}

$result = searchWords($db, $query, $total, $offset, $limit);
// 成功応答：辞書はほぼ不変なので中期ブラウザキャッシュを許可
//   10分間は新鮮扱い、以降 1時間は古い応答を即時返しつつ裏で再検証
header('Cache-Control: public, max-age=600, stale-while-revalidate=3600');
echo json_encode($result, JSON_UNESCAPED_UNICODE);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 入力クエリの正規化
 *   全角ワイルドカード・数字 → 半角
 *   ひらがな → カタカナ
 *   拗音・促音 → 大文字（ァ→ア etc.）
 */
function normalizeQuery(string $str): string {
    $str = str_replace(
        ['？', '＊', '１', '２', '３', '４', '５', '６', '７', '８', '９'],
        ['?',  '*',  '1',  '2',  '3',  '4',  '5',  '6',  '7',  '8',  '9'],
        $str
    );
    $str = mb_convert_kana($str, 'C', 'UTF-8');
    static $map = [
        'ァ' => 'ア', 'ィ' => 'イ', 'ゥ' => 'ウ', 'ェ' => 'エ', 'ォ' => 'オ',
        'ッ' => 'ツ',
        'ャ' => 'ヤ', 'ュ' => 'ユ', 'ョ' => 'ヨ',
    ];
    return strtr($str, $map);
}

/**
 * 正規化済みパターン → SQLite LIKE パターンに変換
 *   ? / 数字 → _（1文字）
 *   *        → %（0文字以上）
 *   リテラル文字中の \ % _ はエスケープ
 */
function buildLikePattern(string $pattern): string {
    $result = '';
    $len    = mb_strlen($pattern);
    for ($i = 0; $i < $len; $i++) {
        $ch = mb_substr($pattern, $i, 1);
        if ($ch === '*') {
            $result .= '%';
        } elseif ($ch === '?') {
            $result .= '_';
        } elseif (preg_match('/[1-9]/', $ch)) {
            $result .= '_';
        } else {
            if ($ch === '\\' || $ch === '%' || $ch === '_') {
                $result .= '\\' . $ch;
            } else {
                $result .= $ch;
            }
        }
    }
    return $result;
}

/**
 * 数字ワイルドカードから位置ペア制約を抽出
 *   同じ数字（例：１...１）→ 同字制約（eq）
 *   違う数字（例：１...２）→ 異字制約（neq）
 *
 * 戻り値: ['eq' => [[posA, posB], ...], 'neq' => [[posA, posB], ...]]
 *   ※ posA/posB は 1-indexed（SQL substr で使うため）
 */
function extractDigitConstraints(array $patChars): array {
    $posByDigit = [];
    foreach ($patChars as $i => $ch) {
        $code = ord($ch);
        if ($code >= 0x31 && $code <= 0x39) {
            $posByDigit[$ch][] = $i + 1;
        }
    }
    $eq = [];
    foreach ($posByDigit as $positions) {
        // 同じ数字の全位置同士が等しい → 最初の位置と他の位置をペアに
        for ($i = 1, $n = count($positions); $i < $n; $i++) {
            $eq[] = [$positions[0], $positions[$i]];
        }
    }
    $neq = [];
    $digits = array_keys($posByDigit);
    $dn = count($digits);
    for ($i = 0; $i < $dn; $i++) {
        for ($j = $i + 1; $j < $dn; $j++) {
            // 違う数字の代表位置同士を 1 組（eq 制約で他の位置へ伝播する）
            $neq[] = [$posByDigit[$digits[$i]][0], $posByDigit[$digits[$j]][0]];
        }
    }
    return ['eq' => $eq, 'neq' => $neq];
}

/**
 * 数字ワイルドカード制約チェック（バックトラッキング）
 *   同じ数字 = 同じ文字
 *   違う数字 = 必ず違う文字
 *   * は任意長マッチ
 *
 * 入力は事前に preg_split('//u') で分解した char 配列を受け取る
 * （mb_substr を再帰の毎回呼ぶと O(n²) になるため）
 */
function matchPattern(
    array $w,  int $wp, int $wlen,
    array $p,  int $pp, int $plen,
    array &$d2c,         // digit  → char
    array &$c2d          // char   → digit
): bool {
    if ($pp === $plen) {
        return $wp === $wlen;
    }

    $ch = $p[$pp];

    if ($ch === '*') {
        // * は 0 文字以上にマッチ → バックトラック
        $sd = $d2c;
        $sc = $c2d;
        for ($i = $wp; $i <= $wlen; $i++) {
            $d2c = $sd;
            $c2d = $sc;
            if (matchPattern($w, $i, $wlen, $p, $pp + 1, $plen, $d2c, $c2d)) {
                return true;
            }
        }
        $d2c = $sd;
        $c2d = $sc;
        return false;
    }

    if ($wp >= $wlen) {
        return false;
    }

    $wc = $w[$wp];

    if ($ch === '?') {
        return matchPattern($w, $wp + 1, $wlen, $p, $pp + 1, $plen, $d2c, $c2d);
    }

    // 数字ワイルドカード（1-9）は ASCII 1 バイトなので ord で高速判定
    $code = ord($ch);
    if ($code >= 0x31 && $code <= 0x39) {
        if (isset($d2c[$ch])) {
            // 既マップ：同じ文字でなければ失敗
            if ($d2c[$ch] !== $wc) {
                return false;
            }
            return matchPattern($w, $wp + 1, $wlen, $p, $pp + 1, $plen, $d2c, $c2d);
        }
        // 未マップ：違う数字がすでにこの文字を使っていれば失敗
        if (isset($c2d[$wc]) && $c2d[$wc] !== $ch) {
            return false;
        }
        $d2c[$ch] = $wc;
        $c2d[$wc] = $ch;
        $ok = matchPattern($w, $wp + 1, $wlen, $p, $pp + 1, $plen, $d2c, $c2d);
        if (!$ok) {
            unset($d2c[$ch]);
            unset($c2d[$wc]);
        }
        return $ok;
    }

    // リテラル文字
    if ($ch !== $wc) {
        return false;
    }
    return matchPattern($w, $wp + 1, $wlen, $p, $pp + 1, $plen, $d2c, $c2d);
}

function searchWords(SQLite3 $db, string $query, int $total, int $offset, int $limit): array {
    $normalized = normalizeQuery($query);

    $hasNumeric  = (bool) preg_match('/[1-9]/', $normalized);
    $hasQuestion = strpos($normalized, '?') !== false;
    $hasStar     = strpos($normalized, '*') !== false;
    $hasWildcard = $hasQuestion || $hasStar;

    // ─── 完全一致 ──────────────────────────────────────────────────────────
    if (!$hasNumeric && !$hasWildcard) {
        $stmt = $db->prepare(
            'SELECT reading, variants
               FROM words
              WHERE normalized = :n
              ORDER BY len, normalized
              LIMIT :lim OFFSET :off'
        );
        $stmt->bindValue(':n',   $normalized, SQLITE3_TEXT);
        $stmt->bindValue(':lim', $limit + 1,  SQLITE3_INTEGER);
        $stmt->bindValue(':off', $offset,     SQLITE3_INTEGER);
        $res   = $stmt->execute();
        $words = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $words[] = [
                'reading'  => $row['reading'],
                'variants' => json_decode($row['variants'], true),
            ];
        }
        $hasMore = count($words) > $limit;
        if ($hasMore) array_pop($words);
        return ['count' => count($words), 'total' => $total, 'words' => $words, 'hasMore' => $hasMore];
    }

    // ─── ワイルドカード検索 ────────────────────────────────────────────────
    $likePattern = buildLikePattern($normalized);

    if (!$hasNumeric) {
        // 数字ワイルドカードなし: SQL の LIMIT/OFFSET でそのままページング
        if (!$hasStar) {
            // * がなければ文字数固定 → len でも絞り込む
            $fixedLen = mb_strlen($normalized);
            $stmt = $db->prepare(
                "SELECT reading, variants
                   FROM words
                  WHERE len = :l AND normalized LIKE :p ESCAPE '\\'
                  ORDER BY len, normalized
                  LIMIT :lim OFFSET :off"
            );
            $stmt->bindValue(':l',   $fixedLen,    SQLITE3_INTEGER);
            $stmt->bindValue(':p',   $likePattern, SQLITE3_TEXT);
            $stmt->bindValue(':lim', $limit + 1,   SQLITE3_INTEGER);
            $stmt->bindValue(':off', $offset,      SQLITE3_INTEGER);
        } else {
            $stmt = $db->prepare(
                "SELECT reading, variants
                   FROM words
                  WHERE normalized LIKE :p ESCAPE '\\'
                  ORDER BY len, normalized
                  LIMIT :lim OFFSET :off"
            );
            $stmt->bindValue(':p',   $likePattern, SQLITE3_TEXT);
            $stmt->bindValue(':lim', $limit + 1,   SQLITE3_INTEGER);
            $stmt->bindValue(':off', $offset,      SQLITE3_INTEGER);
        }

        $res   = $stmt->execute();
        $words = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $words[] = [
                'reading'  => $row['reading'],
                'variants' => json_decode($row['variants'], true),
            ];
        }
        $hasMore = count($words) > $limit;
        if ($hasMore) array_pop($words);

        return [
            'count'   => count($words),
            'total'   => $total,
            'words'   => $words,
            'hasMore' => $hasMore,
        ];
    }

    // パターン側は候補ごとに不変なので事前に分解
    $patChars = preg_split('//u', $normalized, -1, PREG_SPLIT_NO_EMPTY);
    $patLen   = count($patChars);

    // ─── 数字ワイルドカードあり、* なし ─────────────────────────────────────
    // 位置が固定なので、同字/異字制約を substr() で SQL 側に push down できる
    // → PHP 側フィルタ・チャンク走査が不要で LIMIT/OFFSET が効く
    if (!$hasStar) {
        $constraints = extractDigitConstraints($patChars);
        $fixedLen    = $patLen;
        $conds       = ["len = :l", "normalized LIKE :p ESCAPE '\\'"];
        foreach ($constraints['eq'] as [$a, $b]) {
            $conds[] = "substr(normalized, $a, 1) = substr(normalized, $b, 1)";
        }
        foreach ($constraints['neq'] as [$a, $b]) {
            $conds[] = "substr(normalized, $a, 1) != substr(normalized, $b, 1)";
        }
        $sql = "SELECT reading, variants
                  FROM words
                 WHERE " . implode(' AND ', $conds) . "
                 ORDER BY len, normalized
                 LIMIT :lim OFFSET :off";
        $stmt = $db->prepare($sql);
        $stmt->bindValue(':l',   $fixedLen,    SQLITE3_INTEGER);
        $stmt->bindValue(':p',   $likePattern, SQLITE3_TEXT);
        $stmt->bindValue(':lim', $limit + 1,   SQLITE3_INTEGER);
        $stmt->bindValue(':off', $offset,      SQLITE3_INTEGER);

        $res   = $stmt->execute();
        $words = [];
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $words[] = [
                'reading'  => $row['reading'],
                'variants' => json_decode($row['variants'], true),
            ];
        }
        $hasMore = count($words) > $limit;
        if ($hasMore) array_pop($words);
        return [
            'count'   => count($words),
            'total'   => $total,
            'words'   => $words,
            'hasMore' => $hasMore,
        ];
    }

    // ─── 数字ワイルドカード + * あり ─────────────────────────────────────
    // 位置が可変なので PHP 側フィルタが必要。候補をチャンクで舐める
    $candidateChunk = 4000;
    $dbOffset       = 0;
    $matchedIndex   = 0;
    $words          = [];
    $hasMore        = false;

    while (true) {
        if (connection_aborted()) break;  // クライアント切断なら即終了
        $stmt = $db->prepare(
            "SELECT reading, normalized, variants
               FROM words
              WHERE normalized LIKE :p ESCAPE '\\'
              ORDER BY len, normalized
              LIMIT :lim OFFSET :off"
        );
        $stmt->bindValue(':p',   $likePattern,    SQLITE3_TEXT);
        $stmt->bindValue(':lim', $candidateChunk, SQLITE3_INTEGER);
        $stmt->bindValue(':off', $dbOffset,       SQLITE3_INTEGER);
        $res = $stmt->execute();
        $chunkRows = 0;
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $chunkRows++;
            $d2c = [];
            $c2d = [];
            $wordChars = preg_split('//u', $row['normalized'], -1, PREG_SPLIT_NO_EMPTY);
            $wordLen   = count($wordChars);
            if (!matchPattern($wordChars, 0, $wordLen, $patChars, 0, $patLen, $d2c, $c2d)) {
                continue;
            }
            if ($matchedIndex < $offset) {
                $matchedIndex++;
                continue;
            }
            if (count($words) >= $limit) {
                $hasMore = true;
                break 2;
            }
            $words[] = [
                'reading'  => $row['reading'],
                'variants' => json_decode($row['variants'], true),
            ];
            $matchedIndex++;
        }

        if ($chunkRows < $candidateChunk) {
            break;
        }
        $dbOffset += $candidateChunk;
    }

    return [
        'count'   => count($words),
        'total'   => $total,
        'words'   => $words,
        'hasMore' => $hasMore,
    ];
}
