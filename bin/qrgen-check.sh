#!/usr/bin/env bash
# Smoke-check a qrgen deployment end to end.
#
#   bin/qrgen-check.sh                          # checks production
#   bin/qrgen-check.sh http://localhost:3399    # checks a local dev server
#
# The token is read from $QRGEN_TOKEN, else from hc-new over ssh. Internal
# callers need no token, so a missing one is only fatal for the auth checks.
#
# Exits non-zero if anything failed, so it can be dropped into cron or CI.

set -uo pipefail
BASE="${1:-https://qr.hoopscollege.com}"
BASE="${BASE%/}"
TOKEN="${QRGEN_TOKEN:-}"

if [ -z "$TOKEN" ] && [[ "$BASE" == https://qr.hoopscollege.com ]]; then
  TOKEN=$(ssh -o ConnectTimeout=10 hc-new "grep '^QRGEN_TOKEN=' /opt/qrgen/.env | cut -d= -f2" 2>/dev/null || true)
fi

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %-38s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %-38s %s\n' "$1" "$2";     fail=$((fail+1)); }
check(){ # name expected actual
  if [ "$2" = "$3" ]; then ok "$1" "$3"; else bad "$1" "expected $2, got $3"; fi
}
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "$@"; }
JSON=(-H 'Content-Type: application/json')
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "qrgen smoke check → $BASE"
echo
echo "liveness"
check "GET /health"            200 "$(code "$BASE/health")"
check "GET /ui"                200 "$(code "$BASE/ui")"
check "GET /auth"              200 "$(code "$BASE/auth")"

echo "auth gating"
# Internal callers (RFC1918, no X-Forwarded-For) are exempt by design, so the
# "no token" check only applies where the server says a token is required.
if curl -s -m 20 "$BASE/auth" | grep -q '"tokenRequired":true'; then
  check "POST /generate no token"  401 "$(code -X POST "${JSON[@]}" -d '{"data":"x"}' "$BASE/generate")"
else
  ok   "POST /generate no token"   "skipped - caller is internal, token not required"
fi
check "POST /generate bad token"   401 "$(code -X POST "${JSON[@]}" -H 'Authorization: Bearer nope' -d '{"data":"x"}' "$BASE/generate")"
check "GET /generate (405)"        405 "$(code "$BASE/generate")"
check "GET /nonexistent (404)"     404 "$(code "$BASE/nonexistent")"

echo "generation"
tmp=$(mktemp -d)
hdr="$tmp/h"
curl -s -m 30 -D "$hdr" -o "$tmp/a.svg" -X POST "${JSON[@]}" "${AUTH[@]}" \
  -d '{"data":"https://hoopscollege.com/tryouts","dark":"#0B1F3A"}' "$BASE/generate"
if head -c 4 "$tmp/a.svg" | grep -q '<svg'; then
  ok "SVG generated" "$(wc -c < "$tmp/a.svg" | tr -d ' ') bytes, version $(grep -i '^x-qr-version' "$hdr" | tr -dc '0-9')"
else
  bad "SVG generated" "not an SVG: $(head -c 80 "$tmp/a.svg")"
fi

curl -s -m 30 -o "$tmp/a.png" -X POST "${JSON[@]}" "${AUTH[@]}" \
  -d '{"data":"https://hoopscollege.com/camps","format":"png","size":512}' "$BASE/generate"
if [ "$(od -An -tx1 -N4 "$tmp/a.png" | tr -d ' \n')" = "89504e47" ]; then
  ok "PNG generated" "$(wc -c < "$tmp/a.png" | tr -d ' ') bytes"
else
  bad "PNG generated" "bad PNG magic"
fi

check "POST /generate/wifi"  200 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" -d '{"ssid":"HC Gym","password":"x"}' "$BASE/generate/wifi")"
check "POST /generate/vcard" 200 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" -d '{"name":"Aram Parunak"}' "$BASE/generate/vcard")"

curl -s -m 60 -o "$tmp/b.zip" -X POST "${JSON[@]}" "${AUTH[@]}" \
  -d '{"items":[{"name":"a","data":"https://a.com"},{"name":"b","data":"https://b.com"}]}' "$BASE/generate/batch"
if [ "$(head -c 2 "$tmp/b.zip")" = "PK" ]; then
  ok "batch zip" "$(wc -c < "$tmp/b.zip" | tr -d ' ') bytes"
else
  bad "batch zip" "not a zip"
fi

echo "validation"
check "bad hex rejected"      400 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" -d '{"data":"x","dark":"navy"}' "$BASE/generate")"
check "malformed JSON"        400 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" -d '{bad' "$BASE/generate")"
check "over-capacity payload" 413 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" -d "{\"data\":\"$(printf 'y%.0s' $(seq 1 2400))\"}" "$BASE/generate")"

# Optional surfaces: only checked when the deployment has them.
if [ "$(code "$BASE/ui/utilities")" = "200" ]; then
  echo "utilities"
  check "GET /ui/utilities"   200 "$(code "$BASE/ui/utilities")"
  check "GET /ui/shared.css"  200 "$(code "$BASE/ui/shared.css")"
  check "GET /ui/shared.js"   200 "$(code "$BASE/ui/shared.js")"
  check "POST /convert/svg"   200 "$(code -X POST "${JSON[@]}" "${AUTH[@]}" \
    -d '{"svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"5\" height=\"5\"/></svg>","format":"webp"}' "$BASE/convert/svg")"
fi

rm -rf "$tmp"
echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall %d checks passed\033[0m\n' "$pass"; exit 0
else
  printf '\033[31m%d of %d checks FAILED\033[0m\n' "$fail" "$((pass+fail))"; exit 1
fi
