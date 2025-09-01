#!/usr/bin/env node

import url from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";

// TODO: make this import relative to setup.v86dir
import { V86 } from "../v86/build/libv86.mjs";
//import { V86 } from "../v86/src/main.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

function zeropad(i, n)
{
    return i.toString().padStart(n || 2, "0");
}

// ---------------------------------------------------------------------------
// class VgaObserver
// ---------------------------------------------------------------------------

class VgaObserver
{
    EMPTY_ROW_80 = "                                                                                ";
    CAPTURE_INTERVAL_MSEC = 1;

    constructor(rows_handler, debug_screenshots)
    {
        this.rows_handler = rows_handler;
        this.debug_screenshots = !! debug_screenshots;
        this.emulator = undefined;
        this.timeout_h = null;
        this.screen_rows = [];
        this.screen_modified = false;
        this.modified_rowids = new Set();
        this.snapshot_count = 1;
        this.screen_put_char = args => {
            if(args[0] < this.screen_rows.length)
            {
                this.modified_rowids.add(args[0]);
                this.screen_modified = true;
            }
        };
    }

    start(emulator)
    {
        if(this.emulator === undefined)
        {
            this.emulator = emulator;
            this.timeout_h = setTimeout(() => this.check_screen(), this.CAPTURE_INTERVAL_MSEC);
            this.screen_rows = emulator.screen_adapter.get_text_screen();
            this.screen_modified = false;
            this.modified_rowids.clear();
            this.emulator.add_listener("screen-put-char", this.screen_put_char);
        }
    }

    stop()
    {
        if(this.emulator !== undefined)
        {
            this.emulator.remove_listener("screen-put-char", this.screen_put_char);
            clearTimeout(this.timeout_h);
            this.emulator = undefined;
        }
    }

    check_screen()
    {
        if(this.screen_modified)
        {
            // screen is busy
            this.screen_modified = false;
        }
        else if(this.modified_rowids.size)
        {
            // busy-to-idle transition: screen is idle with modified rows pending
            const old_screen_rows = [...this.screen_rows];
            for(const rowid of this.modified_rowids)
            {
                this.screen_rows[rowid] = this.emulator.screen_adapter.get_text_row(rowid);
            }
            this.modified_rowids.clear();

            if(this.debug_screenshots)
            {
                console.log("--- Snapshot " + zeropad(this.snapshot_count++) +
                    " -----------------------------------------------------------------------");
                for(let i = 0; i < this.screen_rows.length; i++)
                {
                    console.log(zeropad(i) + " | " + this.screen_rows[i] + " |");
                }
            }
            else
            {
                // compare old and new screens to capture new rows
                this.capture_changed_rows(old_screen_rows, this.screen_rows);
            }
        }

        this.timeout_h = setTimeout(() => this.check_screen(), this.CAPTURE_INTERVAL_MSEC);
    }

    capture_changed_rows(old_rows, new_rows)
    {
        const new_bottom_rowid = this.find_bottom_rowid(new_rows);
        if(new_bottom_rowid === undefined)
        {
            // new screen is empty: no rows have changed
            return;
        }

        let new_top_rowid;
        const old_bottom_rowid = this.find_bottom_rowid(old_rows);
        if(old_bottom_rowid !== undefined)
        {
            // both screens are not empty
            if(!old_bottom_rowid)
            {
                // only the bottom line of old_rows[] is at the very top of new_rows[]: accept
                new_top_rowid = new_bottom_rowid - 1;
            }
            else
            {
                // find bottom offset in new_rows[] where old and new intersect
                new_top_rowid = this.find_intersect_end(old_rows, old_bottom_rowid, new_rows, new_bottom_rowid);
            }
        }

        if(new_top_rowid !== undefined)
        {
            // rows in new_rows[new_top_rowid : new_bottom_rowid] have changed (1st) or are new (rest)
            this.rows_handler(new_rows, new_top_rowid, new_bottom_rowid + 1, false);
        }
        else
        {
            // all rows in new_rows[ : new_bottom_rowid] are new
            this.rows_handler(new_rows, 0, new_bottom_rowid + 1, true);
        }
    }

    find_bottom_rowid(rows)
    {
        // return index of first non-empty row in rows[] in reverse order
        for(let i = rows.length - 1; i >= 0; i--)
        {
            if(rows[i] !== this.EMPTY_ROW_80)
            {
                return i;
            }
        }
        return undefined;
    }

    find_intersect_end(old_rows, old_bottom_rowid, new_rows, new_bottom_rowid)
    {
        // find bottom offset in new_rows[] where old and new intersect
        const old_anchor_row = old_rows[old_bottom_rowid - 1];
        for(let i_new = new_bottom_rowid - 1; i_new >= 0; i_new--)
        {
            i_new = this.find_reverse(old_anchor_row, new_rows, i_new);
            if(i_new >= 0)
            {
                if(this.rows_match_reverse(old_rows, old_bottom_rowid - 2, new_rows, i_new - 1))
                {
                    return i_new + 1;
                }
            }
        }
        return undefined;
    }

    find_reverse(text, rows, offset)
    {
        // search for text in rows[] starting at offset in reverse order
        for(let i = offset; i >= 0; i--)
        {
            if(rows[i] === text)
            {
                return i;
            }
        }
        return -1;
    }

    rows_match_reverse(lhs_rows, lhs_offset, rhs_rows, count)
    {
        // return true if lhs_rows[lhs_offset-count : lhs_offset ] === rhs_rows[0 : count]
        lhs_offset -= count;
        for(let i = 0; i < count; i++)
        {
            if(lhs_rows[lhs_offset + i] !== rhs_rows[i])
            {
                return false;
            }
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// class StdinHandler
// ---------------------------------------------------------------------------

class StdinHandler
{
    // Map ANSI escape sequences of specific keys to their respective scancodes
    ANSI_TO_SCANCODE = {
        "\u001b[11~": 0x3b,     // F1
        "\u001b[12~": 0x3c,     // F2
        "\u001b[13~": 0x3d,     // F3
        "\u001b[14~": 0x3e,     // F4
        "\u001b[15~": 0x3f,     // F5
        "\u001b[17~": 0x40,     // F6
        "\u001b[18~": 0x41,     // F7
        "\u001b[19~": 0x42,     // F8
        "\u001b[20~": 0x43,     // F9
        "\u001b[21~": 0x44,     // F10
        "\u001b[23~": 0x57,     // F11
        "\u001b[24~": 0x58,     // F12

        "\u001b[A": 0xe048,     // ArrowUp
        "\u001b[B": 0xe050,     // ArrowDown
        "\u001b[C": 0xe04d,     // ArrowRight
        "\u001b[D": 0xe04b,     // ArrowLeft

        "\u001b[1~": 0xe047,    // Home
        "\u001b[2~": 0xe052,    // Insert
        "\u001b[3~": 0xe053,    // Delete
        "\u001b[4~": 0xe04f,    // End
        "\u001b[5~": 0xe049,    // PageUp
        "\u001b[6~": 0xe051,    // PageDown
    };

    ANSI_ERASE_TO_EOL = "\u001b[0K";

    // CTRL+C scancode sequence
    CTRL_C_SCANCODES = [
        0x1D,        // press CTRL
        0x2E,        // press C
        0x2E | 0x80, // release C
        0x1D | 0x80, // release CTRL
    ];

    constructor(ctrl_c_handler)
    {
        this.ctrl_c_handler = ctrl_c_handler;
        this.emulator = undefined;
        this.ctrl_c_count = undefined;
        this.stdin_handler = input => this.handle_stdin(input);
    }

    start(emulator)
    {
        if(this.emulator === undefined)
        {
            this.emulator = emulator;
            this.ctrl_c_count = 0;
            if(process.stdin.isTTY)
            {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", this.stdin_handler);
        }
    }

    stop()
    {
        if(this.emulator !== undefined)
        {
            process.stdin.removeListener("data", this.stdin_handler);
            if(process.stdin.isTTY)
            {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            this.emulator = undefined;
        }
    }

    async handle_stdin(input)
    {
        if(input.startsWith("\u001b["))
        {
            // handle ANSI escape sequence
            const scancode = this.ANSI_TO_SCANCODE[input];
            if(scancode !== undefined)
            {
                await emulator.keyboard_send_scancodes(this.encode_scancode_keypress(scancode));
            }
            else
            {
                console.warn("\nUnhandled ANSI sequence:", JSON.stringify(input));
            }
            return;
        }

        for(let i = 0; i < input.length; i++)
        {
            let ch = input.charCodeAt(i);
            if(ch === 3)
            {
                // CTRL+C pressed
                this.ctrl_c_handler(this.ctrl_c_count++);
                if(this.ctrl_c_count === 1)
                {
                    continue;
                }
                else
                {
                    return;
                }
            }

            if(this.ctrl_c_count)
            {
                // send buffered CTRL+C, silently drop ch
                this.ctrl_c_count = 0;
                await this.emulator.keyboard_send_scancodes(this.CTRL_C_SCANCODES, 10);
                continue;
            }

            if(ch === 127)
            {
                // map DEL (127) to BACKSPACE (8), depends on the keyboard hardware layout
                ch = 8;
            }

            if(ch < 32)
            {
                await this.emulator.keyboard_send_keys([ch], 10);
            }
            else
            {
                await this.emulator.keyboard_send_text(input[i], 10);
            }
        }
    }

    encode_scancode_keypress(scancode)
    {
        // press, then release key with given 8- or 16-bit scancode
        return scancode < 0x100 ?
            [ scancode,
              scancode | 0x80 ] :
            [ scancode >> 8, scancode & 0xff,
              scancode >> 8, (scancode & 0xff) | 0x80 ];
    }
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

function parse_cli()
{
    // CLI is based on v86-system: https://www.npmjs.com/package/v86-system
    const vga2tty_version = "vga2tty 0.1";
    const normalized_args = process.argv.slice(2).map(arg =>
        arg.startsWith("-") &&
        !arg.startsWith("--") &&
        arg.length > 2
            ? "--" + arg.slice(1)   // turn `-name` into `--name`
            : arg
    );

    // Parse command line arguments using built-in Node.js parseArgs
    const { values, positionals } = parseArgs({
        args: normalized_args,
        strict: true,
        options: {
            // Memory options
            mem: { type: "string", short: "m", default: "512M" },
            vgamem: { type: "string", default: "64M" },
            // Storage options
            hda: { type: "string" },
            hdb: { type: "string" },
            fda: { type: "string" },
            fdb: { type: "string" },
            cdrom: { type: "string" },
            // Boot options
            boot: { type: "string", default: "c" },
            kernel: { type: "string" },
            initrd: { type: "string" },
            append: { type: "string" },
            // System options
            v86dir: { type: "string", default: path.join(__dirname, "../v86") },
            v86wasm: { type: "string" },
            bios: { type: "string" },
            vgabios: { type: "string" },
            acpi: { type: "boolean", default: false },
            fastboot: { type: "boolean", default: false },
            // Network options
            netdev: { type: "string" },
            // VirtFS options
            virtfs: { type: "string" },
            // Other options
            verbose: { type: "boolean", default: false },
            debug_screenshots: { type: "boolean", default: false },
            // Standard options
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
        }
    });

    if(values.help)
    {
        console.log(vga2tty_version);
        console.log("");
        console.log("Usage:");
        console.log("  vga2tty.js [options]");
        console.log("");
        console.log("Memory options:");
        console.log("  -m, --mem SIZE        Set memory size (default: 512M)");
        console.log("  -vgamem SIZE          Set VGA memory size (default: 64M)");
        console.log("");
        console.log("Storage options:");
        console.log("  -hda FILE             Primary hard disk image");
        console.log("  -hdb FILE             Secondary hard disk image");
        console.log("  -fda FILE             Floppy disk A image");
        console.log("  -fdb FILE             Floppy disk B image");
        console.log("  -cdrom FILE           CD-ROM image");
        console.log("");
        console.log("Boot options:");
        console.log("  -boot ORDER           Boot order (a,b,c,d,n) (default: c)");
        console.log("  -kernel FILE          Linux kernel image (bzImage)");
        console.log("  -initrd FILE          Initial ramdisk image");
        console.log("  -append STRING        Kernel command line");
        console.log("");
        console.log("System options:");
        console.log("  -v86dir PATH          V86 standard installation directory (default: ../v86/)");
        console.log("  -v86wasm FILE         V86 wasm file path (default: <v86dir>/build/v86.wasm)");
        console.log("  -bios FILE            BIOS image file (default: <v86dir>/bios/seabios.bin)");
        console.log("  -vgabios FILE         VGA BIOS image file (default: <v86dir>/bios/vgabios.bin)");
        console.log("  -acpi                 Enable ACPI (default: off)");
        console.log("  -fastboot             Enable fast boot");
        console.log("");
        console.log("Network options:");
        console.log("  -netdev CONFIG        Network device configuration");
        console.log("");
        console.log("VirtFS options:");
        console.log("  -virtfs CONFIG        VirtFS configuration");
        console.log("");
        console.log("Other options:");
        console.log("  -verbose              Show additional output");
        console.log("  -debug_screenshots    Show VGA screenshots instead of normal output");
        console.log("");
        console.log("Standard options:");
        console.log("  -h, --help            Show help");
        console.log("  -v, --version         Show version");
        console.log("");
        console.log("Examples:");
        console.log("  vga2tty.js -hda disk.img");
        console.log("  vga2tty.js -m 1G -hda disk.img -cdrom boot.iso");
        console.log("  vga2tty.js -kernel vmlinuz -initrd initrd.img -append \"console=ttyS0\"");
        console.log("  vga2tty.js -hda disk.img -netdev user,type=virtio,relay_url=ws://localhost:8777");
        console.log("");
        return;
    }
    else if(values.version)
    {
        console.log(vga2tty_version);
        return;
    }

    // Helper functions
    const assign_image_url = (argv_name, v86_name) => {
        if(values[argv_name]) {
            v86_config[v86_name || argv_name] = { url: path.resolve(values[argv_name]) };
        }
    };
    const assign_value = (argv_name, v86_name) => {
        if(values[argv_name]) {
            v86_config[v86_name || argv_name] = values[argv_name];
        }
    };
    const assign_mem = (argv_name, v86_name) => {
        if(values[argv_name]) {
            const match = values[argv_name].match(/^(\d+(?:\.\d+)?)([KMGT]?)$/i);
            if(!match)
            {
                throw new Error(`Invalid memory size format: ${values[argv_name]}`);
            }
            const value = parseFloat(match[1]);
            const unit = match[2].toUpperCase();
            const multipliers = {
                "": 1024 * 1024, // Default to MB if no unit
                "B": 1,
                "K": 1024,
                "M": 1024 * 1024,
                "G": 1024 * 1024 * 1024,
                "T": 1024 * 1024 * 1024 * 1024,
            };
            v86_config[v86_name || argv_name] = Math.floor(value * multipliers[unit]);
        }
    };
    const assign_bootorder = (argv_name, v86_name) => {
        if(values[argv_name] && values[argv_name] !== "c") {
            const bootMap = {
                "a": 0x01, // Floppy A
                "b": 0x02, // Floppy B
                "c": 0x80, // Hard disk
                "d": 0x81, // CD-ROM
                "n": 0x82, // Network
            };
            // For now, just return the first boot device
            // V86 uses different boot order values than qemu
            const firstChar = bootStr?.charAt(0);
            v86_config[v86_name || argv_name] = bootMap[firstChar] || 0x80; // Default to hard disk
        }
    };
    const assign_net_device = (argv_name, v86_name) => {
        if(values[argv_name]) {
            const parts = values[argv_name].split(",");
            const mode = parts.shift();
            if(mode === "user") {
                v86_config[v86_name || argv_name] = Object.fromEntries(parts.map(item => item.split("=")));
            }
        }
    };
    const assign_virtfs = (argv_name, v86_name) => {
        if(values[argv_name]) {
            const filesystem = {};
            const parts = values[argv_name].split(",");
            const mode = parts.shift();
            if(mode === "proxy") {
                filesystem.proxy_url = parts.shift();
            }
            v86_config[v86_name || argv_name] = filesystem;
        }
    };

    // parse command line options of v86_config
    const v86_config = {
        wasm_path: values.v86wasm || path.join(values.v86dir, "build", "v86.wasm"),
        bios: { url: values.bios || path.join(values.v86dir, "bios", "seabios.bin") },
        vga_bios: { url: values.vgabios || path.join(values.v86dir, "bios", "vgabios.bin") },
        log_level: 0,
        autostart: true
    };
    assign_mem("mem", "memory_size");
    assign_mem("vgamem", "vga_memory_size");
    assign_image_url("hda");
    assign_image_url("hdb");
    assign_image_url("fda");
    assign_image_url("fdb");
    assign_image_url("cdrom");
    assign_image_url("kernel", "bzimage");
    assign_image_url("initrd");
    assign_value("append", "cmdline");
    assign_bootorder("boot", "boot_order");
    assign_value("acpi");
    assign_value("fastboot");
    assign_net_device("netdev", "net_device");
    assign_virtfs("virtfs", "filesystem");

    // return the setup object
    return {
        v86_config: v86_config,
        debug_screenshots: values.debug_screenshots,
        verbose: values.verbose
    };
}

async function main(setup)
{
    const ANSI_ERASE_TO_EOL = "\u001b[0K";

    // create VgaObserver instance
    const rows_handler = (rows, start, end, all_new) => {
        let output = [all_new ? "\n" : "\r"];
        for(let i = start; i < end - 1; i++)
        {
            output.push(rows[i], "\n");
        }
        output.push(rows[end - 1].trimRight(), ANSI_ERASE_TO_EOL);
        process.stdout.write(output.join(""));
    };
    const vga_observer = new VgaObserver(rows_handler, setup.debug_screenshots);

    // create StdinHandler instance
    const ctrl_c_handler = ctrl_c_count => {
        if(ctrl_c_count === 0)
        {
            process.stdout.write("\nPress CTRL+C again to exit\n");
        }
        else
        {
            process.stdout.write("Terminated by user\n");
            emulator.stop();
        }
    };
    const stdin_handler = new StdinHandler(ctrl_c_handler);

    // create V86 instance
    const emulator = new V86(setup.v86_config);

    // wait for emulator to start
    await new Promise(resolve => emulator.bus.register("emulator-started", () => resolve()));
    vga_observer.start(emulator);
    stdin_handler.start(emulator);

    // wait for emulator to stop
    await new Promise(resolve => emulator.bus.register("emulator-stopped", () => resolve()));
    vga_observer.stop();
    stdin_handler.stop();
    await emulator.destroy();
}

const setup = parse_cli();
if(setup)
{
    if(setup.verbose)
    {
        console.log("setup:", setup);
    }
    await main(setup);
}
