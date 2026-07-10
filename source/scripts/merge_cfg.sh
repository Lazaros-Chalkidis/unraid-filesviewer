#!/bin/bash
# ============================================================================
# FILES VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

# keep the user's existing values, let any new keys in this release stay at default
# usage: merge_cfg.sh <current_cfg> <backup_cfg>

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
            if (k != "") user[k] = $0
        }
        next
    }
    # second pass over the default cfg: swap in the saved value where the key exists
    {
        eq = index($0, "=")
        if (eq > 0) {
            k = substr($0, 1, eq-1)
            if (k in user) { print user[k]; next }
        }
        print
    }
' "$BAK" "$CFG" > "$TMP"

mv "$TMP" "$CFG"
