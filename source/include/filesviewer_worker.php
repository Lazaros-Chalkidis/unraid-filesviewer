<?php
/* ============================================================================
   FILES VIEWER - background worker
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit(1);

require_once __DIR__ . '/filesviewer_api.php';
require_once __DIR__ . '/filesviewer_zip.php';

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
    private const CHUNK = 1048576;

    private static string $id;
    private static string $dir;
    private static int    $bytesTotal = 0;
    private static int    $bytesDone  = 0;
    private static int    $itemsTotal = 0;
    private static int    $itemsDone  = 0;
    private static string $current    = '';
    private static array  $failed     = [];
    private static float  $lastFlush  = 0.0;
    private static float  $t0         = 0.0;
    private static string $op         = '';

    public static function run(string $id, string $dir, array $spec): void
    {
        self::$id  = $id;
        self::$dir = $dir;
        self::$t0  = microtime(true);
        self::$op  = (string)($spec['op'] ?? '');

        register_shutdown_function(function () use ($id) {
            $st = FilesViewerEndpoint::jobRead($id);
            if (is_array($st) && !in_array($st['state'] ?? '', ['done', 'cancelled', 'error'], true)) {
                if (self::$xDest !== '') FilesViewerEndpoint::removeTree(self::$xDest);
                FilesViewerEndpoint::jobPatch($id, ['state' => 'error', 'message' => 'the job stopped unexpectedly', 'current' => '']);
                self::notify('error', 'stopped unexpectedly');
            }
        });
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            foreach ([SIGTERM, SIGINT, SIGHUP] as $sig) pcntl_signal($sig, function () { exit(1); });
        }

        $op       = (string)($spec['op'] ?? '');
        if ($op === 'space')   { self::spaceScan($spec); return; }
        if ($op === 'search')  { self::search($spec);    return; }
        if ($op === 'checksum') { self::checksum($spec); return; }
        if ($op === 'extract') { self::extract($spec);   return; }
        if ($op === 'compress') { self::compress($spec); return; }

        $sources  = is_array($spec['sources'] ?? null) ? $spec['sources'] : [];
        $dest     = (string)($spec['dest'] ?? '');
        $conflict = (string)($spec['conflict'] ?? 'rename');

        if (($op !== 'copy' && $op !== 'move') || !$sources || !is_dir($dest)) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }

        if (FilesViewerEndpoint::safePath($dest, 'dir') === null) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }
        foreach ($sources as $s) {
            if (FilesViewerEndpoint::safePath((string)$s) === null) {
                self::patch(['state' => 'error', 'message' => 'bad job spec']);
                return;
            }
        }

        @set_time_limit(0);

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
            self::notify('done');
        }
    }

    private const NOTIFY_AFTER = 60;

    private static function notify(string $state, string $detail = ''): void
    {
        if (microtime(true) - self::$t0 < self::NOTIFY_AFTER) return;
        if (!FilesViewerEndpoint::config()['notify']) return;
        $bin = '/usr/local/emhttp/webGui/scripts/notify';
        if (!is_executable($bin)) return;

        $verb = ['copy' => 'Copy', 'move' => 'Move', 'extract' => 'Extract', 'compress' => 'Compress', 'checksum' => 'Checksum'][self::$op] ?? '';
        if ($verb === '') return;
        $took = self::fmtDur((int)round(microtime(true) - self::$t0));
        if ($state === 'done') {
            $desc = self::$itemsDone . ' ' . (self::$itemsDone === 1 ? 'item' : 'items') . ', ' . self::fmtBytes(self::$bytesDone) . ' in ' . $took;
            $skipped = count(self::$failed) + self::$xSkipped + self::$cSkipped;
            if ($skipped > 0) $desc .= ', ' . $skipped . ' skipped';
            if ($detail !== '') $desc .= ' - ' . $detail;
        } else {
            $desc = ($detail !== '' ? $detail : 'failed') . ' after ' . $took;
        }
        @exec(escapeshellarg($bin) . ' -e "Files Viewer" -s ' . escapeshellarg($verb . ($state === 'done' ? ' finished' : ' failed'))
            . ' -d ' . escapeshellarg($desc) . ' -i ' . ($state === 'done' ? 'normal' : 'warning')
            . ' -l /Tools/FilesViewerTool > /dev/null 2>&1');
    }

    private static function fmtDur(int $s): string
    {
        if ($s < 60) return $s . ' s';
        if ($s < 3600) return intdiv($s, 60) . ' min ' . ($s % 60) . ' s';
        return intdiv($s, 3600) . ' h ' . intdiv($s % 3600, 60) . ' min';
    }

    private static function fmtBytes(int $b): string
    {
        $u = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        $v = (float)$b;
        while ($v >= 1000 && $i < 4) { $v /= 1000; $i++; }
        return ($i >= 3 ? rtrim(rtrim(number_format($v, 2, '.', ''), '0'), '.') : (string)round($v)) . ' ' . $u[$i];
    }

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
        }

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
        if ($move && !self::cancelled()) @rmdir($src);
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
        if ($res === 'cancelled') { @unlink($target); return; }
        if ($res === 'failed')    { @unlink($target); self::$failed[] = basename($src) . ' - copy failed'; return; }

        self::copyMeta($src, $target);
        self::$itemsDone++;
        if ($move) @unlink($src);
    }

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

    private const EXTRACT_RESERVE = 268435456;

    private static string $xDest   = '';
    private static string $xRoot   = '';
    private static array  $xBasis  = [];
    private static int    $xSkipped = 0;
    private static string $xError  = '';

    private static function extract(array $spec): void
    {
        $archive = (string)($spec['archive'] ?? '');
        $dest    = (string)($spec['dest'] ?? '');
        $name    = (string)($spec['name'] ?? '');
        $fmt     = (string)($spec['format'] ?? '');

        if (FilesViewerEndpoint::safePath($archive, 'file') === null
            || FilesViewerEndpoint::safePath(dirname($dest), 'dir') === null
            || strpos(basename($dest), '.fvextract-') !== 0
            || FilesViewerEndpoint::safeName($name) === null
            || file_exists($dest) || is_link($dest)
            || !in_array($fmt, ['zip', 'tar', 'tgz', 'tbz2', 'txz'], true)) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }

        $basis = @stat(dirname($dest));
        if ($basis === false || !@mkdir($dest, 0755)) {
            self::patch(['state' => 'error', 'message' => 'cannot create the folder']);
            return;
        }
        @chown($dest, $basis['uid']); @chgrp($dest, $basis['gid']); @chmod($dest, $basis['mode'] & 0777);
        $root = realpath($dest);
        if ($root === false) { @rmdir($dest); self::patch(['state' => 'error', 'message' => 'cannot create the folder']); return; }

        self::$xDest = $dest; self::$xRoot = $root; self::$xBasis = $basis;
        @set_time_limit(0);
        self::patch(['state' => 'running', 'op' => 'extract', 'bytes_total' => 0, 'bytes_done' => 0,
                     'items_total' => 0, 'items_done' => 0, 'current' => '']);

        $ok = ($fmt === 'zip') ? self::extractZip($archive) : self::extractTar($archive, $fmt);

        if (self::cancelled()) {
            FilesViewerEndpoint::removeTree($dest);
            self::patch(['state' => 'cancelled', 'current' => '']);
            return;
        }
        if (!$ok) {
            FilesViewerEndpoint::removeTree($dest);
            $msg = self::$xError !== '' ? self::$xError : 'extract failed';
            self::patch(['state' => 'error', 'message' => $msg, 'current' => '']);
            self::notify('error', $msg);
            return;
        }
        $final = self::settleExtract($dest, $name);
        if ($final === null) {
            FilesViewerEndpoint::removeTree($dest);
            self::patch(['state' => 'error', 'message' => 'cannot place what was extracted next to the archive', 'current' => '']);
            self::notify('error', 'cannot place what was extracted next to the archive');
            return;
        }
        self::$xDest = '';
        self::flush(true);
        $failed = self::$failed;
        if (count($failed) > 40) $failed = array_merge(array_slice($failed, 0, 40), ['and ' . (count($failed) - 40) . ' more']);
        self::patch(['state' => 'done', 'current' => '', 'failed' => $failed, 'skipped' => self::$xSkipped,
                     'items_total' => max(self::$itemsTotal, self::$itemsDone), 'bytes_total' => max(self::$bytesTotal, self::$bytesDone),
                     'name' => basename($final), 'is_dir' => is_dir($final)]);
        self::notify('done', basename($final));
    }

    private static $cOut   = null;
    private static ?FilesViewerZip $cZip = null;
    private static string $cPart  = '';
    private static array  $cBasis = [];
    private static int    $cSkipped = 0;

    private static function compress(array $spec): void
    {
        $sources = is_array($spec['sources'] ?? null) ? $spec['sources'] : [];
        $dest    = (string)($spec['dest'] ?? '');
        $fmt     = (string)($spec['format'] ?? '');
        $parent  = dirname($dest);

        if (!$sources || !in_array($fmt, ['zip', 'tgz'], true)
            || FilesViewerEndpoint::safePath($parent, 'dir') === null
            || FilesViewerEndpoint::safeName(basename($dest)) === null
            || file_exists($dest) || is_link($dest)) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }
        foreach ($sources as $src) {
            if (FilesViewerEndpoint::safePath((string)$src) === null || dirname((string)$src) !== $parent) {
                self::patch(['state' => 'error', 'message' => 'bad job spec']);
                return;
            }
        }

        @set_time_limit(0);
        foreach ($sources as $src) {
            [$b, $n] = self::measure((string)$src);
            self::$bytesTotal += $b; self::$itemsTotal += $n;
        }
        self::patch(['state' => 'running', 'op' => 'compress', 'bytes_total' => self::$bytesTotal,
                     'bytes_done' => 0, 'items_total' => self::$itemsTotal, 'items_done' => 0, 'current' => '']);

        if (!self::roomFor(self::$bytesTotal, $parent)) {
            self::patch(['state' => 'error', 'message' => self::$xError, 'current' => '']);
            return;
        }

        self::$cPart  = $parent . '/.fvcompress-' . getmypid() . '.part';
        self::$cBasis = @stat($parent) ?: [];
        self::$cOut   = ($fmt === 'zip') ? @fopen(self::$cPart, 'wb') : @gzopen(self::$cPart, 'wb6');
        if (self::$cOut === false) {
            self::patch(['state' => 'error', 'message' => 'cannot write in this folder', 'current' => '']);
            return;
        }
        self::$xDest = self::$cPart;
        if ($fmt === 'zip') self::$cZip = new FilesViewerZip(static function (string $buf): bool { return self::cWrite($buf, 'zip'); });

        $ok = true;
        foreach ($sources as $src) {
            if (!self::packTree((string)$src, basename((string)$src), $fmt)) { $ok = false; break; }
        }
        if ($ok) $ok = ($fmt === 'zip') ? self::$cZip->finish() : self::tarFinish();
        if ($fmt === 'zip') fclose(self::$cOut); else gzclose(self::$cOut);
        if ($fmt === 'zip' && self::$cZip->error !== '') self::$xError = self::$cZip->error;

        if (self::cancelled() || !$ok) {
            @unlink(self::$cPart);
            self::$xDest = '';
            if (self::cancelled()) { self::patch(['state' => 'cancelled', 'current' => '']); return; }
            $msg = self::$xError !== '' ? self::$xError : 'compress failed';
            self::patch(['state' => 'error', 'message' => $msg, 'current' => '']);
            self::notify('error', $msg);
            return;
        }
        if (!@rename(self::$cPart, $dest)) {
            @unlink(self::$cPart);
            self::$xDest = '';
            self::patch(['state' => 'error', 'message' => 'cannot write in this folder', 'current' => '']);
            self::notify('error', 'cannot write in this folder');
            return;
        }
        if (self::$cBasis) { @chown($dest, self::$cBasis['uid']); @chgrp($dest, self::$cBasis['gid']); @chmod($dest, self::$cBasis['mode'] & 0666); }
        self::$xDest = '';
        self::flush(true);
        $failed = self::$failed;
        if (count($failed) > 40) $failed = array_merge(array_slice($failed, 0, 40), ['and ' . (count($failed) - 40) . ' more']);
        self::patch(['state' => 'done', 'current' => '', 'failed' => $failed, 'skipped' => self::$cSkipped, 'name' => basename($dest)]);
        self::notify('done', basename($dest));
    }

    private static function packTree(string $path, string $rel, string $fmt): bool
    {
        if (self::cancelled()) return false;
        if (is_link($path)) { self::$cSkipped++; return true; }
        $st = @stat($path);
        if ($st === false) { self::$failed[] = $rel . ' - cannot read'; return true; }
        if (is_dir($path)) {
            if (!self::packEntry($rel . '/', $st, null, $fmt)) return false;
            $names = @scandir($path);
            if ($names === false) { self::$failed[] = $rel . ' - cannot read'; return true; }
            foreach ($names as $e) {
                if ($e === '.' || $e === '..') continue;
                if (!self::packTree($path . '/' . $e, $rel . '/' . $e, $fmt)) return false;
            }
            return true;
        }
        $in = @fopen($path, 'rb');
        if ($in === false) { self::$failed[] = $rel . ' - cannot read'; return true; }
        self::flush(true, basename($path));
        $ok = self::packEntry($rel, $st, $in, $fmt);
        fclose($in);
        if ($ok) self::$itemsDone++;
        return $ok;
    }

    private static function packEntry(string $name, array $st, $in, string $fmt): bool
    {
        if ($fmt !== 'zip') return self::tarEntry($name, $st, $in);
        if ($in === null) return self::$cZip->dir($name, (int)$st['mtime'], (int)$st['mode']);
        return self::$cZip->file($name, $in, (int)$st['size'], (int)$st['mtime'], (int)$st['mode'], static function (int $n): bool {
            self::$bytesDone += $n;
            self::flush();
            return !self::cancelled();
        });
    }

    private static function cWrite(string $buf, string $fmt): bool
    {
        if ($buf === '') return true;
        $n = ($fmt === 'zip') ? fwrite(self::$cOut, $buf) : gzwrite(self::$cOut, $buf);
        if ($n !== strlen($buf)) { self::$xError = 'write failed, the disk may be full'; return false; }
        return true;
    }

    private static function tarField(int $v, int $len): string
    {
        $oct = decoct($v);
        if (strlen($oct) < $len) return str_pad($oct, $len - 1, '0', STR_PAD_LEFT) . "\0";
        $b = '';
        for ($i = 0; $i < $len - 1; $i++) { $b = chr($v & 0xFF) . $b; $v >>= 8; }
        return chr(0x80) . $b;
    }

    private static function tarHeader(string $name, string $type, int $size, int $mode, int $uid, int $gid, int $mtime): string
    {
        $h  = str_pad(substr($name, 0, 100), 100, "\0");
        $h .= self::tarField($mode & 07777, 8) . self::tarField($uid, 8) . self::tarField($gid, 8);
        $h .= self::tarField($size, 12) . self::tarField($mtime, 12);
        $un = function_exists('posix_getpwuid') ? (string)(posix_getpwuid($uid)['name'] ?? '') : '';
        $gn = function_exists('posix_getgrgid') ? (string)(posix_getgrgid($gid)['name'] ?? '') : '';
        $h .= '        ' . $type . str_repeat("\0", 100) . "ustar\0" . '00' . str_pad(substr($un, 0, 31), 32, "\0") . str_pad(substr($gn, 0, 31), 32, "\0");
        $h .= self::tarField(0, 8) . self::tarField(0, 8) . str_repeat("\0", 155);
        $h  = str_pad($h, 512, "\0");
        $sum = 0;
        for ($i = 0; $i < 512; $i++) $sum += ord($h[$i]);
        return substr_replace($h, str_pad(decoct($sum), 6, '0', STR_PAD_LEFT) . "\0 ", 148, 8);
    }

    private static function tarEntry(string $name, array $st, $in): bool
    {
        $isDir = ($in === null);
        $size  = $isDir ? 0 : (int)$st['size'];
        if (strlen($name) > 100) {
            $long = $name . "\0";
            $lh = self::tarHeader('././@LongLink', 'L', strlen($long), 0644, 0, 0, 0);
            if (!self::cWrite($lh . $long . str_repeat("\0", (512 - strlen($long) % 512) % 512), 'tgz')) return false;
        }
        $hdr = self::tarHeader($name, $isDir ? '5' : '0', $size, (int)$st['mode'], (int)$st['uid'], (int)$st['gid'], (int)$st['mtime']);
        if (!self::cWrite($hdr, 'tgz')) return false;
        if ($isDir) return true;
        $left = $size;
        while ($left > 0) {
            if (self::cancelled()) return false;
            $buf = fread($in, min(self::CHUNK, $left));
            if ($buf === false || $buf === '') { self::$xError = 'read failed, a file changed while it was being packed'; return false; }
            $left -= strlen($buf);
            self::$bytesDone += strlen($buf);
            if (!self::cWrite($buf, 'tgz')) return false;
            self::flush();
        }
        $pad = (512 - $size % 512) % 512;
        return $pad === 0 || self::cWrite(str_repeat("\0", $pad), 'tgz');
    }

    private static function tarFinish(): bool
    {
        return self::cWrite(str_repeat("\0", 1024), 'tgz');
    }

    private static function settleExtract(string $tmp, string $name): ?string
    {
        $parent = dirname($tmp);
        $names  = array_values(array_diff(scandir($tmp) ?: [], ['.', '..']));
        if (count($names) === 1 && !is_link($tmp . '/' . $names[0])) {
            $final = self::freeSpot($parent, $names[0]);
            if (!@rename($tmp . '/' . $names[0], $final)) return null;
            @rmdir($tmp);
            return $final;
        }
        $final = self::freeSpot($parent, $name);
        return @rename($tmp, $final) ? $final : null;
    }

    private static function freeSpot(string $parent, string $base): string
    {
        $cand = $parent . '/' . $base;
        if (!file_exists($cand) && !is_link($cand)) return $cand;
        return FilesViewerEndpoint::freeNamePath($parent, $base);
    }

    private static function entryTarget(string $name, bool $isDir): ?string
    {
        $segs = FilesViewerEndpoint::safeSubSegments($name);
        if ($segs === null) { self::$failed[] = $name . ' - unsafe name'; return null; }
        if (!$segs) return null;
        $dirSegs = $isDir ? $segs : array_slice($segs, 0, -1);
        $cur = self::$xDest;
        foreach ($dirSegs as $sg) {
            $cur .= '/' . $sg;
            if (is_link($cur) || (file_exists($cur) && !is_dir($cur))) { self::$failed[] = $name . ' - path blocked'; return null; }
            if (!is_dir($cur)) {
                if (!@mkdir($cur)) { self::$failed[] = $name . ' - cannot create folder'; return null; }
                @chown($cur, self::$xBasis['uid']); @chgrp($cur, self::$xBasis['gid']); @chmod($cur, self::$xBasis['mode'] & 0777);
            }
        }
        $rp = realpath($cur);
        if ($rp === false || ($rp !== self::$xRoot && strpos($rp, self::$xRoot . '/') !== 0)) {
            self::$failed[] = $name . ' - outside the folder'; return null;
        }
        if ($isDir) return $cur;
        $path = $cur . '/' . end($segs);
        if (is_link($path) || is_dir($path)) { self::$failed[] = $name . ' - path blocked'; return null; }
        return $path;
    }

    private static function roomFor(int $size, string $at = ''): bool
    {
        $free = @disk_free_space($at !== '' ? $at : self::$xDest);
        if ($free !== false && $free - $size < self::EXTRACT_RESERVE) {
            self::$xError = 'not enough free space on this disk';
            return false;
        }
        return true;
    }

    private static function writeEntry(string $path, $in, int $size, int $mtime): bool
    {
        if (!self::roomFor($size)) return false;
        $out = @fopen($path, 'wb');
        if ($out === false) { self::$failed[] = basename($path) . ' - cannot write'; return self::drain($in, $size); }
        $left = $size; $ok = true;
        while ($left > 0) {
            if (self::cancelled()) { $ok = false; break; }
            $buf = fread($in, min(self::CHUNK, $left));
            if ($buf === false || $buf === '') { self::$xError = 'the archive ended early'; $ok = false; break; }
            fwrite($out, $buf);
            $left -= strlen($buf);
            self::$bytesDone += strlen($buf);
            self::flush();
        }
        fclose($out);
        if (!$ok) { @unlink($path); return false; }
        @chown($path, self::$xBasis['uid']); @chgrp($path, self::$xBasis['gid']); @chmod($path, self::$xBasis['mode'] & 0666);
        if ($mtime > 0) @touch($path, $mtime);
        self::$itemsDone++;
        return true;
    }

    private static function drain($in, int $size): bool
    {
        while ($size > 0) {
            $buf = fread($in, min(self::CHUNK, $size));
            if ($buf === false || $buf === '') { self::$xError = 'the archive ended early'; return false; }
            $size -= strlen($buf);
        }
        return true;
    }

    private static function extractZip(string $archive): bool
    {
        $z = new \ZipArchive();
        if ($z->open($archive, \ZipArchive::RDONLY) !== true) { self::$xError = 'not a zip archive, or damaged'; return false; }

        $n = $z->numFiles; $total = 0;
        for ($i = 0; $i < $n; $i++) { $st = $z->statIndex($i); if ($st !== false) $total += (int)$st['size']; }
        self::$bytesTotal = $total; self::$itemsTotal = $n;
        self::patch(['bytes_total' => $total, 'items_total' => $n]);
        if (!self::roomFor($total)) { $z->close(); return false; }

        for ($i = 0; $i < $n; $i++) {
            if (self::cancelled()) { $z->close(); return false; }
            $st = $z->statIndex($i);
            if ($st === false) { self::$xSkipped++; continue; }
            $name = str_replace('\\', '/', (string)$st['name']);
            $mode = 0;
            if ($z->getExternalAttributesIndex($i, $opsys, $attr) && $opsys === \ZipArchive::OPSYS_UNIX) $mode = ($attr >> 16) & 0170000;
            if ($mode === 0120000) { self::$xSkipped++; continue; }
            $isDir = (substr($name, -1) === '/') || $mode === 0040000;
            self::flush(true, basename(rtrim($name, '/')));

            $target = self::entryTarget($name, $isDir);
            if ($target === null) continue;
            if ($isDir) { self::$itemsDone++; continue; }

            $in = $z->getStreamIndex($i);
            if ($in === false) { self::$failed[] = $name . ' - cannot read, encrypted or damaged'; continue; }
            $ok = self::writeEntry($target, $in, (int)$st['size'], (int)$st['mtime']);
            fclose($in);
            if (!$ok) { $z->close(); return false; }
        }
        $z->close();
        return true;
    }

    private static function tarOpen(string $archive, string $fmt)
    {
        if ($fmt === 'tar') return @fopen($archive, 'rb');
        if ($fmt === 'tgz' && function_exists('gzopen')) return @gzopen($archive, 'rb');
        $tool = ['tgz' => 'gzip', 'tbz2' => 'bzip2', 'txz' => 'xz'][$fmt] ?? '';
        if ($tool === '') return false;
        return @popen($tool . ' -dc -- ' . escapeshellarg($archive), 'r');
    }

    private static function readExact($in, int $n): ?string
    {
        $buf = '';
        while (strlen($buf) < $n) {
            $c = fread($in, $n - strlen($buf));
            if ($c === false || $c === '') return null;
            $buf .= $c;
        }
        return $buf;
    }

    private static function tarNum(string $f): int
    {
        if ($f !== '' && (ord($f[0]) & 0x80)) {
            $v = 0;
            for ($i = 0, $n = strlen($f); $i < $n; $i++) $v = ($v << 8) | (ord($f[$i]) & ($i === 0 ? 0x7f : 0xff));
            return $v;
        }
        return (int)octdec(trim($f, " \0"));
    }

    private static function extractTar(string $archive, string $fmt): bool
    {
        $in = self::tarOpen($archive, $fmt);
        if ($in === false) { self::$xError = 'cannot open the archive'; return false; }
        self::$bytesTotal = 0;
        self::patch(['bytes_total' => 0]);

        $ok = true; $longName = null; $pax = []; $zeros = 0; $any = false;
        while (true) {
            if (self::cancelled()) { $ok = false; break; }
            $hdr = self::readExact($in, 512);
            if ($hdr === null) { if (!$any) { self::$xError = 'not a tar archive, or damaged'; $ok = false; } break; }
            if (trim($hdr, "\0") === '') { if (++$zeros >= 2) break; continue; }
            $zeros = 0;

            $sum = 0;
            for ($i = 0; $i < 512; $i++) $sum += ($i >= 148 && $i < 156) ? 32 : ord($hdr[$i]);
            if ($sum !== self::tarNum(substr($hdr, 148, 8))) { self::$xError = 'not a tar archive, or damaged'; $ok = false; break; }
            $any = true;

            $name   = rtrim(substr($hdr, 0, 100), "\0");
            $size   = self::tarNum(substr($hdr, 124, 12));
            $mtime  = self::tarNum(substr($hdr, 136, 12));
            $type   = $hdr[156];
            $prefix = rtrim(substr($hdr, 345, 155), "\0");
            if (substr($hdr, 257, 6) === "ustar\0" && $prefix !== '') $name = $prefix . '/' . $name;
            if ($longName !== null) { $name = $longName; $longName = null; }
            if (isset($pax['path'])) $name = $pax['path'];
            if (isset($pax['size'])) $size = (int)$pax['size'];
            if (isset($pax['mtime'])) $mtime = (int)$pax['mtime'];
            $pax = [];
            $pad = (512 - ($size % 512)) % 512;

            if ($type === 'L' || $type === 'x') {
                if ($size > 1048576) { self::$xError = 'not a tar archive, or damaged'; $ok = false; break; }
                $data = self::readExact($in, $size + $pad);
                if ($data === null) { self::$xError = 'the archive ended early'; $ok = false; break; }
                $data = substr($data, 0, $size);
                if ($type === 'L') { $longName = rtrim($data, "\0"); continue; }
                foreach (explode("\n", $data) as $rec) {
                    $sp = strpos($rec, ' '); $eq = strpos($rec, '=');
                    if ($sp !== false && $eq !== false && $eq > $sp) $pax[substr($rec, $sp + 1, $eq - $sp - 1)] = substr($rec, $eq + 1);
                }
                continue;
            }
            if ($type === 'K' || $type === 'g') { if (!self::drain($in, $size + $pad)) { $ok = false; break; } continue; }

            $isFile = ($type === '0' || $type === "\0" || $type === '7');
            $isDir  = ($type === '5') || ($isFile && substr($name, -1) === '/');
            if (!$isFile && !$isDir) {
                self::$xSkipped++;
                if (!self::drain($in, $size + $pad)) { $ok = false; break; }
                continue;
            }
            self::$itemsTotal++;
            self::flush(true, basename(rtrim($name, '/')));

            $target = self::entryTarget($name, $isDir);
            if ($target === null || $isDir) {
                if ($isDir && $target !== null) self::$itemsDone++;
                if (!self::drain($in, $size + $pad)) { $ok = false; break; }
                continue;
            }
            if (!self::writeEntry($target, $in, $size, $mtime)) { $ok = false; break; }
            if ($pad > 0 && !self::drain($in, $pad)) { $ok = false; break; }
        }

        if ($fmt === 'tar') fclose($in);
        elseif ($fmt === 'tgz' && function_exists('gzopen')) gzclose($in);
        else pclose($in);
        return $ok;
    }

    private static function checksum(array $spec): void
    {
        $path = (string)($spec['path'] ?? '');
        $algo = (string)($spec['algo'] ?? '');
        if ($path === '' || FilesViewerEndpoint::safePath($path, 'file') === null || !in_array($algo, hash_algos(), true)) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }
        $in = @fopen($path, 'rb');
        if ($in === false) { self::patch(['state' => 'error', 'message' => 'cannot read file']); return; }

        @set_time_limit(0);
        self::$bytesTotal = (int)@filesize($path);
        self::$itemsTotal = 1;
        self::patch(['state' => 'running', 'op' => 'checksum', 'algo' => $algo, 'bytes_total' => self::$bytesTotal,
                     'bytes_done' => 0, 'items_total' => 1, 'items_done' => 0, 'current' => basename($path)]);

        $h = hash_init($algo);
        while (!feof($in)) {
            if (self::cancelled()) { fclose($in); self::patch(['state' => 'cancelled', 'current' => '']); return; }
            $buf = fread($in, self::CHUNK);
            if ($buf === false) { fclose($in); self::patch(['state' => 'error', 'message' => 'read failed', 'current' => '']); return; }
            if ($buf === '') continue;
            hash_update($h, $buf);
            self::$bytesDone += strlen($buf);
            self::flush();
        }
        fclose($in);
        self::$itemsDone = 1;
        $hash = hash_final($h);
        self::patch(['state' => 'done', 'hash' => $hash, 'bytes_done' => self::$bytesDone, 'bytes_total' => max(self::$bytesTotal, self::$bytesDone),
                     'items_done' => 1, 'elapsed' => round(microtime(true) - self::$t0, 2), 'current' => '']);
        self::notify('done', $algo . ' ' . basename($path) . ' = ' . $hash);
    }

    private const SEARCH_MAX = 2000;

    private static function search(array $spec): void
    {
        $root = (string)($spec['path'] ?? '');
        $q    = (string)($spec['q'] ?? '');
        if ($root === '' || $q === '' || FilesViewerEndpoint::safePath($root, 'dir') === null) {
            self::patch(['state' => 'error', 'message' => 'bad job spec']);
            return;
        }

        @set_time_limit(0);
        $t0     = microtime(true);
        $glob   = strpbrk($q, '*?') !== false;
        $lower  = function_exists('mb_strtolower') ? 'mb_strtolower' : 'strtolower';
        $ql     = $lower($q);
        $hidden = FilesViewerEndpoint::config()['show_hidden'];
        $matches = []; $scanned = 0; $skipped = 0; $capped = false; $lastPatch = 0.0;

        self::patch(['state' => 'running', 'op' => 'search', 'path' => $root, 'q' => $q,
                     'scanned' => 0, 'found' => 0, 'current' => '', 'matches' => []]);

        $stack = [$root];
        while ($stack && !$capped) {
            $d  = array_pop($stack);
            $es = @scandir($d);
            if ($es === false) { $skipped++; continue; }
            $dirs = [];
            foreach ($es as $e) {
                if ($e === '.' || $e === '..') continue;
                if (!$hidden && $e[0] === '.') continue;
                $p = $d . '/' . $e;
                if (FilesViewerEndpoint::inBin($p)) continue;
                if ((++$scanned & 255) === 0) {
                    if (self::cancelled()) { self::patch(['state' => 'cancelled', 'current' => '']); return; }
                    $now = microtime(true);
                    if ($now - $lastPatch > 0.4) {
                        $lastPatch = $now;
                        self::patch(['scanned' => $scanned, 'found' => count($matches), 'current' => substr($d, strlen($root) + 1), 'matches' => $matches]);
                    }
                }
                $isDir = !is_link($p) && is_dir($p);
                $el = $lower($e);
                if ($glob ? fnmatch($ql, $el) : (strpos($el, $ql) !== false)) {
                    $st = @lstat($p);
                    $matches[] = ['path' => $p, 'name' => $e, 'is_dir' => $isDir,
                                  'size' => ($isDir || $st === false) ? 0 : (int)$st['size'],
                                  'mtime' => $st !== false ? (int)$st['mtime'] : 0];
                    if (count($matches) >= self::SEARCH_MAX) { $capped = true; break; }
                }
                if ($isDir) $dirs[] = $p;
            }
            for ($i = count($dirs) - 1; $i >= 0; $i--) $stack[] = $dirs[$i];
        }

        usort($matches, static function ($a, $b) { return strcasecmp($a['path'], $b['path']); });
        self::patch(['state' => 'done', 'matches' => $matches, 'found' => count($matches), 'scanned' => $scanned,
                     'skipped' => $skipped, 'capped' => $capped, 'elapsed' => round(microtime(true) - $t0, 2), 'current' => '']);
    }

    private static function allocBytes(array $st): int
    {
        $b = (int)($st['blocks'] ?? -1);
        return $b >= 0 ? $b * 512 : (int)($st['size'] ?? 0);
    }

    private static function spaceScan(array $spec): void
    {
        $root = (string)($spec['path'] ?? '');
        if ($root === '' || FilesViewerEndpoint::safePath($root, 'dir') === null) {
            self::patch(['state' => 'error', 'message' => 'folder not found']);
            return;
        }

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
                $bytes += self::allocBytes($st);
                $stack = [$full];
                while ($stack) {
                    $d  = array_pop($stack);
                    $es = @scandir($d);
                    if ($es === false) { $skipped++; continue; }
                    foreach ($es as $e) {
                        if ($e === '.' || $e === '..') continue;
                        if ((++$tick & 511) === 0) {
                            if (self::cancelled()) { self::patch(['state' => 'cancelled', 'current' => '']); return; }
                            $now = microtime(true);
                            if ($now - $lastPatch > 0.4) {
                                $lastPatch = $now;
                                self::patch(['children_done' => $done, 'bytes' => $totalBytes + $bytes,
                                             'files' => $totalFiles + $files, 'skipped' => $skipped, 'current' => $name]);
                            }
                        }
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

