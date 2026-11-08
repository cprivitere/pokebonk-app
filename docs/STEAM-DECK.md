# Steam Deck setup (Game Mode)

The Linux build needs one manual step in Game Mode. Without it the game
crashes at launch (GPU process `error_code=1002` loop, then exit).

## Root cause

Steam injects its overlay (`LD_PRELOAD=gameoverlayrenderer.so`) into every
child process. The overlay's init runs inside the dynamic linker, before any
app code, and its robust-mutex breaks inside Chromium's zygote PID namespace
(TID collision) — the zygote SIGSEGVs at spawn. No in-app fix can reach it:
the library is mapped before any JS runs, and forked children inherit the
mapping. Upstream: `ValveSoftware/steam-for-linux#13552`. The overlay is
functionally useless with Chromium anyway (it hooks Xlib, Chromium reads
xcb), so removing it loses nothing.

## Setup

1. Desktop Mode → Steam → Add a Non-Steam Game → select the
   `PokeBonk-*.AppImage`.
2. Right-click the entry → Properties → Launch Options, set:
   ```
   env -u LD_PRELOAD %command%
   ```
   This strips the overlay from the game's environment before exec. It does
   not affect other games.
3. Launch from Game Mode. No other flags needed: the client pins x11 under
   Gamescope itself and enables the full Vulkan feature set when the
   graphics backend is set to Vulkan (Ajustes → Pantalla).

Desktop Mode needs no setup: without Steam's overlay injection the AppImage
boots with no flags.
