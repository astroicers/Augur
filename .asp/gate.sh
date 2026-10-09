#!/usr/bin/env bash
# ⚠️ 由 `asp render gate` 產生 — 勿手改(單一事實源:asp-gate.yaml)
# source sha256: 694041af08b8c441b7478a6fd9add36a38618f80a769b1340ea5e81879e458b9
# renderer sha256: 35536b691fdd92e788b9fc506201c2d739c1e1eabbedabe400548da3780959f3
# ↑ 渲染器座標(#605):src/asp_cli/render.py+schema.py 的內容雜湊——asp-gate.yaml 沒動而渲染器動了時,只有這一行會變
# gate 子集:gitleaks, commit-format
set -u
STRICT="${ASP_GATE_STRICT:-0}"
WARNINGS=0
UNRUN_BLOCKERS=0
UNRUN_IDS=""
UNRUN_FAILCLOSED=0
ALL_CHECKS=('gitleaks' 'commit-format')
_SUM_SEEN=" "

# ---- 可觀測性(全部 env-guarded;未設 GITHUB_* 時本機輸出逐字不變)----
_on_actions() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }
_group()    { if _on_actions; then echo "::group::$1"; fi; }
_endgroup() { if _on_actions; then echo "::endgroup::"; fi; }
_ann() {  # level id message —— 失敗浮到 PR conversation 與 Checks 分頁
  if _on_actions; then printf '::%s title=%s::%s\n' "$1" "$2" "$3"; fi
}
_sum() {  # id 結果 —— 同一 id 只記一列
  case "$_SUM_SEEN" in *" $1 "*) return 0 ;; esac
  _SUM_SEEN="$_SUM_SEEN$1 "
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '| %s | %s |\n' "$1" "$2" >> "$GITHUB_STEP_SUMMARY"
  fi
}
_sum_open() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### gate 檢查"; echo; echo "| check | 結果 |"; echo "| --- | --- |"; } >> "$GITHUB_STEP_SUMMARY"
  fi
}
_sum_close() {  # blocker 早退後剩下沒跑的那幾支,要在表格裡看得見
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    for _c in "${ALL_CHECKS[@]}"; do
      case "$_SUM_SEEN" in *" $_c "*) continue ;; esac
      printf '| %s | ⛔ 未執行(前一支 blocker 早退) |\n' "$_c" >> "$GITHUB_STEP_SUMMARY"
    done
  fi
}
_sum_open
trap _sum_close EXIT

# ---- 機器標記(#683;僅在 ASP_GATE_MARKERS 非空時印)----
_marks_on() { [ -n "${ASP_GATE_MARKERS:-}" ]; }
_mark() {  # id sev rc status —— 代發路徑據此答出「哪一支紅」
  if _marks_on; then printf 'asp:gate-check id=%s sev=%s rc=%s status=%s\n' "$1" "$2" "$3" "$4"; fi
}
# 該支檢查的原始輸出夾在兩行之間——diagnostics 本身是多行且不受控,沒有邊界就只能猜它在哪裡結束。
_out_begin() { if _marks_on; then printf 'asp:gate-out-begin %s\n' "$1"; fi; }
_out_end() { if _marks_on; then printf 'asp:gate-out-end %s\n' "$1"; fi; }

skip() { echo "⏭  $1: 略過($2)"; _sum "$1" "⏭ 略過"; }

_unrun_blocker() {  # id 成因 failclosed —— 一支 blocker 級檢查沒跑成(#654)
  # 「沒跑」與「跑了、通過」在判定上不等價,故不得共用結論行與退出碼。
  # 本函式是**唯一**的入口:缺工具那條、前置條件缺席那條都走它,
  # 新增一支宣告了前置條件的 blocker 因此不必再登記一次。
  UNRUN_BLOCKERS=$((UNRUN_BLOCKERS+1))
  UNRUN_IDS="$UNRUN_IDS $1"
  _sum "$1" "⛔ 未執行(blocker)"
  if [ "$3" = "1" ]; then
    UNRUN_FAILCLOSED=1
    _ann error "$1" "blocker 未執行($2)——已宣告前置條件,整份不放行"
  else
    _ann warning "$1" "blocker 未執行($2)——gate 對這個面向什麼都沒保證"
  fi
}

missing_blocker() {  # id 腳本路徑 —— blocker 級檢查不得因缺檔而停用
  _ann error "$1" "檢查腳本缺席($2)——blocker 級檢查不得因缺檔而停用"
  _sum "$1" "❌ 檢查腳本缺席"
  _mark "$1" blocker 1 missing
  echo "❌ BLOCKER $1: 檢查腳本缺席($2)——blocker 級檢查不得因缺檔而停用"
  exit 1
}

require_inputs() {  # id severity 前置條件... —— 缺席即依 severity 處置(路徑 #587;cmd:<工具> #631)
  local id="$1" sev="$2"; shift 2
  local p missing=""
  for p in "$@"; do
    case "$p" in
      cmd:*) if ! command -v "${p#cmd:}" >/dev/null 2>&1; then missing="$missing ${p#cmd:}(工具未安裝)"; fi ;;
      *) if [ ! -e "$p" ]; then missing="$missing $p"; fi ;;
    esac
  done
  if [ -z "$missing" ]; then return 0; fi
  if [ "$sev" = "blocker" ]; then
    _unrun_blocker "$id" "前置條件缺席(${missing# })" 1
    _mark "$id" "$sev" 1 missing
    echo "⛔ BLOCKER $id: 前置條件缺席(${missing# })——規則庫缺席是該有的東西不見了,工具缺席是這台機器沒裝;blocker 級兩者皆不得略過(略過等於這支檢查在這台機器上不存在),故本支**未執行**且整份不放行(結論行與退出碼說出來,不在這裡早退)"
    return 1
  fi
  skip "$id" "前置條件缺席(${missing# })"
  _mark "$id" "$sev" 200 missing
  return 1
}

run_check() {  # id severity required_bin own cmd...
  local id="$1" sev="$2" req="$3" own="$4"; shift 4
  if ! command -v "$req" >/dev/null 2>&1; then
    if [ "$sev" = "blocker" ]; then
      _unrun_blocker "$id" "工具未安裝:$req" "$STRICT"
      _mark "$id" "$sev" 1 missing
      skip "$id" "工具未安裝:$req(vendoring 由 P2 base image 落地)"
      return 0
    fi
    skip "$id" "工具未安裝:$req(vendoring 由 P2 base image 落地)"
    _mark "$id" "$sev" 200 skip
    return 0
  fi
  # 輸出捕捉後透傳(issue #33):失敗必印診斷。退出碼契約(200 = 沒跑、
  # 201 = 跑了但依設計不判紅)**僅 ASP 自有檢查(builtin-script)適用**
  # ——第三方工具若回這兩個數應依 severity 處置(own=0),否則 blocker 會
  # 靜默 fail-open(issue #46;新增的 201 有完全相同的風險,故同一個閘)
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  _group "$id"
  if [ "$rc" -eq 200 ] && [ "$own" = "1" ]; then
    _out_begin "$id"
    [ -n "$out" ] && printf "%s\n" "$out" || skip "$id" "子檢查自報跳過"
    _out_end "$id"
    _sum "$id" "⏭ 略過"
    _mark "$id" "$sev" "$rc" skip
  elif [ "$rc" -eq 201 ] && [ "$own" = "1" ]; then
    _out_begin "$id"
    if [ -n "$out" ]; then printf "%s\n" "$out"; fi
    _out_end "$id"
    echo "⚠️  $id(已判定未擋)"
    _sum "$id" "⚠️ 已判定未擋"
    _ann warning "$id" "已判定但依設計不擋(rc=$rc)——跑了、有發現,不判紅"
    _mark "$id" "$sev" "$rc" judged-not-blocking
  elif [ "$rc" -eq 0 ]; then
    echo "✅ $id"; _sum "$id" "✅ 通過"
    _mark "$id" "$sev" "$rc" ok
  else
    _out_begin "$id"
    [ -n "$out" ] && printf "%s\n" "$out"
    _out_end "$id"
    case "$sev" in
      blocker) _sum "$id" "❌ BLOCKER"; _ann error "$id" "blocker 檢查失敗(rc=$rc)"
               _mark "$id" "$sev" "$rc" blocker
               echo "❌ BLOCKER $id"; _endgroup; exit 1 ;;
      warning) _sum "$id" "⚠️ warning"; _ann warning "$id" "warning 檢查失敗(rc=$rc)"
               _mark "$id" "$sev" "$rc" warning
               echo "⚠️  $id(warning)"; WARNINGS=$((WARNINGS+1)) ;;
      *)       _sum "$id" "ℹ️ info"; _mark "$id" "$sev" "$rc" info
               echo "ℹ️  $id(info)" ;;
    esac
  fi
  _endgroup
}

_conclude() {  # 結論行 —— 「通過」要說得起(#654)
  if [ "$UNRUN_BLOCKERS" -eq 0 ]; then
    echo "gate 通過(warnings=$WARNINGS)"
    exit 0
  fi
  echo "⛔ 有 $UNRUN_BLOCKERS 支 blocker 未執行(${UNRUN_IDS# })——這幾個面向本輪什麼都沒保證"
  if [ "$UNRUN_FAILCLOSED" = "1" ]; then
    echo "gate 未完整執行(warnings=$WARNINGS)——未執行者之中有已宣告 requires 的 blocker,不放行"
    exit 202
  fi
  echo "gate 通過但不完整(warnings=$WARNINGS)——未執行者皆未宣告 requires,依宣告式刀口(#631)不翻紅;要它擋就在 asp-gate.yaml 上替它宣告"
  exit 0
}

if require_inputs 'gitleaks' blocker '.asp/gitleaks.toml'; then
  run_check 'gitleaks' blocker 'gitleaks' 0 'gitleaks' 'detect' '--no-git' '--redact' '--config' '.asp/gitleaks.toml'
fi
_check_commit_format() {  # PR 情境驗範圍內所有非 merge commit;非 PR 情境驗最近一筆
  local range msgs bad=0 n=0 m
  if [ -n "${GITHUB_BASE_REF:-}" ]; then
    # PR 情境:範圍判定與 .asp/checks/test-mutex.sh 同一種
    range="origin/${GITHUB_BASE_REF}..HEAD"
    if ! msgs="$(git -C "${ASP_GATE_PROJ:-.}" log --no-merges --format=%s "$range" 2>/dev/null)"; then
      echo "PR 情境(GITHUB_BASE_REF=${GITHUB_BASE_REF})判不出範圍 ${range}——取不到 base ref(檢出深度不足?)"
      echo '   fail-closed:驗不到 PR 自己的 commit 時不冒充通過(#583)'
      return 1
    fi
    if [ -z "$msgs" ]; then
      echo "PR 情境(GITHUB_BASE_REF=${GITHUB_BASE_REF})的 ${range} 內零筆非 merge commit——無受檢物"
      echo '   fail-closed:驗不到 PR 自己的 commit 時不冒充通過(#583)'
      return 1
    fi
  else
    # 非 PR 情境:行為不變
    msgs="$(git -C "${ASP_GATE_PROJ:-.}" log -1 --no-merges --first-parent --format=%s 2>/dev/null)"
  fi
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    n=$((n + 1))
    if ! printf '%s' "$m" | grep -qE '^(feat|fix|docs|refactor|test|chore|ci|perf|build|style)(\([A-Za-z0-9._/-]+\))?!?: .+'; then
      echo "❌ commit 訊息不合慣例:$m"
      bad=1
    fi
  done <<< "$msgs"
  if [ "$bad" -ne 0 ]; then
    echo '   慣例(asp-gate.yaml commit-format pattern):^(feat|fix|docs|refactor|test|chore|ci|perf|build|style)(\([A-Za-z0-9._/-]+\))?!?: .+'
    return 1
  fi
  echo "$n 筆非 merge commit 訊息合慣例"
}
if [ -z "${GITHUB_BASE_REF:-}" ] && [ -z "$(git -C "${ASP_GATE_PROJ:-.}" log -1 --no-merges --first-parent --format=%s 2>/dev/null)" ]; then
  skip 'commit-format' '無非 merge commit 可驗(淺 clone;非 PR 情境)'
else
  run_check 'commit-format' blocker git 0 _check_commit_format
fi

_conclude
