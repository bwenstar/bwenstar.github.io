---
layout: post
title:  "A 4-byte patch and a nil keepsake: fixing Hades II crashes on a Switch emulator"
date:   2026-10-25 10:30:00 +1000
excerpt: "Hades II kept dying on the Eden emulator. One crash was the game giving up on a hardware audio decoder; the other was a Lua bug in the game itself. Here's how I found both and patched them."
tags:   [emulation, reverse-engineering]
---

Hades II runs well on [Eden](https://git.eden-emu.dev/eden-emu/eden), the community Switch
emulator, right up until it doesn't. On my machine (Eden v0.2.1 on Linux, an i5-7600K and an
RTX 3060) it would play fine for half an hour and then die: sometimes on a room transition,
sometimes the moment I closed the keepsake screen. There's a long-running issue about it on
Eden's tracker, and no fix that worked for my copy of the game.

It turned out to be two unrelated bugs that look the same from the outside. One is in how the
game reacts to the emulator's audio decoder service; that one is fixed with a single changed
instruction. The other is a nil check missing from one of the game's own Lua scripts. This post
walks through finding both, including a small debugger I had to write on the way because none
of my tools could talk to an emulated ARM64 process.

Everything below is for the game's base version (v0) unless I say otherwise. Addresses are
offsets into the game's `main` executable. If you just want the fixes, they're
[at the end](#files).

*I worked through this with Claude, Anthropic's AI assistant, running in Claude Code on my
machine. It helped with the disassembly, the debugger script and testing the patches while I
played the game to trigger each crash.*

## Two crashes, not one

Eden's log, `~/.local/share/eden/log/eden_log.txt`, had two crashes from the same session. Both
look like this:

```
Debug.Emulated <Critical> svc_exception.cpp:52:Break: Userspace PANIC! info1=0x0000001086EFD678, info2=0x0000000000000004
Debug.Emulated <Critical> svc_exception.cpp:33:operator(): debug_buffer_err_code=160A
Core.ARM <Error> arm_interface.cpp:43:LogBacktrace: Backtrace @ PC=00000000862C2190
```

"Userspace PANIC" means the game called `svcBreak` itself. Eden didn't fall over; the game
looked at something, decided it couldn't continue, and aborted. That changes the question from
"what did the emulator get wrong?" to "what did the game check, and why did it fail?"

The two crashes had different result codes. Switch result codes pack a module number into the
low 9 bits and a description into the rest, and are usually written as `2000+module-description`:

- `0x160A`: module `0x160A & 0x1FF = 10`, description `0x160A >> 9 = 11`, so **2010-0011**.
  Module 10 is the service framework, the IPC layer games use to talk to system services.
- `0x2A2`, reported through `SetTerminateResult` before the second abort: module 162,
  description 1, so **2162-0001**, the generic "the application called abort()" code.

So: one failed call into a system service, and one plain `abort()`. I didn't know yet that
these were unrelated.

## Somebody had been here before

Searching for the codes led to [Eden issue #105](https://github.com/eden-emulator/Issue-Reports/issues/105)
and the older [#2628](https://git.eden-emu.dev/eden-emu/eden/issues/2628), which has the same
`0x160a`. People report the same two triggers: entering a new room after dying, and equipping a
keepsake then leaving the menu.

In #105, a contributor had found that the crash goes through what looks like the game setting
up a **hardware** Opus decoder (Opus is the audio codec the game uses for music and voice), and
posted an IPS patch that skips the call so the game falls back to software decoding. It helped
some people and did nothing for others. Two problems for me:

1. It was built for a later game update. Switch exefs patches are keyed to the executable's build
   ID, and my `main` had a different one, so Eden would never load it.
2. The thread's annotations said the patch was at `0x1CEC50`, but the bytes in the IPS file
   said `0x1CED50`, and people applying it by hand weren't sure which to use.

The second one has a boring explanation, which I'll get to. The first meant I had to look at the
code myself.

## Getting at the code

A Switch game file (NSP) is a container of encrypted NCAs. The program NCA holds an `exefs`
with the executable (`main`, an NSO) and a `romfs` with the game's assets. With your console's
keys, [nstool](https://github.com/jakcron/nstool) can pull files straight out:

```
nstool -t pfs -x nsp/ "Hades II.nsp"
nstool -k prod.keys --tik nsp/*.tik --fstree nsp/<program>.nca      # main sits at /0/main
nstool -k prod.keys --tik nsp/*.tik -x /0/main main nsp/<program>.nca
```

`nstool -t nso main` gives the module ID `5219053E5EB156BE80FBB2F3037795317BEA8C2F`, which is
the build ID Eden logs when it looks for patches. It matched the log line
`HasNSOPatch: Querying NSO patch existence for build_id=5219053E…, name=main`, so this was
definitely the binary that crashed.

An NSO is three segments (text, rodata, data), each optionally LZ4-compressed, behind a 0x100
byte header. Decompressing them and laying them out at their memory offsets is about ten lines of
Python with the `lz4` package. Then [Capstone](https://www.capstone-engine.org/) disassembles
ARM64 fine. (My distro's `objdump` doesn't support aarch64, and `gdb-multiarch` wasn't installed.)

## Naming the calls

Raw disassembly of the crash area is full of `bl` instructions into a block of stubs near the end
of text, like `bl #0x596230`. Those are PLT stubs for functions imported from the Nintendo SDK
module, and the SDK exports are named, so the names are recoverable:

1. The word at offset 4 of the text segment points to the `MOD0` header, which points to the
   ELF-style `.dynamic` section.
2. `.dynamic` gives `DT_SYMTAB`, `DT_STRTAB`, `DT_JMPREL` and `DT_PLTRELSZ`.
3. Each `JMPREL` relocation maps a GOT slot to a symbol index.
4. Each PLT stub is `adrp x16, page; ldr x17, [x16, #off]; br x17`. Decoding the `adrp` and
   `ldr` immediates gives the GOT slot, and that gives the name.

Run through `c++filt`, the stubs in this function came out as:

```
0x596210  nn::codec::GetOpusDecoderWorkBufferSize(int, int)
0x596220  nn::codec::GetHardwareOpusMultiStreamDecoderWorkBufferSize(int, int, int, int, int)
0x596230  nn::codec::GetHardwareOpusDecoderWorkBufferSize(int, int, int)
0x5961f0  nn::codec::GetOpusMultiStreamDecoderWorkBufferSize(int, int, int, int)
```

That confirmed the guess from the issue thread. This is the game's audio code choosing between
Nintendo's hardware-accelerated Opus decoder and a software one.

## The decoder fallback

Here's the path the game takes for mono and stereo streams (fewer than three channels),
trimmed and annotated:

```
1cec00  mov    w24, #0xbb80                ; 48000 Hz
...
1cec24  bl     GetHardwareOpusDecoderWorkBufferSize(48000, channels, 0)
1cec28  mov    x23, x0                     ; work buffer size
1cec2c  ldr    x0, [x21]                   ; decoder object (hardware flavour)
1cec44  ldr    x8, [x0]                    ; its vtable
1cec4c  ldr    x8, [x8, #0x20]             ; virtual Initialize(...)
1cec50  blr    x8
1cec54  cmp    w0, #8
1cec58  b.ne   1ced14                      ; anything but 8: success (0) or fail (return 0x1c)

; w0 == 8: build a software decoder in the same slot and try again
1cec68  ldr    x8, [x8, #0xf28]            ; software decoder vtable
1cec8c  bl     GetOpusDecoderWorkBufferSize(48000, channels)
1cecb8  blr    x8                          ; software Initialize(...)
```

So the developers already handle the case where hardware decoding isn't available. If the
hardware `Initialize` returns `8`, the game quietly builds a software decoder instead. The crash
happens because, under Eden, the hardware path doesn't come back with a polite `8`. The service
call underneath fails with `2010-0011`, and the SDK aborts on that result before control ever
gets back to this function.

That makes the fix obvious. Don't call the hardware `Initialize` at all; pretend it returned `8`.
One instruction:

```
1cec50  blr x8        00 01 3f d6   →   mov w0, #8        00 01 80 52
```

The `cmp` and `b.ne` stay as they are, so the game takes its own fallback path exactly as if it
were running on a Switch without the hardware decoder.

The patch in #105 replaces both the `blr` and the `cmp` with `adr x0, #0`. That skips the call
too, but without the `cmp` the `b.ne` ends up testing whatever condition flags the previous
function call left behind, so which path you get is down to luck. That may be why it worked for
some people and not others.

### The offset mystery

Eden's IPS patches (`load/<title id>/<mod name>/exefs/<build id>.ips`) are applied to the NSO
*including* its 0x100-byte header. The instruction is at text offset `0x1CEC50`, which is file
offset `0x1CED50`. Both numbers in the thread were right; they just meant different things.

The whole patch is 17 bytes:

```
50 41 54 43 48       "PATCH"
1c ed 50             offset 0x1CED50
00 04                length 4
00 01 80 52          mov w0, #8
45 4f 46             "EOF"
```

With it installed, Eden logged `Applying IPS patch from mod "Software Opus Fix"`, and the
`2010-0011` crash didn't happen again.

There's a matching block for streams with three or more channels at `0x1CEB68`, with the same
`cmp w0, #8` fallback. I left it alone, because it never showed up in a crash, but it would take
the same patch if it did.

## The second crash isn't audio

The next time I opened the keepsake screen, chose a keepsake and closed it, the game froze again.
The log showed `SetTerminateResult … (2162-0001)` and an abort, with nothing interesting before
it.

The backtrace pointed at a short function around `0x1FDD90` that ends in a call to `abort`.
Its shape is familiar if you've read Lua's source:

```
1fdd98  ldr    x8, [x0, #0x70]       ; L->errorJmp
1fdd9c  cbnz   x8, 1fddc4            ; protected call active: longjmp to it
1fdda0  ldr    x9, [x0, #0x18]       ; G(L)
1fdda4  strb   w1, [x0, #0xa]        ; L->status = errcode
1fdda8  ldr    x8, [x9, #0x108]      ; G(L)->mainthread
1fddac  ldr    x10, [x8, #0x70]      ; mainthread->errorJmp
1fddb0  cbnz   x10, 1fddd4           ; re-throw on the main thread
1fddb4  ldr    x8, [x9, #0x100]      ; G(L)->panic
1fddb8  cbz    x8, 1fddc0
1fddbc  blr    x8
1fddc0  bl     abort
```

That's `luaD_throw` from Lua 5.2, almost line for line. The game runs its logic in an embedded
Lua interpreter, a script raised an error that nothing caught, and Lua's last resort is
`abort()`. The struct offsets (`status` at `0xa`, `top` at `0x10`, `l_G` at `0x18`) match a
64-bit Lua 5.2 build too.

So the second crash was a script error, and the useful information, the error message, was
sitting on the Lua stack at the moment of the abort. The game doesn't log it and neither does
Eden. I needed to stop the game right there and read it.

## Building a debugger out of a socket

Eden has a GDB stub (Configure → Debug → Enable GDB Stub, port 6543). A few things I learned
about it the hard way:

- It only starts when a game boots. Turning it on while the game is running does nothing.
- With it on, the game waits at its entry point ("launching…") until a debugger connects.
- It doesn't report a library list, so the debugger can't find module base addresses on its own.
  It does support a custom monitor command, `get info`, that prints them.

Ubuntu's `gdb` only targets x86-64, and attaching to Eden's process from the host was out
anyway (ptrace is restricted). But the GDB remote serial protocol is simple: packets look like
`$<data>#<two hex digit checksum>`, and you only need a handful of commands. So I wrote a
client in about 100 lines of Python:

```python
def send(pkt):
    data = pkt.encode()
    s.sendall(b"$" + data + b"#" + b"%02x" % (sum(data) & 0xFF))

info = rcmd("get info")                       # qRcmd: module layout
base = ...                                    # parse the Game.Switch.nss line
cmd("Z0,%x,4" % (base + 0x1FDDA0))            # sw breakpoint: luaD_throw, no handler path
send("c")                                     # continue; wait for a stop packet

regs = bytes.fromhex(cmd("g"))
L = u64(regs, 0)                              # x0 = lua_State*
top = u64(mem(L, 0x80), 0x10)                 # L->top
for i in range(1, 4):                         # each TValue is 16 bytes
    val, tt = struct.unpack_from("<QI", mem(top - 16 * i, 16))
    if tt & 0x0F == 4:                        # a string: the text starts after a 0x18-byte header
        print(mem(val, 0x1000)[0x18:].split(b"\0")[0].decode())
```

The breakpoint goes on `0x1FDDA0` rather than the start of the function. That instruction is
only reached when there's no protected call to unwind to, so ordinary errors that the game
catches with `pcall` won't stop it.

I attached, closed the keepsake screen, and the game stopped:

```
lua_State* L = 0x21c1a12990
slot top-1: tt=0x54
[string "Main"]:169: [string "KeepsakeLogic"]:186: attempt to index field '?' (a nil value)
slot top-2: tt=0x54
[string "KeepsakeLogic"]:186: attempt to index field '?' (a nil value)
```

(`0x54` is a collectable long string in Lua 5.2, which is a nice confirmation the guess about the
version was right.)

The nesting is the game's own design. Game logic runs in coroutines, and the scheduler in
`Main.lua` resumes them and re-raises any failure with `assert(status, info)` on line 169. That
`assert` runs on the main thread with no `pcall` around it, so it ends up at the breakpoint.

## The bug: unequipping nothing

The scripts are plain text in the romfs under `Scripts/`. Here's the path that fails, in
`KeepsakeLogic.lua`:

```lua
function OpenKeepsakeRackScreen( source )
    screen.LastTrait = GameState.LastAwardTrait            -- line 497: nil if nothing equipped

function KeepsakeScreenClose( screen, button )
    if screen.LastTrait ~= GameState.LastAwardTrait then   -- line 1033: you picked something new
        UnequipKeepsake( CurrentRun.Hero, screen.LastTrait )  -- passes nil
        EquipKeepsake( CurrentRun.Hero, GameState.LastAwardTrait, ... )

function UnequipKeepsake( heroUnit, traitName, args )
    ...
    if TraitData[traitName].Permanent and ...              -- line 186: TraitData[nil] is nil
```

If you open the keepsake screen with no keepsake equipped and choose one, closing the screen
tries to unequip "the previous keepsake", which is `nil`, and `TraitData[nil].Permanent` throws.
`EquipKeepsake` guards against exactly this (`if traitName == nil … then return end`) but
`UnequipKeepsake` doesn't. My save was a few hours old, which is probably why I hit it.

Eden can override any romfs file with a mod folder
(`load/<title id>/<mod name>/romfs/Scripts/KeepsakeLogic.lua`), so the fix is a patched copy of
the script with the missing guard:

```diff
 function UnequipKeepsake( heroUnit, traitName, args )
 	args = args or {}
 	local unit = heroUnit or CurrentRun.Hero
+	if traitName == nil then
+		return
+	end
 	...
-	if TraitData[traitName].Permanent and not CanFreeSwapKeepsakes() and not args.AdvanceKeepsakeMoment then
+	if TraitData[traitName] and TraitData[traitName].Permanent and not CanFreeSwapKeepsakes() and not args.AdvanceKeepsakeMoment then
```

The first change is the real fix; the second just makes the same line safe for an unknown
keepsake name. I kept the file's CRLF line endings and changed nothing else. After that, the
keepsake screen worked every time.

I also noticed in passing that a few lines further down, the same function checks
`trait.BoonConversionUses and trait.BoonConversationUses <= 0`. "Conversation" is a typo, so
whenever the first field is set, the second is `nil` and the comparison throws. I never hit that
one, and I left it alone.

The code path doesn't touch anything emulator-specific, so I'd expect it to crash the same way
on real hardware. I haven't been able to check that. I do suspect some of the "keepsake" reports
in #105 are this script bug rather than the audio one, but I can't tell from the logs posted
there.

## Then the update broke it again

A few days later I installed a game update (v458752, which Eden shows as v0.7.0) and the game
locked up as soon as I picked my save file.

There were two obvious suspects. The update changed `main`'s build ID to
`CF8DDAAB2D318451FD0CEECA0F627E610C96440E`, so the audio patch no longer matched and was being
skipped. And the keepsake fix was a copy of the v0 script, which would now be shadowing the
update's own `KeepsakeLogic.lua`. That's a good way to get strange errors if the rest of the
scripts have moved on. I turned both mods off and booted with the GDB stub on.

It still "hung" at the save select. This time I had a client attached that halts on any stop
and dumps every thread. The main thread was sitting just after an `svc #0x26`, which is
`svcBreak`, the same game-initiated abort as before. Its call stack went through
`main+0x1CEC54`, the return address of the `blr` I'd patched in v0, and the result `0x160A`
was sitting in its stack frame. The "lock-up" was the old audio crash. The debugger just
stopped Eden from showing it as one.

Reading the code at that address out of the running process showed the same bytes as before:
`00 01 3f d6 1f 20 00 71` (`blr x8; cmp w0, #8`). Supergiant hadn't touched this function, so
the existing IPS applies unchanged. I copied it to `CF8DDAAB2D318451FD0CEECA0F627E610C96440E.ips`
in the same mod folder.

The keepsake override stays off on the updated game. If the bug is still there, the fix needs
to be redone against the new version of the script, not by shipping the old one.

## Loose ends

- **The real fix belongs in Eden.** The game copes fine with "no hardware decoder"; what it
  doesn't survive is the hardware decoder service failing with `2010-0011`. I didn't dig into
  which call fails in Eden's `hwopus` implementation. Whoever does could fix this for every game
  that uses the hardware decoder, not just Hades.
- **Exefs patches are tied to one build.** Each update means checking that the bytes at the
  patch site are still the same and adding a copy under the new build ID. If the function
  moves, the offset has to be found again. The PLT names make that quick: look for the call
  after `GetHardwareOpusDecoderWorkBufferSize`.
- **Don't ship old scripts on new builds.** A romfs override replaces the whole file, so it
  silently undoes whatever the update changed in it.

## Files

**[Download hades-ii-eden-fixes.zip](/assets/downloads/hades-ii-eden/hades-ii-eden-fixes.zip)**
(2 KB). It's laid out as Eden mod folders, with a README. You'll need your own copy of the game;
nothing from the game is in it.

- **Software Opus Fix:** the 17-byte IPS from above, once per game build. Copy the folder into
  Eden's `load/0100A00019DE0000/` (on Linux, `~/.local/share/eden/load/0100A00019DE0000/`).
  - [`5219053E5EB156BE80FBB2F3037795317BEA8C2F.ips`](/assets/downloads/hades-ii-eden/5219053E5EB156BE80FBB2F3037795317BEA8C2F.ips):
    base game (v0), tested.
  - [`CF8DDAAB2D318451FD0CEECA0F627E610C96440E.ips`](/assets/downloads/hades-ii-eden/CF8DDAAB2D318451FD0CEECA0F627E610C96440E.ips):
    update v458752. The patched bytes are identical at the same offset, so the same patch applies.
- **Keepsake Crash Fix (v0 only):** I can't post the patched script because it's Supergiant's
  file, so the zip has `apply_keepsake_fix.py` instead. Extract `Scripts/KeepsakeLogic.lua` from
  your own romfs and run `python3 apply_keepsake_fix.py KeepsakeLogic.lua`. It makes the two
  changes from the diff above, writes `romfs/Scripts/KeepsakeLogic.lua` into the mod folder, and
  refuses to touch a file that doesn't match v0. Don't use it on an updated game.

Then enable the fixes under Properties → Add-ons in Eden, and turn the GDB stub back off.
