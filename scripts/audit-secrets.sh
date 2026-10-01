#!/usr/bin/env bash
# Audit this repository for committed secrets — working tree AND full history.
#
#   bash scripts/audit-secrets.sh
#
# Run it inside your clone. It reads only; it changes nothing.
#
# Deleting a secret in a later commit does NOT remove it from history: anyone
# who cloned, and GitHub's own commit views, can still reach the old blob. So
# history is what actually matters, and it is what this checks.

set -uo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
problems=0

say()   { printf '%s\n' "$*"; }
head2() { printf '\n%s%s%s\n' "$BLD" "$*" "$OFF"; }
bad()   { printf '%s  x %s%s\n' "$RED" "$*" "$OFF"; problems=$((problems+1)); }
good()  { printf '%s  ok %s%s\n' "$GRN" "$*" "$OFF"; }
warn()  { printf '%s  ! %s%s\n' "$YEL" "$*" "$OFF"; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  say "Not a git repository. cd into your clone first."
  exit 1
fi

say "${BLD}Secret audit — $(git rev-parse --show-toplevel)${OFF}"
say "Commits in history: $(git rev-list --all --count)"

# ---------------------------------------------------------------------------
head2 "1. Is .env tracked, now or ever?"

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  bad ".env IS TRACKED right now. It holds your live secrets."
  say "      Fix: git rm --cached .env && git commit -m 'stop tracking .env' && git push"
  say "      Then rotate every value in it — see section 6."
else
  good ".env is not tracked in the current commit"
fi

if git log --all --oneline --diff-filter=A -- '.env' '*/.env' '.env.local' '.env.production' 2>/dev/null | grep -q .; then
  bad ".env appears in the repository HISTORY:"
  git log --all --oneline --diff-filter=A -- '.env' '*/.env' | sed 's/^/        /'
  say "      Going private does NOT undo this if anyone already cloned it."
  say "      Rotate the secrets (section 6). Rewriting history is optional after that."
else
  good ".env has never been committed on any branch"
fi

# ---------------------------------------------------------------------------
head2 "2. Live credentials anywhere in history"

ALL_REVS=$(git rev-list --all)

scan_history() {
  local label="$1" pattern="$2" hits
  hits=$(git grep -I -n -E "$pattern" $ALL_REVS -- \
           ':!package-lock.json' ':!*.md' ':!.env.example' 2>/dev/null \
         | grep -v -E 'REALPASSWORD|<password>|your-username|replace-me|sup3rs3cret|Str0ngPass|u:p@|example\.com|xxxxx' \
         | head -12 || true)
  if [ -n "$hits" ]; then
    bad "$label found:"
    printf '%s\n' "$hits" | sed 's/^/        /'
  else
    good "no $label"
  fi
}

scan_history "MongoDB connection string with a password" \
  'mongodb(\+srv)?://[^[:space:]"'"'"']*:[^[:space:]"'"'"'@]{6,}@'
scan_history "long hex string (a real JWT_SECRET)" '[0-9a-f]{64,}'
scan_history "bcrypt password hash" '\$2[aby]\$[0-9]{2}\$'
scan_history "AWS access key" 'AKIA[0-9A-Z]{16}'
scan_history "GitHub token" 'gh[pousr]_[A-Za-z0-9]{30,}'
scan_history "private key block" '-----BEGIN [A-Z ]*PRIVATE KEY-----'

# ---------------------------------------------------------------------------
head2 "3. Assigned-secret lines outside documentation"

assigns=$(git grep -I -n -E '(MONGODB_URI|JWT_SECRET|ADMIN_PASSWORD)[[:space:]]*=[[:space:]]*[^[:space:]]{8,}' \
            $ALL_REVS -- ':!*.md' ':!.env.example' ':!package-lock.json' 2>/dev/null \
          | grep -v -E 'replace-me|your-username|REALPASSWORD|process\.env|\$\{|<password>|sync: false|generateValue' \
          | head -12 || true)
if [ -n "$assigns" ]; then
  warn "lines assigning a secret-looking value — check each by eye:"
  printf '%s\n' "$assigns" | sed 's/^/        /'
else
  good "no secret assignments outside .env.example and the docs"
fi

# ---------------------------------------------------------------------------
head2 "4. .gitignore covers the right things"

if grep -qx -- '.env' .gitignore 2>/dev/null; then
  good ".gitignore excludes .env"
else
  bad ".gitignore is missing an entry for .env"
fi
if grep -q 'node_modules' .gitignore 2>/dev/null; then
  good ".gitignore excludes node_modules"
else
  warn ".gitignore does not exclude node_modules"
fi

# ---------------------------------------------------------------------------
head2 "5. What the published site folder exposes"

if [ -d docs ]; then
  leak=$(grep -rIl -E 'mongodb(\+srv)?://|JWT_SECRET|passwordHash' docs 2>/dev/null || true)
  if [ -n "$leak" ]; then
    bad "docs/ mentions database or secret material, and it is served publicly:"
    printf '%s\n' "$leak" | sed 's/^/        /'
  else
    good "docs/ contains no database or secret references"
  fi
  if [ -f docs/admin.html ] || [ -f docs/assets/admin.js ]; then
    bad "the editor is inside docs/ — it would be published to GitHub Pages"
  else
    good "the editor is not inside docs/"
  fi
fi

# ---------------------------------------------------------------------------
head2 "6. Verdict"

if [ "$problems" -eq 0 ]; then
  say "${GRN}${BLD}  No secrets in the working tree or in any commit.${OFF}"
  say ""
  say "  Your credentials live in the host's environment variables and in Atlas,"
  say "  not in this repository. It can stay public safely."
else
  say "${RED}${BLD}  $problems problem(s). Rotate first, then clean up.${OFF}"
  say ""
  say "  ROTATE FIRST. Once a secret has been public, removing it from git does"
  say "  not un-publish it — assume it is known and replace it."
  say ""
  say "    Atlas password:  Atlas -> Database Access -> Edit user -> Edit Password"
  say "                     then update MONGODB_URI on your host"
  say "    JWT_SECRET:      node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  say "                     set it on the host (signs everyone out, which is the point)"
  say "    Admin password:  npm run create-admin"
  say ""
  say "  THEN stop tracking the file:"
  say "    git rm --cached .env && git commit -m 'stop tracking .env' && git push"
  say ""
  say "  Rewriting history is optional once rotated, and it breaks every existing"
  say "  clone. If you want it: https://github.com/newren/git-filter-repo"
fi
say ""
exit 0
