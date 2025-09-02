# v86-vga2tty
Connects V86 screen buffer to interactive terminal

## Installation

This script will find all required files automatically if you clone this repository next to [v86](https://github.com/copy/v86), the assumed directory layout is:

```
.
├── v86/
│   ├── bios/
│   │   ├── seabios.bin
│   │   └── vgabios.bin
│   └── build/
│       ├── libv86.mjs
│       └── v86.wasm
└── v86-vga2tty/
    └── v86-vga2tty.js
```

Alternatively, use CLI option `-v86dir` to specify the v86 installation directory, or use options `-libv86`, `-v86wasm`, `-bios` and `-vgabios` to tell `vga2tty` where to find the required v86 files.

## Command line interface

```
$ ./vga2tty.js -h
vga2tty 0.1

Usage:
  vga2tty.js [options]

Memory options:
  -m, --mem SIZE        Set memory size (default: 512M)
  -vgamem SIZE          Set VGA memory size (default: 64M)

Storage options:
  -hda FILE             Primary hard disk image
  -hdb FILE             Secondary hard disk image
  -fda FILE             Floppy disk A image
  -fdb FILE             Floppy disk B image
  -cdrom FILE           CD-ROM image

Boot options:
  -boot ORDER           Boot order (a,b,c,d,n) (default: c)
  -kernel FILE          Linux kernel image (bzImage)
  -initrd FILE          Initial ramdisk image
  -append STRING        Kernel command line

System options:
  -v86dir PATH          V86 installation directory (default: ../v86)
  -libv86 FILE          V86 library file path (default: <v86dir>/build/libv86.mjs)
  -v86wasm FILE         V86 wasm file path (default: <v86dir>/build/v86.wasm)
  -bios FILE            BIOS image file (default: <v86dir>/bios/seabios.bin)
  -vgabios FILE         VGA BIOS image file (default: <v86dir>/bios/vgabios.bin)
  -acpi                 Enable ACPI (default: off)
  -fastboot             Enable fast boot
  -loglevel LEVEL       Debug log level (default: 0)

Network options:
  -netdev CONFIG        Network device configuration

VirtFS options:
  -virtfs CONFIG        VirtFS configuration

Other options:
  -verbose              Show additional output
  -debug_v86            Run V86 in debug mode
  -debug_screenshots    Show VGA screenshots instead of normal output

Standard options:
  -h, --help            Show help
  -v, --version         Show version

Examples:
  vga2tty.js -hda disk.img
  vga2tty.js -m 1G -hda disk.img -cdrom boot.iso
  vga2tty.js -kernel vmlinuz -initrd initrd.img -append "console=ttyS0"
  vga2tty.js -hda disk.img -netdev user,type=virtio,relay_url=ws://localhost:8777
```
