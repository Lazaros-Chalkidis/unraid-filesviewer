<?php
/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

// streams raw file bytes for the in-page preview (images now, media and pdf in
// the phases that follow) and for raw or download links. all the safety lives in
// the shared class: path containment, the fixed mime map, and the csrf gate.
require_once __DIR__ . '/filesviewer_api.php';

if (!FilesViewerEndpoint::validateCsrf()) {
    http_response_code(403);
    exit;
}

$real = FilesViewerEndpoint::safePath((string)($_GET['path'] ?? ''), 'file');
if ($real === null) {
    http_response_code(404);
    exit;
}

$ext  = FilesViewerEndpoint::effectiveExt(basename($real));
$mime = FilesViewerEndpoint::mimeFor($ext);                 // never trust the file content for this
$dl   = isset($_GET['dl']) && (string)$_GET['dl'] === '1';

$size = (int)@filesize($real);
$fh   = @fopen($real, 'rb');
if ($fh === false) {
    http_response_code(500);
    exit;
}

header('X-Content-Type-Options: nosniff');                  // the browser must honour the type we send
header('Content-Type: ' . $mime);
header('Accept-Ranges: bytes');
header('Cache-Control: private, max-age=0, must-revalidate');

// no known type means download, so the browser never renders an unknown blob.
// svg downloads too: inside the preview <img> it cannot run, opened as a
// document it would script our origin
$svg = ($mime === 'image/svg+xml');
$disposition = ($dl || $svg || $mime === 'application/octet-stream') ? 'attachment' : 'inline';
$fname = str_replace(['"', "\r", "\n"], '', basename($real));
header('Content-Disposition: ' . $disposition . '; filename="' . $fname . '"');

// turn off buffering and compression so ranges are exact and large files stream
@ini_set('zlib.output_compression', 'Off');
@set_time_limit(0);                                         // a long media stream must not be cut off
while (ob_get_level() > 0) ob_end_clean();

// head requests want the headers only
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    header('Content-Length: ' . $size);
    fclose($fh);
    exit;
}

// byte ranges, so the browser can seek media and never has to pull a whole file
$start = 0;
$end   = $size - 1;
$range = (string)($_SERVER['HTTP_RANGE'] ?? '');
if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
    if ($m[1] === '' && $m[2] !== '') {
        // suffix form "bytes=-N": the last N bytes of the file
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

$chunk     = 1 << 19;   // 512 KB per read, so memory stays flat on big files
$remaining = $length;
while ($remaining > 0 && !feof($fh)) {
    $buf = fread($fh, ($remaining > $chunk) ? $chunk : $remaining);
    if ($buf === false) break;
    echo $buf;
    $remaining -= strlen($buf);
    flush();
}
fclose($fh);
