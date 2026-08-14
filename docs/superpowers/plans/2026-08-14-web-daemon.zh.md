# Web 鍚庡彴鍚姩瀹炴柦璁″垝

[English](2026-08-14-web-daemon.md) | 涓枃

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**鐩爣锛?* 澧炲姞璺ㄥ钩鍙扮殑 `dsh web --daemon` 涓?`dsh web --background` 鍒悕锛屼娇鐜版湁 Web profile 鍦ㄨ皟鐢ㄧ粓绔箣澶栬繍琛屻€?
**鏋舵瀯锛?* CLI 杈呭姪妯″潡鍙湪閫変腑 Web profile 鍚庤瘑鍒埆鍚嶏紝鍦ㄩ噸鏂版墽琛?CLI 鍓嶇Щ闄ゅ畠浠紝骞朵互绉佹湁鏂囦欢鎵挎帴杈撳嚭鐨勬柟寮忓惎鍔ㄨ劚绂荤粓绔殑 Node 瀛愯繘绋嬨€傚瓙杩涚▼娌跨敤鐜版湁 Web profile 鍚姩璺緞锛涙搷浣滅郴缁熺‘璁ゅ惎鍔ㄥ悗锛岀埗杩涚▼杈撳嚭 PID 鍜屾棩蹇楄矾寰勫苟閫€鍑恒€?
**鎶€鏈爤锛?* Node.js 22 瀛愯繘绋嬪拰鏂囦欢绯荤粺 API銆乀ypeScript銆丆ommander銆乂itest銆佺幇鏈夊凡鏋勫缓 CLI smoke 鍩虹璁炬柦浠ュ強閰嶅 Markdown銆?
## 鍏ㄥ眬绾︽潫

- `--daemon` 鍜?`--background` 鏄粎閫傜敤浜?Web 鐨勭瓑浠峰埆鍚嶏紱鍚屼竴娆¤皟鐢ㄥ悓鏃朵紶鍏ヤ袱涓埆鍚嶄篃鍙垱寤轰竴涓瓙杩涚▼銆?- 鍦ㄥ瓙杩涚▼涓繚鎸佸墠鍙?Web 鍚姩銆乭ost銆乸ort銆佷俊浠汇€佸氨缁拰鍏抽棴璺緞涓嶅彉銆?- `--help` 浼樺厛锛氱Щ闄ゅ悗鍙板埆鍚嶃€佹墦鍗板府鍔┿€佷笉鍒涘缓瀛愯繘绋嬨€?- 浣跨敤鑴辩缁堢鐨勫瓙杩涚▼锛屽拷鐣?stdin锛屽皢绉佹湁杈撳嚭鍐欏叆 `$DSH_HOME/logs/`锛岃缃?`windowsHide: true`锛屽苟鍦?`spawn` 浜嬩欢鍚庤皟鐢?`unref()`銆?- 鐖惰繘绋嬫垚鍔熶粎琛ㄧず瀛愯繘绋嬪凡鍒涘缓锛涙櫘閫氭湇鍔″惎鍔ㄥけ璐ヤ繚鐣欏湪绉佹湁鏃ュ織涓€?- 涓嶅鍔犱緷璧栥€佽繙绋嬬粦瀹氥€佸氨缁疆璇€佹湇鍔＄鐞嗗懡浠ゆ垨鐧诲綍鏃跺惎鍔ㄣ€?- Node 鏀寔淇濇寔 `^22.19.0 || >=24.0.0`銆佷弗鏍?ESM TypeScript銆侀厤瀵规枃妗ｃ€佸凡瀹炵幇 Agent Note銆佽仛鐒﹀崟鍏冭鐩栥€佸凡鏋勫缓 CLI smoke 涓庢棤瀵嗛挜蹇収銆?
---

### 浠诲姟 1锛氭坊鍔犲彲娴嬭瘯鐨勮劚绂荤粓绔惎鍔ㄨ緟鍔╂ā鍧?
**鏂囦欢锛?*

- 鏂板缓锛歕`apps/cli/src/web-daemon.ts`
- 鏂板缓锛歕`apps/cli/tests/web-daemon.spec.ts`

**鎺ュ彛锛?*

- 浜у嚭锛歕`resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean }`銆?- 浜у嚭锛歕`launchWebDaemon(input: { entry: string; patches: readonly string[]; args: readonly string[] }): Promise<{ pid: number; logPath: string }>`銆?- 浜у嚭锛氬彲娉ㄥ叆鐨勬枃浠剁郴缁熷拰瀛愯繘绋嬮€傞厤鍣紱鐢熶骇鐜閫氳繃 `resolveDshHome()` 瑙ｆ瀽 home銆?- 渚涗换鍔?2 浣跨敤锛氫粎鐢?`apps/cli/src/bin.ts` 鐨?`profile === 'web'` 鍒嗘敮璋冪敤銆?
- [ ] **姝ラ 1锛氱紪鍐欏け璐ョ殑鍗曞厓娴嬭瘯**

```ts
expect(resolveWebDaemonInvocation(['--port', '0', '--daemon', '--background']))
  .toEqual({ args: ['--port', '0'], detached: true })
expect(resolveWebDaemonInvocation(['--daemon', '--help']))
  .toEqual({ args: ['--help'], detached: false })

const launched = launchWebDaemon({ entry: '/dsh/bin.js', patches: ['overlay.yml'], args: ['--port', '0'] }, adapters)
child.emit('spawn')
await expect(launched).resolves.toMatchObject({ pid: 417 })
expect(adapters.spawn).toHaveBeenCalledWith(process.execPath, ['/dsh/bin.js', '--profile', 'web', '--patch', 'overlay.yml', '--port', '0'], expect.objectContaining({ detached: true, windowsHide: true, stdio: ['ignore', 9, 9] }))
```

- [ ] **姝ラ 2锛氱‘璁ゆ祴璇曞湪瀹炵幇鍓嶅け璐?*

杩愯锛歕`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts`

棰勬湡锛氬け璐ワ紝鍥犱负 `../src/web-daemon.ts` 涓嶅瓨鍦ㄣ€?
- [ ] **姝ラ 3锛氬疄鐜拌緟鍔╂ā鍧?*

```ts
export function resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean } {
  const requested = args.some(arg => arg === '--daemon' || arg === '--background')
  const cleaned = args.filter(arg => arg !== '--daemon' && arg !== '--background')
  return { args: cleaned, detached: requested && !cleaned.some(arg => arg === '-h' || arg === '--help') }
}
```

浠?owner-only 鏉冮檺鍒涘缓 `$DSH_HOME/logs/`锛岄€氳繃 `mkdtempSync` 鍒涘缓鍞竴瀛愮洰褰曪紝浠ョ嫭鍗?owner-only 妯″紡鎵撳紑 `server.log`锛屽苟鎶婂悓涓€鎻忚堪绗︿紶缁欏瓙杩涚▼ stdout 涓?stderr銆傚瓙杩涚▼ argv 閲嶅缓涓?`['--profile', 'web', ...patches.flatMap(path => ['--patch', path]), ...args]`銆傜瓑寰?`spawn` 鎴?`error`锛屽湪涓ょ璺緞鍏抽棴鐖惰繘绋嬫弿杩扮锛屼粎鍦?`spawn` 鍚庤皟鐢?`unref()`锛屽苟鎶涘嚭鎸囧嚭鏃ュ織鎴栧惎鍔ㄥけ璐ユ搷浣滅殑閿欒銆?
- [ ] **姝ラ 4锛氳繍琛岃仛鐒﹂獙璇?*

杩愯锛歕`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts && pnpm exec tsc -p apps/cli/tsconfig.json --noEmit`

棰勬湡锛氶€氳繃锛涜鐩栧埆鍚嶅綊涓€鍖栥€佸府鍔╀紭鍏堢骇銆侀噸寤?argv銆佽劚绂荤粓绔€夐」銆佹弿杩扮鎵€鏈夋潈鍜屽惎鍔ㄩ敊璇€?
- [ ] **姝ラ 5锛氭彁浜や换鍔?1**

```sh
git add apps/cli/src/web-daemon.ts apps/cli/tests/web-daemon.spec.ts
git commit -m "feat(cli): launch web server in background"
```

### 浠诲姟 2锛氬垎娲?Web 鍒悕骞舵祴璇曞彲瑙佽涓?
**鏂囦欢锛?*

- 淇敼锛歕`apps/cli/src/bin.ts`
- 淇敼锛歕`packages/bundle/web-app/src/startup.ts`
- 淇敼锛歕`packages/bundle/web-app/tests/startup.spec.ts`
- 鏂板缓锛歕`apps/cli/tests/web-daemon.compat.spec.ts`
- 鏂板缓锛歕`apps/cli/tests/web-daemon.snapshot.ts`

**鎺ュ彛锛?*

- 浣跨敤锛氫换鍔?1 鐨?`resolveWebDaemonInvocation()` 鍜?`launchWebDaemon()`銆?- 浜у嚭锛氫娇鐢ㄦ竻鐞嗗悗 args 鐨勫墠鍙?`runProfile()`锛屾垨鐖惰繘绋?stdout `dsh web: started detached process <pid>; log: <path>`銆?- 浜у嚭锛氳褰曚袱涓埆鍚嶇殑甯姪鏂囨湰锛屼絾涓嶅皢瀹冧滑鍔犲叆 `WebStartupValues`銆?- 浣跨敤锛歕`DSH_REQUIRE_BUILT_CLI_SMOKE` 鍜屽瓙杩涚▼ URL 琛?`dsh web: http://127.0.0.1:<port>`銆?
- [ ] **姝ラ 1锛氱紪鍐欏け璐ョ殑鐪熷疄杩涚▼鍜屽府鍔╂祴璇?*

```ts
const parent = await runBuiltBin(['web', '--daemon', '--port', '0'], { DSH_HOME: home })
expect(parent.code).toBe(0)
const [, pid, logPath] = parent.stdout.match(/^dsh web: started detached process (\d+); log: (.+)\n$/u) ?? []
await waitForLogLine(logPath, /dsh web: http:\/\/127\.0\.0\.1:\d+/u)
await expect(fetch(urlFromLog(logPath))).resolves.toMatchObject({ ok: true })
await stopDetachedProcess(Number(pid))
```

鍏煎娴嬭瘯浠呭湪 `DSH_REQUIRE_BUILT_CLI_SMOKE === '1'` 鏃惰繍琛岋紝骞惰姹?`apps/cli/lib/bin.js` 鍜?`apps/web/dist/index.html`銆傚畠浣跨敤鐙珛涓存椂 `DSH_HOME`锛岃疆璇㈠瓙杩涚▼鏃ュ織锛屽湪娓呯悊鍚庡垹闄?home锛沇indows 浣跨敤 `taskkill /PID <pid> /T /F`锛屽叾浠栧钩鍙板彂閫?`SIGTERM` 骞剁瓑寰呫€?
蹇収鏍规嵁 `DSH_EXAMPLE_MODE` 璋冪敤婧愮爜鎴栧凡鏋勫缓 CLI锛屾墽琛?`web --daemon --help` 骞跺揩鐓?`{ code: 0, stderr: '', stdout }`銆傚畠鏂█鍖呭惈涓や釜鍒悕锛屼笉鍖呭惈 PID/鏃ュ織琛屻€?
- [ ] **姝ラ 2锛氱‘璁ゅけ璐?*

杩愯锛歕`pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts --maxWorkers=1 --no-file-parallelism`

棰勬湡锛氬け璐ワ紝鍥犱负 CLI 鏈垎娲捐緟鍔╂ā鍧楋紝甯姪缂哄皯涓や釜鍒悕锛屼笖娌℃湁 PID/鏃ュ織琛屻€?
- [ ] **姝ラ 3锛氳繛鎺ュ垎娲惧拰甯姪**

```ts
const web = invocation.profile === 'web' ? resolveWebDaemonInvocation(invocation.args) : undefined
if (web?.detached) {
  const launched = await launchWebDaemon({ entry: fileURLToPath(import.meta.url), patches: invocation.patches, args: web.args })
  process.stdout.write(`dsh web: started detached process \${String(launched.pid)}; log: \${launched.logPath}\n`)
  break
}
await runProfile({ environment: loadLayeredEnv('dsh'), profile: invocation.profile, patchFiles: invocation.patches, args: web?.args ?? invocation.args })
```

灏嗕袱涓埆鍚嶅姞鍏?Web 甯姪绀轰緥銆備笉瑕佹妸瀹冧滑鍔犲叆 `WebStartupValues`锛屽洜涓哄畠浠湪 Web 琛屽瓨鍦ㄥ墠鏀瑰彉鍚姩鍣ㄨ繘绋嬬敓鍛藉懆鏈熴€?
- [ ] **姝ラ 4锛氭瀯寤哄苟杩愯琛屼负瑕嗙洊**

杩愯锛歕`pnpm run build && pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.spec.ts && DSH_REQUIRE_BUILT_CLI_SMOKE=1 pnpm exec vitest run apps/cli/tests/web-daemon.compat.spec.ts && DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts`

棰勬湡锛氶€氳繃锛涚埗杩涚▼鍦ㄥ惎鍔ㄥ悗閫€鍑猴紝瀛愯繘绋嬫彁渚涘凡鏋勫缓 Web UI锛屽府鍔╂樉绀轰袱涓埆鍚嶏紝涓斿彲瑙佸府鍔╂枃鏈ǔ瀹氥€?
- [ ] **姝ラ 5锛氭彁浜や换鍔?2**

```sh
git add apps/cli/src/bin.ts packages/bundle/web-app/src/startup.ts packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-daemon.snapshot.ts
git commit -m "feat(cli): support detached web launch"
```

### 浠诲姟 3锛氳褰曠敤鎴锋搷浣滃拰宸蹭氦浠樺喅绛?
**鏂囦欢锛?*

- 淇敼锛歕`apps/cli/README.md`銆乗`apps/cli/README.zh.md` 鍜?`apps/cli/README.i18n.yaml`
- 淇敼锛歕`apps/cli/reference/README.md`銆乗`apps/cli/reference/README.zh.md` 鍜?`apps/cli/reference/README.i18n.yaml`
- 淇敼锛歕`packages/bundle/web-app/README.md`銆乗`packages/bundle/web-app/README.zh.md` 鍜?`packages/bundle/web-app/README.i18n.yaml`
- 鏂板缓锛歕`.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`銆乗`.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md` 鍜?`.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml`

**鎺ュ彛锛?*

- 璁板綍锛氬埆鍚嶃€佺埗杩涚▼鎴愬姛璇箟銆丳ID/鏃ュ織杈撳嚭銆佺鏈夋棩蹇椼€佸墠鍙板吋瀹规€у拰瀛愯繘绋嬩俊鍙锋竻鐞嗐€?- 璁板綍锛欳LI 绉婚櫎鍒悕鍚庯紝`web-startup` 浠嶈礋璐?host銆乸ort銆乼rusted-host 鍜屽府鍔┿€?- 璁板綍锛氬叿鏈?Problem銆丏ecision銆丄lternatives considered 鍜?Consequences 鐨勫凡瀹炵幇鍔熻兘 Agent Note銆?
- [ ] **姝ラ 1锛氱‘璁ゆ柊鐨勫喅绛栬褰曚笉瀛樺湪**

杩愯锛歕`pnpm run verify-translation-pairing .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`

棰勬湡锛氬け璐ワ紝鍥犱负 Agent Note 閰嶅涓嶅瓨鍦ㄣ€?
- [ ] **姝ラ 2锛氱紪鍐欓厤瀵圭殑鎿嶄綔鏂囨。鍜?Agent Note**

鍦?CLI 鍏ュ彛鍜?Web 鍒悕鍙傝€冧腑璁板綍 `dsh web --daemon` 涓?`dsh web --background`銆傝鏄庣埗杩涚▼鎴愬姛琛ㄧず鍒涘缓瀛愯繘绋嬭€岄潪灏辩华锛屽瓙杩涚▼ URL 涓庡惎鍔ㄥけ璐ヨ繘鍏ョ鏈夋棩蹇楋紝`--help` 涓嶅垱寤哄瓙杩涚▼锛岃繑鍥炵殑 PID 浣跨敤鏃㈡湁鐨勫瓙杩涚▼娓呯悊銆傛妸鍒悕鎻忚堪涓?CLI 鍦?Web provider 鑾峰緱娓呯悊鍚庡弬鏁板墠娑堣€楃殑鍞竴 Web 杩涚▼鐢熷懡鍛ㄦ湡鎺у埗銆?
浣跨敤浠ヤ笅涓ユ牸绔犺妭椤哄簭鍒涘缓宸插疄鐜?Agent Note锛?
```markdown
# Agent Note: Web daemon launch stays in the CLI

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences
```

璁板綍鎷掔粷涓嶉噸鏂版墽琛岀殑缁堢鑴辩鏂瑰紡鍜屾嫆缁?`status`/`stop` 绠＄悊鍣ㄣ€傝鏄庣鏈夋棩蹇楁槸璇婃柇瀛愯繘绋嬪惎鍔ㄥけ璐ョ殑蹇呯粡浣嶇疆銆?
- [ ] **姝ラ 3锛氶噸鏂拌褰曢厤瀵瑰苟杩愯鏂囨。妫€鏌?*

杩愯锛歕`pnpm run verify-translation-pairing --write apps/cli/README.md apps/cli/reference/README.md packages/bundle/web-app/README.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md && pnpm run doc-sync && git diff --check`

棰勬湡锛氶€氳繃锛涙墍鏈夋洿鏂伴厤瀵瑰潎鍏锋湁鍖归厤缁撴瀯鍜屽綋鍓嶅搱甯岋紝Agent Note 鏍煎紡鏈夋晥锛孧arkdown 妫€鏌ラ€氳繃銆?
- [ ] **姝ラ 4锛氭彁浜や换鍔?3**

```sh
git add apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/cli/reference/README.md apps/cli/reference/README.zh.md apps/cli/reference/README.i18n.yaml packages/bundle/web-app/README.md packages/bundle/web-app/README.zh.md packages/bundle/web-app/README.i18n.yaml .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml
git commit -m "docs: document detached web launch"
```

## 璁″垝鑷煡

- 瑙勬牸瑕嗙洊锛氫换鍔?1 瑕嗙洊褰掍竴鍖栥€佽劚绂荤粓绔惎鍔ㄣ€佺鏈夋棩蹇椼€佸瓙杩涚▼ argv 鍜岀珛鍗宠缃け璐ャ€備换鍔?2 瑕嗙洊浠呴檺 Web 鐨勫垎娲俱€佸府鍔╀紭鍏堢骇銆佹湭鏀瑰彉鐨勫瓙杩涚▼鍚姩銆佺湡瀹炲凡鏋勫缓鏈嶅姟杩炵画鎬у拰鏃犲瘑閽ュ彲瑙佽緭鍑哄揩鐓с€備换鍔?3 瑕嗙洊鎿嶄綔鏂囨。銆侀厤瀵硅褰曞拰蹇呴渶鐨勫姛鑳藉喅绛栥€?- 鍗犱綅绗︽壂鎻忥細姣忎釜浠诲姟閮藉懡鍚嶆枃浠躲€佹帴鍙ｃ€佹祴璇曘€侀鏈熺粨鏋溿€佸疄鐜拌涓哄拰鎻愪氦銆?- 绫诲瀷涓€鑷存€э細浠诲姟 1 瀹氫箟 `resolveWebDaemonInvocation()` 涓?`launchWebDaemon()`锛涗换鍔?2 浣跨敤鐩稿悓鍚嶇О鍜屽瓧娈点€?