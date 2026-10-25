import fs from 'node:fs';
const p = process.env.APPDATA + '\\Microsoft\\Windows\\Start Menu\\Programs\\AgentChat.lnk';
const buf = fs.readFileSync(p);
const u16 = buf.toString('utf16le');
const m = u16.match(/[A-Za-z]:\\[^\u0000"]*?AgentChat\.exe/);
console.log('UTF-16 命中:', m ? m[0] : '无');
const ansi = buf.toString('latin1');
const m2 = ansi.match(/[A-Za-z]:\\[^\u0000"]*?AgentChat\.exe/);
console.log('ANSI 命中:', m2 ? m2[0] : '无');
