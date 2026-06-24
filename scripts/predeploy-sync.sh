#!/usr/bin/env bash
# Предеплойная синхронизация: сравнивает ЛОКАЛЬНЫЙ код с тем, что РЕАЛЬНО запущено
# на сервере /opt/app (другой разработчик может деплоить параллельно, минуя git).
#
# ЗАПУСКАТЬ ПЕРЕД КАЖДЫМ ДЕПЛОЕМ. Если есть расхождения — сначала забрать серверную
# версию (--pull) и слить изменения, иначе деплой затрёт чужую работу.
#
# Использование:
#   bash scripts/predeploy-sync.sh          # только сравнить и показать расхождения
#   bash scripts/predeploy-sync.sh --pull    # + скачать серверные исходники в /tmp/server-app
#
# Требует в окружении (или .env): VIBE_API_KEY, SERVER_ID
set -e
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${VIBE_API_KEY:?нужен VIBE_API_KEY}"
: "${SERVER_ID:=6680c024-3a3e-4821-a898-d90cbefd5ff9}"
BASE="https://vibecode.bitrix24.tech/v1"
SET="server.js setup-db.sh src public billing"
EXT='\( -name "*.js" -o -name "*.cjs" -o -name "*.json" -o -name "*.html" -o -name "*.css" -o -name "*.sh" \)'

echo "== git =="
git fetch origin -q || true
LOCAL=$(git rev-parse HEAD 2>/dev/null); REMOTE=$(git rev-parse origin/main 2>/dev/null || echo '')
[ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ] && echo "  ⚠ расхождение с origin/main — сделайте git pull" || echo "  ок: в синхроне с origin"

echo "== хэши: локально vs сервер =="
eval "find $SET -type f $EXT" 2>/dev/null | sort | xargs sha256sum 2>/dev/null \
  | awk '{print $1"  "$2}' > /tmp/local_rel.txt

CMD="cd /opt/app && find $SET -type f $EXT 2>/dev/null | sort | xargs sha256sum 2>/dev/null"
python3 -c "import json,sys;json.dump({'command':sys.argv[1],'timeout':40},open('/tmp/_exec.json','w'))" "$CMD"
curl -s -X POST "$BASE/infra/servers/$SERVER_ID/exec" -H "X-Api-Key: $VIBE_API_KEY" \
  -H "Content-Type: application/json" --data @/tmp/_exec.json \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('data',{}).get('stdout',''))" \
  | grep -E '^[0-9a-f]{64}  ' > /tmp/server_rel.txt || true

echo "  ИЗМЕНЕНЫ (отличается хэш):"
join -j2 <(sort -k2 /tmp/local_rel.txt) <(sort -k2 /tmp/server_rel.txt) | awk '$2!=$3{print "    "$1}'
echo "  ТОЛЬКО НА СЕРВЕРЕ (чужие новые файлы — НЕ ЗАТЕРЕТЬ!):"
comm -13 <(awk '{print $2}' /tmp/local_rel.txt|sort) <(awk '{print $2}' /tmp/server_rel.txt|sort) | sed 's/^/    /'
echo "  ТОЛЬКО ЛОКАЛЬНО (ваши новые файлы):"
comm -23 <(awk '{print $2}' /tmp/local_rel.txt|sort) <(awk '{print $2}' /tmp/server_rel.txt|sort) | sed 's/^/    /'

if [ "$1" = "--pull" ]; then
  echo "== скачиваю серверные исходники в /tmp/server-app =="
  PCMD="cd /opt/app && tar czf - $SET 2>/dev/null | base64 -w0"
  python3 -c "import json,sys;json.dump({'command':sys.argv[1],'timeout':60},open('/tmp/_tar.json','w'))" "$PCMD"
  curl -s -X POST "$BASE/infra/servers/$SERVER_ID/exec" -H "X-Api-Key: $VIBE_API_KEY" \
    -H "Content-Type: application/json" --data @/tmp/_tar.json \
    | python3 -c "import sys,json,base64;b=json.load(sys.stdin).get('data',{}).get('stdout','').strip();open('/tmp/server-app.tgz','wb').write(base64.b64decode(b))"
  rm -rf /tmp/server-app && mkdir -p /tmp/server-app && tar xzf /tmp/server-app.tgz -C /tmp/server-app
  echo "  готово: /tmp/server-app  (сравните: diff -r /tmp/server-app <локальные>)"
fi
echo "== ИТОГ: при наличии 'ТОЛЬКО НА СЕРВЕРЕ' или 'ИЗМЕНЕНЫ' — синхронизируйте перед деплоем =="
