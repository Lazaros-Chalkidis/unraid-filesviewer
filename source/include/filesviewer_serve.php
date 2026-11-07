<?php
/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

require_once __DIR__ . '/filesviewer_api.php';

if (!FilesViewerEndpoint::validateNonce()) {
    http_response_code(403);
    exit;
}

function fv_disposition(string $kind, string $name): string
{
    $name  = str_replace(['"', '\\', "\r", "\n"], '', $name);
    $ascii = @preg_replace('/[^\x20-\x7e]/u', '_', $name);
    if ($ascii === null) $ascii = preg_replace('/[^\x20-\x7e]/', '_', $name);
    return $kind . '; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name);
}

function fv_stream_setup(): void
{
    @ini_set('zlib.output_compression', 'Off');
    @set_time_limit(0);
    while (ob_get_level() > 0) ob_end_clean();
    @ignore_user_abort(true);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && isset($_POST['zip'])) {
    if (!FilesViewerEndpoint::validateCsrf()) {
        http_response_code(403);
        exit;
    }
    $src = FilesViewerEndpoint::zipSources((string)($_POST['paths'] ?? ''));
    if (!$src['ok']) {
        http_response_code(404);
        exit;
    }
    require_once __DIR__ . '/filesviewer_zip.php';

    header('X-Content-Type-Options: nosniff');
    header('Content-Type: application/zip');
    header('Content-Disposition: ' . fv_disposition('attachment', FilesViewerEndpoint::zipName((string)($_POST['name'] ?? ''), $src['items'])));
    header('Cache-Control: private, no-store');
    header('X-Accel-Buffering: no');
    fv_stream_setup();

    $zip = new FilesViewerZip(static function (string $buf): bool {
        echo $buf;
        flush();
        return !connection_aborted();
    }, 1);

    $walk = function (string $path, string $rel) use (&$walk, $zip): bool {
        if (is_link($path)) return true;
        $st = @stat($path);
        if ($st === false) return true;
        if (is_dir($path)) {
            if (!$zip->dir($rel . '/', (int)$st['mtime'], (int)$st['mode'])) return false;
            foreach ((array)@scandir($path) as $e) {
                if ($e === '.' || $e === '..') continue;
                if (!$walk($path . '/' . $e, $rel . '/' . $e)) return false;
            }
            return true;
        }
        $in = @fopen($path, 'rb');
        if ($in === false) return true;
        $ok = $zip->file($rel, $in, (int)$st['size'], (int)$st['mtime'], (int)$st['mode']);
        fclose($in);
        return $ok;
    };

    foreach ($src['items'] as $it) {
        if (!$walk($it['path'], $it['name'])) exit;
    }
    $zip->finish();
    exit;
}

$real = FilesViewerEndpoint::safePath((string)($_GET['path'] ?? ''), 'file');
if ($real === null) {
    http_response_code(404);
    exit;
}

$ext  = FilesViewerEndpoint::effectiveExt(basename($real));
$mime = FilesViewerEndpoint::mimeFor($ext);
$dl   = isset($_GET['dl']) && (string)$_GET['dl'] === '1';

$size = (int)@filesize($real);
$fh   = @fopen($real, 'rb');
if ($fh === false) {
    http_response_code(500);
    exit;
}

header('X-Content-Type-Options: nosniff');
header('Content-Type: ' . $mime);
header('Accept-Ranges: bytes');
header('Cache-Control: private, max-age=0, must-revalidate');

$svg = ($mime === 'image/svg+xml');
$disposition = ($dl || $svg || $mime === 'application/octet-stream') ? 'attachment' : 'inline';
header('Content-Disposition: ' . fv_disposition($disposition, basename($real)));

fv_stream_setup();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    header('Content-Length: ' . $size);
    fclose($fh);
    exit;
}

$start = 0;
$end   = $size - 1;
$range = (string)($_SERVER['HTTP_RANGE'] ?? '');
if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
    if ($m[1] === '' && $m[2] !== '') {
        $n     = (int)$m[2];
        $start = ($n >= $size) ? 0 : $size - $n;
        $end   = $size - 1;
    } else {
        if ($m[1] !== '') $start = (int)$m[1];
        if ($m[2] !== '') $end   = (int)$m[2];
        if ($end >= $size) $end = $size - 1;
    }

    if ($start < 0 || $start > $end || $start >= $size) {
        http_response_code(416);
        header('Content-Range: bytes */' . $size);
        fclose($fh);
        exit;
    }
    http_response_code(206);
    header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
}

$length = $end - $start + 1;
header('Content-Length: ' . $length);

if ($start > 0) fseek($fh, $start);

$chunk     = 1 << 19;
$remaining = $length;
while ($remaining > 0 && !feof($fh)) {
    $buf = fread($fh, ($remaining > $chunk) ? $chunk : $remaining);
    if ($buf === false) break;
    echo $buf;
    $remaining -= strlen($buf);
    flush();
    if (connection_aborted()) break;
}
fclose($fh);
