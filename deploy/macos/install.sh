#!/bin/sh
# ============================================================================
# deploy/macos/install.sh · launchd 安装 + 四项验收（装 / 停 / 崩溃自拉 / 重启自启）
# ----------------------------------------------------------------------------
# 为什么这一步必须由**人**在自己的终端里跑：
#   Agent 的沙箱挡住 launchctl（实测 `launchctl list` → exit=1、0 行输出），
#   所以"装服务"这个动作 Agent 做不到、也不可能验证。本脚本能做的只是把
#   该做的事写成**按键即可**的一串，并把每一步的判断条件打出来。
#
# 跑法（两种，都要求你在自己的终端里）：
#   sh deploy/macos/install.sh --dry-run   # 只检查 + 打印将要做什么，不碰 launchctl
#   sh deploy/macos/install.sh            # 真的装
#
# 环境变量（都可选）：
#   HOST=127.0.0.1   监听回环（默认 0.0.0.0，局域网可达；理由见 plist 头注释）
#   DATA_SRC=/tmp/xxym-v5   强制指定要搬的库（默认自动探测 8899 正在用的那个）
#   NODE=/path/to/node      强制指定 node
#
# 它会（顺序不能换）：
#   0) 自检：node 可执行 / 代码目录 / node_modules / 磁盘空间
#   1) 停掉 8899 上的临时实例 —— **必须先停**，因为 PGlite 单写者，
#      运行中复制会得到一份撕裂的库（docs/50 §2）
#   2) 把库复制到持久目录（/tmp 重启会被清空），并**打开副本数一遍**
#   3) 生成并安装 plist（把 node 路径 / 数据目录 / HOST 换成本机实际值）
#   4) 四项验收
#
# ★ 退出码：0 成功 / 1 某步失败 / 2 用法错
# ============================================================================
set -u

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：${a}（只有 --dry-run / --help）"; exit 2 ;;
  esac
done

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
CODE=$(cd "$SELF_DIR/../../code" 2>/dev/null && pwd) || { echo "找不到 code/ 目录（本脚本应在 deploy/macos/ 下）"; exit 1; }
TEMPLATE="$SELF_DIR/aihr-demo.plist"

BASE="$HOME/Library/Application Support/aihr-demo"
DATA="$BASE/data"
LOGS="$BASE/logs"
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT="$AGENT_DIR/com.aihr.demo.plist"
LABEL="com.aihr.demo"
PORT=8899
HOST="${HOST:-0.0.0.0}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
plan(){ printf '  \033[36m→\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------------------
# 0) 自检
# ---------------------------------------------------------------------------
say "0) 自检"

# node：不写死版本号。WorkBuddy 把 node 放在带版本号的目录里，升级后会变，
# 而 plist 里一旦写错路径，launchd 就是"每 10 秒崩一次"的沉默循环。
CUR_FILE="$HOME/.workbuddy/binaries/node/versions/current"
if [ -n "${NODE:-}" ]; then
  :
elif [ -f "$CUR_FILE" ]; then
  V=$(cat "$CUR_FILE" | tr -d '[:space:]')
  NODE="$HOME/.workbuddy/binaries/node/versions/$V/bin/node"
else
  NODE=""
fi

if [ -n "$NODE" ] && [ -x "$NODE" ]; then
  ok "node $("$NODE" -v) → $NODE"
else
  bad "找不到可执行的 node（探测结果：${NODE:-空}）"
  echo "    试：ls ~/.workbuddy/binaries/node/versions/  然后 NODE=/…/bin/node sh $0"
  exit 1
fi

if [ -f "$CODE/app/server.mjs" ]; then ok "代码目录 $CODE"; else bad "缺 $CODE/app/server.mjs"; exit 1; fi
if [ -d "$CODE/node_modules/@electric-sql/pglite" ]; then
  ok "依赖已装（@electric-sql/pglite）"
else
  bad "缺 node_modules/@electric-sql/pglite —— 先 cd $CODE && npm install"
  exit 1
fi

mkdir -p "$BASE" "$LOGS" 2>/dev/null || true
if [ -w "$BASE" ]; then ok "可写：$BASE"; else bad "不可写：$BASE"; exit 1; fi

# 磁盘：一份库 67MB，复制 + 备份都要空间。剩不到 2GB 就别装
AVAIL_MB=$(df -m "$BASE" 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "${AVAIL_MB:-}" ] && [ "$AVAIL_MB" -lt 2048 ]; then
  warn "磁盘只剩 ${AVAIL_MB}MB（库约 67MB；备份目录也在同一块盘）"
else
  ok "磁盘可用 ${AVAIL_MB:-?}MB"
fi

# ---------------------------------------------------------------------------
# 1) 端口 / 临时实例
# ---------------------------------------------------------------------------
say "1) 8899 上的临时实例"

PIDS=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
PORT_BUSY=0
if [ -n "$PIDS" ]; then
  PORT_BUSY=1
  echo "  当前占用 $PORT 的 pid：$(echo $PIDS | tr '\n' ' ')"
  if [ "$DRY" -eq 1 ]; then
    plan "[dry-run] 会 kill 上面这些 pid，并等端口释放（最多 15 秒）"
  else
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null
    i=0
    while [ $i -lt 15 ]; do
      [ -z "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)" ] && break
      sleep 1; i=$((i+1))
    done
    if [ -z "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)" ]; then
      ok "端口 $PORT 已释放（等 ${i}s）"
    else
      bad "端口仍被占用 —— 先手动确认是谁，别硬来"; exit 1
    fi
  fi
else
  ok "端口 $PORT 空闲"
fi

# ---------------------------------------------------------------------------
# 2) 库 → 持久目录（并核对）
# ---------------------------------------------------------------------------
say "2) 库迁移到持久目录"

# 自动探测"当前真正在用的库"，不硬编码版本号：
# 演示库换过 v3 / v4 / v5，写死一个会搬错库。优先取 8899 进程实际打开的
# /tmp/xxym-*，取不到再退"最新的 /tmp/xxym-v<数字> 目录"。
# ★ 两条判据缺一不可：
#   ① 目录里有 PG_VERSION —— /tmp/xxym-v5-scripts 这种脚本目录名字也匹配，搬过去打不开；
#   ② 名字必须是 **xxym-v<纯数字>** —— /tmp 里现在有 xxym-v5-copy、xxym-v5.bak-日期
#      这类副本与备份，按 mtime 取"最新的"会正好取到昨天刚做的副本（它更"新"）。
list_libs() {
  for d in $(ls -dt /tmp/xxym-v[0-9]* 2>/dev/null); do
    case "$(basename "$d")" in
      xxym-v[0-9]|xxym-v[0-9][0-9]) ;;
      *) continue ;;
    esac
    [ -f "$d/PG_VERSION" ] && printf '%s ' "$d"
  done
}
detect_src() {
  if [ -n "${DATA_SRC:-}" ]; then printf '%s' "$DATA_SRC"; return; fi
  for _p in $PIDS; do
    _d=$(lsof -p "$_p" 2>/dev/null | grep -oE '/tmp/xxym-v[0-9]+' | sort -u | head -1)
    if [ -n "${_d:-}" ] && [ -f "$_d/PG_VERSION" ]; then printf '%s' "$_d"; return; fi
  done
  set -- $(list_libs)
  [ -n "${1:-}" ] && printf '%s' "$1"
}
SRC=$(detect_src)

if [ -d "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
  ok "持久库已存在，跳过复制：$DATA"
  echo "      （要用别的库覆盖：先 mv \"$DATA\" \"$DATA.old\" 再重跑 —— 别直接 rm，那是生产数据）"
elif [ -n "$SRC" ] && [ -d "$SRC" ]; then
  echo "  源：$SRC (PG_VERSION=$(cat "$SRC/PG_VERSION" 2>/dev/null)，$(du -sm "$SRC" | cut -f1)MB)"
  echo "  其它候选： $(list_libs)"
  if [ "$DRY" -eq 1 ]; then
    plan "[dry-run] 会 cp -R \"$SRC\" \"$DATA\"，然后打开副本数表/行数（打不开就是失败）"
  else
    cp -R "$SRC" "$DATA" || { bad "复制失败"; exit 1; }
    ok "已复制 → $DATA"
    # ★ 抄完要**打开它**：只看 du 出来的 67MB 不算备份，能开、能数出行数才算。
    #   这一步必须在 launchd 起来之前做 —— 之后库就被服务独占了（单写者）。
    if DATA="$DATA" "$NODE" -e '
      const { PGlite } = await import("@electric-sql/pglite");
      const db = await PGlite.create({ dataDir: process.env.DATA });
      const t = (await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname=\x27public\x27")).rows[0].n;
      const p = (await db.query("SELECT count(*)::int n FROM person")).rows[0].n;
      const s = (await db.query("SELECT count(*)::int n FROM payslip")).rows[0].n;
      await db.close();
      if (t < 10) { console.error(`只有 ${t} 张表，这不是一个可用的库`); process.exit(1); }
      console.log(`表 ${t} · person ${p} · payslip ${s}`);
    '; then
      ok "副本能打开、表与关键行数都在"
    else
      bad "副本打不开或关键表为空 —— 不要继续装（装上去也登录不了）"; exit 1
    fi
  fi
else
  bad "找不到库：/tmp 下没有带 PG_VERSION 的 xxym-v* 目录，也没给 DATA_SRC"
  echo "    此时不要用 SEED_SKIP=1 启动（会得到空库、无账号）。"
  echo "    可显式指定： DATA_SRC=/tmp/xxym-vX sh $0"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) 生成并安装 plist
# ---------------------------------------------------------------------------
say "3) 安装 launchd 服务（${LABEL}）"

[ -f "$TEMPLATE" ] || { bad "找不到模板 $TEMPLATE"; exit 1; }

if [ "$DRY" -eq 1 ]; then
  plan "[dry-run] 会由 $TEMPLATE 生成 ${AGENT}，替换："
  plan "    __NODE__  → $NODE"
  plan "    __CODE__  → $CODE"
  plan "    __DATA__  → $DATA"
  plan "    __LOGS__  → $LOGS"
  plan "    __HOST__  → $HOST   （0.0.0.0 = 局域网可达；127.0.0.1 = 只本机）"
  plan "[dry-run] 会 launchctl bootout/bootstrap gui/$(id -u)（沙箱里做不到，所以只打印）"
  say "dry-run 结束（没有碰 launchctl、没有 kill、没有复制）"
  echo "  确认无误后去掉 --dry-run 再跑一次。"
  exit 0
fi

mkdir -p "$AGENT_DIR"
TMP_PLIST=$(mktemp "/tmp/aihr-plist.XXXXXX")
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__CODE__|$CODE|g" \
    -e "s|__DATA__|$DATA|g" \
    -e "s|__LOGS__|$LOGS|g" \
    -e "s|__HOST__|$HOST|g" \
    "$TEMPLATE" > "$TMP_PLIST" || { bad "生成 plist 失败"; rm -f "$TMP_PLIST"; exit 1; }

# 占位符没换干净 = 装上去必然 exec 失败。宁可在这里停
if grep -q '__\(NODE\|CODE\|DATA\|LOGS\|HOST\)__' "$TMP_PLIST"; then
  bad "plist 里还有没替换的占位符："; grep -n '__[A-Z]*__' "$TMP_PLIST" | head -5
  rm -f "$TMP_PLIST"; exit 1
fi
plutil -lint "$TMP_PLIST" >/dev/null 2>&1 || { bad "plist 语法不合法（plutil -lint 失败）"; rm -f "$TMP_PLIST"; exit 1; }
cp "$TMP_PLIST" "$AGENT"
rm -f "$TMP_PLIST"
ok "已写入 $AGENT"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl unload "$AGENT" 2>/dev/null || true
# 新版 macOS 用 bootstrap；老版用 load。两个都试，以"最后是否注册上"为准
launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null || launchctl load "$AGENT" 2>/dev/null || true
sleep 6
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  ok "服务已注册：$LABEL"
else
  bad "服务未注册 —— 看日志：tail -30 \"$LOGS/aihr-8899.log\""
  echo "    常见原因：node 路径变了（重跑本脚本）、plist 权限、8899 被别的进程抢走"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4) 四项验收
# ---------------------------------------------------------------------------
say "4) 四项验收"

# --- 4.1 装：RunAtLoad 自己起来 ---
printf '  [4.1] 装：RunAtLoad 自动拉起 … '
UP=0; i=0
while [ $i -lt 40 ]; do
  curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/livez" 2>/dev/null && { UP=1; break; }
  sleep 1; i=$((i+1))
done
[ $UP -eq 1 ] && ok "已监听（耗时 ${i}s）" || bad "40 秒内没起来"

# --- 4.2 活过 30 秒（Agent 起的实例撑不过这个窗口，docs/49）---
printf '  [4.2] 存活 30 秒 … '
sleep 30
P1=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$P1" ] && curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/readyz" 2>/dev/null; then
  ok "30 秒后仍在监听 pid=${P1}，readyz=200"
else
  bad "30 秒后已不在 —— launchd 没起到保活作用，查 $LOGS/aihr-8899.log"
fi

# --- 4.3 崩溃自拉 ---
printf '  [4.3] 崩溃自拉：kill -9 后是否自动重启 … '
if [ -n "${P1:-}" ]; then
  # shellcheck disable=SC2086
  kill -9 $P1 2>/dev/null
  sleep 14   # ThrottleInterval=10
  P2=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$P2" ] && [ "$P2" != "$P1" ]; then
    ok "已自动拉起，新 pid=${P2}（旧 ${P1}）"
  else
    bad "没有自动拉起（pid=${P2:-无}）"
  fi
else
  bad "跳过：上一步没有可用 pid"
fi

# --- 4.4 业务可用（登录 + 取数）---
printf '  [4.4] 业务可用：登录 + 带 token 取数 … '
TOK=$(curl -s --max-time 10 -X POST "http://127.0.0.1:$PORT/login?user=1&pwd=admin1234" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOK" ]; then
  N=$(curl -s --max-time 20 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/employees?as_of=2026-03-31" 2>/dev/null | grep -o '"employee_id"' | wc -l | tr -d ' ')
  if [ "${N:-0}" -gt 0 ]; then ok "登录成功，/api/employees 返回 ${N} 条"
  else bad "登录成功但取数为空（N=${N}）—— 库可能是空的"; fi
else
  bad "登录失败 —— 库很可能是空的（查 PGLITE_DATA_DIR 与 SEED_SKIP）"
fi

# ---------------------------------------------------------------------------
# 收尾：把手册写在屏幕上，别只写在文档里
# ---------------------------------------------------------------------------
say "完成。剩下的手工项"
cat <<EOF
  停服务（不会自杀式重启）：
    launchctl bootout gui/\$(id -u)/$LABEL
    （老写法：launchctl unload ~/Library/LaunchAgents/$LABEL.plist）

  重启自启（唯一必须重启机器才能验的一项）：
    重启后  lsof -nP -iTCP:$PORT -sTCP:LISTEN
    有监听 = 成功。库已在 ${DATA}，不会再变空库。

  局域网访问（HOST=${HOST}）：
    本机 IP：  ipconfig getifaddr en0
    别人打开： http://<本机IP>:$PORT
    ★ 局域网里是明文 HTTP（没有 TLS）。只在内网演示用，见 docs/50 §3。

  日志：tail -f "$LOGS/aihr-8899.log"

  备份：服务停着时  cd "$CODE" && $NODE tools/backup-cron.mjs
        （运行时它会拒绝 —— 单写者，运行中 cp 是撕裂的库，docs/52 §2）

  不要再手工起第二个 8899：端口和 PGlite 数据目录都只允许一个写者。
EOF
