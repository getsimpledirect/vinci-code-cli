#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_root=$(mktemp -d "${TMPDIR:-/tmp}/vinci-native-build.XXXXXX")
trap 'rm -rf "$build_root"' EXIT HUP INT TERM
compiler=${CC:-cc}
common='-std=c17 -Wall -Wextra -Werror -Wpedantic -O2'

"$compiler" $common -c "$package_root/native/protocol.c" -o "$build_root/protocol.o"
"$compiler" $common -c "$package_root/native/sha256.c" -o "$build_root/sha256.o"
"$compiler" $common -c "$package_root/native/launcher_linux.c" -o "$build_root/launcher_linux.o"
"$compiler" $common -c "$package_root/native/session_linux.c" -o "$build_root/session_linux.o"
"$compiler" $common -c "$package_root/native/target_bootstrap_linux.c" -o "$build_root/target_bootstrap_linux.o"
"$compiler" -Wall -Wextra -Werror -ffreestanding -fno-stack-protector -fno-builtin -ffunction-sections \
  -c "$package_root/native/target_entry_linux.S" -o "$build_root/target_entry_linux.o"
"$compiler" $common -ffunction-sections -c "$package_root/native/sha256.c" -o "$build_root/sha256_target.o"
"$compiler" $common "$package_root/native/trampoline_linux.c" "$build_root/protocol.o" "$build_root/sha256.o" -o "$build_root/vinci-trampoline"
"$compiler" $common "$package_root/test/native-link-smoke.c" "$build_root/launcher_linux.o" \
  "$build_root/session_linux.o" "$build_root/protocol.o" "$build_root/sha256.o" -o "$build_root/native-link-smoke"
"$compiler" $common "$package_root/test/protocol-selftest.c" "$build_root/protocol.o" -o "$build_root/protocol-selftest"
"$compiler" $common "$package_root/test/sha256-selftest.c" "$build_root/sha256.o" -o "$build_root/sha256-selftest"
"$compiler" $common -static -nostartfiles -Wl,-e,_start -Wl,--gc-sections \
  "$build_root/target_entry_linux.o" "$build_root/target_bootstrap_linux.o" "$build_root/sha256_target.o" \
  "$package_root/test/target-fixture-main.c" -o "$build_root/vinci-target-fixture"
if readelf -l "$build_root/vinci-trampoline" | grep -q INTERP; then
  echo "refusing trampoline with a filesystem ELF interpreter" >&2
  exit 1
fi
readelf -h "$build_root/vinci-target-fixture" | grep -Eq 'Entry point address:.*0x[1-9a-fA-F]'
if readelf -l "$build_root/vinci-target-fixture" | grep -q INTERP; then exit 1; fi
entry=$(readelf -h "$build_root/vinci-target-fixture" | awk '/Entry point address:/ { print $4 }')
start=$(nm -n "$build_root/vinci-target-fixture" | awk '$3 == "_start" { print "0x" $1 }')
test -n "$entry" && test "$entry" = "$start"
if readelf -SW "$build_root/vinci-target-fixture" | grep -Eq '\.(preinit_array|init_array|fini_array)[[:space:]]'; then exit 1; fi
nm "$build_root/vinci-target-fixture" | grep -Eq '[[:space:]]vinci_target_bootstrap_attest$'
"$build_root/protocol-selftest"
"$build_root/sha256-selftest"

sha256sum "$build_root/vinci-trampoline" "$build_root/vinci-target-fixture" "$build_root/native-link-smoke" "$build_root/launcher_linux.o" \
  "$build_root/session_linux.o" "$build_root/target_bootstrap_linux.o" "$build_root/target_entry_linux.o"
