/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

(function () {
    'use strict';

    var _cfg   = window.filesviewerToolConfig || {};
    var _token = _cfg.fvToken || '';
    var _imgMaxBytes = (Number(_cfg.imgMaxMb) || 50) * 1000 * 1000;
    var _docMaxBytes    = 30 * 1000 * 1000;
    var _ebookMaxBytes  = 60 * 1000 * 1000;
    var _fontMaxBytes   = 15 * 1000 * 1000;
    var _editMaxBytes   = 2 * 1024 * 1024;   // matches the server edit cap (2 MiB)
    var _autoplay = !!_cfg.autoplay;
    var _remember = (_cfg.remember !== false);   // default on
    var _recycleOn = (_cfg.recycle !== false);   // default on: deletes go to the recycle bin
    var _permsFmt = (_cfg.permsFormat === 'symbolic') ? 'symbolic' : 'octal';
    var _roots    = _cfg.roots || [];

    // prefer the token the page injected, fall back to the global unraid sets
    function csrfToken() { return _cfg.csrfToken || window.csrf_token || ''; }

    var API   = '/plugins/filesviewer/include/filesviewer_api.php';
    var SERVE = '/plugins/filesviewer/include/filesviewer_serve.php';

    // the csrf token rides on the query so the same call style works for media
    // src urls, which cannot send custom headers
    function apiUrl(action, extra) {
        var url = API + '?action=' + encodeURIComponent(action)
                + '&_fvt=' + encodeURIComponent(_token)
                + '&csrf_token=' + encodeURIComponent(csrfToken());
        if (extra) url += '&' + extra;
        return url;
    }

    function serveUrl(path, dl) {
        var u = SERVE + '?path=' + encodeURIComponent(path)
              + '&_fvt=' + encodeURIComponent(_token)
              + '&csrf_token=' + encodeURIComponent(csrfToken());
        if (dl) u += '&dl=1';
        return u;
    }

    // remember the last folder across visits, when the setting allows it
    // key the remembered folder to the current roots, so changing the allowed
    // folders opens at the new root instead of a stale path from the old one
    var LS_KEY = 'filesviewer:lastdir:' + (_roots.length ? _roots.join('|') : 'default');
    function saveDir(p) { if (!_remember) return; try { if (p) localStorage.setItem(LS_KEY, p); } catch (e) {} }
    function readDir()  { if (!_remember) return ''; try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }

    function fetchJson(action, extra) {
        return fetch(apiUrl(action, extra), {
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'same-origin'
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    // writes go by POST. action and csrf still ride on the query like the reads,
    // and csrf goes in the body too, so the gate finds it either way.
    function postJson(action, params) {
        var body = 'csrf_token=' + encodeURIComponent(csrfToken());
        for (var k in params) {
            if (Object.prototype.hasOwnProperty.call(params, k)) {
                body += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
            }
        }
        return fetch(apiUrl(action), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            credentials: 'same-origin',
            body: body
        }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
        });
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // rich previews pull a vendored library only the first time it is needed, so
    // the page stays light. each script is fetched once and cached by its promise
    var _libs = {};
    function loadLib(file) {
        if (_libs[file]) return _libs[file];
        _libs[file] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = '/plugins/filesviewer/js/vendor/' + file;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('could not load ' + file)); };
            document.head.appendChild(s);
        });
        return _libs[file];
    }
    function fetchBytes(path) {
        return fetch(serveUrl(path, false), { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
        });
    }

    // the file a read-only action targets: a single ticked file, else the previewed one
    function focusedFile() {
        if (singleSelectedFile()) return selectedPaths()[0];
        if (_previewFile && _previewFile.path) return _previewFile.path;
        return null;
    }
    // Download is read-only, so it works on the previewed file too, no tick needed
    function downloadSelected() {
        var p = focusedFile();
        if (!p) return;
        var a = document.createElement('a');
        a.href = serveUrl(p, true);
        a.setAttribute('download', '');
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    function openRawSelected() {
        if (!_selectedFile) return;
        window.open(serveUrl(_selectedFile, false), '_blank', 'noopener');
    }
    function toggleWrap() {
        var pre = _bodyEl ? _bodyEl.querySelector('.fv-code') : null;
        if (!pre) return;
        var on = !pre.classList.contains('wrap-on');
        pre.classList.toggle('wrap-on', on);
        pre.classList.toggle('wrap-off', !on);
        if (_wrapBtn) _wrapBtn.classList.toggle('active', on);
    }
    // each renderer says which of the shared preview tools apply to it
    function setFileTools(canWrap, canRaw, canEdit) {
        if (_wrapBtn) { _wrapBtn.disabled = !canWrap; _wrapBtn.classList.toggle('active', canWrap); }
        if (_rawBtn)  { _rawBtn.disabled = !canRaw; }
        _editable = !!canEdit;
        refreshEditBtn();
    }
    // Edit needs both an editable file and edit mode switched on
    function refreshEditBtn() {
        if (_editBtn) _editBtn.disabled = !(_editable && _editMode);
    }

    // decimal units, kept identical to the other plugins
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        var units = ['B','KB','MB','GB','TB','PB'];
        var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
        var val = bytes / Math.pow(1000, i);
        var str = (i >= 3) ? val.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(val));
        return str + ' ' + units[i];
    }

    function formatDate(epoch) {
        if (!epoch) return '';
        try { return new Date(epoch * 1000).toLocaleString(); }
        catch (e) { return ''; }
    }

    var CAT_LABEL = {
        dir: 'Folder', img: 'Image', code: 'Text', md: 'Markdown', pdf: 'PDF',
        audio: 'Audio', video: 'Video', arch: 'Archive', bin: 'File',
        sqlite: 'Database', doc: 'Document', sheet: 'Spreadsheet', ebook: 'E-book', font: 'Font'
    };
    var CAT_TAG = {
        dir: '', img: 'IMG', code: '{}', md: 'MD', pdf: 'PDF',
        audio: '\u266a', video: '\u25b6', arch: 'ZIP', bin: 'BIN',
        sqlite: 'DB', doc: 'DOC', sheet: 'XLS', ebook: 'BK', font: 'Aa'
    };

    // unknown extensions share one neutral category, so they would all look alike.
    // derive a stable colour from the extension text itself so each one reads distinct
    function extColor(ext) {
        var s = String(ext || '').toLowerCase();
        if (!s) return null;
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        h ^= h >>> 13; h = (h * 0x5bd1e995) >>> 0; h ^= h >>> 15;
        var hue = (h >>> 0) % 360;
        return { bg: 'hsla(' + hue + ',55%,50%,.18)', fg: 'hsl(' + hue + ',62%,68%)' };
    }
    function iconStyleAttr(cat, ext) {
        if (cat !== 'bin') return '';
        var c = extColor(ext);
        return c ? (' style="background:' + c.bg + ';color:' + c.fg + '"') : '';
    }
    var FOLDER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';

    // files are drawn as a small document (white page, black outline, folded
    // corner) where only the type symbol carries colour. this is the darker,
    // white-bg-legible variant of the category colours
    var ICON_COLOR = {
        img: '#1f7ae0', code: '#2f6fe0', md: '#7c3aed', pdf: '#d83a2c',
        audio: '#d98a1f', video: '#2a82d6', arch: '#4b5563', bin: '#4b5563',
        sqlite: '#0f9d6b', doc: '#2f63d6', sheet: '#1f9d57', ebook: '#7a45c8', font: '#c43d7a'
    };
    function extColorDark(ext) {
        var s = String(ext || '').toLowerCase();
        if (!s) return '#4b5563';
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        h ^= h >>> 13; h = (h * 0x5bd1e995) >>> 0; h ^= h >>> 15;
        return 'hsl(' + ((h >>> 0) % 360) + ',60%,42%)';
    }
    var DOC_PAGE = 'M14 2 H6 a2 2 0 0 0 -2 2 v16 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V8 Z';
    var DOC_FOLD = 'M14 2 v6 h6';
    function fileIconSvg(cat, ext) {
        var tag = CAT_TAG[cat] || 'BIN';
        var color = (cat === 'bin') ? extColorDark(ext) : (ICON_COLOR[cat] || '#4b5563');
        var fs = tag.length <= 1 ? 13 : (tag.length === 2 ? 10 : 7.5);   // px, html overlay
        // page drawn as svg (reliable), symbol as html text so it always renders
        var svg = '<svg class="fv-docicon" width="30" height="30" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="' + DOC_PAGE + '" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>' +
            '<path d="' + DOC_FOLD + ' Z" fill="#e8e8e8"/>' +
            '<path d="' + DOC_FOLD + '" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>';
        return svg + '<span class="fv-doc__tag" style="color:' + color + ';font-size:' + fs + 'px">' + esc(tag) + '</span>';
    }

    // ---- state ---------------------------------------------------------------

    var _listEl, _crumbEl, _bodyEl, _titleEl, _countEl, _pvTypeEl, _pvToolsEl, _filterEl, _pvEl, _pvCloseEl, _dlBtn, _wrapBtn, _rawBtn;
    var _createBtn, _renameBtn, _deleteBtn, _editBtn, _ownerBtn, _permBtn, _copyBtn, _moveBtn, _uploadBtn, _recycleBtn, _spaceBtn, _rootEl;
    var _editMode = false;      // false = preview only, true = editing allowed (header toggle)
    var _editable = false;      // the previewed file is small enough to edit
    var _inFolder = false;      // a real folder is open (not the roots list)
    var _currentCrumbs = [];     // folder breadcrumb data, reused to append the open file
    var _hasManyRoots = false;
    var EMPTY_HTML = '';
    var _currentPath = '';
    var _selectedFile = null;   // path of the file in the preview, used by Open raw
    var _selected = {};         // checkbox selection (path -> true); the file ops act on this
    var _previewFile = null;    // {path,cat,size,name,ext} of the file in the preview
    var _editing = false;       // the preview is in edit mode (textarea)
    var _editBaseline = '';     // content as loaded, to detect unsaved changes
    var _editMtime = 0;         // mtime the file had when opened, for the stale guard
    var _editCtx = null;        // file context to restore the read-only preview on exit

    // ---- shared bits ---------------------------------------------------------

    function setLoading(target) {
        target.innerHTML =
            '<div class="fv-loading">' +
              '<div class="fv-loading__bars">' +
                '<div class="fv-loading__bar"></div><div class="fv-loading__bar"></div>' +
                '<div class="fv-loading__bar"></div><div class="fv-loading__bar"></div>' +
                '<div class="fv-loading__bar"></div>' +
              '</div>' +
              '<div class="fv-loading__text">Reading\u2026</div>' +
            '</div>';
    }

    function errorBox(msg) { return '<div class="fv-error">' + esc(msg) + '</div>'; }

    function setPvHead(name, typeText, cat) {
        resetPaneModes();
        renderPathCrumbs(name || null);
        if (_pvTypeEl) {
            _pvTypeEl.textContent = typeText || '';
            _pvTypeEl.className = 'fv-preview__type' + (typeText && cat ? ' fv-pt-' + cat : '');
            _pvTypeEl.style.background = '';
            _pvTypeEl.style.color = '';
            if (cat === 'bin' && typeText && typeText.charAt(0) === '.') {
                var c = extColor(typeText.slice(1));
                if (c) { _pvTypeEl.style.background = c.bg; _pvTypeEl.style.color = c.fg; }
            }
        }
        _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
    }

    // close the preview: dropping the media element stops playback, then show the empty pane
    function clearPreview() {
        resetPaneModes();
        _bodyEl.innerHTML = EMPTY_HTML;
        if (_pvTypeEl) {
            _pvTypeEl.textContent = '';
            _pvTypeEl.className = 'fv-preview__type';
            _pvTypeEl.style.background = '';
            _pvTypeEl.style.color = '';
        }
        _pvToolsEl.innerHTML = '';
        renderPathCrumbs(null);
        markActive(null);
        _selectedFile = null;
        _previewFile = null;
        _editable = false;
        resetEditState();
        setFileTools(false, false);
        updateOps();                // download off, folder-add back on (if editing)
        if (_pvEl) _pvEl.classList.remove('fv-preview--active');
    }

    function addTool(label, title, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fv-pv-btn';
        b.title = title || label;
        b.textContent = label;
        b.addEventListener('click', onClick);
        _pvToolsEl.appendChild(b);
        return b;
    }

    function addLink(label, title, path, dl) {
        var a = document.createElement('a');
        a.className = 'fv-pv-btn';
        a.href = serveUrl(path, dl);
        a.target = '_blank';
        a.rel = 'noopener';
        if (dl) a.setAttribute('download', '');
        a.title = title || label;
        a.textContent = label;
        _pvToolsEl.appendChild(a);
        return a;
    }

    // ---- list rendering ------------------------------------------------------

    function buildCrumbsHtml(crumbs, hasManyRoots, fileName) {
        if (!crumbs || !crumbs.length) {
            return '<span class="fv-crumb cur">Roots</span>';
        }
        var html = '<span class="fv-crumb-label">Path:</span>';
        if (hasManyRoots) {
            html += '<a class="fv-crumb" data-path="">Roots</a><span class="fv-crumb-sep">/</span>';
        }
        for (var i = 0; i < crumbs.length; i++) {
            var last = (i === crumbs.length - 1);
            if (last && !fileName) {
                html += '<span class="fv-crumb cur">' + esc(crumbs[i].name) + '</span>';
            } else {
                html += '<a class="fv-crumb" data-path="' + esc(crumbs[i].path) + '">' + esc(crumbs[i].name) + '</a>'
                      + '<span class="fv-crumb-sep">/</span>';
            }
        }
        if (fileName) html += '<span class="fv-crumb cur">' + esc(fileName) + '</span>';
        return html;
    }
    function renderPathCrumbs(fileName) {
        if (_crumbEl) _crumbEl.innerHTML = buildCrumbsHtml(_currentCrumbs, _hasManyRoots, fileName || null);
    }
    function renderCrumbs(crumbs, isRoot, hasManyRoots) {
        _currentCrumbs = crumbs || [];
        _hasManyRoots = !!hasManyRoots;
        renderPathCrumbs(null);
    }

    function renderList(data) {
        var entries = data.entries || [];
        _titleEl.textContent = data.root_picker ? 'Roots' : 'Contents';
        _listEl.setAttribute('data-trunc', data.truncated ? '1' : '0');
        _selected = {};                      // a fresh listing starts with nothing ticked

        if (!entries.length) {
            _listEl.innerHTML = '<div class="fv-list-empty">This folder is empty.</div>';
            if (_countEl) _countEl.textContent = '';
            updateOps();
            return;
        }

        var sel = !data.root_picker;         // roots are not selectable targets
        var cb  = sel ? '<label class="fv-item__cb"><input type="checkbox" class="fv-rowcb" aria-label="Select"></label>' : '';
        var html = '';

        if (!data.is_root && data.parent) {
            html += '<div class="fv-item fv-item--up" data-dir="1" data-path="' + esc(data.parent) + '">' +
                      (sel ? '<span class="fv-item__cb"></span>' : '') +
                      '<div class="fv-ico dir">' + FOLDER_SVG + '</div>' +
                      '<div class="fv-item__meta"><div class="fv-item__name">..</div>' +
                      '<div class="fv-item__sub">Parent folder</div></div>' +
                    '</div>';
        }

        for (var i = 0; i < entries.length; i++) {
            var e   = entries[i];
            var cat = e.is_dir ? 'dir' : (e.category || 'bin');
            var ico = e.is_dir ? FOLDER_SVG : fileIconSvg(cat, e.ext);
            var base = e.is_dir ? 'Folder'
                                : (formatBytes(e.size) + ' \u00b7 ' + (CAT_LABEL[cat] || 'File'));
            var pv  = (_permsFmt === 'symbolic') ? (e.perms || '') : (e.mode || '');
            var sub = base;
            if (e.owner) sub += ' \u00b7 ' + esc(e.owner);
            if (pv)      sub += ' \u00b7 ' + esc(pv);

            html += '<div class="fv-item"' +
                      ' data-dir="' + (e.is_dir ? '1' : '0') + '"' +
                      ' data-path="' + esc(e.path) + '"' +
                      ' data-cat="'  + esc(cat) + '"' +
                      ' data-size="' + (e.size || 0) + '"' +
                      ' data-name="' + esc(e.name) + '"' +
                      ' data-ext="'  + esc(e.ext || '') + '">' +
                      cb +
                      '<div class="fv-ico ' + (e.is_dir ? 'dir' : 'fv-ico--doc') + '">' + ico + '</div>' +
                      '<div class="fv-item__meta">' +
                        '<div class="fv-item__name">' + esc(e.name) + '</div>' +
                        '<div class="fv-item__sub">' + sub + '</div>' +
                      '</div>' +
                    '</div>';
        }
        _listEl.innerHTML = html;
        updateOps();
    }

    function markActive(path) {
        var items = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active',
                items[i].getAttribute('data-path') === path && items[i].getAttribute('data-dir') === '0');
        }
    }

    // ---- image preview -------------------------------------------------------

    function renderImage(path, name) {
        setPvHead(name, 'Image', 'img');
        _bodyEl.innerHTML = '<div class="fv-imgwrap" id="fv-imgwrap"><img class="fv-img fit" id="fv-img" alt=""></div>';
        var wrap = document.getElementById('fv-imgwrap');
        var img  = document.getElementById('fv-img');
        img.onerror = function () { loadMeta(path, 'This file could not be shown as an image.'); };
        img.src = serveUrl(path, false);
        img.addEventListener('dragstart', function (e) { e.preventDefault(); });

        var fit = true, fitBtn;
        function toggleFit() {
            fit = !fit;
            img.classList.toggle('fit', fit);
            wrap.classList.toggle('actual', !fit);
            img.style.cursor = fit ? 'zoom-in' : 'zoom-out';
            if (fitBtn) { fitBtn.textContent = fit ? 'Actual size' : 'Fit'; fitBtn.classList.toggle('active', !fit); }
            if (!fit) {
                // open the 1:1 view on the middle of the picture
                wrap.scrollLeft = (wrap.scrollWidth  - wrap.clientWidth)  / 2;
                wrap.scrollTop  = (wrap.scrollHeight - wrap.clientHeight) / 2;
            }
        }
        fitBtn = addTool('Actual size', 'Switch between fit and actual size', toggleFit);
        img.style.cursor = 'zoom-in';

        // 1:1 can outgrow the pane and there are no bars: overflow is reached
        // by dragging, and a real drag must not count as the toggle click
        var dragging = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;
        wrap.addEventListener('pointerdown', function (e) {
            if (fit || e.button !== 0) return;
            e.preventDefault();
            dragging = true; moved = false;
            sx = e.clientX; sy = e.clientY; sl = wrap.scrollLeft; st = wrap.scrollTop;
            if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId);
        });
        wrap.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.abs(dx) + Math.abs(dy) > 4) { moved = true; wrap.classList.add('panning'); }
            if (moved) { wrap.scrollLeft = sl - dx; wrap.scrollTop = st - dy; }
        });
        function dragEnd() { dragging = false; wrap.classList.remove('panning'); }
        wrap.addEventListener('pointerup', dragEnd);
        wrap.addEventListener('pointercancel', dragEnd);

        // pointer capture retargets the click to the wrap, so the toggle lives
        // there: on the image while fitted, anywhere while zoomed in
        wrap.addEventListener('click', function (e) {
            if (moved) { moved = false; return; }
            if (fit && e.target !== img) return;
            toggleFit();
        });
        setFileTools(false, true);
    }

    // ---- media (audio, video) ------------------------------------------------
    // the browser plays what its codecs support. anything it cannot decode (often
    // MKV or H.265) falls back to the details card rather than a blank player.

    function mediaError(path, kind) {
        return function () {
            loadMeta(path, 'This ' + kind + ' could not be played in the browser. The container or codec may be unsupported.');
        };
    }

    function renderVideo(path, name) {
        setPvHead(name, 'Video', 'video');
        _bodyEl.innerHTML =
            '<div class="fv-mediawrap">' +
              '<div class="fv-videobox">' +
                '<video id="fv-media" class="fv-video" controls playsinline preload="metadata"' + (_autoplay ? ' autoplay' : '') + '></video>' +
              '</div>' +
              '<div class="fv-media-note">If playback does not start, the container or codec may not be supported by the browser (for example MKV or H.265).</div>' +
            '</div>';
        var v = document.getElementById('fv-media');
        v.addEventListener('error', mediaError(path, 'video'));
        v.src = serveUrl(path, false);
        setFileTools(false, true);
    }

    function renderAudio(path, name) {
        setPvHead(name, 'Audio', 'audio');
        _bodyEl.innerHTML =
            '<div class="fv-mediawrap fv-mediawrap--audio">' +
              '<audio id="fv-media" class="fv-audio" controls preload="metadata"' + (_autoplay ? ' autoplay' : '') + '></audio>' +
            '</div>';
        var a = document.getElementById('fv-media');
        a.addEventListener('error', mediaError(path, 'audio'));
        a.src = serveUrl(path, false);
        setFileTools(false, true);
    }

    // ---- text, code and markdown ---------------------------------------------

    function truncatedBanner(d) {
        return d.truncated
            ? '<div class="fv-trunc">Showing the first part only. This file is larger than the preview limit.</div>'
            : '';
    }

    function loadPreview(path, name, ext) {
        setLoading(_bodyEl);
        setPvHead(name, ext ? ('.' + ext) : '', 'code');
        fetchJson('preview', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || 'Could not read this file.'); return; }
            if (d.kind === 'text') {
                if (ext === 'csv' || ext === 'tsv') renderCsv(d, path, name, ext);
                else                                renderText(d, path, name, ext);
            }
            else if (d.kind === 'markdown') renderMarkdown(d, path, name);
            else                            loadMeta(path);   // binary or anything not text
        }).catch(function () { _bodyEl.innerHTML = errorBox('Request failed.'); });
    }

    function renderText(d, path, name, ext) {
        setPvHead(name, ext ? ('.' + ext) : 'Text', 'code');
        _bodyEl.innerHTML = truncatedBanner(d);

        var text = d.content || '';
        // highlighting a multi-MB log blocks the page, so past this size we skip it and
        // break the text into chunks the browser can skip while they are off screen
        var big = text.length > 120000;

        var pre = document.createElement('pre');
        pre.className = 'fv-code wrap-on' + (big ? ' fv-code--big' : '');

        if (big) {
            var inner = document.createElement('div');
            inner.className = 'fv-code__inner';
            var lines = text.split('\n');
            for (var i = 0; i < lines.length; i += 400) {
                var ch = document.createElement('div');
                ch.className = 'fv-code__chunk';
                ch.textContent = lines.slice(i, i + 400).join('\n');
                inner.appendChild(ch);
            }
            pre.appendChild(inner);
            _bodyEl.appendChild(pre);
        } else {
            var code = document.createElement('code');
            if (d.language) code.className = 'language-' + d.language;
            code.textContent = text;   // textContent, never innerHTML, so the file cannot inject markup
            pre.appendChild(code);
            _bodyEl.appendChild(pre);
            try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
        }

        if (ext === 'csv' || ext === 'tsv') {
            addTool('Table', 'Show as a table', function () { renderCsv(d, path, name, ext); });
        }
        setFileTools(true, true, (d.size || 0) <= _editMaxBytes);
    }

    function renderMarkdown(d, path, name) {
        setPvHead(name, 'Markdown', 'md');
        var rendered = true;

        function highlightInside() {
            try {
                if (window.hljs) {
                    _bodyEl.querySelectorAll('.fv-md pre code').forEach(function (c) { window.hljs.highlightElement(c); });
                }
            } catch (e) {}
        }
        function showRendered() {
            var html;
            try { html = window.marked ? window.marked.parse(d.content) : ('<pre>' + esc(d.content) + '</pre>'); }
            catch (e) { html = '<pre>' + esc(d.content) + '</pre>'; }
            // strip any script, event handlers or unsafe urls from the rendered html
            if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
            _bodyEl.innerHTML = truncatedBanner(d) + '<div class="fv-md">' + html + '</div>';
            highlightInside();
        }
        function showSource() {
            var pre  = document.createElement('pre');
            pre.className = 'fv-code wrap-on';
            var code = document.createElement('code');
            code.className = 'language-markdown';
            code.textContent = d.content;
            pre.appendChild(code);
            _bodyEl.innerHTML = truncatedBanner(d);
            _bodyEl.appendChild(pre);
            try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
        }

        showRendered();

        var srcBtn = addTool('View source', 'Toggle rendered or source', function () {
            rendered = !rendered;
            if (rendered) showRendered(); else showSource();
            srcBtn.textContent = rendered ? 'View source' : 'View rendered';
            srcBtn.classList.toggle('active', !rendered);
        });
        setFileTools(false, true, (d.size || 0) <= _editMaxBytes);
    }

    // ---- metadata fallback card ----------------------------------------------

    function loadMeta(path, note) {
        markActive(path);
        setLoading(_bodyEl);
        setPvHead('Preview', '');
        fetchJson('meta', 'path=' + encodeURIComponent(path)).then(function (m) {
            renderMeta(m, note);
        }).catch(function () { _bodyEl.innerHTML = errorBox('Request failed.'); });
    }

    function renderMeta(m, note) {
        if (!m || !m.ok) { _bodyEl.innerHTML = errorBox('This file could not be read.'); return; }

        setPvHead(m.name, m.ext ? ('.' + m.ext) : (CAT_LABEL[m.category] || ''), m.category);

        var rows = [
            ['Type',     (CAT_LABEL[m.category] || 'File') + (m.ext ? ' (.' + esc(m.ext) + ')' : '')],
            ['Size',     formatBytes(m.size)],
            ['Modified', formatDate(m.mtime)],
            ['Type id',  esc(m.mime)],
            ['Perms',    esc((_permsFmt === 'symbolic') ? (m.perms || m.mode) : (m.mode || m.perms))],
            ['Path',     esc(m.path)]
        ];
        var table = '';
        for (var i = 0; i < rows.length; i++) {
            table += '<div><span>' + rows[i][0] + '</span><span>' + rows[i][1] + '</span></div>';
        }

        var msg = note || 'This file has no preview available.';
        _bodyEl.innerHTML =
            '<div class="fv-meta">' +
              '<div class="fv-meta__msg">' + esc(msg) + '</div>' +
              '<div class="fv-meta__table">' + table + '</div>' +
            '</div>';
    }

    // ---- pdf and archive -----------------------------------------------------

    function renderPdf(path, name) {
        setPvHead(name, 'PDF', 'pdf');
        _bodyEl.innerHTML = '<div class="fv-pdfwrap"><iframe class="fv-pdf" id="fv-pdf" title="PDF preview"></iframe></div>';
        document.getElementById('fv-pdf').src = serveUrl(path, false);   // the browser viewer renders it inline
        setFileTools(false, true);
    }

    function loadArchive(path, name) {
        setLoading(_bodyEl);
        setPvHead(name, 'Archive', 'arch');
        fetchJson('archive', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || 'Could not read this archive.'); return; }
            if (d.kind === 'archive') renderArchive(d, path, name);
            else loadMeta(path, 'Listing for this archive type is not supported yet.');
        }).catch(function () { _bodyEl.innerHTML = errorBox('Request failed.'); });
    }

    function renderArchive(d, path, name) {
        setPvHead(name, 'Archive', 'arch');
        var rows = d.entries || [];

        var head = '<div class="fv-arch-head">' +
            (d.count || 0) + (d.truncated ? '+' : '') + ' entries' +
            (d.truncated ? ' (showing the first ' + d.count + ')' : '') +
            ' \u00b7 listing only, nothing is extracted</div>';

        if (!rows.length) {
            _bodyEl.innerHTML = head + '<div class="fv-list-empty">No entries, or this archive could not be listed.</div>';
            return;
        }

        var html = '<div class="fv-arch">';
        for (var i = 0; i < rows.length; i++) {
            var r   = rows[i];
            var ico = r.is_dir ? FOLDER_SVG : 'FILE';
            html += '<div class="fv-arch-row">' +
                      '<span class="fv-ico ' + (r.is_dir ? 'dir' : 'bin') + ' fv-arch-ico">' + ico + '</span>' +
                      '<span class="fv-arch-name">' + esc(r.name) + '</span>' +
                      '<span class="fv-arch-size">' + (r.is_dir ? '' : formatBytes(r.size)) + '</span>' +
                    '</div>';
        }
        html += '</div>';

        _bodyEl.innerHTML = head + html;
    }

    // ---- navigation ----------------------------------------------------------

    function loadDir(path, fromInit) {
        if (!leaveEditOk()) return Promise.resolve();
        _currentPath = path || '';
        clearPreview();
        clearFilter();
        setLoading(_listEl);
        return fetchJson('list', 'path=' + encodeURIComponent(_currentPath)).then(function (data) {
            if (!data || !data.ok) {
                // a remembered path may no longer exist or be allowed; drop to the root on first load
                if (fromInit && _currentPath !== '') { loadDir('', false); return; }
                _listEl.innerHTML = errorBox((data && data.error) || 'Could not read this folder.');
                return;
            }
            var manyRoots = (data.roots && data.roots.length > 1);
            saveDir(data.path || '');
            _inFolder = !!data.path;            // the roots list has no target folder
            renderCrumbs(data.breadcrumb, data.is_root, manyRoots);
            renderList(data);
            applyFilter();
        }).catch(function () {
            if (fromInit && _currentPath !== '') { loadDir('', false); return; }
            _listEl.innerHTML = errorBox('Request failed.');
        });
    }

    // ---- wiring --------------------------------------------------------------

    // dispatch a file to the right preview once it is cleared to be read
    // ---- rich previews -------------------------------------------------------

    function renderCsv(d, path, name, ext) {
        setPvHead(name, (ext ? '.' + ext : 'CSV'), 'code');
        _bodyEl.innerHTML = truncatedBanner(d) + '<div class="fv-csvwrap" id="fv-csvwrap"></div>';
        var wrap = document.getElementById('fv-csvwrap');
        setLoading(wrap);
        loadLib('papaparse.min.js').then(function () {
            var parsed = window.Papa.parse(d.content || '', {
                delimiter: (ext === 'tsv') ? '\t' : '',
                skipEmptyLines: true
            });
            var rows = (parsed && parsed.data) || [];
            if (!rows.length) { wrap.innerHTML = errorBox('No rows to show.'); return; }
            var head = rows[0], html = '<table class="fv-table"><thead><tr>';
            for (var i = 0; i < head.length; i++) html += '<th>' + esc(String(head[i])) + '</th>';
            html += '</tr></thead><tbody>';
            for (var r = 1; r < rows.length; r++) {
                html += '<tr>';
                var row = rows[r];
                for (var k = 0; k < row.length; k++) html += '<td>' + esc(String(row[k])) + '</td>';
                html += '</tr>';
            }
            wrap.innerHTML = html + '</tbody></table>';
        }).catch(function () { wrap.innerHTML = errorBox('Could not parse this file.'); });

        addTool('Raw', 'Show as plain text', function () { renderText(d, path, name, ext); });
        setFileTools(false, true);
    }

    // sqlite preview: the server reads the database (immutable, read only) and
    // hands over tables and rows. nothing is downloaded to the browser, so a
    // multi gigabyte live library opens instantly and cannot be disturbed
    var _db = null;   // { path, name, info } while a database preview is open

    function renderSqlite(path, name) {
        setPvHead(name, 'Database', 'sqlite');
        setLoading(_bodyEl);
        _db = null;
        fetchJson('db_info', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || 'Could not open this database.'); return; }
            _db = { path: path, name: name, info: d };
            renderDbTables();
        }).catch(function () { _bodyEl.innerHTML = errorBox('Request failed.'); });
    }

    var DB_TABLE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5h18M3 10h18M3 15h18M3 20h18M8 5v15M16 5v15"/></svg>';

    function renderDbTables() {
        if (!_db) return;
        var d = _db.info;
        var tables = d.tables || [];
        var nt = 0, nv = 0;
        tables.forEach(function (t) { if (t.kind === 'view') nv++; else nt++; });

        var html = '<div class="fv-db2">' +
            '<div class="fv-db2-head"><b>' + esc(_db.name) + '</b> \u00b7 ' + formatBytes(d.size || 0) +
            ' \u00b7 SQLite ' + esc(d.sqlite || '?') + ' \u00b7 ' + nt + (nt === 1 ? ' table' : ' tables') +
            (nv ? ', ' + nv + (nv === 1 ? ' view' : ' views') : '') +
            ' \u00b7 ' + (d.immutable ? 'opened read only, no locks' : 'opened read only') + '</div>';
        if (d.wal) html += '<div class="fv-db2-warn">Write ahead log present: recent changes by the running app may not appear here.</div>';
        if (d.counts_partial) html += '<div class="fv-db2-note">Some row counts were skipped to keep this large database quick to open.</div>';

        if (!tables.length) {
            html += '<div class="fv-list-empty">No tables found in this database.</div>';
        } else {
            html += '<div class="fv-db2-list">';
            tables.forEach(function (t, i) {
                var meta = t.cols + (t.cols === 1 ? ' col' : ' cols');
                if (t.rows !== null && t.rows !== undefined) meta += ' \u00b7 ' + t.rows.toLocaleString() + (t.rows === 1 ? ' row' : ' rows');
                html += '<div class="fv-db2-trow" data-i="' + i + '">' +
                          '<span class="fv-db2-tico">' + DB_TABLE_SVG + '</span>' +
                          '<span class="fv-db2-tname">' + esc(t.name) + '</span>' +
                          (t.kind === 'view' ? '<span class="fv-db2-badge">view</span>' : '') +
                          '<span class="fv-db2-tmeta">' + meta + '</span>' +
                        '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        _bodyEl.querySelector('.fv-db2').addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.fv-db2-trow') : null;
            if (!row) return;
            var t = tables[parseInt(row.getAttribute('data-i'), 10)];
            if (t) loadDbRows(t.name, 0);
        });
    }

    function loadDbRows(table, offset) {
        if (!_db) return;
        setLoading(_bodyEl);
        fetchJson('db_rows', 'path=' + encodeURIComponent(_db.path) +
                             '&table=' + encodeURIComponent(table) +
                             '&offset=' + offset + '&limit=100').then(function (d) {
            if (!_db) return;
            if (!d || !d.ok) {
                _bodyEl.innerHTML = '<div class="fv-db2"><div class="fv-db2-top"><button type="button" class="fv-btn" id="fv-db-back">\u2190 Tables</button></div>' +
                                    errorBox((d && d.error) || 'Could not read this table.') + '</div>';
                var bk = _bodyEl.querySelector('#fv-db-back');
                if (bk) bk.addEventListener('click', renderDbTables);
                return;
            }
            renderDbGrid(d);
        }).catch(function () { _bodyEl.innerHTML = errorBox('Request failed.'); });
    }

    function renderDbGrid(d) {
        var cols = d.columns || [], rows = d.rows || [];
        var from = d.offset + 1, to = d.offset + rows.length;

        var html = '<div class="fv-db2 fv-db2--grid">' +
            '<div class="fv-db2-top">' +
              '<button type="button" class="fv-btn" id="fv-db-back">\u2190 Tables</button>' +
              '<span class="fv-db2-ttitle">' + esc(d.table) + '</span>' +
              (rows.length
                  ? '<span class="fv-db2-range">rows ' + from.toLocaleString() + ' to ' + to.toLocaleString() + '</span>'
                  : '<span class="fv-db2-norows">No rows</span>') +
            '</div>';

        if (!rows.length && d.offset === 0) {
            html += '<div class="fv-list-empty">This table is empty.</div>';
        } else {
            html += '<div class="fv-tablewrap"><table class="fv-table"><thead><tr>';
            cols.forEach(function (c) { html += '<th>' + esc(String(c)) + '</th>'; });
            html += '</tr></thead><tbody>';
            rows.forEach(function (r) {
                html += '<tr>';
                r.forEach(function (v) {
                    if (v === null) html += '<td><i class="fv-db2-null">null</i></td>';
                    else if (typeof v === 'string' && v.indexOf('[blob ') === 0) html += '<td><span class="fv-db2-blob">' + esc(v) + '</span></td>';
                    else html += '<td>' + esc(String(v)) + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table></div>';
        }

        html += '<div class="fv-db2-foot">' +
                  '<span class="fv-db2-note">Values over 300 characters are clipped \u00b7 blobs shown by size</span>' +
                  '<span class="fv-db2-page">' +
                    '<button type="button" class="fv-btn" id="fv-db-prev"' + (d.offset > 0 ? '' : ' disabled') + '>\u2190 Prev 100</button>' +
                    '<button type="button" class="fv-btn" id="fv-db-next"' + (d.more ? '' : ' disabled') + '>Next 100 \u2192</button>' +
                  '</span>' +
                '</div></div>';
        _bodyEl.innerHTML = html;

        var bk = _bodyEl.querySelector('#fv-db-back');
        if (bk) bk.addEventListener('click', renderDbTables);
        var pv = _bodyEl.querySelector('#fv-db-prev');
        if (pv) pv.addEventListener('click', function () { loadDbRows(d.table, Math.max(0, d.offset - d.limit)); });
        var nx = _bodyEl.querySelector('#fv-db-next');
        if (nx) nx.addEventListener('click', function () { loadDbRows(d.table, d.offset + d.limit); });
    }

    function renderDoc(path, name) {
        setPvHead(name, 'Document', 'doc');
        setLoading(_bodyEl);
        Promise.all([loadLib('mammoth.browser.min.js'), fetchBytes(path)]).then(function (res) {
            return window.mammoth.convertToHtml({ arrayBuffer: res[1] });
        }).then(function (out) {
            var html = (out && out.value) || '';
            if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
            _bodyEl.innerHTML = '<div class="fv-doc">' + html + '</div>';
        }).catch(function () { _bodyEl.innerHTML = errorBox('Could not render this document.'); });
    }

    function renderSheet(path, name) {
        setPvHead(name, 'Spreadsheet', 'sheet');
        setLoading(_bodyEl);
        Promise.all([loadLib('xlsx.full.min.js'), fetchBytes(path)]).then(function (res) {
            var wb = window.XLSX.read(new Uint8Array(res[1]), { type: 'array' });
            var names = wb.SheetNames || [];
            if (!names.length) { _bodyEl.innerHTML = errorBox('This spreadsheet has no sheets.'); return; }
            var tabs = '';
            for (var i = 0; i < names.length; i++) tabs += '<button type="button" class="fv-sheet__tab' + (i === 0 ? ' active' : '') + '" data-sheet="' + esc(names[i]) + '">' + esc(names[i]) + '</button>';
            _bodyEl.innerHTML = '<div class="fv-sheet"><div class="fv-sheet__tabs">' + tabs + '</div><div class="fv-tablewrap" id="fv-sheet-view"></div></div>';
            function show(n) {
                var html = window.XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false });
                if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
                document.getElementById('fv-sheet-view').innerHTML = html;
            }
            var tabsEl = _bodyEl.querySelectorAll('.fv-sheet__tab');
            for (var j = 0; j < tabsEl.length; j++) {
                tabsEl[j].addEventListener('click', function () {
                    for (var x = 0; x < tabsEl.length; x++) tabsEl[x].classList.remove('active');
                    this.classList.add('active');
                    show(this.getAttribute('data-sheet'));
                });
            }
            show(names[0]);
        }).catch(function () { _bodyEl.innerHTML = errorBox('Could not open this spreadsheet.'); });
    }

    function renderFont(path, name, ext) {
        setPvHead(name, (ext ? '.' + ext : 'Font'), 'font');
        setLoading(_bodyEl);
        fetchBytes(path).then(function (buf) {
            var fam = 'fvfont_' + Date.now();
            var face = new FontFace(fam, buf);
            return face.load().then(function (loaded) {
                document.fonts.add(loaded);
                var pangram = 'The quick brown fox jumps over the lazy dog';
                var glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  .,:;!?()[]{}/\\&@#%';
                var sizes = [40, 30, 22, 16], lines = '';
                for (var i = 0; i < sizes.length; i++) lines += '<div class="fv-font__line" style="font-size:' + sizes[i] + 'px">' + esc(pangram) + '</div>';
                _bodyEl.innerHTML =
                    '<div class="fv-font" style="font-family:\'' + fam + '\',sans-serif">' +
                      '<pre class="fv-font__glyphs">' + esc(glyphs) + '</pre>' +
                      lines +
                    '</div>';
            });
        }).catch(function () { _bodyEl.innerHTML = errorBox('Could not load this font.'); });
    }

    function renderEbook(path, name) {
        setPvHead(name, 'E-book', 'ebook');
        setLoading(_bodyEl);
        loadLib('jszip.min.js').then(function () {
            return loadLib('epub.min.js');
        }).then(function () {
            return fetchBytes(path);
        }).then(function (buf) {
            _bodyEl.innerHTML =
                '<div class="fv-ebook">' +
                  '<div class="fv-ebook__view" id="fv-ebook-view"></div>' +
                  '<div class="fv-ebook__nav">' +
                    '<button type="button" class="fv-pv-btn" id="fv-ebook-prev">Previous</button>' +
                    '<button type="button" class="fv-pv-btn" id="fv-ebook-next">Next</button>' +
                  '</div>' +
                '</div>';
            var book = window.ePub(buf);
            var rendition = book.renderTo('fv-ebook-view', { width: '100%', height: '100%', flow: 'scrolled-doc' });
            rendition.display();
            document.getElementById('fv-ebook-prev').addEventListener('click', function () { rendition.prev(); });
            document.getElementById('fv-ebook-next').addEventListener('click', function () { rendition.next(); });
        }).catch(function () { _bodyEl.innerHTML = errorBox('Could not open this e-book.'); });
    }

    function doOpen(cat, size, name, ext, path) {
        if (cat === 'img')                       renderImage(path, name);
        else if (cat === 'code' || cat === 'md') loadPreview(path, name, ext);
        else if (cat === 'audio')                renderAudio(path, name);
        else if (cat === 'video')                renderVideo(path, name);
        else if (cat === 'pdf')                  renderPdf(path, name);
        else if (cat === 'arch')                 loadArchive(path, name);
        else if (cat === 'sqlite')               renderSqlite(path, name);
        else if (cat === 'doc')                  renderDoc(path, name);
        else if (cat === 'sheet')                renderSheet(path, name);
        else if (cat === 'ebook')                renderEbook(path, name);
        else if (cat === 'font')                 renderFont(path, name, ext);
        else                                     loadMeta(path);
    }

    function openFile(item) {
        if (!leaveEditOk()) return;
        var path = item.getAttribute('data-path');
        var cat  = item.getAttribute('data-cat') || 'bin';
        var size = Number(item.getAttribute('data-size') || '0');
        var name = item.getAttribute('data-name') || '';
        var ext  = item.getAttribute('data-ext') || '';

        markActive(path);
        _selectedFile = path;
        _previewFile = { path: path, cat: cat, size: size, name: name, ext: ext };
        _editable = false;          // a renderer flips this on for editable text
        refreshEditBtn();
        updateOps();                // download on, folder-add off while a file is open

        // these types read the file content; everything else is a details view
        var willRead = (cat === 'code' || cat === 'md' || cat === 'audio' || cat === 'video'
                        || cat === 'pdf' || cat === 'arch'
                        || (cat === 'img'    && size > 0 && size <= _imgMaxBytes)
                        || cat === 'sqlite'
                        || (cat === 'doc'    && size > 0 && size <= _docMaxBytes)
                        || (cat === 'sheet'  && size > 0 && size <= _docMaxBytes)
                        || (cat === 'ebook'  && size > 0 && size <= _ebookMaxBytes)
                        || (cat === 'font'   && size > 0 && size <= _fontMaxBytes));

        if (!willRead) {
            var capped = (cat === 'img' || cat === 'doc'
                          || cat === 'sheet' || cat === 'ebook' || cat === 'font');
            loadMeta(path, (capped && size > 0) ? 'This file is larger than the preview limit.' : '');
            return;
        }

        doOpen(cat, size, name, ext, path);
    }

    // ---- filter, refresh and keyboard ----------------------------------------

    function clearFilter() {
        if (_filterEl && _filterEl.value !== '') _filterEl.value = '';
    }

    // hides list rows whose name does not contain the query. the parent row stays
    function applyFilter() {
        if (!_filterEl) return;
        var q = _filterEl.value.trim().toLowerCase();
        var items = _listEl.querySelectorAll('.fv-item');
        var shown = 0, total = 0;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.classList.contains('fv-item--up')) continue;
            total++;
            var name = (it.getAttribute('data-name') || '').toLowerCase();
            var match = (q === '' || name.indexOf(q) !== -1);
            it.style.display = match ? '' : 'none';
            if (match) shown++;
        }
        if (_countEl) {
            var trunc = (_listEl.getAttribute('data-trunc') === '1');
            _countEl.textContent = (q === '')
                ? (total ? (total + (trunc ? '+' : '') + ' items') : '')
                : (shown + ' of ' + total);
        }
    }

    function visibleItems() {
        return Array.prototype.filter.call(_listEl.querySelectorAll('.fv-item'), function (el) {
            return el.style.display !== 'none';
        });
    }
    function kbdIndex(items) {
        for (var i = 0; i < items.length; i++) if (items[i].classList.contains('kbd')) return i;
        return -1;
    }
    function setKbd(items, idx) {
        for (var i = 0; i < items.length; i++) items[i].classList.toggle('kbd', i === idx);
        if (idx >= 0 && items[idx] && items[idx].scrollIntoView) items[idx].scrollIntoView({ block: 'nearest' });
    }
    function onKey(e) {
        if (!_listEl) return;
        var tag = e.target && e.target.tagName;
        var inFilter = (e.target === _filterEl);
        if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !inFilter) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            var items = visibleItems();
            if (!items.length) return;
            e.preventDefault();
            var i = kbdIndex(items);
            i = (e.key === 'ArrowDown')
                ? ((i < 0) ? 0 : Math.min(items.length - 1, i + 1))
                : ((i < 0) ? 0 : Math.max(0, i - 1));
            setKbd(items, i);
        } else if (e.key === 'Enter') {
            var its = visibleItems();
            var f = kbdIndex(its);
            var target = (f >= 0) ? its[f] : null;
            if (!target) {
                for (var k = 0; k < its.length; k++) {
                    if (!its[k].classList.contains('fv-item--up')) { target = its[k]; break; }
                }
            }
            if (target) {
                e.preventDefault();
                if (target.getAttribute('data-dir') === '1') loadDir(target.getAttribute('data-path'));
                else openFile(target);
            }
        } else if (e.key === 'Escape') {
            if (_filterEl && _filterEl.value !== '') { clearFilter(); applyFilter(); }
        }
    }

    function onListClick(ev) {
        if (ev.target.closest && ev.target.closest('.fv-item__cb')) return;   // checkbox toggles itself
        var item = ev.target.closest ? ev.target.closest('.fv-item') : null;
        if (!item) return;
        if (item.getAttribute('data-dir') === '1') { loadDir(item.getAttribute('data-path')); return; }
        openFile(item);
    }

    function onCrumbClick(ev) {
        var a = ev.target.closest ? ev.target.closest('a.fv-crumb') : null;
        if (!a) return;
        ev.preventDefault();
        loadDir(a.getAttribute('data-path') || '');
    }

    // ---- list selection (checkboxes) -----------------------------------------
    // the toolbar file ops act on the ticked rows, not on what is previewed. a
    // new listing clears the selection (renderList resets _selected).

    function selectedPaths() { return Object.keys(_selected); }
    function selCount() { return selectedPaths().length; }

    // the lone ticked row is a file (a folder cannot be downloaded)
    function singleSelectedFile() {
        var p = selectedPaths();
        if (p.length !== 1) return false;
        var row = findRow(p[0]);
        return !!row && row.getAttribute('data-dir') === '0';
    }

    // enablement rules:
    //  - download is read-only: a previewed file or a single ticked file, in either mode
    //  - rename/move/copy/owner/permission/delete are writes: edit mode + a ticked selection
    //  - create/upload add to the folder: edit mode, inside a folder, with no file open
    function updateOps() {
        var n = selCount();
        var hasPv = !!(_previewFile && _previewFile.path);
        var w = _editMode;
        if (_dlBtn)     _dlBtn.disabled     = !(hasPv || singleSelectedFile());
        if (_renameBtn) _renameBtn.disabled = !(w && n === 1);
        if (_deleteBtn) _deleteBtn.disabled = !(w && n >= 1);
        if (_ownerBtn)  _ownerBtn.disabled  = !(w && n >= 1);
        if (_permBtn)   _permBtn.disabled   = !(w && n >= 1);
        if (_copyBtn)   _copyBtn.disabled   = !(w && n >= 1);
        if (_moveBtn)   _moveBtn.disabled   = !(w && n >= 1);
        var add = w && _inFolder && !hasPv;
        if (_createBtn) _createBtn.disabled = !add;
        if (_uploadBtn) _uploadBtn.disabled = !add;
        if (_recycleBtn) _recycleBtn.disabled = !w;
        if (_spaceBtn) _spaceBtn.disabled = !_inFolder;   // read only, works in either mode
    }

    // header toggle: preview only vs editing allowed. switching drops the selection
    // so no hidden ticks survive, and the icon flips between an eye and a pencil
    function setMode(edit) {
        _editMode = !!edit;
        if (_rootEl) _rootEl.classList.toggle('fv-edit', _editMode);
        var mb = document.getElementById('fv-mode');
        if (mb) {
            var ic = mb.querySelector('i');
            if (ic) ic.className = 'fa fa-fw ' + (_editMode ? 'fa-pencil' : 'fa-eye');
            mb.title = _editMode ? 'Editing on - click for preview only' : 'Preview only - click to allow editing';
        }
        _selected = {};
        if (_listEl) {
            var cbs = _listEl.querySelectorAll('.fv-rowcb');
            for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
        }
        updateSelUi();
        refreshEditBtn();
    }

    // paint the ticked rows, sync the header checkbox and the count, refresh ops
    function updateSelUi() {
        var rows = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('selected', !!_selected[rows[i].getAttribute('data-path')]);
        }
        var total = _listEl.querySelectorAll('.fv-rowcb').length;
        var n = selCount();
        var all = document.getElementById('fv-selall');
        if (all) { all.checked = (n > 0 && n === total); all.indeterminate = (n > 0 && n < total); }
        var lbl = document.getElementById('fv-sel-count');
        if (lbl) lbl.textContent = n > 0 ? (n + ' selected') : (total + (total === 1 ? ' item' : ' items'));
        updateOps();
    }

    // delegated: the header select-all, or one row checkbox
    function onListChange(ev) {
        var t = ev.target;
        if (!t) return;
        if (t.id === 'fv-selall') {
            var on = t.checked, cbs = _listEl.querySelectorAll('.fv-rowcb');
            _selected = {};
            for (var i = 0; i < cbs.length; i++) {
                cbs[i].checked = on;
                if (on) { var r = cbs[i].closest('.fv-item'); if (r) _selected[r.getAttribute('data-path')] = true; }
            }
            updateSelUi();
            return;
        }
        if (t.classList && t.classList.contains('fv-rowcb')) {
            var row = t.closest('.fv-item');
            if (!row) return;
            var p = row.getAttribute('data-path');
            if (t.checked) _selected[p] = true; else delete _selected[p];
            updateSelUi();
        }
    }

    // ---- modal dialogs --------------------------------------------------------
    // one small overlay built on demand, shared by create, rename and delete.
    // esc cancels, enter confirms, a click on the backdrop cancels. it carries
    // the light-theme class itself since it lives on the body, outside the wrapper.

    var _modal = null;

    function modalClose() {
        if (_modal && _modal.parentNode) _modal.parentNode.removeChild(_modal);
        _modal = null;
        document.removeEventListener('keydown', modalKey, true);
    }
    function modalKey(e) {
        if (!_modal) return;
        if (e.key === 'Escape') { e.preventDefault(); modalClose(); return; }
        if (e.key === 'Enter') {
            if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
            var ok = _modal.querySelector('.fv-modal__ok');
            if (ok && !ok.disabled) { e.preventDefault(); ok.click(); }
        }
    }
    // build the shell, wire cancel and backdrop, run onOk(overlay) on confirm.
    // returns the overlay so the caller can read its inputs.
    function modalOpen(title, inner, okLabel, okClass, onOk, okOnly) {
        modalClose();
        var ov = document.createElement('div');
        ov.className = 'fv-modal' + (_cfg.lightTheme ? ' fv-light' : '');
        ov.innerHTML =
            '<div class="fv-modal__panel" role="dialog" aria-modal="true">' +
              '<div class="fv-modal__head">' + esc(title) + '</div>' +
              '<div class="fv-modal__body">' + inner + '</div>' +
              '<div class="fv-modal__foot">' +
                (okOnly ? '' : '<button type="button" class="fv-btn fv-modal__cancel">Cancel</button>') +
                '<button type="button" class="fv-btn ' + (okClass || 'fv-btn--primary') + ' fv-modal__ok">' + esc(okLabel || 'OK') + '</button>' +
              '</div>' +
            '</div>';
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) modalClose(); });
        var cancel = ov.querySelector('.fv-modal__cancel');
        if (cancel) cancel.addEventListener('click', modalClose);
        ov.querySelector('.fv-modal__ok').addEventListener('click', function () { onOk(ov); });
        document.body.appendChild(ov);
        _modal = ov;
        document.addEventListener('keydown', modalKey, true);
        return ov;
    }
    // a one-button message, used to report partial failures
    function noteModal(title, html) {
        modalOpen(title, html, 'Close', 'fv-btn--primary', function () { modalClose(); }, true);
    }
    function modalError(ov, msg) {
        var e = ov.querySelector('.fv-modal__err');
        if (e) { e.textContent = msg || ''; e.style.display = msg ? '' : 'none'; }
    }
    function modalBusy(ov, on) {
        var ok = ov.querySelector('.fv-modal__ok');
        if (ok) ok.disabled = !!on;
    }

    // ---- file operations (phase 1) -------------------------------------------

    function baseName(p) {
        var s = String(p || '').replace(/\/+$/, '');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }
    function findRow(path) {
        var items = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < items.length; i++) {
            if (items[i].getAttribute('data-path') === path) return items[i];
        }
        return null;
    }
    function opMsg(label, d) { return (d && d.error) ? (label + ': ' + d.error) : (label + ' failed.'); }

    // reload the open folder, then highlight an item by path if asked
    function refreshAfter(selectPath) {
        return loadDir(_currentPath).then(function () {
            if (!selectPath) return;
            var row = findRow(selectPath);
            if (row) { row.classList.add('active'); if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' }); }
        });
    }

    // create a file or folder in the folder currently open
    function promptCreate() {
        if (!_currentPath) return;
        var inner =
            '<label class="fv-field"><span>Name</span>' +
              '<input type="text" class="fv-input" id="fv-new-name" autocomplete="off" spellcheck="false" placeholder="new-file.txt"></label>' +
            '<div class="fv-radio">' +
              '<label><input type="radio" name="fv-kind" value="file" checked> File</label>' +
              '<label><input type="radio" name="fv-kind" value="dir"> Folder</label>' +
            '</div>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen('Create in this folder', inner, 'Create', 'fv-btn--primary', function (ov) {
            var name = (ov.querySelector('#fv-new-name').value || '').trim();
            var kind = ov.querySelector('input[name="fv-kind"]:checked').value;
            if (!name) { modalError(ov, 'Enter a name.'); return; }
            modalBusy(ov, true);
            postJson('create', { parent: _currentPath, name: name, kind: kind }).then(function (d) {
                if (!d || !d.ok) { modalBusy(ov, false); modalError(ov, opMsg('Create', d)); return; }
                modalClose();
                refreshAfter(d.path);
            });
        });
        ov.querySelector('#fv-new-name').focus();
    }

    // rename the single ticked item (file or folder)
    function promptRename() {
        var paths = selectedPaths();
        if (paths.length !== 1) return;
        var target = paths[0], cur = baseName(target);
        var inner =
            '<label class="fv-field"><span>New name</span>' +
              '<input type="text" class="fv-input" id="fv-rn-name" autocomplete="off" spellcheck="false"></label>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen('Rename', inner, 'Rename', 'fv-btn--primary', function (ov) {
            var name = (ov.querySelector('#fv-rn-name').value || '').trim();
            if (!name) { modalError(ov, 'Enter a name.'); return; }
            if (name === cur) { modalClose(); return; }
            modalBusy(ov, true);
            postJson('rename', { path: target, name: name }).then(function (d) {
                if (!d || !d.ok) { modalBusy(ov, false); modalError(ov, opMsg('Rename', d)); return; }
                modalClose();
                refreshAfter(d.path);
            });
        });
        var inp = ov.querySelector('#fv-rn-name');
        inp.value = cur;
        var dot = cur.lastIndexOf('.');
        inp.focus();
        if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();   // skip the extension, like a desktop fm
    }

    // permanent delete of the ticked set, behind a confirm. items go one by one
    // through the single-path endpoint; the bulk/background path is phase 4. the
    // trash mode rides on the same call once the recycle bin exists.
    function promptDelete() {
        var paths = selectedPaths();
        if (!paths.length) return;
        var inner =
            '<p class="fv-confirm">' + (_recycleOn
                ? (paths.length === 1
                    ? 'Move <b>' + esc(baseName(paths[0])) + '</b> to the Recycle Bin?'
                    : 'Move <b>' + paths.length + ' items</b> to the Recycle Bin?')
                : ((paths.length === 1
                    ? 'Permanently delete <b>' + esc(baseName(paths[0])) + '</b>?'
                    : 'Permanently delete <b>' + paths.length + ' items</b>?') +
                   ' This cannot be undone.')) +
            '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        modalOpen('Delete', inner, 'Delete', 'fv-btn--danger', function (ov) {
            modalBusy(ov, true);
            postJson('delete', { paths: JSON.stringify(paths), mode: _recycleOn ? 'trash' : 'permanent' }).then(function (d) {
                modalClose();
                clearPreview();
                refreshAfter(null).then(function () {
                    var failed = (d && d.failed) || [];
                    if (!d || !d.ok) {
                        noteModal('Delete', '<p class="fv-confirm">' + esc((d && d.error) || 'Delete failed.') + '</p>');
                    } else if (failed.length) {
                        noteModal('Delete', '<p class="fv-confirm">Some items were not deleted:</p>' +
                            '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + failed.map(esc).join('<br>') + '</p>');
                    }
                });
            });
        });
    }

    // ---- upload (phase 5) -----------------------------------------------------
    // upload into the current folder, one file at a time, each split into chunks
    // so a large file never hits a php size limit. each chunk is base64 encoded and
    // sent in a normal form post (the same transport the rest of the webgui and the
    // official file manager use), which is reliable through unraid's nginx and fpm.
    // progress is per file plus an overall count; cancel aborts the chunk in flight
    // and drops the half-staged file.

    var UPLOAD_CHUNK = 1024 * 1024;   // 1 MiB raw per chunk (base64 grows it ~1.4x)
    var UPLOAD_PARALLEL = 4;          // files uploaded at once - under the browser's 6-conn cap, leaves room for the rest of the gui

    function uid12() {
        var c = '0123456789abcdefghijklmnopqrstuvwxyz', s = '';
        for (var i = 0; i < 12; i++) s += c[Math.floor(Math.random() * 36)];
        return s;
    }

    // ---- upload (lives in the preview pane, no popup) ------------------------
    // pick or drop files, or a whole folder, then a small pool uploads several
    // files at once, each with its own bar. a file is sent in base64 chunks over a
    // plain form post (the transport the official file manager uses), which is
    // reliable through unraid's nginx and fpm. folder uploads carry a relative
    // subpath the server recreates under the destination.

    var _uploadMode = false;     // the preview pane is showing the uploader
    var _upQueue = [];           // queued items: { file, name, subpath }
    var _upBusy = false;         // an upload run is in progress
    var _upActive = null;        // running run, exposes kill() so closing the pane stops it

    function resetUpload() {
        if (_upActive) { _upActive.kill(); _upActive = null; }
        _uploadMode = false; _upBusy = false; _upQueue = [];
    }

    function upLabelHtml(it) {
        return (it.subpath ? '<i>' + esc(it.subpath) + '/</i>' : '') + esc(it.name);
    }

    function enterUploadMode() {
        if (!_currentPath) return;             // the roots view has no target folder
        if (!leaveEditOk()) return;
        resetPaneModes();
        _uploadMode = true;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        renderPathCrumbs(null);
        markActive(null);
        _selectedFile = null; _previewFile = null;
        if (_pvToolsEl) _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        renderUploadIdle();
    }

    function renderUploadIdle() {
        _bodyEl.innerHTML =
            '<div class="fv-uppanel">' +
              '<div class="fv-uppanel__title">Upload to <span>' + esc(baseName(_currentPath || '/')) + '</span></div>' +
              '<div class="fv-up2-drop" id="fv-up-drop">' +
                '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13v8"/><path d="M8 17l4-4 4 4"/><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 14.9"/></svg>' +
                '<p>Drop files or a folder here</p>' +
                '<div class="fv-up2-pickers">' +
                  '<button type="button" class="fv-btn" id="fv-up-pick">Choose files</button>' +
                  '<button type="button" class="fv-btn" id="fv-up-pickdir">Choose folder</button>' +
                '</div>' +
                '<input type="file" id="fv-up-input" multiple style="display:none">' +
                '<input type="file" id="fv-up-inputdir" webkitdirectory style="display:none">' +
              '</div>' +
              '<div class="fv-up2-list" id="fv-up-list"></div>' +
              '<label class="fv-check"><input type="checkbox" id="fv-up-over"> Overwrite files with the same name</label>' +
              '<div class="fv-up2-actions">' +
                '<button type="button" class="fv-btn" id="fv-up-cancel">Cancel</button>' +
                '<button type="button" class="fv-btn fv-btn--primary" id="fv-up-go" disabled>Upload</button>' +
              '</div>' +
            '</div>';

        var list = _bodyEl.querySelector('#fv-up-list');
        var go   = _bodyEl.querySelector('#fv-up-go');

        function renderQueue() {
            list.innerHTML = _upQueue.map(function (it, i) {
                return '<div class="fv-up2-row">' +
                         '<button type="button" class="fv-up2-del" data-i="' + i + '" title="Remove" aria-label="Remove">\u00d7</button>' +
                         '<span class="fv-up2-name">' + upLabelHtml(it) + '</span>' +
                         '<span class="fv-up2-size">' + fmtBytes(it.file.size) + '</span>' +
                       '</div>';
            }).join('');
            go.disabled = !_upQueue.length;
            go.textContent = _upQueue.length ? ('Upload ' + _upQueue.length + (_upQueue.length === 1 ? ' file' : ' files')) : 'Upload';
        }
        function pushPlain(fileList) {
            for (var i = 0; i < fileList.length; i++) _upQueue.push({ file: fileList[i], name: fileList[i].name, subpath: '' });
            renderQueue();
        }
        function pushFolder(fileList) {
            for (var i = 0; i < fileList.length; i++) {
                var f = fileList[i];
                var rp = (f.webkitRelativePath || f.name).split('/');
                var nm = rp.pop();
                _upQueue.push({ file: f, name: nm, subpath: rp.join('/') });
            }
            renderQueue();
        }

        list.addEventListener('click', function (e) {
            var b = e.target;
            if (!b.classList || !b.classList.contains('fv-up2-del')) return;
            var i = parseInt(b.getAttribute('data-i'), 10);
            if (i >= 0 && i < _upQueue.length) { _upQueue.splice(i, 1); renderQueue(); }
        });
        _bodyEl.querySelector('#fv-up-pick').addEventListener('click', function () { _bodyEl.querySelector('#fv-up-input').click(); });
        _bodyEl.querySelector('#fv-up-pickdir').addEventListener('click', function () { _bodyEl.querySelector('#fv-up-inputdir').click(); });
        _bodyEl.querySelector('#fv-up-input').addEventListener('change', function (e) { pushPlain(e.target.files); e.target.value = ''; });
        _bodyEl.querySelector('#fv-up-inputdir').addEventListener('change', function (e) { pushFolder(e.target.files); e.target.value = ''; });
        _bodyEl.querySelector('#fv-up-cancel').addEventListener('click', function () { clearPreview(); });
        go.addEventListener('click', function () {
            if (!_upQueue.length) return;
            var conflict = _bodyEl.querySelector('#fv-up-over').checked ? 'overwrite' : 'rename';
            startPanelUpload(_upQueue.slice(), conflict);
        });

        var drop = _bodyEl.querySelector('#fv-up-drop');
        ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('fv-up2-drop--on'); }); });
        ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('fv-up2-drop--on'); }); });
        drop.addEventListener('drop', function (e) {
            var dt = e.dataTransfer; if (!dt) return;
            var its = dt.items;
            if (its && its.length && its[0] && its[0].webkitGetAsEntry) {
                var entries = [];
                for (var i = 0; i < its.length; i++) { var en = its[i].webkitGetAsEntry(); if (en) entries.push(en); }
                var pending = entries.length, out = [];
                if (!pending) return;
                entries.forEach(function (en) {
                    walkEntry(en, '', out, function () {
                        if (--pending === 0) { out.forEach(function (it) { _upQueue.push(it); }); renderQueue(); }
                    });
                });
            } else if (dt.files) {
                pushPlain(dt.files);
            }
        });

        renderQueue();
    }

    // recursively collect { file, name, subpath } from a dropped file/dir entry
    function walkEntry(entry, prefix, out, after) {
        if (entry.isFile) {
            entry.file(function (f) { out.push({ file: f, name: f.name, subpath: prefix }); after(); }, after);
        } else if (entry.isDirectory) {
            var here = prefix ? prefix + '/' + entry.name : entry.name;
            var reader = entry.createReader(), all = [];
            (function readMore() {
                reader.readEntries(function (ents) {
                    if (!ents.length) {
                        var i = 0;
                        (function next() { if (i >= all.length) { after(); return; } walkEntry(all[i++], here, out, next); })();
                    } else { all = all.concat(Array.prototype.slice.call(ents)); readMore(); }
                }, after);
            })();
        } else { after(); }
    }

    // run the queue with a small pool: workers each own a bar; when a worker's file
    // finishes, the same bar shows the next queued file (cpanel style)
    function startPanelUpload(items, conflict) {
        _upBusy = true;
        var total = items.length, totalBytes = 0;
        items.forEach(function (it) { totalBytes += it.file.size; });
        var qi = 0, done = 0, completedBytes = 0, failed = [], cancelled = false, finished = false, killed = false;
        var workers = Math.min(UPLOAD_PARALLEL, total) || 1;
        var activeWorkers = workers;
        var live = {};               // worker id -> bytes sent for its current file
        var controls = {};           // worker id -> abort control

        _upActive = { kill: function () { killed = true; cancelled = true; for (var k in controls) { if (controls[k] && controls[k].abort) controls[k].abort(); } } };

        _bodyEl.innerHTML =
            '<div class="fv-uppanel">' +
              '<div class="fv-up2-overall"><span id="fv-up-done"></span><span class="sub" id="fv-up-bytes"></span></div>' +
              '<div class="fv-up2-slots" id="fv-up-slots"></div>' +
              '<div class="fv-up2-actions"><button type="button" class="fv-btn fv-btn--danger" id="fv-up-stop">Cancel</button></div>' +
            '</div>';
        var slotsEl = _bodyEl.querySelector('#fv-up-slots');
        var doneEl  = _bodyEl.querySelector('#fv-up-done');
        var bytesEl = _bodyEl.querySelector('#fv-up-bytes');
        var stopBtn = _bodyEl.querySelector('#fv-up-stop');

        stopBtn.addEventListener('click', function () {
            if (finished) { clearPreview(); return; }
            cancelled = true; stopBtn.disabled = true; stopBtn.textContent = 'Cancelling\u2026';
            for (var k in controls) { if (controls[k] && controls[k].abort) controls[k].abort(); }
        });

        function renderOverall() {
            if (killed) return;
            var sent = completedBytes; for (var k in live) sent += live[k];
            if (sent > totalBytes) sent = totalBytes;
            doneEl.innerHTML = '<b>' + done + '</b> of ' + total + (total === 1 ? ' file' : ' files') + ' done';
            bytesEl.textContent = fmtBytes(sent) + ' of ' + fmtBytes(totalBytes) + ' \u00b7 ' + workers + ' at once';
        }
        function makeSlot() {
            var el = document.createElement('div');
            el.className = 'fv-up2-item';
            el.innerHTML = '<div class="fv-up2-item__top"><span class="fv-up2-item__name"></span><span class="fv-up2-item__pct">0%</span></div>' +
                           '<div class="fv-up2-bar"><div class="fv-up2-fill"></div></div>';
            slotsEl.appendChild(el);
            return { el: el, name: el.querySelector('.fv-up2-item__name'), pct: el.querySelector('.fv-up2-item__pct'), fill: el.querySelector('.fv-up2-fill') };
        }
        function finish() {
            if (finished || killed) return; finished = true; _upActive = null; _upBusy = false;
            loadDir(_currentPath);          // refresh the listing now; this clears the preview synchronously
            var msg = cancelled ? ('Upload cancelled' + (done ? (' \u2014 ' + (total - failed.length) + ' of ' + total + ' uploaded') : '') + '.')
                    : (failed.length === total ? 'Upload failed.' : ('Done \u2014 ' + (total - failed.length) + ' of ' + total + (total === 1 ? ' file' : ' files') + ' uploaded.'));
            var extra = failed.length ? '<div class="fv-up2-failed">Failed:<br>' + failed.map(esc).join('<br>') + '</div>' : '';
            _bodyEl.innerHTML =
                '<div class="fv-uppanel">' +
                  '<div class="fv-up2-msg">' + esc(msg) + '</div>' + extra +
                  '<div class="fv-up2-actions"><button type="button" class="fv-btn fv-btn--primary" id="fv-up-close">Close</button></div>' +
                '</div>';
            var cb = _bodyEl.querySelector('#fv-up-close');
            if (cb) cb.addEventListener('click', function () { clearPreview(); });
        }
        function runWorker(slot, wid) {
            if (cancelled || qi >= items.length) {
                if (slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
                delete live[wid];
                activeWorkers--;
                if (activeWorkers <= 0) finish();
                return;
            }
            var it = items[qi++];
            slot.name.innerHTML = upLabelHtml(it);
            slot.pct.textContent = '0%'; slot.fill.style.width = '0%';
            live[wid] = 0;
            var control = {}; controls[wid] = control;
            sendOneFile(it, conflict, control,
                function (offset) {
                    live[wid] = offset;
                    var p = it.file.size ? Math.round(offset / it.file.size * 100) : 100;
                    slot.pct.textContent = p + '%'; slot.fill.style.width = p + '%';
                    renderOverall();
                },
                function (ok, err) {
                    done++; completedBytes += it.file.size; live[wid] = 0; delete controls[wid];
                    if (!ok && !cancelled) failed.push((it.subpath ? it.subpath + '/' : '') + it.name + (err ? ' - ' + err : ''));
                    renderOverall();
                    runWorker(slot, wid);
                });
        }

        renderOverall();
        for (var w = 0; w < workers; w++) runWorker(makeSlot(), w);
    }

    function sendOneFile(it, conflict, control, onProg, onDone) {
        var file = it.file, offset = 0, aborter = null, stopped = false;
        var uid = uid12();
        control.abort = function () { stopped = true; if (aborter) aborter.abort(); };

        function step() {
            var end = Math.min(offset + UPLOAD_CHUNK, file.size);
            var last = end >= file.size;
            var reader = new FileReader();
            reader.onerror = function () { if (!stopped) onDone(false, 'read error'); };
            reader.onloadend = function (e) {
                if (stopped) return;
                if (!e.target || e.target.readyState !== FileReader.DONE) return;
                var b64; try { b64 = btoa(e.target.result); } catch (err) { onDone(false, 'encode error'); return; }
                var body = 'csrf_token=' + encodeURIComponent(csrfToken()) +
                           '&uid=' + encodeURIComponent(uid) +
                           '&dest=' + encodeURIComponent(_currentPath) +
                           '&subpath=' + encodeURIComponent(it.subpath || '') +
                           '&name=' + encodeURIComponent(it.name) +
                           '&offset=' + offset +
                           '&total=' + file.size +
                           '&conflict=' + encodeURIComponent(conflict) +
                           (last ? '&last=1' : '') +
                           '&data=' + encodeURIComponent(b64);
                aborter = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                fetch(apiUrl('upload', ''), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
                    credentials: 'same-origin',
                    body: body,
                    signal: aborter ? aborter.signal : undefined
                }).then(function (r) {
                    return r.text().then(function (t) {
                        try { return JSON.parse(t); }
                        catch (e2) { return { ok: false, error: (t && t.trim()) ? ('server: ' + t.replace(/\s+/g, ' ').slice(0, 140)) : ('HTTP ' + r.status) }; }
                    });
                }).then(function (d) {
                    if (!d || !d.ok) { onDone(false, (d && d.error) || 'failed'); return; }
                    offset = end; onProg(offset);
                    if (last) onDone(true); else step();
                }).catch(function (e) {
                    onDone(false, (e && e.name === 'AbortError') ? 'cancelled' : 'network error');
                });
            };
            reader.readAsBinaryString(file.slice(offset, end));
        }
        step();
    }

    // ---- space usage view (phase 7) -------------------------------------------
    // ranks what a folder holds by allocated disk space. the scan runs as a
    // detached worker job started with space_start; the pane polls job_status and
    // can cancel it. clicking a folder row drills in: navigate there, scan again.

    var _spaceMode = false;
    var _spJobId = '';
    var _spTimer = null;
    var _spPath = '';
    var _spCancelling = false;

    function resetSpace() {
        if (_spTimer) { clearInterval(_spTimer); _spTimer = null; }
        if (_spaceMode && _spJobId) postJson('job_cancel', { id: _spJobId });   // stop a running walk quietly
        _spaceMode = false; _spJobId = ''; _spCancelling = false;
    }

    // the pane modes are exclusive: entering one always clears the others
    function resetPaneModes() { resetUpload(); resetRecycle(); resetSpace(); }

    function enterSpaceMode() {
        if (!_currentPath) return;
        if (!leaveEditOk()) return;
        startSpaceScan(_currentPath, true);
    }

    function startSpaceScan(path, takeover) {
        resetPaneModes();
        _spaceMode = true;
        _spPath = path;
        _spCancelling = false;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        if (takeover) {
            renderPathCrumbs(null);
            markActive(null);
            _selectedFile = null; _previewFile = null;
            if (_pvToolsEl) _pvToolsEl.innerHTML = '';
            setFileTools(false, false);
        }
        _bodyEl.innerHTML = '<div class="fv-sppanel">' + spHead('') + '<div class="fv-sp-line">Starting the scan\u2026</div></div>';
        postJson('space_start', { path: path }).then(function (d) {
            if (!_spaceMode) return;
            if (!d || !d.ok) { renderSpaceError((d && d.error) || 'failed'); return; }
            _spJobId = d.id;
            _spTimer = setInterval(pollSpace, 500);
            pollSpace();
        });
    }

    function pollSpace() {
        if (!_spaceMode || !_spJobId) return;
        fetchJson('job_status', 'id=' + encodeURIComponent(_spJobId)).then(function (d) {
            if (!_spaceMode || !_spJobId) return;
            var st = d && d.status;
            if (!d || !d.ok || !st) { stopSpacePoll(); renderSpaceError((d && d.error) || 'job lost'); return; }
            if (st.state === 'running' || st.state === 'queued') { renderSpaceProgress(st); return; }
            stopSpacePoll();
            if (st.state === 'done') renderSpaceResult(st);
            else if (st.state === 'cancelled') renderSpaceCancelled();
            else renderSpaceError(st.message || 'scan failed');
        }).catch(function () {});   // transient poll errors: just try again on the next tick
    }

    function stopSpacePoll() {
        if (_spTimer) { clearInterval(_spTimer); _spTimer = null; }
        _spJobId = '';
    }

    function spHead(btnHtml) {
        return '<div class="fv-sp-top"><div class="fv-sp-title">Space usage <span>\u00b7 ' + esc(baseName(_spPath || '/')) + '</span></div>' + btnHtml + '</div>';
    }

    function spBindRescan() {
        var rb = _bodyEl.querySelector('#fv-sp-rescan');
        if (rb) rb.addEventListener('click', function () { startSpaceScan(_spPath, false); });
    }

    function renderSpaceProgress(st) {
        var tot = st.children_total || 0, done = st.children_done || 0;
        var pct = tot > 0 ? Math.min(100, Math.round(done / tot * 100)) : 0;
        var line = 'Scanning\u2026 ' + done + ' of ' + tot + ' items \u00b7 ' +
                   fmtBytes(st.bytes || 0) + ' so far \u00b7 ' + (st.files || 0).toLocaleString() + ' files' +
                   (st.current ? ' \u00b7 current: ' + esc(st.current) : '');
        _bodyEl.innerHTML = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn fv-btn--danger" id="fv-sp-cancel"' + (_spCancelling ? ' disabled' : '') + '>' + (_spCancelling ? 'Cancelling\u2026' : 'Cancel') + '</button>') +
            '<div class="fv-sp-bar"><div class="fv-sp-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="fv-sp-line">' + line + '</div></div>';
        var cb = _bodyEl.querySelector('#fv-sp-cancel');
        if (cb) cb.addEventListener('click', function () {
            _spCancelling = true;
            cb.disabled = true; cb.textContent = 'Cancelling\u2026';
            if (_spJobId) postJson('job_cancel', { id: _spJobId });
        });
    }

    function renderSpaceResult(st) {
        var kids = st.children || [];
        var total = st.bytes || 0;
        var max = 0;
        kids.forEach(function (c) { if ((c.bytes || 0) > max) max = c.bytes; });

        var html = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn" id="fv-sp-rescan">Rescan</button>') +
            '<div class="fv-sp-note">Click a folder to open and analyse it. Hard linked files are counted once. Sizes are allocated space on disk.</div>' +
            '<div class="fv-sp-sum"><b>' + fmtBytes(total) + '</b> in ' + (st.files || 0).toLocaleString() + ' files \u00b7 scanned in ' + (st.elapsed != null ? st.elapsed : '?') + 's' +
            ((st.skipped || 0) > 0 ? ' \u00b7 <span class="fv-sp-warn">' + st.skipped + ' unreadable</span>' : '') + '</div>';

        if (!kids.length) {
            html += '<div class="fv-sp-line">This folder is empty.</div>';
        } else {
            html += '<div class="fv-sp-rows">';
            kids.forEach(function (c) {
                var others = (c.name == null);
                var w = max > 0 ? Math.round((c.bytes || 0) / max * 100) : 0;
                var pct = total > 0 ? (c.bytes || 0) / total * 100 : 0;
                var pctTxt = pct >= 1 ? Math.round(pct) + '%' : ((c.bytes || 0) > 0 ? '&lt;1%' : '0%');
                var dim = others || (c.name && c.name.charAt(0) === '.');
                var glyph = others ? '' : (c.is_dir ? RB_FOLDER_SVG : RB_FILE_SVG);
                var label = others ? ('Others \u00b7 ' + c.others + ' items') : esc(c.name);
                html += '<div class="fv-sp-row' + (dim ? ' fv-sp-row--dim' : '') + (!others && c.is_dir ? ' fv-sp-row--dir' : '') + '"' +
                        (!others && c.is_dir ? ' data-dir="' + esc(c.name) + '"' : '') + '>' +
                        (w > 0 ? '<i class="fv-sp-rowfill" style="width:' + w + '%"></i>' : '') +
                        '<span class="fv-sp-glyph">' + glyph + '</span>' +
                        '<span class="fv-sp-name">' + label + '</span>' +
                        '<span class="fv-sp-size">' + fmtBytes(c.bytes || 0) + '</span>' +
                        '<span class="fv-sp-pct">' + pctTxt + '</span>' +
                        '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        spBindRescan();
        _bodyEl.querySelector('.fv-sppanel').addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.fv-sp-row--dir') : null;
            if (!row) return;
            var name = row.getAttribute('data-dir');
            if (!name) return;
            var p = _spPath.replace(/\/+$/, '') + '/' + name;
            loadDir(p);                    // navigate the list; this clears the pane
            startSpaceScan(p, false);      // then analyse the new folder
        });
    }

    function renderSpaceCancelled() {
        _bodyEl.innerHTML = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn" id="fv-sp-rescan">Rescan</button>') +
            '<div class="fv-sp-line">Scan cancelled.</div></div>';
        spBindRescan();
    }

    function renderSpaceError(msg) {
        _bodyEl.innerHTML = '<div class="fv-sppanel">' + spHead('') +
            '<div class="fv-sp-line fv-sp-warn">' + esc(msg) + '</div></div>';
    }

    // ---- recycle bin view (phase 6) -------------------------------------------
    // takes over the preview pane like the uploader. events list newest first,
    // each with restore and a permanent delete, plus an empty for the whole
    // scope and a this share / all shares toggle. opening quietly purges the
    // expired events first so the list never shows rows about to vanish.

    var _recycleMode = false;
    var _rbScope = 'share';

    function resetRecycle() { _recycleMode = false; }

    // a share scope needs at least /mnt/<top>/<share>
    function rbShareOk() {
        var parts = (_currentPath || '').split('/').filter(Boolean);
        return parts.length >= 3 && parts[0] === 'mnt';
    }

    function relTime(ts) {
        if (!ts) return '';
        var s = Math.floor(Date.now() / 1000) - ts;
        if (s < 60) return 'just now';
        var m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
        var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
        var d = Math.floor(h / 24); if (d === 1) return 'yesterday';
        if (d < 30) return d + ' days ago';
        return new Date(ts * 1000).toLocaleDateString();
    }

    var RB_FILE_SVG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
    var RB_FOLDER_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var RB_TRASH_SVG  = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';

    function enterRecycleMode() {
        if (!leaveEditOk()) return;
        resetPaneModes();
        _recycleMode = true;
        _rbScope = rbShareOk() ? 'share' : 'all';
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        renderPathCrumbs(null);
        markActive(null);
        _selectedFile = null; _previewFile = null;
        if (_pvToolsEl) _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        _bodyEl.innerHTML = '<div class="fv-rbpanel"><div class="fv-rb-loading">Loading the recycle bin\u2026</div></div>';
        postJson('recycle_purge', { mode: 'expired', scope: 'all' }).then(loadRecycle, loadRecycle);
    }

    function loadRecycle() {
        if (!_recycleMode) return;
        var extra = 'scope=' + encodeURIComponent(_rbScope);
        if (_rbScope === 'share') extra += '&path=' + encodeURIComponent(_currentPath || '');
        fetchJson('recycle_list', extra).then(function (d) {
            if (!_recycleMode) return;
            if (!d || !d.ok) { renderRecycleError((d && d.error) || 'failed'); return; }
            renderRecycle(d);
        }).catch(function () {
            if (_recycleMode) renderRecycleError('network error');
        });
    }

    function renderRecycleError(msg) {
        _bodyEl.innerHTML =
            '<div class="fv-rbpanel"><div class="fv-rb-empty">' + RB_TRASH_SVG +
            '<div class="h">Recycle Bin unavailable</div><div class="s">' + esc(msg) + '</div></div></div>';
    }

    // after a restore or a purge the folder listing may have changed too:
    // refresh it (which clears the pane), then take the pane back and re-list
    function rbAfterChange() {
        loadDir(_currentPath);
        _recycleMode = true;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        _bodyEl.innerHTML = '<div class="fv-rbpanel"><div class="fv-rb-loading">Working\u2026</div></div>';
        loadRecycle();
    }

    function renderRecycle(d) {
        var evs = d.events || [];
        var canShare = rbShareOk();
        var days = d.days || 30;
        var never = (days === 'never');

        var html = '<div class="fv-rbpanel">' +
            '<div class="fv-rb-top"><div class="fv-rb-title">Recycle Bin</div>' +
              '<div class="fv-rb-seg">' +
                '<button type="button" class="fv-rb-segbtn' + (_rbScope === 'share' ? ' fv-rb-segbtn--on' : '') + '" id="fv-rb-share"' + (canShare ? '' : ' disabled') + '>This share</button>' +
                '<button type="button" class="fv-rb-segbtn' + (_rbScope === 'all' ? ' fv-rb-segbtn--on' : '') + '" id="fv-rb-all">All shares</button>' +
              '</div></div>';
        if (d.enabled === false) {
            html += '<div class="fv-rb-note">The recycle bin is turned off in Settings. New deletes are permanent; items below can still be restored.</div>';
        }
        html += '<div class="fv-rb-policy">' + (never
            ? 'Items are kept until you empty the bin yourself.'
            : 'Items older than ' + days + ' days are emptied automatically.') + '</div>';

        if (!evs.length) {
            html += '<div class="fv-rb-empty">' + RB_TRASH_SVG +
                    '<div class="h">Recycle Bin is empty</div>' +
                    '<div class="s">' + (never
                        ? 'Deleted items appear here until you empty the bin.'
                        : 'Deleted items appear here for ' + days + ' days.') + '</div></div>';
        } else {
            var totalSize = 0, anyPartial = false;
            html += '<div class="fv-rb-list">';
            evs.forEach(function (ev, i) {
                totalSize += ev.size || 0;
                if (ev.size_partial) anyPartial = true;
                var chip = ev.count > 1 ? esc(String(ev.count)) : (ev.kind === 'dir' ? RB_FOLDER_SVG : RB_FILE_SVG);
                var names = (ev.names || []).map(esc).join(', ');
                if (ev.count > (ev.names || []).length) names += ' +' + (ev.count - ev.names.length) + ' more';
                var cnt = ev.count === 1 ? (ev.kind === 'dir' ? '1 folder' : '1 item') : ev.count + ' items';
                var sub = esc(ev.share || '') + ' \u00b7 ' + esc(relTime(ev.deleted_at)) + ' \u00b7 ' + cnt;
                if (!ev.size_partial && ev.size > 0) sub += ' \u00b7 ' + fmtBytes(ev.size);
                html += '<div class="fv-rb-ev">' +
                          '<div class="fv-rb-chip' + (ev.count > 1 ? ' fv-rb-chip--n' : '') + '">' + chip + '</div>' +
                          '<div class="fv-rb-main">' +
                            '<div class="fv-rb-name" title="' + esc((ev.names || []).join(', ')) + '">' + names + '</div>' +
                            '<div class="fv-rb-sub">' + sub + '</div>' +
                          '</div>' +
                          '<div class="fv-rb-act">' +
                            '<button type="button" class="fv-btn" data-rb="restore" data-i="' + i + '">Restore</button>' +
                            '<button type="button" class="fv-btn fv-btn--danger" data-rb="purge" data-i="' + i + '">Delete forever</button>' +
                          '</div>' +
                        '</div>';
            });
            html += '</div>';
            if (d.truncated) html += '<div class="fv-rb-note">Showing the newest 500 events only.</div>';
            html += '<div class="fv-rb-foot">' +
                      '<div class="fv-rb-cnt">' + evs.length + (evs.length === 1 ? ' event' : ' events') +
                        (totalSize > 0 ? ' \u00b7 ' + fmtBytes(totalSize) + (anyPartial ? '+' : '') : '') + '</div>' +
                      '<button type="button" class="fv-btn fv-btn--danger" id="fv-rb-empty">Empty Recycle Bin</button>' +
                    '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        var panel = _bodyEl.querySelector('.fv-rbpanel');
        panel.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!b || b.disabled) return;
            if (b.id === 'fv-rb-share') { if (_rbScope !== 'share') { _rbScope = 'share'; loadRecycle(); } return; }
            if (b.id === 'fv-rb-all')   { if (_rbScope !== 'all')   { _rbScope = 'all';   loadRecycle(); } return; }
            if (b.id === 'fv-rb-empty') { rbConfirmEmpty(evs.length); return; }
            var act = b.getAttribute('data-rb');
            if (!act) return;
            var ev = evs[parseInt(b.getAttribute('data-i'), 10)];
            if (!ev) return;
            if (act === 'restore') rbRestore(ev, b); else rbConfirmPurge(ev);
        });
    }

    function rbEventLabel(ev) {
        return ev.count === 1 ? esc((ev.names && ev.names[0]) || '1 item') : ev.count + ' items';
    }

    function rbRestore(ev, btn) {
        btn.disabled = true;
        btn.textContent = 'Restoring\u2026';
        postJson('recycle_restore', { event: ev.event }).then(function (d) {
            rbAfterChange();
            if (!d || !d.ok) {
                noteModal('Restore', '<p class="fv-confirm">' + esc((d && d.error) || 'Restore failed.') + '</p>');
            } else if (d.failed && d.failed.length) {
                noteModal('Restore', '<p class="fv-confirm">Some items were not restored:</p>' +
                    '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + d.failed.map(esc).join('<br>') + '</p>');
            }
        });
    }

    function rbConfirmPurge(ev) {
        modalOpen('Delete forever',
            '<p class="fv-confirm">Permanently delete <b>' + rbEventLabel(ev) + '</b> from the Recycle Bin? This cannot be undone.</p>' +
            '<div class="fv-modal__err" style="display:none"></div>',
            'Delete forever', 'fv-btn--danger', function (ov) {
                modalBusy(ov, true);
                postJson('recycle_purge', { mode: 'event', event: ev.event }).then(function (d) {
                    modalClose();
                    rbAfterChange();
                    if (!d || !d.ok) noteModal('Delete forever', '<p class="fv-confirm">' + esc((d && d.error) || 'Purge failed.') + '</p>');
                });
            });
    }

    function rbConfirmEmpty(n) {
        var where = _rbScope === 'share' ? 'this share' : 'all shares';
        modalOpen('Empty Recycle Bin',
            '<p class="fv-confirm">Permanently delete <b>' + n + (n === 1 ? ' event' : ' events') + '</b> from the Recycle Bin of ' + where + '? This cannot be undone.</p>' +
            '<div class="fv-modal__err" style="display:none"></div>',
            'Empty', 'fv-btn--danger', function (ov) {
                modalBusy(ov, true);
                var p = { mode: 'all', scope: _rbScope };
                if (_rbScope === 'share') p.path = _currentPath || '';
                postJson('recycle_purge', p).then(function (d) {
                    modalClose();
                    rbAfterChange();
                    if (!d || !d.ok) noteModal('Empty Recycle Bin', '<p class="fv-confirm">' + esc((d && d.error) || 'Purge failed.') + '</p>');
                });
            });
    }

    // ---- copy / move (phase 4) -----------------------------------------------
    // copy or move the ticked items into a folder chosen with a picker, then watch
    // a background job. a same-fs move is instant; copies and cross-fs moves stream
    // with a progress bar and can be cancelled.

    var UP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

    function fmtBytes(n) {
        n = Number(n) || 0;
        var u = ['B','KB','MB','GB','TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    function beginCopyMove(op) {
        var paths = selectedPaths();
        if (paths.length) openDestPicker(op, paths);
    }

    function openDestPicker(op, paths) {
        var label = (op === 'move' ? 'Move' : 'Copy');
        var cur = '', parent = null;
        var inner =
            '<div class="fv-pick">' +
              '<div class="fv-pick-bar"><button type="button" class="fv-pick-up" id="fv-pick-up" title="Up one folder">' + UP_SVG + '</button>' +
                '<span class="fv-pick-path" id="fv-pick-path"></span></div>' +
              '<div class="fv-pick-list" id="fv-pick-list"></div>' +
              '<label class="fv-field"><span>If a name exists</span>' +
                '<select class="fv-input" id="fv-pick-conf"><option value="rename">Keep both</option><option value="overwrite">Overwrite</option><option value="skip">Skip</option></select>' +
              '</label>' +
            '</div><div class="fv-modal__err" style="display:none"></div>';

        var ov = modalOpen(label + ' ' + paths.length + (paths.length > 1 ? ' items to' : ' item to'), inner,
            label + ' here', 'fv-btn--primary', function (ov) {
                if (!cur) return;
                modalBusy(ov, true);
                startCopyMove(op, paths, cur, ov.querySelector('#fv-pick-conf').value, false, ov);
            });

        function render(d) {
            cur = d.path; parent = d.parent || null;
            ov.querySelector('#fv-pick-path').textContent = d.path || '/';
            ov.querySelector('#fv-pick-up').disabled = (parent === null);
            var dirs = (d.entries || []).filter(function (e) { return e.is_dir; });
            ov.querySelector('#fv-pick-list').innerHTML = dirs.length
                ? dirs.map(function (e) { return '<button type="button" class="fv-pick-row" data-p="' + esc(e.path) + '"><span class="fv-pick-ico">' + FOLDER_SVG + '</span>' + esc(e.name) + '</button>'; }).join('')
                : '<div class="fv-pick-empty">No subfolders here</div>';
        }
        function load(p) {
            fetchJson('list', 'path=' + encodeURIComponent(p || '')).then(function (d) {
                if (!d || !d.ok) { modalError(ov, (d && d.error) || 'Cannot open folder.'); return; }
                render(d);
            });
        }
        ov.querySelector('#fv-pick-up').addEventListener('click', function () { if (parent !== null) load(parent); });
        ov.querySelector('#fv-pick-list').addEventListener('click', function (e) {
            var row = e.target.closest ? e.target.closest('.fv-pick-row') : null;
            if (row) load(row.getAttribute('data-p'));
        });
        load(_currentPath);
    }

    function startCopyMove(op, paths, dest, conflict, confirm, ov) {
        var body = { sources: JSON.stringify(paths), dest: dest, conflict: conflict };
        if (confirm) body.confirm = 1;
        postJson(op, body).then(function (d) {
            if (d && d.warn && !confirm) { confirmCrossMount(op, paths, dest, conflict, d.message); return; }
            if (!d || !d.ok) {
                var msg = (d && d.error) || 'Could not start.';
                if (ov) { modalError(ov, msg); modalBusy(ov, false); }
                else noteModal(op === 'move' ? 'Move' : 'Copy', '<p class="fv-confirm">' + esc(msg) + '</p>');
                return;
            }
            openProgress(op, d.job);
        });
    }

    function confirmCrossMount(op, paths, dest, conflict, message) {
        modalOpen('Are you sure?', '<p class="fv-confirm">' + esc(message || 'This may be risky.') + '</p>',
            (op === 'move' ? 'Move anyway' : 'Copy anyway'), 'fv-btn--danger',
            function (ov) { modalBusy(ov, true); startCopyMove(op, paths, dest, conflict, true, ov); });
    }

    function openProgress(op, jobId) {
        var verb = (op === 'move' ? 'Moving' : 'Copying');
        var act  = (op === 'move' ? 'moving' : 'copying');
        var inner =
            '<div class="fv-prog">' +
              '<div class="fv-prog-bar"><div class="fv-prog-fill" id="fv-prog-fill"></div></div>' +
              '<div class="fv-prog-row"><span id="fv-prog-pct">0%</span><span id="fv-prog-bytes"></span></div>' +
              '<div class="fv-prog-row fv-prog-sub"><span id="fv-prog-count"></span><span id="fv-prog-eta"></span></div>' +
              '<div class="fv-prog-cur" id="fv-prog-cur">starting…</div>' +
            '</div>';
        var done = false, timer = null, t0 = Date.now();
        var ov = modalOpen(verb, inner, 'Cancel', 'fv-btn--danger', function (ov) {
            if (done) { modalClose(); return; }
            var btn = ov.querySelector('.fv-modal__ok');
            if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
            postJson('job_cancel', { id: jobId });
        }, true);

        function paint(st) {
            var bt = Number(st.bytes_total) || 0, bd = Number(st.bytes_done) || 0;
            var pct = bt > 0 ? Math.min(100, Math.round(bd / bt * 100)) : (st.state === 'done' ? 100 : 0);
            ov.querySelector('#fv-prog-fill').style.width = pct + '%';
            ov.querySelector('#fv-prog-pct').textContent = pct + '%';
            ov.querySelector('#fv-prog-bytes').textContent = fmtBytes(bd) + ' of ' + fmtBytes(bt);
            ov.querySelector('#fv-prog-count').textContent = (st.items_done || 0) + ' of ' + (st.items_total || 0) + ' items';
            ov.querySelector('#fv-prog-cur').textContent = st.current ? (act + ' ' + st.current) : '…';
            var el = (Date.now() - t0) / 1000, eta = '';
            if (bd > 0 && bt > bd && el > 1) {
                var rem = Math.round((bt - bd) / (bd / el));
                eta = rem > 90 ? ('~' + Math.round(rem / 60) + 'm left') : ('~' + rem + 's left');
            }
            ov.querySelector('#fv-prog-eta').textContent = eta;
        }
        function finish(st) {
            done = true; if (timer) { clearInterval(timer); timer = null; }
            var fails = (st && st.failed) || [], msg;
            if (st && st.state === 'cancelled') msg = 'Cancelled. Items already ' + (op === 'move' ? 'moved' : 'copied') + ' are in place.';
            else if (st && st.state === 'error') msg = 'Something went wrong. ' + ((st && st.message) || '');
            else msg = 'Done. ' + (st.items_done || 0) + (((st.items_done || 0) === 1) ? ' item ' : ' items ') + (op === 'move' ? 'moved' : 'copied') + '.';
            var extra = fails.length ? '<p class="fv-confirm" style="color:var(--fv-warn-text)">Skipped:<br>' + fails.map(esc).join('<br>') + '</p>' : '';
            var b = ov.querySelector('.fv-modal__body'); if (b) b.innerHTML = '<p class="fv-confirm">' + esc(msg) + '</p>' + extra;
            var btn = ov.querySelector('.fv-modal__ok');
            if (btn) { btn.disabled = false; btn.textContent = 'Close'; btn.className = 'fv-btn fv-btn--primary fv-modal__ok'; }
            loadDir(_currentPath);
        }
        function poll() {
            fetchJson('job_status', 'id=' + encodeURIComponent(jobId)).then(function (d) {
                if (!d || !d.ok) return;
                var st = d.status || {};
                try { paint(st); } catch (e) {}
                if (st.state === 'done' || st.state === 'cancelled' || st.state === 'error') finish(st);
            });
        }
        timer = setInterval(poll, 1000);
        poll();
    }

    // ---- owner and permission (phase 3) --------------------------------------
    // both act on the ticked set. the dialog seeds from the first selected item,
    // then the chosen values are applied to each one in turn.

    // run an action over every path, collect failures, report. no list refresh:
    // owner and mode are not shown in the list, so the selection is kept and you
    // can chain owner then permission on the same items.
    function applyToEach(action, paths, paramsFor, label) {
        var failed = [];
        (function next(i) {
            if (i >= paths.length) {
                modalClose();
                if (failed.length) {
                    noteModal(label, '<p class="fv-confirm">Some items were not changed:</p>' +
                        '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + failed.map(esc).join('<br>') + '</p>');
                }
                return;
            }
            postJson(action, paramsFor(paths[i])).then(function (d) {
                if (!d || !d.ok) failed.push(baseName(paths[i]) + ' - ' + ((d && d.error) || 'failed'));
                next(i + 1);
            });
        })(0);
    }

    // weights for the 3x3 rwx grid, in mode order
    var PERM_BITS = [256,128,64, 32,16,8, 4,2,1];

    function readPermOctal(ov) {
        var sum = 0, bits = ov.querySelectorAll('.fv-permbit');
        for (var i = 0; i < bits.length; i++) if (bits[i].checked) sum += Number(bits[i].getAttribute('data-v'));
        var s = sum.toString(8);
        while (s.length < 3) s = '0' + s;
        return s;
    }

    // rwx string for the three classes, matching the list's symbolic format so
    // the popup preview reads the same way as the row it came from. the special
    // digit folds into the three x positions the usual way: s, S, t, T
    function permSymbolic(oct, isDir, special) {
        var n  = parseInt(oct, 8) || 0;
        var sp = parseInt(special || '0', 8) || 0;
        var t = 'rwxrwxrwx', out = '';
        for (var i = 0; i < 9; i++) out += (n & (1 << (8 - i))) ? t.charAt(i) : '-';
        if (sp & 4) out = out.slice(0, 2) + ((n & 64) ? 's' : 'S') + out.slice(3);
        if (sp & 2) out = out.slice(0, 5) + ((n & 8)  ? 's' : 'S') + out.slice(6);
        if (sp & 1) out = out.slice(0, 8) + ((n & 1)  ? 't' : 'T');
        return (isDir ? 'd' : '-') + out;
    }

    function permPreview(ov, isDir, special) {
        var oct = readPermOctal(ov);
        if (_permsFmt === 'symbolic') return permSymbolic(oct, isDir, special);
        return (special && special !== '0' ? special : '') + oct;
    }

    function promptPermission() {
        var paths = selectedPaths();
        if (!paths.length) return;
        fetchJson('attrs', 'path=' + encodeURIComponent(paths[0])).then(function (a) {
            if (!a || !a.ok) { noteModal('Permission', '<p class="fv-confirm">' + esc((a && a.error) || 'Cannot read attributes.') + '</p>'); return; }
            openPermissionDialog(paths, a);
        });
    }

    function openPermissionDialog(paths, a) {
        var mode = parseInt(a.mode, 8) || 0;
        var rows = ['Owner','Group','Other'];
        var grid = '<table class="fv-perm"><tr><th></th><th>r</th><th>w</th><th>x</th></tr>';
        for (var r = 0; r < 3; r++) {
            grid += '<tr><td>' + rows[r] + '</td>';
            for (var c = 0; c < 3; c++) {
                var bit = PERM_BITS[r * 3 + c];
                grid += '<td><input type="checkbox" class="fv-permbit" data-v="' + bit + '"' + ((mode & bit) ? ' checked' : '') + '></td>';
            }
            grid += '</tr>';
        }
        grid += '</table>';

        var inner =
            (paths.length > 1 ? '<p class="fv-confirm" style="margin-bottom:.6rem">Applies to ' + paths.length + ' items.</p>' : '') +
            grid +
            '<div class="fv-permline">Mode <code id="fv-perm-oct">000</code></div>' +
            '<label class="fv-check"><input type="checkbox" id="fv-perm-rec"> Apply to all contents (folders)</label>' +
            '<div class="fv-modal__err" style="display:none"></div>';

        var isDir = !!a.is_dir;
        // suid, sgid and sticky are not edited here, so they must survive an
        // apply untouched: keep the incoming special digit and send it back
        var special = (typeof a.mode === 'string' && a.mode.length === 4) ? a.mode.charAt(0) : '0';
        var ov = modalOpen('Permission', inner, 'Apply', 'fv-btn--primary', function (ov) {
            var oct = (special !== '0' ? special : '') + readPermOctal(ov);
            var rec = ov.querySelector('#fv-perm-rec').checked ? 1 : '';
            modalBusy(ov, true);
            applyToEach('chmod', paths, function (p) { return { path: p, mode: oct, recursive: rec }; }, 'Permission');
        });

        var sync = function () { ov.querySelector('#fv-perm-oct').textContent = permPreview(ov, isDir, special); };
        var bits = ov.querySelectorAll('.fv-permbit');
        for (var i = 0; i < bits.length; i++) bits[i].addEventListener('change', sync);
        sync();
    }

    function promptOwner() {
        var paths = selectedPaths();
        if (!paths.length) return;
        fetchJson('attrs', 'path=' + encodeURIComponent(paths[0])).then(function (a) {
            if (!a || !a.ok) { noteModal('Owner', '<p class="fv-confirm">' + esc((a && a.error) || 'Cannot read attributes.') + '</p>'); return; }
            openOwnerDialog(paths, a);
        });
    }

    function openOwnerDialog(paths, a) {
        var inner =
            (paths.length > 1 ? '<p class="fv-confirm" style="margin-bottom:.6rem">Applies to ' + paths.length + ' items.</p>' : '') +
            '<label class="fv-field"><span>User</span><input type="text" class="fv-input" id="fv-own-user" autocomplete="off" spellcheck="false" value="' + esc(a.owner) + '"></label>' +
            '<label class="fv-field"><span>Group</span><input type="text" class="fv-input" id="fv-own-group" autocomplete="off" spellcheck="false" value="' + esc(a.group) + '"></label>' +
            '<p class="fv-hint">Name or numeric id. Leave a field empty to keep it as is.</p>' +
            '<label class="fv-check"><input type="checkbox" id="fv-own-rec"> Apply to all contents (folders)</label>' +
            '<div class="fv-modal__err" style="display:none"></div>';

        var ov = modalOpen('Owner', inner, 'Apply', 'fv-btn--primary', function (ov) {
            var user  = ov.querySelector('#fv-own-user').value.trim();
            var group = ov.querySelector('#fv-own-group').value.trim();
            if (!user && !group) { modalError(ov, 'Set a user or a group.'); return; }
            var rec = ov.querySelector('#fv-own-rec').checked ? 1 : '';
            modalBusy(ov, true);
            applyToEach('chown', paths, function (p) { return { path: p, user: user, group: group, recursive: rec }; }, 'Owner');
        });
        ov.querySelector('#fv-own-user').focus();
    }

    // ---- edit mode (phase 2) -------------------------------------------------
    // turn the read-only text preview into a textarea, save atomically with a
    // stale guard, and restore the preview when done.

    function resetEditState() {
        _editing = false;
        _editBaseline = '';
        _editMtime = 0;
        _editCtx = null;
    }
    function editorDirty() {
        var ta = document.getElementById('fv-editor');
        return _editing && !!ta && ta.value !== _editBaseline;
    }
    // navigation guard: true when it is safe to leave the editor. a clean editor
    // leaves quietly, a dirty one asks first. a native confirm is used here since
    // the caller needs a synchronous answer before it navigates.
    function leaveEditOk() {
        if (!_editing) return true;
        if (!editorDirty()) { resetEditState(); return true; }
        if (window.confirm('Discard unsaved changes?')) { resetEditState(); return true; }
        return false;
    }

    // load the full file (not the capped preview) and open it in the editor
    function enterEdit() {
        if (!_editMode) return;
        var ctx = _previewFile;
        if (!ctx || (ctx.cat !== 'code' && ctx.cat !== 'md')) return;
        fetchJson('filetext', 'path=' + encodeURIComponent(ctx.path)).then(function (d) {
            if (!d || !d.ok) { noteModal('Edit', '<p class="fv-confirm">' + esc((d && d.error) || 'This file cannot be edited.') + '</p>'); return; }
            openEditor(ctx, d.content, d.mtime);
        });
    }

    function openEditor(ctx, content, mtime) {
        _editing = true; _editCtx = ctx; _editMtime = mtime; _editBaseline = content;
        setPvHead(ctx.name, (ctx.ext ? '.' + ctx.ext : 'Text') + ' \u00b7 editing', 'code');   // clears tools, wrap/raw/edit off
        var ta = document.createElement('textarea');
        ta.id = 'fv-editor';
        ta.className = 'fv-editor';
        ta.spellcheck = false;
        ta.value = content;
        _bodyEl.innerHTML = '';
        _bodyEl.appendChild(ta);
        var save = addTool('Save', 'Save changes', function () { saveEdit(false); });
        save.classList.add('fv-pv-btn--primary');
        addTool('Cancel', 'Discard changes', cancelEdit);
        ta.focus();
    }

    function setEditorBusy(on) {
        var b = _pvToolsEl ? _pvToolsEl.querySelector('.fv-pv-btn--primary') : null;
        if (b) b.disabled = !!on;
    }
    function flashSaved() {
        var b = _pvToolsEl ? _pvToolsEl.querySelector('.fv-pv-btn--primary') : null;
        if (!b) return;
        var t = b.textContent;
        b.textContent = 'Saved'; b.classList.add('active');
        setTimeout(function () { if (b) { b.textContent = t; b.classList.remove('active'); } }, 1200);
    }

    function saveEdit(force) {
        var ta = document.getElementById('fv-editor');
        if (!ta || !_editCtx) return;
        var content = ta.value;
        setEditorBusy(true);
        postJson('save', { path: _editCtx.path, content: content, mtime: _editMtime, force: force ? 1 : '' }).then(function (d) {
            setEditorBusy(false);
            if (d && d.ok) { _editBaseline = content; _editMtime = d.mtime; flashSaved(); return; }
            if (d && d.stale) { confirmStale(); return; }
            noteModal('Save', '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + esc((d && d.error) || 'Could not save.') + '</p>');
        });
    }

    // the file moved under us: overwrite with the editor copy, or keep editing
    function confirmStale() {
        modalOpen('File changed on disk',
            '<p class="fv-confirm">This file was changed outside the editor since you opened it. Overwrite it with your version?</p>',
            'Overwrite', 'fv-btn--danger', function () { modalClose(); saveEdit(true); });
    }

    function cancelEdit() {
        if (editorDirty()) {
            modalOpen('Discard changes', '<p class="fv-confirm">Discard your unsaved changes?</p>',
                'Discard', 'fv-btn--danger', function () { modalClose(); exitToPreview(); });
            return;
        }
        exitToPreview();
    }
    // back to the read-only preview of the same file
    function exitToPreview() {
        var ctx = _editCtx;
        resetEditState();
        if (ctx) doOpen(ctx.cat, ctx.size, ctx.name, ctx.ext, ctx.path);
    }

    function init() {
        _listEl   = document.getElementById('fv-list');
        _crumbEl  = document.getElementById('fv-pv-crumbs');
        _bodyEl   = document.getElementById('fv-pv-body');
        _titleEl  = document.getElementById('fv-browser-title');
        _countEl  = document.getElementById('fv-browser-count');
        _pvTypeEl = document.getElementById('fv-pv-type');
        _pvToolsEl = document.getElementById('fv-pv-tools');
        _filterEl  = document.getElementById('fv-filter-input');
        _pvEl      = document.querySelector('.fv-preview');
        _rootEl    = document.querySelector('.fv-wrapper');
        _pvCloseEl = document.getElementById('fv-pv-close');
        _dlBtn     = document.getElementById('fv-op-download');
        _wrapBtn   = document.getElementById('fv-op-wrap');
        _rawBtn    = document.getElementById('fv-op-openraw');
        _createBtn = document.getElementById('fv-op-create');
        _renameBtn = document.getElementById('fv-op-rename');
        _deleteBtn = document.getElementById('fv-op-delete');
        _editBtn   = document.getElementById('fv-op-edit');
        _ownerBtn  = document.getElementById('fv-op-owner');
        _permBtn   = document.getElementById('fv-op-perm');
        _copyBtn   = document.getElementById('fv-op-copy');
        _moveBtn   = document.getElementById('fv-op-move');
        _uploadBtn = document.getElementById('fv-op-upload');
        _recycleBtn = document.getElementById('fv-op-recycle');
        _spaceBtn = document.getElementById('fv-op-space');
        EMPTY_HTML = _bodyEl ? _bodyEl.innerHTML : '';
        if (!_listEl) return;

        _listEl.addEventListener('click', onListClick);
        _crumbEl.addEventListener('click', onCrumbClick);
        if (_pvCloseEl) _pvCloseEl.addEventListener('click', function () { if (leaveEditOk()) clearPreview(); });
        if (_dlBtn) _dlBtn.addEventListener('click', downloadSelected);
        if (_wrapBtn) _wrapBtn.addEventListener('click', toggleWrap);
        if (_rawBtn) _rawBtn.addEventListener('click', openRawSelected);
        if (_createBtn) _createBtn.addEventListener('click', promptCreate);
        if (_renameBtn) _renameBtn.addEventListener('click', promptRename);
        if (_deleteBtn) _deleteBtn.addEventListener('click', promptDelete);
        if (_editBtn) _editBtn.addEventListener('click', enterEdit);
        if (_ownerBtn) _ownerBtn.addEventListener('click', promptOwner);
        if (_permBtn) _permBtn.addEventListener('click', promptPermission);
        if (_copyBtn) _copyBtn.addEventListener('click', function () { beginCopyMove('copy'); });
        if (_moveBtn) _moveBtn.addEventListener('click', function () { beginCopyMove('move'); });
        if (_uploadBtn) _uploadBtn.addEventListener('click', enterUploadMode);
        if (_recycleBtn) _recycleBtn.addEventListener('click', enterRecycleMode);
        if (_spaceBtn) _spaceBtn.addEventListener('click', enterSpaceMode);
        _listEl.addEventListener('change', onListChange);
        updateOps();   // nothing ticked yet

        if (_filterEl) _filterEl.addEventListener('input', applyFilter);
        var modeBtn = document.getElementById('fv-mode');
        if (modeBtn) modeBtn.addEventListener('click', function (e) { e.preventDefault(); setMode(!_editMode); });
        document.addEventListener('keydown', onKey);

        setMode(false);   // start in preview-only
        loadDir(readDir(), true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
