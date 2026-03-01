import pc from "picocolors";
import { WHISPER_MODEL_PATH } from "../src/config";
import { dirname } from "node:path";

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";

const cmds = [
  { cmd: "yt-dlp", brew: "yt-dlp" },
  { cmd: "ffmpeg", brew: "ffmpeg" },
  { cmd: "whisper-cli", brew: "whisper-cpp" },
  { cmd: "claude", install: "curl -fsSL https://claude.ai/install.sh | sh" },
  { cmd: "op", brew: "1password-cli" },
] as const;

type MissingCmd = (typeof cmds)[number];
const missingCmds: MissingCmd[] = [];
let modelMissing = false;

for (const dep of cmds) {
  const found = !!Bun.which(dep.cmd);
  console.log(found ? pc.green(`✓ ${dep.cmd}`) : pc.red(`✗ ${dep.cmd} not found`));
  if (!found) missingCmds.push(dep);
}

const modelLabel = `whisper model (${WHISPER_MODEL_PATH})`;
if (await Bun.file(WHISPER_MODEL_PATH).exists()) {
  console.log(pc.green(`✓ ${modelLabel}`));
} else {
  console.log(pc.red(`✗ ${modelLabel} not found`));
  modelMissing = true;
}

if (missingCmds.length === 0 && !modelMissing) process.exit(0);

console.log();
const answer = prompt("Install missing dependencies? (y/n)");
if (answer?.toLowerCase() !== "y") process.exit(1);

const brewPkgs = missingCmds.filter((d) => "brew" in d).map((d) => d.brew);
const shellCmds = missingCmds.filter((d) => "install" in d);

if (brewPkgs.length > 0) {
  console.log(`\nInstalling ${brewPkgs.join(", ")} via brew...`);
  const proc = Bun.spawnSync(["brew", "install", ...brewPkgs], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    console.error(pc.red("brew install failed"));
    process.exit(1);
  }
}

for (const dep of shellCmds) {
  console.log(`\nInstalling ${dep.cmd}...`);
  const proc = Bun.spawnSync(["bash", "-c", dep.install], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    console.error(pc.red(`${dep.cmd} install failed`));
    process.exit(1);
  }
}

if (modelMissing) {
  console.log(`\nDownloading whisper model to ${WHISPER_MODEL_PATH}...`);
  await Bun.spawn(["mkdir", "-p", dirname(WHISPER_MODEL_PATH)]).exited;
  const proc = Bun.spawnSync(
    ["curl", "-L", "-o", WHISPER_MODEL_PATH, WHISPER_MODEL_URL],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (proc.exitCode !== 0) {
    console.error(pc.red("whisper model download failed"));
    process.exit(1);
  }
}

console.log(pc.green("\nAll dependencies installed."));
