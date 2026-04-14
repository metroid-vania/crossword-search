# NOTICE

本アプリ「クロスワード辞典」は、SKK 日本語入力システム用の辞書
**SKK-JISYO.L**（<https://github.com/skk-dev/dict>）を加工した辞書データを使用しています。

本 NOTICE は、GPL v3 §5(a)（著作権表示および改変告知の保持義務）に従い、
原著作権表示および本アプリで行った加工内容を明示するものです。

---

## 1. SKK-JISYO.L 原著作権表示（原文ママ）

以下は `skk-dev/dict` リポジトリの `SKK-JISYO.L` 冒頭コメント（ヘッダブロック）を
そのまま転記したものです。

```
;; -*- mode: fundamental; coding: euc-jp -*-
;; Large size dictionary for SKK system
;; Copyright (C) 1988-1995, 1997, 1999-2014
;;
;; Masahiko Sato <masahiko@kuis.kyoto-u.ac.jp>
;; Hironobu Takahashi <takahasi@tiny.or.jp>,
;; Masahiro Doteguchi, Miki Inooka,
;; Yukiyoshi Kameyama <kameyama@kuis.kyoto-u.ac.jp>,
;; Akihiko Sasaki, Dai Ando, Junichi Okukawa,
;; Katsushi Sato and Nobuhiro Yamagishi
;; NAKAJIMA Mikio <minakaji@osaka.email.ne.jp>
;; MITA Yuusuke <clefs@mail.goo.ne.jp>
;; SKK Development Team <skk@ring.gr.jp>
;;
;; Maintainer: SKK Development Team <skk@ring.gr.jp>
;; Keywords: japanese
;;
;; This dictionary is free software; you can redistribute it and/or
;; modify it under the terms of the GNU General Public License as
;; published by the Free Software Foundation; either version 2, or
;; (at your option) any later version.
;;
;; This dictionary is distributed in the hope that it will be useful,
;; but WITHOUT ANY WARRANTY; without even the implied warranty of
;; MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
;; General Public License for more details.
;;
;; You should have received a copy of the GNU General Public License
;; along with Daredevil SKK, see the file COPYING.  If not, write to
;; the Free Software Foundation Inc., 59 Temple Place - Suite 330,
;; Boston, MA 02111-1307, USA.
;;
;; ACKNOWLEDGEMENT
;;
;; この辞書は、SKK 原作者の佐藤雅彦先生が、第 1 版作成のために東北大学
;; 電気通信研究所佐藤研究室 (当時) の学生さん達とともに scratch から作
;; 成されたのをその起源とし、その後、無数のユーザからのユーザ辞書の提
;; 供やフォームによる追加・校閲によって今尚日々メンテナンスされている日
;; 本で最大規模の、GPL による copy free の辞書です。
;;
;; この辞書の作成にご尽力頂いた全ての方に感謝すると共に、これをお読み
;; のあなたのご協力を是非ともお待ちしております。
;;
;;   https://github.com/skk-dev/dict
;;
;; にアクセスし、Issue や Pull request をお寄せください。
;;
;; 辞書の編集方針は committers.md をご参照下さい。
;; そこに記載のない事項、またその変更については、その都度 github.com/skk-dev/dict/Issue
;; で話し合いで決められます。
```

SKK-JISYO.L は **GNU General Public License version 2 or any later version**
の条件の下でライセンスされています。本アプリはこれを GPL v3 の条件下で利用しています
（GPL v2+ は GPL v3 と互換です）。

## 2. 本アプリで行った改変内容

本アプリ（このリポジトリ）は、SKK-JISYO.L に対し以下の加工を行った辞書データ
（`words.txt` / `words.db`）を使用しています。

1. **エンコーディング変換**：EUC-JP → UTF-8
2. **見出し語の抽出**：送りなしエントリ（okuri-nasi entries）から、
   カタカナ／ひらがなの見出し語のみを抽出
3. **ひらがな → カタカナ変換**：見出しをカタカナへ正規化
4. **短すぎる語の除外**：2 文字未満の見出し語を除外
5. **表記バリエーションの制限**：`/` 区切りの表記候補を先頭 10 件までに制限
6. **注釈の除去**：`;` 以降の注釈・語義コメントを削除
7. **フォーマット変換**：SKK 形式 → 独自のタブ区切りテキスト `words.txt`、
   さらに SQLite データベース `words.db`（テーブル `words(id, reading, variants)`）
   へ変換
8. **独自追加語の統合**：`words_addition.txt`（本アプリのために新規作成、同じく GPL v2 以降）
   のエントリを合成

加工処理の具体的な実装は `backend/import.php` にあります。これが本アプリにおける
「preferred form for modification（改変に適した形式）」に相当します。

## 3. ライセンス境界

| 成果物 | 出所 | ライセンス |
|-------|------|-----------|
| `backend/` 以下の PHP / `frontend/` 以下の HTML・JS・CSS | 本アプリ独自 | **GPL v3** |
| `words_addition.txt` | 本アプリ独自 | **GPL v2 or later**（SKK-JISYO.L と互換） |
| `words.txt`（配布対象外・`.gitignore`） | SKK-JISYO.L の派生物 | GPL v2 or later |
| `words.db`（配布対象外・`.gitignore`） | SKK-JISYO.L の派生物 | GPL v2 or later |

リポジトリ全体としては GPL v3 のもとで公開しています。  
本アプリの再配布・改変は GPL v3 の条件に、辞書データ単体の再配布は
原ライセンス（GPL v2 or later）の条件に従ってください。

## 4. 関連リンク

- SKK-JISYO.L 原典: <https://github.com/skk-dev/dict>
- GPL v2: <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>
- GPL v3: <https://www.gnu.org/licenses/gpl-3.0.html>
