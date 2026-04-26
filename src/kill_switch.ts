// src/kill_switch.ts
import * as fs from "node:fs";
import * as path from "node:path";

const KILL_FILE = path.join(process.cwd(), "data", "kill_switch.flag");

export function getKillFilePath(): string {
  return KILL_FILE;
}

export function isKillEngaged(): boolean {
  return fs.existsSync(KILL_FILE);
}

export function engageKillSwitch() {
  fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
  if (!fs.existsSync(KILL_FILE)) {
    fs.writeFileSync(
      KILL_FILE,
      `KILL ENGAGED AT ${new Date().toISOString()}\n`,
      "utf8"
    );
  }
}

export function clearKillSwitch() {
  if (fs.existsSync(KILL_FILE)) {
    fs.unlinkSync(KILL_FILE);
  }
}
