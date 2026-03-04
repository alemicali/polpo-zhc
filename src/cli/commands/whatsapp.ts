/**
 * CLI commands for WhatsApp integration.
 *
 * polpo whatsapp login [profile]  — Link WhatsApp via QR code scanning
 * polpo whatsapp status           — Check WhatsApp connection status
 * polpo whatsapp logout [profile] — Remove WhatsApp credentials
 *
 * ⚠️  PERSONAL USE ONLY — Uses the unofficial WhatsApp Web protocol (Baileys).
 *     Not the official WhatsApp Business API. Use a dedicated phone number.
 */

import { resolve, join } from "node:path";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";

export function registerWhatsAppCommands(parent: Command): void {
  const wa = parent
    .command("whatsapp")
    .description("Manage WhatsApp connection (personal use — Baileys)");

  // ── polpo whatsapp login [profile] ──

  wa
    .command("login [profile]")
    .description("Link WhatsApp by scanning a QR code")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (profile: string | undefined, opts: { dir: string }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const profileName = profile ?? "default";
      const profilePath = join(polpoDir, "whatsapp-profiles", profileName);
      mkdirSync(profilePath, { recursive: true });

      console.log();
      console.log(chalk.bold("  WhatsApp Login"));
      console.log(chalk.dim(`  Profile:  ${profileName}`));
      console.log(chalk.dim(`  Path:     ${profilePath}`));
      console.log();
      console.log(chalk.yellow("  ⚠  PERSONAL USE ONLY"));
      console.log(chalk.dim("  This uses the unofficial WhatsApp Web protocol (Baileys)."));
      console.log(chalk.dim("  Use a dedicated phone number, not your primary one."));
      console.log(chalk.dim("  For commercial use, implement WhatsApp Business Cloud API."));
      console.log();

      // Check if already authenticated
      const credsFile = join(profilePath, "creds.json");
      if (existsSync(credsFile)) {
        console.log(chalk.green("  Existing credentials found — reconnecting to verify..."));
        console.log();
      }

      try {
        // Dynamic import to avoid loading Baileys at CLI startup
        const { WhatsAppChannel, WhatsAppBridge } = await import("../../notifications/channels/whatsapp.js");

        // Create a temporary channel + bridge for interactive login
        const channel = new WhatsAppChannel(
          { type: "whatsapp", chatId: "0", profileDir: profileName },
          polpoDir,
        );
        const bridge = new WhatsAppBridge(channel, (level, msg) => {
          if (level === "info") console.log(chalk.green(`  ✓ ${msg}`));
          else if (level === "warn") console.log(chalk.yellow(`  ⚠ ${msg}`));
        });

        let qrDisplayed = false;

        console.log(chalk.cyan("  Waiting for QR code..."));
        console.log();

        await bridge.connectInteractive((qr) => {
          if (!qrDisplayed) {
            qrDisplayed = true;
            console.log(chalk.bold("  Scan this QR code with WhatsApp:"));
            console.log(chalk.dim("  Open WhatsApp → Settings → Linked Devices → Link a Device"));
            console.log();
          }

          // Display QR code in terminal using simple block characters
          displayQR(qr);
        });

        console.log();
        console.log(chalk.green.bold("  ✓ WhatsApp linked successfully!"));
        console.log();
        console.log(chalk.dim("  Credentials saved to: " + profilePath));
        console.log(chalk.dim("  The server will auto-connect when started with a WhatsApp channel configured."));
        console.log();
        console.log(chalk.bold("  Add to polpo.json:"));
        console.log();
        console.log(chalk.dim('  "notifications": {'));
        console.log(chalk.dim('    "channels": {'));
        console.log(chalk.dim('      "whatsapp": {'));
        console.log(chalk.dim('        "type": "whatsapp",'));
        console.log(chalk.dim('        "chatId": "YOUR_PHONE_NUMBER",'));
        console.log(chalk.dim(`        "profileDir": "${profileName}",`));
        console.log(chalk.dim('        "gateway": {'));
        console.log(chalk.dim('          "enableInbound": true,'));
        console.log(chalk.dim('          "dmPolicy": "pairing"'));
        console.log(chalk.dim('        }'));
        console.log(chalk.dim('      }'));
        console.log(chalk.dim('    }'));
        console.log(chalk.dim('  }'));
        console.log();

        process.exit(0);
      } catch (err) {
        console.error();
        console.error(chalk.red(`  ✗ Login failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── polpo whatsapp status ──

  wa
    .command("status")
    .description("Check WhatsApp profiles")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((_opts: { dir: string }) => {
      const polpoDir = resolve(_opts.dir, ".polpo");
      const profilesDir = join(polpoDir, "whatsapp-profiles");

      if (!existsSync(profilesDir)) {
        console.log(chalk.dim("\n  No WhatsApp profiles found. Run `polpo whatsapp login` first.\n"));
        return;
      }

      const profiles = readdirSync(profilesDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      if (profiles.length === 0) {
        console.log(chalk.dim("\n  No WhatsApp profiles found.\n"));
        return;
      }

      console.log();
      console.log(chalk.bold("  WhatsApp Profiles"));
      console.log();

      for (const p of profiles) {
        const credsFile = join(profilesDir, p.name, "creds.json");
        const hasAuth = existsSync(credsFile);
        const icon = hasAuth ? chalk.green("●") : chalk.red("○");
        const status = hasAuth ? "authenticated" : "no credentials";
        console.log(`  ${icon} ${p.name} — ${chalk.dim(status)}`);
      }

      console.log();
    });

  // ── polpo whatsapp logout [profile] ──

  wa
    .command("logout [profile]")
    .description("Remove WhatsApp credentials")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((profile: string | undefined, opts: { dir: string }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const profileName = profile ?? "default";
      const profilePath = join(polpoDir, "whatsapp-profiles", profileName);

      if (!existsSync(profilePath)) {
        console.log(chalk.yellow(`\n  Profile "${profileName}" not found.\n`));
        return;
      }

      rmSync(profilePath, { recursive: true, force: true });
      console.log(chalk.green(`\n  ✓ Profile "${profileName}" removed.\n`));
    });
}

// ─── QR Code Display ────────────────────────────

/**
 * Display a QR code in the terminal using the `qrcode` package.
 */
async function displayQR(data: string): Promise<void> {
  try {
    const QRCode = await import("qrcode");
    const str = await QRCode.toString(data, { type: "terminal", small: true });
    // Indent each line
    const lines = str.split("\n").map((line: string) => `    ${line}`);
    console.log(lines.join("\n"));
  } catch {
    // Fallback: print raw data
    console.log(chalk.dim("  QR data for manual scanning:"));
    console.log(chalk.dim(`  ${data}`));
  }
}
