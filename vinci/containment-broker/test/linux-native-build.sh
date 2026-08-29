#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_root=$(mktemp -d "${TMPDIR:-/tmp}/vinci-native-build.XXXXXX")
trap 'rm -rf "$build_root"' EXIT HUP INT TERM
compiler=${CC:-cc}
common='-std=c17 -Wall -Wextra -Werror -Wpedantic -O2'
freestanding='-std=c17 -Wall -Wextra -Werror -Wpedantic -O2 -ffreestanding -fno-stack-protector -fno-builtin -ffunction-sections'
freestanding_asm='-Wall -Wextra -Werror -ffreestanding -fno-stack-protector -fno-builtin -ffunction-sections'

# Hosted objects retained for the launcher, session, and selftest links.
"$compiler" $common -c "$package_root/native/protocol.c" -o "$build_root/protocol.o"
"$compiler" $common -c "$package_root/native/sha256.c" -o "$build_root/sha256.o"
"$compiler" $common -c "$package_root/native/launcher_linux.c" -o "$build_root/launcher_linux.o"
"$compiler" $common -c "$package_root/native/session_linux.c" -o "$build_root/session_linux.o"
"$compiler" $common -c "$package_root/native/target_bootstrap_linux.c" -o "$build_root/target_bootstrap_linux.o"
"$compiler" $freestanding_asm -c "$package_root/native/target_entry_linux.S" -o "$build_root/target_entry_linux.o"
"$compiler" $common -ffunction-sections -c "$package_root/native/sha256.c" -o "$build_root/sha256_target.o"

# Freestanding trampoline objects compiled separately from the hosted objects.
"$compiler" $freestanding_asm -c "$package_root/native/trampoline_entry_linux.S" -o "$build_root/trampoline_entry_linux.o"
"$compiler" $freestanding -c "$package_root/native/trampoline_runtime_linux.c" -o "$build_root/trampoline_runtime_linux.o"
"$compiler" $freestanding -c "$package_root/native/trampoline_linux.c" -o "$build_root/trampoline_linux.o"
"$compiler" $freestanding -c "$package_root/native/protocol.c" -o "$build_root/protocol_freestanding.o"
"$compiler" $freestanding -c "$package_root/native/sha256.c" -o "$build_root/sha256_freestanding.o"

# Hermetic static trampoline link with no runtime or startup dependencies.
"$compiler" $common "$build_root/trampoline_entry_linux.o" "$build_root/trampoline_linux.o" \
  "$build_root/trampoline_runtime_linux.o" "$build_root/protocol_freestanding.o" "$build_root/sha256_freestanding.o" \
  -static -nostdlib -nostartfiles -Wl,-e,_start -Wl,--gc-sections -o "$build_root/vinci-trampoline"

# Verify the trampoline really is a hermetic static ELF binary.
if readelf -l "$build_root/vinci-trampoline" | grep -q INTERP; then
  echo "refusing trampoline with a filesystem ELF interpreter" >&2
  exit 1
fi
# ELF entry point vs a symbol address, compared NUMERICALLY. readelf prints
# 0x401000 while nm prints 0000000000401000, so a string comparison of the two
# never matches even when they name the same address. Shared by the trampoline
# and the target fixture so the two cannot drift apart.
elf_entry_is_symbol() {
  entry=$(readelf -h "$1" | awk '/Entry point address:/ { print $4 }')
  symbol=$(nm -n "$1" | awk -v want="$2" '$3 == want { print "0x" $1 }')
  if test -z "$entry" || test -z "$symbol"; then return 1; fi
  test $((entry)) -eq $((symbol))
}

# One rejection, shared by the real trampoline and the pre-main mutant below, so the
# mutant exercises the gate that actually guards the binary instead of a copy of it.
reject_pre_main_sections() {
  if readelf -SW "$1" | grep -Eq '\.(interp|preinit_array|init_array|fini_array)[[:space:]]'; then
    return 1
  fi
  return 0
}
if ! reject_pre_main_sections "$build_root/vinci-trampoline"; then
  echo "refusing trampoline carrying an interpreter or init/fini array section" >&2
  exit 1
fi
if readelf -SW "$build_root/vinci-trampoline" | grep -Eq '\.(dynamic|dynsym|dynstr)[[:space:]]'; then
  echo "refusing trampoline carrying dynamic linking sections or a dynamic symbol table" >&2
  exit 1
fi
if ! elf_entry_is_symbol "$build_root/vinci-trampoline" _start; then
  echo "refusing trampoline whose ELF entry point does not equal _start" >&2
  exit 1
fi
if ! nm "$build_root/vinci-trampoline" | grep -Eq '[[:space:]]vinci_trampoline_main$'; then
  echo "refusing trampoline missing the vinci_trampoline_main entry" >&2
  exit 1
fi

# Mutant gates: a hosted trampoline and a pre-main constructor must both be refused.
log="$build_root/mutant-gate.log"
"$compiler" $common -c "$package_root/test/trampoline-hosted-mutant.c" -o "$build_root/trampoline-hosted-mutant.o"
"$compiler" $common -c "$package_root/test/trampoline-pre-main-mutant.c" -o "$build_root/trampoline-pre-main-mutant.o"
# Prove each mutation is really present in its object before trusting the mutant
# as a gate. A mutation the compiler eliminated makes the gate below pass for a
# reason that has nothing to do with the contract it claims to enforce.
if ! nm "$build_root/trampoline-hosted-mutant.o" | grep -Eq '[[:space:]]T[[:space:]]main$'; then
  echo "MUTANT ERROR: hosted mutant object does not define main; the mutation is not in the object" >&2
  exit 1
fi
if ! readelf -SW "$build_root/trampoline-pre-main-mutant.o" | grep -Eq '\.init_array[[:space:]]'; then
  echo "MUTANT ERROR: pre-main mutant object carries no .init_array; the mutation was optimised away" >&2
  exit 1
fi
if "$compiler" $common "$build_root/trampoline_entry_linux.o" "$build_root/trampoline_runtime_linux.o" \
    "$build_root/trampoline-hosted-mutant.o" "$build_root/protocol_freestanding.o" "$build_root/sha256_freestanding.o" \
    -static -nostdlib -nostartfiles -Wl,-e,_start -Wl,--gc-sections \
    -o "$build_root/vinci-trampoline-hosted-mutant" 2>"$log"; then
  echo "MUTANT ERROR: hosted mutant (main instead of vinci_trampoline_main) linked successfully" >&2
  exit 1
fi
if ! grep -q 'vinci_trampoline_main' "$log"; then
  echo "MUTANT ERROR: hosted mutant link failed, but not for the undefined vinci_trampoline_main reference" >&2
  cat "$log" >&2
  exit 1
fi
"$compiler" $common "$build_root/trampoline_entry_linux.o" "$build_root/trampoline_linux.o" \
  "$build_root/trampoline_runtime_linux.o" "$build_root/trampoline-pre-main-mutant.o" \
  "$build_root/protocol_freestanding.o" "$build_root/sha256_freestanding.o" \
  -static -nostdlib -nostartfiles -Wl,-e,_start -Wl,--gc-sections \
  -o "$build_root/vinci-trampoline-premain-mutant"
if reject_pre_main_sections "$build_root/vinci-trampoline-premain-mutant"; then
  echo "MUTANT ERROR: pre-main constructor binary escaped the init_array/preinit_array rejection" >&2
  exit 1
fi

"$compiler" $common "$package_root/test/native-link-smoke.c" "$build_root/launcher_linux.o" \
  "$build_root/session_linux.o" "$build_root/protocol.o" "$build_root/sha256.o" -o "$build_root/native-link-smoke"
"$compiler" $common "$package_root/test/protocol-selftest.c" "$build_root/protocol.o" -o "$build_root/protocol-selftest"
"$compiler" $common "$package_root/test/sha256-selftest.c" "$build_root/sha256.o" -o "$build_root/sha256-selftest"
"$compiler" $freestanding -c "$package_root/native/target_runtime_linux.c" -o "$build_root/target_runtime_linux.o"
"$compiler" $common -static -nostdlib -nostartfiles -Wl,-e,_start -Wl,--gc-sections \
  "$build_root/target_entry_linux.o" "$build_root/target_bootstrap_linux.o" "$build_root/sha256_target.o" \
  "$build_root/target_runtime_linux.o" "$package_root/test/target-fixture-main.c" \
  -o "$build_root/vinci-target-fixture"
# Every refusal below names itself. These were bare `grep -q` lines under
# `set -eu`, so a failing check aborted the gate with no output at all and the
# reason for a refusal could not be read off a build log.
if ! readelf -h "$build_root/vinci-target-fixture" | grep -Eq 'Entry point address:.*0x[1-9a-fA-F]'; then
  echo "refusing target fixture with a null ELF entry point address" >&2
  exit 1
fi
if readelf -l "$build_root/vinci-target-fixture" | grep -q INTERP; then
  echo "refusing target fixture with a filesystem ELF interpreter" >&2
  exit 1
fi
if ! elf_entry_is_symbol "$build_root/vinci-target-fixture" _start; then
  echo "refusing target fixture whose ELF entry point does not equal _start" >&2
  exit 1
fi
if readelf -SW "$build_root/vinci-target-fixture" | grep -Eq '\.(preinit_array|init_array|fini_array)[[:space:]]'; then
  echo "refusing target fixture carrying init/fini array sections" >&2
  exit 1
fi
if ! nm "$build_root/vinci-target-fixture" | grep -Eq '[[:space:]]vinci_target_bootstrap_attest$'; then
  echo "refusing target fixture missing the vinci_target_bootstrap_attest entry" >&2
  exit 1
fi
if ! "$build_root/protocol-selftest"; then
  echo "protocol known-answer selftest failed" >&2
  exit 1
fi
if ! "$build_root/sha256-selftest"; then
  echo "sha256 known-answer selftest failed" >&2
  exit 1
fi

sha256sum "$build_root/vinci-trampoline" "$build_root/vinci-target-fixture" "$build_root/native-link-smoke" \
  "$build_root/launcher_linux.o" "$build_root/session_linux.o" "$build_root/target_bootstrap_linux.o" \
  "$build_root/target_entry_linux.o" "$build_root/target_runtime_linux.o" "$build_root/sha256_target.o" "$build_root/protocol.o" "$build_root/sha256.o" \
  "$build_root/trampoline_entry_linux.o" "$build_root/trampoline_linux.o" "$build_root/trampoline_runtime_linux.o" \
  "$build_root/protocol_freestanding.o" "$build_root/sha256_freestanding.o"
