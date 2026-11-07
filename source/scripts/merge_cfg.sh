#!/bin/bash
# ============================================================================
# FILES VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

set -e

CFG="$1"
BAK="$2"

if [[ -z "$CFG" || -z "$BAK" ]]; then
    echo "Usage: merge_cfg.sh <current_cfg> <backup_cfg>" 1>&2
    exit 1
fi
if [[ ! -f "$CFG" ]]; then
    echo "merge_cfg: current cfg not found: $CFG" 1>&2
    exit 1
fi
if [[ ! -f "$BAK" ]]; then
    exit 0
fi

TMP="${CFG}.new"

awk '
    NR==FNR {
        eq = index($0, "=")
        if (eq > 0) {
            k = substr($0, 1, eq-1)
            if (k != "") {
                if (!(k in user)) order[++n] = k
                user[k] = $0
            }
        }
        next
    }
    {
        eq = index($0, "=")
        if (eq > 0) {
            k = substr($0, 1, eq-1)
            if (k in user) { seen[k] = 1; print user[k]; next }
        }
        print
    }
    END {
        for (i = 1; i <= n; i++) if (!(order[i] in seen)) print user[order[i]]
    }
' "$BAK" "$CFG" > "$TMP"

mv "$TMP" "$CFG"
