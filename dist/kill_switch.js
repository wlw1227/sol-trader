"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKillFilePath = getKillFilePath;
exports.isKillEngaged = isKillEngaged;
exports.engageKillSwitch = engageKillSwitch;
exports.clearKillSwitch = clearKillSwitch;
// src/kill_switch.ts
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const KILL_FILE = path.join(process.cwd(), "data", "kill_switch.flag");
function getKillFilePath() {
    return KILL_FILE;
}
function isKillEngaged() {
    return fs.existsSync(KILL_FILE);
}
function engageKillSwitch() {
    fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
    if (!fs.existsSync(KILL_FILE)) {
        fs.writeFileSync(KILL_FILE, `KILL ENGAGED AT ${new Date().toISOString()}\n`, "utf8");
    }
}
function clearKillSwitch() {
    if (fs.existsSync(KILL_FILE)) {
        fs.unlinkSync(KILL_FILE);
    }
}
