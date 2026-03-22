/**
 * Interactive prompting utilities using node:readline.
 *
 * Only prompts when stdin is a TTY. Returns null otherwise.
 */
import * as readline from "node:readline";

export function isTTY(): boolean {
  return process.stdin.isTTY === true;
}

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptMasked(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute output after question is printed
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(question);

    let input = "";

    // Switch to raw mode for masking
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf-8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r") {
          stdin.setRawMode!(false);
          stdin.removeListener("data", onData);
          stdout.write("\n");
          rl.close();
          resolve(input.trim());
        } else if (char === "\u0003") {
          // Ctrl+C
          rl.close();
          process.exit(1);
        } else if (char === "\u007F" || char === "\b") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
        } else {
          input += char;
          stdout.write("*");
        }
      };

      stdin.on("data", onData);
    } else {
      // Fallback: no raw mode (e.g., piped input)
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}
