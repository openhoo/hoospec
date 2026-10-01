#!/bin/sh
# Portable: works in existing Pages jobs without a Node.js runtime.
set -eu
hoospec_output=${1-}
case "$hoospec_output" in ''|/*|*[!A-Za-z0-9_./-]*|.|..|../*|*/../*|*/..|*/./*|*/.) echo 'Invalid relative Pages output directory.' >&2; exit 1;; esac
hoospec_path=$(cat .hoospec-pages/path)
case "$hoospec_path" in ''|/*|*[!A-Za-z0-9_/-]*|*//*|*/) echo 'Invalid Hoospec Pages path.' >&2; exit 1;; esac
hoospec_source=".hoospec-pages/$hoospec_path"
hoospec_target="$hoospec_output/$hoospec_path"
test -f "$hoospec_source/.hoospec-generated" || { echo 'Missing Hoospec build artifact. Add hoospec-build to this job needs.' >&2; exit 1; }
hoospec_probe=.
hoospec_old_ifs=$IFS
IFS=/
for hoospec_part in $hoospec_target; do
  hoospec_probe="$hoospec_probe/$hoospec_part"
  test ! -L "$hoospec_probe" || { echo 'Pages target must not be a symlink.' >&2; exit 1; }
done
IFS=$hoospec_old_ifs
if test -e "$hoospec_target"; then
  test -f "$hoospec_target/.hoospec-generated" || { echo 'Pages path already occupied. Choose another HOOSPEC_PAGES_PATH; existing content was preserved.' >&2; exit 1; }
  rm -rf "$hoospec_target"
fi
mkdir -p "$hoospec_target"
cp -R "$hoospec_source/." "$hoospec_target/"
echo "Hoospec integrated at $hoospec_target/; existing Pages content preserved."
