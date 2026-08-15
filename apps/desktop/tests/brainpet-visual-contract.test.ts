import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const petWindow = readFileSync(resolve(desktopRoot, "src/pet-window.ts"), "utf8");
const petWindowCss = petWindow.slice(petWindow.indexOf("function createPetWindowCss"), petWindow.indexOf("function createSpriteStateCss"));
const primaryCompanionUi = readFileSync(resolve(desktopRoot, "src/primary-companion-ui.ts"), "utf8");
const stageCss = readFileSync(resolve(desktopRoot, "src/renderer/src/brainpet/stage.css"), "utf8");
const stageMain = readFileSync(resolve(desktopRoot, "src/renderer/src/brainpet/main.ts"), "utf8");
const stageHtml = readFileSync(resolve(desktopRoot, "src/renderer/brainpet.html"), "utf8");
const stageHost = readFileSync(resolve(desktopRoot, "src/brainpet/host.ts"), "utf8");
const stagePreload = readFileSync(resolve(desktopRoot, "brainpet-preload.cjs"), "utf8");
const petPreload = readFileSync(resolve(desktopRoot, "pet-preload.cjs"), "utf8");
const fusionPixelFontPath = resolve(desktopRoot, "assets/FusionPixel12ProportionalSC.woff2");
const fusionPixelLicense = readFileSync(resolve(desktopRoot, "assets/FusionPixelFont.OFL-1.1.txt"), "utf8");

test("pet accessory and stage share the frozen V1 palette and pixel treatment", () => {
  for (const token of ["#17243b", "#f5bd3d", "#d9952f"]) {
    assert.match(petWindow, new RegExp(token));
    assert.match(stageCss, new RegExp(token));
  }
  assert.match(petWindow, /brainpet-trigger[\s\S]*width: 30px; height: 30px/);
  assert.match(petWindow, /class="brainpet-gem"/);
  assert.doesNotMatch(petWindow, /<span[^>]*>B<\/span>/);
  assert.match(petWindow, /image-rendering: pixelated/);
  assert.match(stageCss, /image-rendering: pixelated/);
});

test("BrainPet embeds the licensed Simplified Chinese and Latin pixel font", () => {
  assert.equal(statSync(fusionPixelFontPath).size > 500_000, true, "embedded font must be the full CJK build rather than a tiny Latin-only fallback");
  assert.match(fusionPixelLicense, /Copyright \(c\) 2022, TakWolf/);
  assert.match(fusionPixelLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(stageCss, /@font-face\s*\{[^}]*Fusion Pixel 12px Proportional SC[^}]*FusionPixel12ProportionalSC\.woff2/);
  assert.match(stageCss, /font-synthesis:none/);
  assert.match(stageCss, /\.tutorial-copy>span\{[^}]*font:400 10px/);
  assert.match(stageCss, /\.minimal-result strong\{[^}]*font:400 20px/);
  assert.match(petWindow, /FusionPixel12ProportionalSC\.woff2/);
  assert.match(petWindow, /@font-face \{ font-family: "BrainPet Pixel";[^\n]*format\("woff2"\)/);
});

test("the host applies one pixel UI contract to built-in and installed pets", () => {
  const bubbleRule = petWindowCss.match(/^\s*\.bubble \{.*$/m)?.[0] ?? "";
  const actionRule = petWindowCss.match(/^\s*\.bubble-action \{.*$/m)?.[0] ?? "";
  const inputRule = petWindowCss.match(/^\s*\.bubble-input-control \{.*$/m)?.[0] ?? "";
  const pinnedRule = petWindowCss.slice(petWindowCss.indexOf(".bubble.is-pinned {"), petWindowCss.indexOf(".bubble.is-pinned::after"));
  assert.equal((petWindow.match(/data-pet-ui-theme="pixel"/g) ?? []).length, 2, "both pet render paths must opt into the host pixel theme");
  assert.match(petWindowCss, /--pet-ui-font: "BrainPet Pixel"/);
  assert.match(petWindowCss, /font-synthesis: none/);
  assert.match(bubbleRule, /font: normal 10px\/13px var\(--pet-ui-font\).*border: 3px solid var\(--pet-ui-ink\).*border-radius: 0.*box-shadow: 4px 4px 0/);
  assert.match(actionRule, /border: 2px solid var\(--pet-ui-ink\).*border-radius: 0.*var\(--pet-ui-font\)/);
  assert.match(inputRule, /border: 2px solid var\(--pet-ui-ink\).*border-radius: 0.*var\(--pet-ui-font\)/);
  assert.match(pinnedRule, /background: var\(--pet-ui-paper\)[\s\S]*border-radius: 0[\s\S]*box-shadow: 4px 4px 0/);
  assert.doesNotMatch(petWindowCss, /\bInter\b|ui-sans-serif|linear-gradient|backdrop-filter/);
});

test("primary companion controls stay compact, pixel-styled, and capability honest", () => {
  assert.match(petWindow, /class="primary-companion-badge status-/);
  assert.match(petWindow, /class="primary-companion-tray"/);
  assert.match(primaryCompanionUi, /summary\.items\.slice\(0, limit\)/);
  assert.match(petWindow, /data-companion-dismiss/);
  assert.match(petPreload, /brainpet:companionTrayToggled/);
  assert.match(petPreload, /brainpet:companionActivityDismissed/);
  assert.match(petPreload, /brainpet:companionActionRequested/);
  assert.match(petWindow, /class="primary-companion-request/);
  assert.match(petWindow, /--pet-ui-font/);
  assert.match(petWindow, /Broker tokens and user replies never enter the plugin event bus/);
  assert.doesNotMatch(petWindow, /data-companion-(allow|deny|stop|reply)/);
});

test("V1 visual and sound states have explicit production behavior", () => {
  assert.match(petWindow, /brainpet-gem-ready 480ms/);
  for (const state of ["clear", "streak", "new-best"]) assert.match(petWindow, new RegExp(`brainpet-feedback="${state}"`));
  assert.match(stageMain, /default-pet-spritesheet\.webp/);
  for (const sound of ["start", "correct", "incorrect", "finish"]) assert.match(stageMain, new RegExp(`${sound}:`));
  assert.doesNotMatch(stageMain, /placeholder|lorem ipsum/i);
});

test("BrainPet stage permits only the internal custom-pet image schemes", () => {
  assert.match(stageHtml, /img-src[^;]*openpets-codex:[^;]*openpets-installed:/);
  assert.match(stageHtml, /font-src 'self'/);
  assert.match(stageHtml, /script-src 'self'; style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(stageHtml, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(stageHtml, /img-src[^;]*https:/);
  assert.doesNotMatch(stageHtml, /font-src[^;]*https:/);
});

test("desktop overlay paints no full-window card and passes through transparent pixels", () => {
  assert.match(stageCss, /Desktop overlay mode/);
  assert.match(stageCss, /\.stage-card\{[^}]*background:transparent;[^}]*box-shadow:none/);
  assert.match(stageCss, /\.stage-scene\{[^}]*background:transparent;[^}]*box-shadow:none/);
  assert.match(stageMain, /INTERACTIVE_SELECTOR/);
  assert.match(stagePreload, /brainpet:stage-interactive/);
  assert.match(stageHost, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
  assert.match(stageCss, /--brainpet-playfield-x/);
  assert.match(stageMain, /data-rig-drag-surface/);
  assert.match(stageMain, /rig\.throwOriginScreen/);
  assert.match(stageMain, /rig\.reactionBoundsScreen/);
  assert.match(stagePreload, /brainpet:rig-drag-start/);
  assert.match(stageHost, /stageWindow\.focus\(\);[\s\S]*rig-drag-end/);
});

test("cargo signal is rendered as a real overlay scene rather than a symbol card", () => {
  assert.match(stageCss, /\[data-scene="cargo-toss"\]/);
  assert.match(stageCss, /\[data-asset="cargo-dock"\]/);
  assert.match(stageMain, /data-asset=/);
  assert.match(stageMain, /data-rig-projectile-input=/);
  assert.match(stageCss, /\.rig-projectile\{/);
  assert.match(stageMain, /focusMode \? "" : `<div class="task-copy">/);
  assert.doesNotMatch(stageMain, /focus-hud/);
  assert.match(stageMain, /score-pop/);
  assert.match(stageMain, /minimal-result/);
  assert.match(stageCss, /\.focus-stage \.task-layout/);
  assert.match(stageMain, /stage-input-surface/);
  assert.match(stageMain, /if \(!pointer\.dragging && pointer\.input\)[\s\S]*sendInput\(pointer\.input\)/);
  assert.match(stageMain, /reaction-panel/);
  assert.match(stageMain, /bootstrap\.mode === "stage-exerciser"/);
  assert.match(stageMain, /点击 \/ SPACE 开始/);
  assert.match(stageMain, /setTimeout\(\(\) => \{ void startTask\(currentSession\); \}, 650\)/);
  assert.doesNotMatch(stageMain, /session\.level === 1/);
  assert.match(stageHost, /toggleBrainPetStage\(anchor[\s\S]*"plugin-command"\)/);
  assert.match(stageHost, /openpets:brainpet-stage-state/);
  assert.match(petPreload, /brainpetStageOpen/);
  assert.match(stageCss, /\.stage-input-surface\{[^}]*background:transparent/);
  assert.match(stageCss, /--pixel-font/);
  assert.match(stageHost, /rig\.stageBoundsScreen, 3/);
  assert.match(stagePreload, /brainpet:pet-throw/);
  assert.match(petPreload, /openpets:brainpet-throw/);
  assert.match(petWindow, /brainpet-throw-right/);
  assert.match(stageHost, /showMessage: false/);
});
