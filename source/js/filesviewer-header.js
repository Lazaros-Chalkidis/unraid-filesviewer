/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

// navbar button click handler, opens the tool page
function FilesViewerButton(){
    location.href = '/Tools/FilesViewerTool';
}

(function(){
    "use strict";

    function setup(){
        var navItem = document.querySelector('.nav-item.FilesViewerButton');
        if(!navItem){ setTimeout(setup, 500); return; }  // nav item not in the dom yet, retry shortly

        var link = navItem.querySelector('a');
        if(!link) return;

        var img = link.querySelector('img, b.system, i.system, b.fa');
        if(img){
            var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
            svg.setAttribute('width','16');
            svg.setAttribute('height','16');
            svg.setAttribute('viewBox','0 0 24 24');
            svg.setAttribute('fill','none');
            svg.setAttribute('stroke','currentColor');
            svg.setAttribute('stroke-width','2');
            svg.setAttribute('stroke-linecap','round');
            svg.setAttribute('stroke-linejoin','round');
            svg.setAttribute('class','system');

            // stacked pages, the plugin logo as a line glyph
            var paths = [
                'M20 7h-3a2 2 0 0 1-2-2V2',
                'M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z',
                'M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8'
            ];
            for(var i = 0; i < paths.length; i++){
                var p = document.createElementNS('http://www.w3.org/2000/svg','path');
                p.setAttribute('d', paths[i]);
                svg.appendChild(p);
            }
            img.parentNode.replaceChild(svg, img);

            var iconColor = getComputedStyle(link).color || '#ccc';  // tint the glyph to match the navbar text colour
            svg.setAttribute('stroke', iconColor);
        }
    }

    setTimeout(setup, 800);
})();
