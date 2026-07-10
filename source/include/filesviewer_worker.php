<?php
/* ============================================================================
   FILES VIEWER - background worker
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

// one detached job per run: php filesviewer_worker.php <jobId>
// reads spec.json from the job dir, runs the copy or move, and writes progress
// to status.json as it goes. cli only. a same-filesystem move is a rename, so it
// is instant; a copy, or a move across filesystems, transfers bytes with a live
// count and can be stopped by a cancel flag the loop checks. on cancel nothing is
// left half deleted: a source is removed only after its copy is verified.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit(1);

require_once __DIR__ . '/filesviewer_api.php';

$id  = (string)($argv[1] ?? '');
$dir = FilesViewerEndpoint::jobDir($id);
if ($dir === null) exit(1);

$raw  = @file_get_contents($dir . '/spec.json');
$spec = ($raw !== false) ? json_decode($raw, true) : null;
if (!is_array($spec)) {
    FilesViewerEndpoint::jobPatch($id, ['state' => 'error', 'message' => 'bad job spec']);
    exit(1);
}

FilesViewerWorker::run($id, $dir, $spec);


final class FilesViewerWorker
{
    private const CHUNK = 1048576;   // 1 MiB transfer buffer

    private static string $id;
    private static string $dir;
    private static int    $bytesTotal = 0;
    private static int    $bytesDone  = 0;
    private static int    $itemsTotal = 0;
    private static int    $itemsDone  = 0;
    private static string $current    = '';
    private static array  $failed     = [];
    private static float  $lastFlush  = 0.0;

    public static function run(string $id, string $dir, array $spec): void
    {
        self::$id  = $id;
        self::$dir = $dir;

        $op       = (string)($spec['op'] ?? '');
        if ($op === 'space') { self::spaceScan($spec); return; }

        $sources  = is_array($spec['sources'] ?? null) ? $spec['sources'] : [];
        $dest     = (string)($spec['dest'] ?? '');
        $conflict = (string)($spec['conflict'] ?? 'rename');

        if (($op !== 'copy' && $op !== 'move') || !$sources || !is_dir($dest)) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }

        @set_time_limit(0);

        // size each source once: for the totals and for the instant-rename bump
        $sizes = [];
        foreach ($sources as $s) {
            $sizes[$s] = self::measure((string)$s);
            self::$bytesTotal += $sizes[$s][0];
            self::$itemsTotal += $sizes[$s][1];
        }

        self::patch(['state' => 'running', 'op' => $op, 'bytes_total' => self::$bytesTotal,
                     'bytes_done' => 0, 'items_total' => self::$itemsTotal, 'items_done' => 0, 'current' => '']);

        foreach ($sources as $s) {
            if (self::cancelled()) break;
            self::processTop((string)$s, $dest, $op, $conflict, $sizes[$s]);
        }

        if (self::cancelled()) {
            self::patch(['state' => 'cancelled', 'current' => '']);
        } else {
            self::flush(true);
            self::patch(['state' => 'done', 'current' => '', 'failed' => self::$failed]);
        }
    }

    // [bytes, files] under a path; a symlink counts as one item of zero bytes
    private static function measure(string $path): array
    {
        if (is_link($path)) return [0, 1];
        if (is_file($path)) return [(int)@filesize($path), 1];
        if (!is_dir($path)) return [0, 0];
        $b = 0; $n = 0;
        foreach (scandir($path) ?: [] as $e) {
            if ($e === '.' || $e === '..') continue;
            [$cb, $cn] = self::measure($path . '/' . $e);
            $b += $cb; $n += $cn;
        }
        return [$b, $n];
    }

    private static function processTop(string $src, string $dest, string $op, string $conflict, array $size): void
    {
        $base   = basename($src);
        $target = $dest . '/' . $base;

        if (file_exists($target) || is_link($target)) {
            if ($conflict === 'skip')   return;
            if ($conflict === 'rename') $target = self::freeName($dest, $base);
            // overwrite: keep $target and merge or replace below
        }

        // same-filesystem move with a clear target: rename the whole subtree at once
        if ($op === 'move' && !file_exists($target) && self::sameDevice($src, $dest)) {
            if (@rename($src, $target)) {
                self::$bytesDone += $size[0];
                self::$itemsDone += $size[1];
                self::flush(true);
                return;
            }
        }

        if (is_dir($src) && !is_link($src)) {
            self::copyDir($src, $target, $op === 'move', $conflict === 'overwrite');
        } else {
            self::copyOne($src, $target, $op === 'move');
        }
    }

    private static function copyDir(string $src, string $target, bool $move, bool $overwrite): void
    {
        if (!is_dir($target)) { @mkdir($target, 0755, true); self::copyMeta($src, $target); }
        foreach (scandir($src) ?: [] as $e) {
            if ($e === '.' || $e === '..') continue;
            if (self::cancelled()) return;
            $cs = $src . '/' . $e;
            $ct = $target . '/' . $e;
            if (is_dir($cs) && !is_link($cs)) {
                self::copyDir($cs, $ct, $move, $overwrite);
            } else {
                if ((file_exists($ct) || is_link($ct)) && !$overwrite) continue;
                self::copyOne($cs, $ct, $move);
            }
        }
        if ($move && !self::cancelled()) @rmdir($src);   // succeeds only once emptied
    }

    private static function copyOne(string $src, string $target, bool $move): void
    {
        if (self::cancelled()) return;

        if (is_link($src)) {
            $t = @readlink($src);
            if ($t !== false) {
                if (file_exists($target) || is_link($target)) @unlink($target);
                @symlink($t, $target);
            }
            if ($move) @unlink($src);
            self::$itemsDone++;
            self::flush();
            return;
        }

        self::flush(true, basename($src));
        $res = self::copyBytes($src, $target);
        if ($res === 'cancelled') { @unlink($target); return; }     // drop partial, keep source
        if ($res === 'failed')    { @unlink($target); self::$failed[] = basename($src) . ' - copy failed'; return; }

        self::copyMeta($src, $target);
        self::$itemsDone++;
        if ($move) @unlink($src);   // delete source only after a verified copy
    }

    // returns 'ok', 'cancelled' or 'failed'
    private static function copyBytes(string $src, string $target): string
    {
        $in = @fopen($src, 'rb');  if ($in === false) return 'failed';
        $out = @fopen($target, 'wb'); if ($out === false) { fclose($in); return 'failed'; }
        $res = 'ok';
        while (!feof($in)) {
            if (self::cancelled()) { $res = 'cancelled'; break; }
            $buf = fread($in, self::CHUNK);
            if ($buf === false) { $res = 'failed'; break; }
            if ($buf !== '') { fwrite($out, $buf); self::$bytesDone += strlen($buf); self::flush(); }
        }
        fclose($in); fclose($out);
        if ($res === 'ok' && (int)@filesize($target) !== (int)@filesize($src)) $res = 'failed';
        return $res;
    }

    private static function copyMeta(string $src, string $target): void
    {
        $st = @stat($src);
        if ($st === false) return;
        @chmod($target, $st['mode'] & 07777);
        @chown($target, $st['uid']);
        @chgrp($target, $st['gid']);
    }

    private static function sameDevice(string $a, string $dir): bool
    {
        $sa = @stat($a); $sd = @stat($dir);
        return $sa !== false && $sd !== false && $sa['dev'] === $sd['dev'];
    }

    // first free "name (n).ext" in a folder, so a copy never clobbers a sibling
    private static function freeName(string $dir, string $base): string
    {
        $dot  = strrpos($base, '.');
        $name = ($dot !== false && $dot > 0) ? substr($base, 0, $dot) : $base;
        $ext  = ($dot !== false && $dot > 0) ? substr($base, $dot)    : '';
        for ($i = 1; $i < 10000; $i++) {
            $cand = $dir . '/' . $name . ' (' . $i . ')' . $ext;
            if (!file_exists($cand) && !is_link($cand)) return $cand;
        }
        return $dir . '/' . $name . ' (' . uniqid() . ')' . $ext;
    }

    private static function cancelled(): bool
    {
        return file_exists(self::$dir . '/cancel');
    }

    // write progress, throttled, so a long transfer does not hammer the disk
    private static function flush(bool $force = false, ?string $current = null): void
    {
        if ($current !== null) self::$current = $current;
        $now = microtime(true);
        if (!$force && ($now - self::$lastFlush) < 0.4) return;
        self::$lastFlush = $now;
        self::patch(['bytes_done' => self::$bytesDone, 'items_done' => self::$itemsDone, 'current' => self::$current]);
    }

    private static function patch(array $p): void
    {
        FilesViewerEndpoint::jobPatch(self::$id, $p);
    }

    // ---- space analysis -------------------------------------------------------
    // ranks the direct children of a folder by the disk space they hold, in one
    // walk of the whole tree. sizes come from lstat blocks, so sparse files count
    // what they really allocate; links are never followed; an inode with several
    // hard links is charged once, to the first child that reaches it, the way du
    // does. progress lands in status.json and the cancel flag stops the walk.

    private static function allocBytes(array $st): int
    {
        $b = (int)($st['blocks'] ?? -1);
        return $b >= 0 ? $b * 512 : (int)($st['size'] ?? 0);
    }

    private static function spaceScan(array $spec): void
    {
        $root = (string)($spec['path'] ?? '');
        if ($root === '' || !is_dir($root)) { self::patch(['state' => 'error', 'message' => 'folder not found']); return; }

        @set_time_limit(0);
        $t0    = microtime(true);
        $names = array_values(array_diff(scandir($root) ?: [], ['.', '..']));

        $rows = []; $seen = [];
        $totalBytes = 0; $totalFiles = 0; $skipped = 0; $done = 0;
        $tick = 0; $lastPatch = 0.0;

        self::patch(['state' => 'running', 'op' => 'space', 'path' => $root,
                     'children_total' => count($names), 'children_done' => 0,
                     'bytes' => 0, 'files' => 0, 'skipped' => 0, 'current' => '']);

        foreach ($names as $name) {
            if (self::cancelled()) { self::patch(['state' => 'cancelled', 'current' => '']); return; }
            $full = $root . '/' . $name;
            $st   = @lstat($full);
            if ($st === false) { $skipped++; continue; }

            $isDir = !is_link($full) && is_dir($full);
            $bytes = 0; $files = 0;

            if ($isDir) {
                $bytes += self::allocBytes($st);            // the folder inode itself, like du
                $stack = [$full];
                while ($stack) {
                    if ((++$tick & 511) === 0) {
                        if (self::cancelled()) { self::patch(['state' => 'cancelled', 'current' => '']); return; }
                        $now = microtime(true);
                        if ($now - $lastPatch > 0.4) {
                            $lastPatch = $now;
                            self::patch(['children_done' => $done, 'bytes' => $totalBytes + $bytes,
                                         'files' => $totalFiles + $files, 'skipped' => $skipped, 'current' => $name]);
                        }
                    }
                    $d  = array_pop($stack);
                    $es = @scandir($d);
                    if ($es === false) { $skipped++; continue; }
                    foreach ($es as $e) {
                        if ($e === '.' || $e === '..') continue;
                        $p = $d . '/' . $e;
                        $s = @lstat($p);
                        if ($s === false) { $skipped++; continue; }
                        if (!is_link($p) && is_dir($p)) { $bytes += self::allocBytes($s); $stack[] = $p; continue; }
                        if ((int)($s['nlink'] ?? 1) > 1) {
                            $k = $s['dev'] . ':' . $s['ino'];
                            if (isset($seen[$k])) continue;
                            $seen[$k] = true;
                        }
                        $bytes += self::allocBytes($s);
                        $files++;
                    }
                }
            } else {
                $files = 1;
                if ((int)($st['nlink'] ?? 1) > 1) {
                    $k = $st['dev'] . ':' . $st['ino'];
                    if (isset($seen[$k])) { $bytes = 0; } else { $seen[$k] = true; $bytes = self::allocBytes($st); }
                } else {
                    $bytes = self::allocBytes($st);
                }
            }

            $rows[] = ['name' => $name, 'is_dir' => $isDir, 'bytes' => $bytes, 'files' => $files];
            $totalBytes += $bytes; $totalFiles += $files; $done++;
        }

        usort($rows, function ($a, $b) { return $b['bytes'] <=> $a['bytes']; });
        $shown = array_slice($rows, 0, 400);
        if (count($rows) > 400) {
            $rb = 0; $rf = 0;
            foreach (array_slice($rows, 400) as $r) { $rb += $r['bytes']; $rf += $r['files']; }
            $shown[] = ['name' => null, 'others' => count($rows) - 400, 'is_dir' => false, 'bytes' => $rb, 'files' => $rf];
        }

        self::patch(['state' => 'done', 'children' => $shown, 'children_done' => $done,
                     'bytes' => $totalBytes, 'files' => $totalFiles, 'skipped' => $skipped,
                     'elapsed' => round(microtime(true) - $t0, 2), 'current' => '']);
    }
}

