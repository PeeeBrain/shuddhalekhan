#!/bin/bash

# rpm runs the old package's %postun after the new package's %post, with $1 = number
# of versions left installed. On upgrade ($1 >= 1) the stock script would delete the
# link the new version just made, so only clean up on a real uninstall (deb runs its
# postinst last, so it keeps the stock script).
if [ "${1:-0}" -ge 1 ] 2>/dev/null; then
    exit 0
fi

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# fpm-built rpms own files, not directories: drop the empty tree uninstall leaves behind.
find '/opt/${sanitizedProductName}' -depth -type d -empty -delete 2>/dev/null || true
