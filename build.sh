#!/bin/bash
# ============================================================================
# FILES VIEWER
# Copyright (C) 2026 Lazaros Chalkidis
# License: GPLv3
# =========================================================================

PLUGIN_NAME="filesviewer"
AUTHOR="Lazaros Chalkidis"
GITHUB_USER="Lazaros-Chalkidis"
GIT_URL="https://github.com/Lazaros-Chalkidis/unraid-filesviewer"
RAW_URL="${GIT_URL/github.com/raw.githubusercontent.com}"
PACKAGE_DIR_FINAL="packages"
PACKAGE_DIR_TEMP="package-temp"

BASE_VERSION=$(date +'%Y.%m.%d')
LETTER_SUFFIX="${1}"
STAGE_INPUT="${2}"
LOCAL_INSTALL="${3:-}"

if [[ "$STAGE_INPUT" == "local" ]]; then
    LOCAL_INSTALL="local"
    STAGE_INPUT=""
fi

if [[ ! "$LETTER_SUFFIX" =~ ^[a-z]?$ ]]; then
    echo "Version suffix must be a single lowercase letter."
    exit 1
fi
if [[ ! "$STAGE_INPUT" =~ ^(dev|release)?$ ]]; then
    echo "Stage must be dev or release."
    exit 1
fi
if [[ ! "$LOCAL_INSTALL" =~ ^(local)?$ ]]; then
    echo "Third argument can only be local."
    exit 1
fi

STAGE_SUFFIX=""
if [[ -n "$STAGE_INPUT" && "$STAGE_INPUT" != "release" ]]; then
    STAGE_SUFFIX="-${STAGE_INPUT}"
fi
VERSION="${BASE_VERSION}${LETTER_SUFFIX}${STAGE_SUFFIX}"

if [[ "$LOCAL_INSTALL" == "local" ]]; then
    BRANCH="local"
    PLUGIN_URL_STRUCTURE=""
    CHANGES_TEXT="- Local build (embedded package; no URL download)."
elif [[ "$STAGE_INPUT" == "dev" ]]; then
    BRANCH="dev"
    PLUGIN_URL_STRUCTURE="&gitURL;/raw/&branch;/packages/&name;-&version;.txz"
    CHANGES_TEXT="- Development build from the 'dev' branch. For testing only."
else
    BRANCH="main"
    PLUGIN_URL_STRUCTURE="&gitURL;/releases/download/&version;/&name;-&version;.txz"
    CHANGES_TEXT="- Automated release build."
fi

CHANGELOG_MD_FILE="CHANGELOG.md"
if [[ -f "$CHANGELOG_MD_FILE" ]]; then
    CHANGES_BLOCK="$(cat "$CHANGELOG_MD_FILE")"
else
    CHANGES_BLOCK="### ${VERSION}
${CHANGES_TEXT}"
fi

if [[ "$CHANGES_BLOCK" == *"]]>"* ]]; then
    CHANGES_BLOCK="${CHANGES_BLOCK//]]>/]] >}"
    echo "Note: a ]]> in ${CHANGELOG_MD_FILE} was broken up before going into the plg."
fi

CHANGELOG_TOP="$(grep -m1 -oE '^## Version [0-9]{4}\.[0-9]{2}\.[0-9]{2}[a-z]?' "$CHANGELOG_MD_FILE" 2>/dev/null | awk '{print $3}')"
if [[ "$BRANCH" == "main" && "$CHANGELOG_TOP" != "${BASE_VERSION}${LETTER_SUFFIX}" ]]; then
    echo "CHANGELOG.md top entry is ${CHANGELOG_TOP:-missing}, this build is ${BASE_VERSION}${LETTER_SUFFIX}."
    exit 1
fi

echo "=============================================="
echo " Files Viewer build"
echo " Version : ${VERSION}"
echo " Branch  : ${BRANCH}"
echo "=============================================="

rm -rf "${PACKAGE_DIR_TEMP}" "${PACKAGE_DIR_FINAL}"
mkdir -p "${PACKAGE_DIR_TEMP}" "${PACKAGE_DIR_FINAL}"

PLUGIN_DEST="${PACKAGE_DIR_TEMP}/usr/local/emhttp/plugins/${PLUGIN_NAME}"
mkdir -p "${PLUGIN_DEST}"
cp -R source/* "${PLUGIN_DEST}/"

echo "${VERSION}" > "${PLUGIN_DEST}/VERSION"

cat > "${PLUGIN_DEST}/branch.meta" << METAEOF
BRANCH="${BRANCH}"
IS_MAIN_BRANCH=$([[ "$BRANCH" == "main" ]] && echo "1" || echo "0")
METAEOF

find "${PLUGIN_DEST}" -type d        -exec chmod 755 {} \;
find "${PLUGIN_DEST}" -type f        -exec chmod 644 {} \;
find "${PLUGIN_DEST}" -name "*.sh"   -exec chmod 755 {} \;

FILENAME="${PLUGIN_NAME}-${VERSION}"
PACKAGE_PATH="${PACKAGE_DIR_FINAL}/${FILENAME}.txz"

echo "Creating package: ${FILENAME}.txz ..."
tar -C "${PACKAGE_DIR_TEMP}" -cJf "${PACKAGE_PATH}" usr

if [[ ! -f "${PACKAGE_PATH}" ]]; then
    echo "Package creation failed!"
    exit 1
fi
echo "Package: $(du -h "${PACKAGE_PATH}" | cut -f1)  ->  ${PACKAGE_PATH}"

if command -v md5sum &>/dev/null; then
    PACKAGE_MD5="$(md5sum "${PACKAGE_PATH}" | cut -d' ' -f1)"
elif command -v md5 &>/dev/null; then
    PACKAGE_MD5="$(md5 -q "${PACKAGE_PATH}")"
else
    echo "md5sum/md5 not found - MD5 will be empty in PLG!"
    PACKAGE_MD5=""
fi
echo "MD5: ${PACKAGE_MD5}"

b64_nolf() {
    if base64 --help 2>/dev/null | grep -q -- "-w"; then
        base64 -w 0 "$1"
    else
        base64 "$1" | tr -d '\n'
    fi
}

read -r -d '' DEFAULT_CFG << 'CFGEOF'
FV_SHOW_HIDDEN="0"
FV_FOLDERS_FIRST="1"
FV_REMEMBER="1"
FV_SORT="name"
FV_SORT_DIR="asc"
FV_PERMS_FORMAT="octal"
FV_TEXT_CAP_KB="2048"
FV_MD_RENDER="1"
FV_BTN_COLORS="1"
FV_SPACE="0"
FV_IMG_MAX_MB="50"
FV_ARCHIVE_MAX="1000"
FV_AUTOPLAY="0"
FV_RECYCLE="0"
FV_RECYCLE_DAYS="30"
FV_EDIT_DEFAULT="0"
FV_PALETTE="auto"
FV_NOTIFY="1"
CFGEOF

CFG_MISSING=""
for K in $(grep -o "new_cfg\['FV_[A-Z_]*'\]" source/FilesViewerSettings.page | grep -o "FV_[A-Z_]*" | sort -u); do
    grep -q "^${K}=" <<< "$DEFAULT_CFG" || CFG_MISSING="${CFG_MISSING} ${K}"
done
if [[ -n "$CFG_MISSING" ]]; then
    echo "Default config is missing:${CFG_MISSING}"
    exit 1
fi

PLG_DESCRIPTION="A file browser and manager. Previews files and manages daily tasks. Deletes files to a recycle bin per share."

PLG_INSTALL_SCRIPT='chown -R root:root /usr/local/emhttp/plugins/&name;
find /usr/local/emhttp/plugins/&name; -type d -exec chmod 755 {} \;
find /usr/local/emhttp/plugins/&name; -type f -exec chmod 644 {} \;
find /usr/local/emhttp/plugins/&name; -name "*.sh"   -exec chmod 755 {} \;

if [[ -f /boot/config/plugins/&name;/&name;.cfg ]]; then
    chmod 644 /boot/config/plugins/&name;/&name;.cfg
fi

php -r "if (function_exists(\"opcache_reset\")) opcache_reset();" >/dev/null 2>/dev/null

CFG=/boot/config/plugins/&name;/&name;.cfg
BAK=/boot/config/plugins/&name;/&name;.cfg.bak
if [[ -f "$BAK" ]]; then
    /usr/local/emhttp/plugins/&name;/scripts/merge_cfg.sh "$CFG" "$BAK"
    rm -f "$BAK"
fi

cp -f /usr/local/emhttp/plugins/&name;/&name;.cron /etc/cron.d/&name;
chmod 644 /etc/cron.d/&name;
if [[ -x /usr/local/sbin/update_cron ]]; then
    /usr/local/sbin/update_cron
fi

SMBX=/boot/config/smb-extra.conf
if ! grep -q "FILESVIEWER RECYCLE BEGIN" "$SMBX" 2>/dev/null; then
    TMPX=$(mktemp)
    echo "# FILESVIEWER RECYCLE BEGIN - managed by the files viewer plugin, do not edit" > "$TMPX"
    echo "veto files = /.RecycleBin/" >> "$TMPX"
    echo "# FILESVIEWER RECYCLE END" >> "$TMPX"
    if [[ -f "$SMBX" ]]; then cat "$SMBX" >> "$TMPX"; fi
    mv "$TMPX" "$SMBX"
    smbcontrol all reload-config >/dev/null 2>/dev/null
fi

for FVB in /mnt/*/*/.RecycleBin ; do
    if [[ -d "$FVB" ]]; then chown root:root "$FVB" ; chmod 700 "$FVB" ; fi
done

echo ""
echo "----------------------------------------------------"
echo " &name; (&branch; build) installed successfully."
echo " Version : &version;"
echo " Open    : Tools > Files Viewer"
echo " Settings: Settings > Files Viewer"
echo "----------------------------------------------------"
echo ""'

PLG_REMOVE_SCRIPT='rm -f /etc/cron.d/&name;
if [[ -x /usr/local/sbin/update_cron ]]; then
    /usr/local/sbin/update_cron
fi

shopt -s nullglob
FVBINS=(/mnt/*/*/.RecycleBin)
shopt -u nullglob

sed -i "/FILESVIEWER RECYCLE BEGIN/,/FILESVIEWER RECYCLE END/d" /boot/config/smb-extra.conf 2>/dev/null
smbcontrol all reload-config >/dev/null 2>/dev/null

removepkg &name;-&version;
rm -rf /usr/local/emhttp/plugins/&name;
rm -rf /tmp/&name;
rm -f /var/log/&name;.log /var/log/&name;.log.1

rm -f /boot/config/plugins/&name;/&name;-*.txz /boot/config/plugins/&name;/&name;-*.txz.b64 /boot/config/plugins/&name;/&name;.cfg.bak
rmdir /boot/config/plugins/&name; 2>/dev/null

echo ""
echo "----------------------------------------------------"
echo " &name; has been removed."
echo ""
echo " Your settings were left in place:"
echo "   /boot/config/plugins/&name;/&name;.cfg"
if (( ${#FVBINS[@]} )); then
    echo ""
    echo " The recycle bins were left as they are, with everything"
    echo " still in them, and a reinstall picks them up. To see"
    echo " what they hold:"
    echo "   du -sh /mnt/*/*/.RecycleBin"
    echo " To erase them for good:"
    echo "   rm -rf /mnt/*/*/.RecycleBin"
fi
echo "----------------------------------------------------"
echo ""'

echo "Generating ${PLUGIN_NAME}.plg (${BRANCH} target)..."

if [[ "$LOCAL_INSTALL" == "local" ]]; then
    PACKAGE_B64="$(b64_nolf "${PACKAGE_PATH}")"

    cat > "${PLUGIN_NAME}.plg" << EOF
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
 <!ENTITY name    "${PLUGIN_NAME}">
 <!ENTITY author  "${AUTHOR}">
 <!ENTITY version "${VERSION}">
 <!ENTITY branch  "${BRANCH}">
 <!ENTITY gitURL  "${GIT_URL}">
 <!ENTITY selfURL "${RAW_URL}/&branch;/&name;.plg">
 <!ENTITY launch  "Settings/FilesViewerSettings">
]>

<PLUGIN name="&name;" Title="Files Viewer" author="&author;" version="&version;"
        pluginURL="&selfURL;" launch="&launch;"
        icon="img/filesviewerplugin.png"
        min="7.2.0"
        support="${GIT_URL}/issues">

<DESCRIPTION>
<![CDATA[
${PLG_DESCRIPTION}
]]>
</DESCRIPTION>

<CHANGES>
<![CDATA[
${CHANGES_BLOCK}
]]>
</CHANGES>

<FILE Name="/boot/config/plugins/&name;/&name;-&version;.txz.b64">
  <INLINE>${PACKAGE_B64}</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
mkdir -p /boot/config/plugins/&name;
base64 -d /boot/config/plugins/&name;/&name;-&version;.txz.b64 \\
    > /boot/config/plugins/&name;/&name;-&version;.txz 2>/dev/null || \\
  base64 -D /boot/config/plugins/&name;/&name;-&version;.txz.b64 \\
    > /boot/config/plugins/&name;/&name;-&version;.txz
rm -f /boot/config/plugins/&name;/&name;-&version;.txz.b64
upgradepkg --install-new /boot/config/plugins/&name;/&name;-&version;.txz
</INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
if [[ -f /boot/config/plugins/&name;/&name;.cfg ]]; then cp /boot/config/plugins/&name;/&name;.cfg /boot/config/plugins/&name;/&name;.cfg.bak; fi
</INLINE>
</FILE>

<FILE Name="/boot/config/plugins/&name;/&name;.cfg" Mode="0644">
  <INLINE>
${DEFAULT_CFG}
  </INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
${PLG_INSTALL_SCRIPT}
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
${PLG_REMOVE_SCRIPT}
</INLINE>
</FILE>

</PLUGIN>
EOF

else

    cat > "${PLUGIN_NAME}.plg" << EOF
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
 <!ENTITY name      "${PLUGIN_NAME}">
 <!ENTITY author    "${AUTHOR}">
 <!ENTITY version   "${VERSION}">
 <!ENTITY branch    "${BRANCH}">
 <!ENTITY gitURL    "${GIT_URL}">
 <!ENTITY pluginURL "${PLUGIN_URL_STRUCTURE}">
 <!ENTITY selfURL   "${RAW_URL}/&branch;/&name;.plg">
 <!ENTITY md5       "${PACKAGE_MD5}">
 <!ENTITY launch    "Settings/FilesViewerSettings">
]>

<PLUGIN name="&name;" Title="Files Viewer" author="&author;" version="&version;"
        pluginURL="&selfURL;" launch="&launch;"
        icon="img/filesviewerplugin.png"
        min="7.2.0"
        support="${GIT_URL}/issues">

<DESCRIPTION>
<![CDATA[
${PLG_DESCRIPTION}
]]>
</DESCRIPTION>

<CHANGES>
<![CDATA[
${CHANGES_BLOCK}
]]>
</CHANGES>

<FILE Name="/boot/config/plugins/&name;/&name;-&version;.txz" Run="upgradepkg --install-new">
  <URL>&pluginURL;</URL>
  <MD5>&md5;</MD5>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
if [[ -f /boot/config/plugins/&name;/&name;.cfg ]]; then cp /boot/config/plugins/&name;/&name;.cfg /boot/config/plugins/&name;/&name;.cfg.bak; fi
</INLINE>
</FILE>

<FILE Name="/boot/config/plugins/&name;/&name;.cfg" Mode="0644">
  <INLINE>
${DEFAULT_CFG}
  </INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE>
${PLG_INSTALL_SCRIPT}
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
${PLG_REMOVE_SCRIPT}
</INLINE>
</FILE>

</PLUGIN>
EOF

fi

rm -rf "${PACKAGE_DIR_TEMP}"

echo ""
echo "Build complete!"
echo "   Package : ${PACKAGE_PATH}  ($(du -h "${PACKAGE_PATH}" | cut -f1))"
echo "   PLG     : ${PLUGIN_NAME}.plg"
echo "   MD5     : ${PACKAGE_MD5}"
echo "   Version : ${VERSION}"
echo "   Branch  : ${BRANCH}"
echo ""
