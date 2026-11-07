# Translations

Files Viewer shows up in the language a user has picked in Unraid, as long as
the language pack carries its strings. These are the strings, one folder per
language, two files each:

- `filesviewer.txt`: everything the two pages print. Loaded by the plugin
  itself with `parse_plugin('filesviewer')`, so it only applies to its own pages.
- `javascript.filesviewer.txt`: everything the browser side prints. Unraid picks
  up every `javascript*.txt` in a language on its own and builds one `_()` for
  all pages from them.

## How they reach users

Unraid does not read translations from a plugin. They live in the language
packs, one repository per language under github.com/unraid, and reach a server
when the user installs or updates that pack. Plugins keep a folder of their own
in the pack, the way Unassigned Devices and Community Applications do.

So each language here goes to its pack as a pull request, in a folder named
`Files Viewer` holding the two files. Nothing else to do on the plugin side.

## Keeping the files in step with the code

The left side of every line is the key Unraid looks up, which is the English
text with the characters its parser cannot carry removed: `? ! . : ( ) / ' "`
and HTML tags. `tools/strings.py` collects the strings from the code and derives
the keys the same way, so the keys are never written by hand:

    python3 tools/strings.py            what each language is missing
    python3 tools/strings.py --write    add the missing keys, value left empty

A line left as `key=` is ignored by Unraid, so an untranslated entry simply
shows the English text.

## Rules for the right side

- `%s` is filled in by the plugin, keep each one and keep their order unless
  the sentence needs them swapped.
- `**bold**` in `filesviewer.txt` becomes bold on the page. Do not use `*` or
  `**` for anything else there.
- No double quotes in `javascript.filesviewer.txt`, the generated script cannot
  carry them.
- `Apply`, `Edit`, `Cancel`, `Remove`, `Done` and `Are you sure` stay empty in
  `javascript.filesviewer.txt`. The pack's own `javascript.txt` already has them,
  and a value here would override it for every page of the GUI.
- Keep translations about as long as the English, the buttons do not grow.
