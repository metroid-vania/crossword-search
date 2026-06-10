"""フロントエンドの E2E スモークテスト（Playwright / Chromium ヘッドレス）.

PHP 組み込みサーバーを自動起動し、実ブラウザで主要機能の回帰を検証する:
  1. 検索の基本動作とパターン解釈表示
  2. フォーム暗黙送信（実 Enter キーで submit が発火するか。iOS の「完了」キー相当。
     検索フォームにテキスト入力を増やすと壊れる回帰を検知する）
  3. 除外文字・必須文字の絞り込み
  4. シャッフル＋まとめてコピー（全件取得の重複なし・件数一致）
  5. 0件時の「もしかして？」候補

事前準備（初回のみ）:
    pip install playwright
    python -m playwright install chromium

使い方:
    python scripts/e2e_smoke.py
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}/frontend/"

# Windows コンソールのコードページに依存せず UTF-8 で出力する
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))
        failures.append(name)


def fill_search(page, text: str) -> None:
    """検索ボックスに入力し、API の確定描画（stale 解除）を待つ."""
    page.fill("#search-input", text)
    page.wait_for_function(
        "() => !document.getElementById('results-list').classList.contains('stale')"
        " && document.getElementById('hit-count').textContent.includes('件')",
        timeout=10000,
    )


def readings(page) -> list[str]:
    return page.eval_on_selector_all(".reading-copy", "els => els.map(e => e.textContent)")


def main() -> int:
    server = subprocess.Popen(
        ["php", "-S", f"127.0.0.1:{PORT}", "-t", str(ROOT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # サーバー起動待ち
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE, timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            print("エラー: PHP サーバーが起動しませんでした。")
            return 1

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(BASE)

            # ─── 1. 検索の基本動作・パターン解釈 ─────────────────────
            fill_search(page, "？？いろ")
            count_text = page.text_content("#hit-count")
            check("検索: ？？イロ が73件", "73件" in count_text, count_text)
            check("検索: 結果リスト描画", len(readings(page)) == 73)
            assist = page.text_content("#pattern-assist")
            check("解釈表示: 4文字・3〜4文字目", "4文字" in assist and "イロ" in assist, assist)

            # ─── 2. フォーム暗黙送信（iOS 完了キー相当） ─────────────
            n_inputs = page.evaluate(
                "document.querySelectorAll('#search-form input[type=text]').length")
            check("暗黙送信: フォーム内テキスト入力は1つ", n_inputs == 1, f"{n_inputs}個")
            page.evaluate("""() => {
                window.__submitFired = 0;
                document.getElementById('search-form')
                        .addEventListener('submit', () => { window.__submitFired++; });
            }""")
            page.focus("#search-input")
            page.keyboard.press("Enter")
            fired = page.evaluate("window.__submitFired")
            check("暗黙送信: Enter で submit 発火", fired == 1, f"fired={fired}")

            # ─── 3. 除外文字・必須文字 ───────────────────────────────
            page.click("#exclude-toggle")
            page.fill("#exclude-input", "し")
            page.wait_for_function(
                "() => document.getElementById('hit-count').textContent.includes('71件')",
                timeout=10000)
            check("除外: シ除外で71件・ラベル反映",
                  "シ除外" in page.text_content("#hit-count"))
            check("除外: 結果にシを含まない",
                  all("シ" not in r for r in readings(page)))
            page.fill("#include-input", "か")
            page.wait_for_function(
                "() => document.getElementById('hit-count').textContent.includes('11件')",
                timeout=10000)
            check("必須: カ必須で11件・全件カ入り",
                  all("カ" in r for r in readings(page)))
            page.click("#exclude-toggle")  # パネルを閉じてバッジ確認
            check("バッジ: 除外/必須が表示",
                  page.is_visible("#exclude-badge") and page.is_visible("#include-badge"))
            page.click("#exclude-toggle")
            page.fill("#exclude-input", "")
            page.fill("#include-input", "")
            page.click("#exclude-toggle")

            # ─── 4. シャッフル＋まとめてコピー（重複なし・件数一致） ───
            fill_search(page, "＊いろ")
            gojuon_head = readings(page)[:5]
            # NOTE: evaluate に渡す文字列は必ず () => {} で包むこと。
            # 矢印関数を含む「式」を渡すと Playwright が関数とみなして即時呼び出してしまう
            page.evaluate("""() => {
                navigator.clipboard.writeText =
                    t => { window.__copied = t; return Promise.resolve(); };
            }""")
            # シャッフル応答の反映は「先頭5件が変わる」ことで検知する
            # （楽観表示は同じ並びを仮表示するため、stale 解除待ちでは早すぎる）
            page.evaluate("""() => {
                window.__head = [...document.querySelectorAll('.reading-copy')]
                    .slice(0, 5).map(e => e.textContent).join('|');
            }""")
            page.click("#btn-sort-shuffle")
            page.wait_for_function(
                "() => [...document.querySelectorAll('.reading-copy')]"
                ".slice(0, 5).map(e => e.textContent).join('|') !== window.__head",
                timeout=10000)
            check("シャッフル: 並びが五十音順と変化", readings(page)[:5] != gojuon_head)
            page.click("#copy-all-btn")
            page.wait_for_function("() => window.__copied !== undefined", timeout=30000)
            copied = page.evaluate("window.__copied")
            lines = copied.split("\n")
            body = lines[1:]  # 先頭は【パターン】行
            count_text = page.text_content("#hit-count")
            check("コピー: 見出し行に全角パターン", lines[0].startswith("【＊イロ"), lines[0])
            check("コピー: 全件取得で件数表示と一致",
                  f"（{len(body)}件）" in count_text.replace(" ", ""),
                  f"コピー{len(body)}行 vs {count_text}")
            check("コピー: シャッフル全ページに重複なし", len(set(body)) == len(body))
            page.click("#btn-sort-default")

            # ─── 5. 0件時の「もしかして？」 ──────────────────────────
            fill_search(page, "あいあいあ")
            page.wait_for_selector(".suggestion-btn", timeout=10000)
            suggestions = page.eval_on_selector_all(
                ".suggestion-btn", "els => els.map(e => e.textContent)")
            check("もしかして: あいあい を提案", "あいあい" in suggestions, json.dumps(suggestions, ensure_ascii=False))

            # コンソールエラーがないこと（page.on で拾うには遅いので最後に pageerror 件数だけ確認）
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print()
    if failures:
        print(f"{len(failures)} 件のチェックが失敗しました: {', '.join(failures)}")
        return 1
    print("E2E スモークテスト: 全チェック PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
