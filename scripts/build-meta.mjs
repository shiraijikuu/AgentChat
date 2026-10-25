// 版本口径，只有这一个地方。
//
// VERSION 锁死不动，只递增 BUILD。这条是用户 2026-10-25 指定的，跟 LumEdit 同一套做法：
// 版本号不代表功能多少，build 号代表出了第几包。
//
// 改了这里不用改别处。dist.mjs 读它注入产物版本，应用内显示的版本也从打包后的
// package.json 读（buildNumber 字段由 extraMetadata 写进去）。
export const APP_NAME = 'AgentChat';
export const VERSION = '1.0.0';
export const BUILD = 22;
