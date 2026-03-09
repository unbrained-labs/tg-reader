#!/usr/bin/env bash
# E2E verification script for tg-reader Worker API
# Run after deploying: bash scripts/e2e-verify.sh
#
# Required env vars:
#   WORKER_URL    — full URL of deployed Worker (no trailing slash)
#   INGEST_TOKEN  — shared auth token
#
# Usage:
#   WORKER_URL=https://tg-reader.<account>.workers.dev \
#   INGEST_TOKEN=<secret> \
#   bash scripts/e2e-verify.sh

set -euo pipefail

WORKER_URL="${WORKER_URL:?WORKER_URL is required}"
INGEST_TOKEN="${INGEST_TOKEN:?INGEST_TOKEN is required}"

PASS=0
FAIL=0

green() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$1"; }
info()  { printf '\033[36m  %s\033[0m\n' "$1"; }

pass() { green "$1"; PASS=$((PASS+1)); }
fail() { red "$1";   FAIL=$((FAIL+1)); }

header() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
# Auth check
# ---------------------------------------------------------------------------
header "Auth"

status=$(curl -s -o /dev/null -w "%{http_code}" "$WORKER_URL/search")
if [ "$status" = "401" ]; then
  pass "Unauthenticated request returns 401"
else
  fail "Expected 401 without token, got $status"
fi

# ---------------------------------------------------------------------------
# Config endpoints
# ---------------------------------------------------------------------------
header "Config"

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" "$WORKER_URL/config")
sync_mode=$(echo "$body" | grep -o '"sync_mode":"[^"]*"' | cut -d'"' -f4)
if [ -n "$sync_mode" ]; then
  pass "GET /config returns sync_mode=$sync_mode"
else
  fail "GET /config missing sync_mode field (got: $body)"
fi

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sync_mode":"all"}' \
  "$WORKER_URL/config")
if [ "$status" = "200" ]; then
  pass "POST /config accepted sync_mode=all"
else
  fail "POST /config returned $status (expected 200)"
fi

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sync_mode":"invalid"}' \
  "$WORKER_URL/config")
if [ "$status" = "400" ]; then
  pass "POST /config rejects invalid sync_mode with 400"
else
  fail "POST /config should return 400 for invalid sync_mode, got $status"
fi

# ---------------------------------------------------------------------------
# Ingest endpoint
# ---------------------------------------------------------------------------
header "Ingest"

NOW=$(date +%s)
TEST_CHAT_ID="99999999999"
TEST_MSG_ID=$((RANDOM + 90000))
KEYWORD="xqz9test_$(date +%s)"

body=$(curl -s -X POST \
  -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"messages\":[{
    \"tg_message_id\": $TEST_MSG_ID,
    \"tg_chat_id\": \"$TEST_CHAT_ID\",
    \"chat_name\": \"E2E Test Chat\",
    \"chat_type\": \"user\",
    \"direction\": \"out\",
    \"message_type\": \"text\",
    \"text\": \"$KEYWORD hello world\",
    \"sent_at\": $NOW
  }]}" \
  "$WORKER_URL/ingest")

inserted=$(echo "$body" | grep -o '"inserted":[0-9]*' | cut -d: -f2)
if [ "$inserted" = "1" ]; then
  pass "POST /ingest inserted=1 for new message"
else
  fail "POST /ingest unexpected response: $body"
fi

# Idempotency: re-insert same message
body2=$(curl -s -X POST \
  -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"messages\":[{
    \"tg_message_id\": $TEST_MSG_ID,
    \"tg_chat_id\": \"$TEST_CHAT_ID\",
    \"chat_name\": \"E2E Test Chat\",
    \"chat_type\": \"user\",
    \"direction\": \"out\",
    \"message_type\": \"text\",
    \"text\": \"$KEYWORD hello world\",
    \"sent_at\": $NOW
  }]}" \
  "$WORKER_URL/ingest")

skipped=$(echo "$body2" | grep -o '"skipped":[0-9]*' | cut -d: -f2)
if [ "$skipped" = "1" ]; then
  pass "POST /ingest skipped=1 on duplicate (ON CONFLICT idempotency)"
else
  fail "POST /ingest re-insert: expected skipped=1, got: $body2"
fi

# Validation: empty array
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}' \
  "$WORKER_URL/ingest")
if [ "$status" = "400" ]; then
  pass "POST /ingest rejects empty messages array with 400"
else
  fail "POST /ingest empty array: expected 400, got $status"
fi

# ---------------------------------------------------------------------------
# Search endpoint
# ---------------------------------------------------------------------------
header "Search"

# FTS5 search — slight delay for FTS5 index to be consistent
sleep 1

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/search?q=$KEYWORD")
count=$(echo "$body" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)
if [ "$count" = "1" ]; then
  pass "GET /search?q=$KEYWORD found 1 result"
else
  fail "GET /search FTS5: expected total=1, got: $body"
fi

# Verify sent_at is integer (not string)
sent_at_val=$(echo "$body" | grep -o '"sent_at":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "$sent_at_val" ] && [ "$sent_at_val" -gt 1000000000 ] 2>/dev/null; then
  pass "sent_at is integer epoch seconds (value=$sent_at_val)"
else
  fail "sent_at is missing or not an integer: $body"
fi

# Date range filter
PAST=$((NOW - 3600))
FUTURE=$((NOW + 3600))
body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/search?from=$PAST&to=$FUTURE&chat_id=$TEST_CHAT_ID")
count=$(echo "$body" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)
if [ "${count:-0}" -ge 1 ] 2>/dev/null; then
  pass "GET /search?from=&to= date range filter works (total=$count)"
else
  fail "GET /search date range: expected >=1 result, got: $body"
fi

# Out-of-range: future window should return 0
FUTURE2=$((NOW + 7200))
FUTURE3=$((NOW + 10800))
body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/search?from=$FUTURE2&to=$FUTURE3&chat_id=$TEST_CHAT_ID")
count=$(echo "$body" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)
if [ "${count:-0}" = "0" ] 2>/dev/null; then
  pass "GET /search future date range returns 0 results"
else
  fail "GET /search future range: expected 0, got: $body"
fi

# ---------------------------------------------------------------------------
# Chats endpoint
# ---------------------------------------------------------------------------
header "Chats"

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" "$WORKER_URL/chats")
if echo "$body" | grep -q "$TEST_CHAT_ID"; then
  pass "GET /chats includes test chat $TEST_CHAT_ID"
else
  fail "GET /chats missing test chat: $body"
fi

# ---------------------------------------------------------------------------
# Chat config
# ---------------------------------------------------------------------------
header "Chat Config"

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tg_chat_id\":\"$TEST_CHAT_ID\",\"sync\":\"exclude\"}" \
  "$WORKER_URL/chats/config")
if [ "$status" = "200" ]; then
  pass "POST /chats/config set exclude for test chat"
else
  fail "POST /chats/config returned $status"
fi

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" "$WORKER_URL/chats/config")
if echo "$body" | grep -q '"exclude"'; then
  pass "GET /chats/config shows exclude override"
else
  fail "GET /chats/config missing override: $body"
fi

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/chats/config/$TEST_CHAT_ID")
if [ "$status" = "200" ]; then
  pass "DELETE /chats/config/:id removes override"
else
  fail "DELETE /chats/config returned $status"
fi

# ---------------------------------------------------------------------------
# Backfill state
# ---------------------------------------------------------------------------
header "Backfill State"

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"dialogs\":[{\"tg_chat_id\":\"$TEST_CHAT_ID\",\"chat_name\":\"E2E Test\",\"total_messages\":null}]}" \
  "$WORKER_URL/backfill/seed")
if [ "$status" = "200" ]; then
  pass "POST /backfill/seed accepts dialog list"
else
  fail "POST /backfill/seed returned $status"
fi

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" "$WORKER_URL/backfill/pending")
if echo "$body" | grep -q "$TEST_CHAT_ID"; then
  pass "GET /backfill/pending returns seeded dialog"
else
  fail "GET /backfill/pending missing test dialog: $body"
fi

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tg_chat_id\":\"$TEST_CHAT_ID\",\"status\":\"complete\",\"fetched_messages\":1}" \
  "$WORKER_URL/backfill/progress")
if [ "$status" = "200" ]; then
  pass "POST /backfill/progress updates status to complete"
else
  fail "POST /backfill/progress returned $status"
fi

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tg_chat_id\":\"$TEST_CHAT_ID\",\"status\":\"bogus\"}" \
  "$WORKER_URL/backfill/progress")
if [ "$status" = "400" ]; then
  pass "POST /backfill/progress rejects invalid status with 400"
else
  fail "POST /backfill/progress invalid status: expected 400, got $status"
fi

# ---------------------------------------------------------------------------
# Contacts endpoint
# ---------------------------------------------------------------------------
header "Contacts"

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"tg_user_id":"11111111","username":"e2etest","first_name":"E2E","is_bot":0}]' \
  "$WORKER_URL/contacts")
if [ "$status" = "200" ]; then
  pass "POST /contacts upserts contact"
else
  fail "POST /contacts returned $status"
fi

body=$(curl -s -H "X-Ingest-Token: $INGEST_TOKEN" "$WORKER_URL/contacts")
if echo "$body" | grep -q "e2etest"; then
  pass "GET /contacts returns upserted contact"
else
  fail "GET /contacts missing upserted contact: $body"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n\033[1m=== Results ===\033[0m\n'
green "$PASS passed"
if [ "$FAIL" -gt 0 ]; then
  red "$FAIL failed"
  exit 1
else
  printf '\n\033[32mAll API tests passed.\033[0m\n'
fi
