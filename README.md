# クロスワード単語検索

SKK-JISYO.L を加工した辞書データを使う、クロスワードパズル作成支援用の単語検索 Web アプリです。  
バックエンドは PHP + SQLite、フロントエンドは静的 HTML/JavaScript で構成されています。

## 特徴

- 1つの検索ボックスで検索（リアルタイム、120ms debounce）
- `?` / `？`（任意の1文字）、`*` / `＊`（任意の0文字以上）
- 数字ワイルドカード（`1`〜`9`、全角可）
  - 同じ数字 = 同じ文字
  - 異なる数字 = 異なる文字
- ひらがな入力対応（検索時にカタカナへ正規化）
- 結果の「まとめてコピー」

## 動作環境

- PHP 8.3 以上（`mbstring`, `sqlite3`, `pdo_sqlite` を有効化）

## セットアップ

1. 辞書ファイル `words.txt` をプロジェクトルートに配置
2. DB 生成

```bash
php backend/import.php
```

3. 開発サーバー起動

```bash
php -S localhost:8000 -t .
```

4. ブラウザで開く

- `http://localhost:8000/frontend/`

## ライセンス

- このアプリ: GPL v3（`LICENSE` を参照）
- 辞書データ: SKK-JISYO.L（`skk-dev/dict`）

## 公開リポジトリ

- [https://github.com/metroid-vania/crossword-search](https://github.com/metroid-vania/crossword-search)

## 注意事項

- `words.txt` と `words.db` はリポジトリに含めません（`.gitignore` 管理）
- 辞書データを再配布する場合は、元ライセンス条件に従ってください
