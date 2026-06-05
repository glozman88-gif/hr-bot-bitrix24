#!/usr/bin/env bash
# Инициализация PostgreSQL для HR-бота (выполняется в preStart на сервере, от root).
# Рантайм node20-pg ставит postgresql-14, но БД/пользователя создаём сами.
set -e

DB_NAME="${HRBOT_DB:-hrbot}"
DB_USER="${HRBOT_USER:-hrbot}"
DB_PASS="${HRBOT_PASS:-hrbotpass}"

echo "[setup-db] запуск PostgreSQL…"
systemctl enable --now postgresql 2>/dev/null \
  || service postgresql start 2>/dev/null \
  || pg_ctlcluster 14 main start 2>/dev/null || true

# Подождать готовности сокета.
for i in $(seq 1 20); do
  if su - postgres -c "psql -tAc 'SELECT 1' >/dev/null 2>&1"; then break; fi
  sleep 1
done

echo "[setup-db] создаю роль и базу (идемпотентно)…"
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\" | grep -q 1" \
  || su - postgres -c "psql -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'\""

su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\" | grep -q 1" \
  || su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}\""

echo "[setup-db] готово: postgres://${DB_USER}:***@127.0.0.1:5432/${DB_NAME}"
