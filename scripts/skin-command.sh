#!/bin/sh
# Ask a running hachiware-pet host to install a skin without the panel button.
# The host polls <data dir>/command.json every 1.2s, so this also works when the
# pet is not clickable (for example on a Windows build that lost mouse input).
#
#   sh scripts/skin-command.sh                 # install the default skin
#   sh scripts/skin-command.sh nanami-hiromachi
#   sh scripts/skin-command.sh --random        # any skin not installed yet
set -e
action='install-skin'
slug='hachiware-2'
if [ "$1" = '--random' ]; then
  action='new-skin'
  slug=''
elif [ -n "$1" ]; then
  slug="$1"
fi
dir="$HOME/Library/Application Support/dsh-hachiware-pet"
mkdir -p "$dir"
if [ "$action" = 'new-skin' ]; then
  printf '{"action":"new-skin"}\n' > "$dir/command.json"
else
  printf '{"action":"install-skin","slug":"%s"}\n' "$slug" > "$dir/command.json"
fi
echo "wrote $dir/command.json ($action${slug:+ $slug})"
