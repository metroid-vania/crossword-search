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

$query = trim($_GET['q'] ?? '');
$offset = max(0, (int)($_GET['offset'] ?? 0));
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
 * 数字ワイルドカード制約チェック（バックトラッキング）
 *   同じ数字 = 同じ文字
 *   違う数字 = 必ず違う文字
 *   * は任意長マッチ
 */
function matchPattern(
    string $word,  int $wp,
    string $pat,   int $pp,
    array  &$d2c,         // digit  → char
    array  &$c2d          // char   → digit
): bool {
    $plen = mb_strlen($pat);
    $wlen = mb_strlen($word);

    if ($pp === $plen) {
        return $wp === $wlen;
    }

    $p = mb_substr($pat, $pp, 1);

    if ($p === '*') {
        // * は 0 文字以上にマッチ → バックトラック
        $sd = $d2c;
        $sc = $c2d;
        for ($i = $wp; $i <= $wlen; $i++) {
            $d2c = $sd;
            $c2d = $sc;
            if (matchPattern($word, $i, $pat, $pp + 1, $d2c, $c2d)) {
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

    $w = mb_substr($word, $wp, 1);

    if ($p === '?') {
        return matchPattern($word, $wp + 1, $pat, $pp + 1, $d2c, $c2d);
    }

    if (preg_match('/[1-9]/', $p)) {
        if (isset($d2c[$p])) {
            // 既マップ：同じ文字でなければ失敗
            if ($d2c[$p] !== $w) {
                return false;
            }
            return matchPattern($word, $wp + 1, $pat, $pp + 1, $d2c, $c2d);
        }
        // 未マップ：違う数字がすでにこの文字を使っていれば失敗
        if (isset($c2d[$w]) && $c2d[$w] !== $p) {
            return false;
        }
        $d2c[$p] = $w;
        $c2d[$w] = $p;
        $ok = matchPattern($word, $wp + 1, $pat, $pp + 1, $d2c, $c2d);
        if (!$ok) {
            unset($d2c[$p]);
            unset($c2d[$w]);
        }
        return $ok;
    }

    // リテラル文字
    if ($p !== $w) {
        return false;
    }
    return matchPattern($word, $wp + 1, $pat, $pp + 1, $d2c, $c2d);
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
              ORDER BY normalized
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
                  ORDER BY normalized
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
                  ORDER BY normalized
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

    // 数字ワイルドカードあり: PHP 側フィルタが必要なため、候補をチャンクで舐める
    $candidateChunk = 4000;
    $dbOffset       = 0;
    $matchedIndex   = 0;
    $words          = [];
    $hasMore        = false;

    while (true) {
        if (connection_aborted()) break;  // クライアント切断なら即終了
        if (!$hasStar) {
            $fixedLen = mb_strlen($normalized);
            $stmt = $db->prepare(
                "SELECT reading, normalized, variants
                   FROM words
                  WHERE len = :l AND normalized LIKE :p ESCAPE '\\'
                  ORDER BY normalized
                  LIMIT :lim OFFSET :off"
            );
            $stmt->bindValue(':l',   $fixedLen,       SQLITE3_INTEGER);
            $stmt->bindValue(':p',   $likePattern,    SQLITE3_TEXT);
            $stmt->bindValue(':lim', $candidateChunk, SQLITE3_INTEGER);
            $stmt->bindValue(':off', $dbOffset,       SQLITE3_INTEGER);
        } else {
            $stmt = $db->prepare(
                "SELECT reading, normalized, variants
                   FROM words
                  WHERE normalized LIKE :p ESCAPE '\\'
                  ORDER BY normalized
                  LIMIT :lim OFFSET :off"
            );
            $stmt->bindValue(':p',   $likePattern,    SQLITE3_TEXT);
            $stmt->bindValue(':lim', $candidateChunk, SQLITE3_INTEGER);
            $stmt->bindValue(':off', $dbOffset,       SQLITE3_INTEGER);
        }
        $res = $stmt->execute();
        $chunkRows = 0;
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $chunkRows++;
            $d2c = [];
            $c2d = [];
            if (!matchPattern($row['normalized'], 0, $normalized, 0, $d2c, $c2d)) {
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
