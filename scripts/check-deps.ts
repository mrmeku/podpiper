import pc from "picocolors";
const WHISPER_MODEL_PATH = `${process.env.HOME}/.whisper-models/ggml-large-v3-turbo.bin`;
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

type YtdlpPkg = { label: string; spec: string; check: (python: string) => boolean };

const ytdlpPkgs: YtdlpPkg[] = [
  {
    label: "curl_cffi (--impersonate chrome)",
    spec: "curl_cffi<0.15",
    check: () => {
      const r = Bun.spawnSync(["yt-dlp", "--list-impersonate-targets"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return r.exitCode === 0 && !r.stdout.toString().includes("(unavailable)");
    },
  },
  {
    label: "bgutil-ytdlp-pot-provider (PO tokens)",
    spec: "bgutil-ytdlp-pot-provider",
    check: (python) => venvHasPackage(python, "bgutil-ytdlp-pot-provider"),
  },
];

function ytdlpPython(): string | null {
  const r = Bun.spawnSync(["brew", "--prefix", "yt-dlp"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  return `${r.stdout.toString().trim()}/libexec/bin/python`;
}

function venvHasPackage(python: string, pkg: string): boolean {
  const r = Bun.spawnSync(
    [python, "-c", `import importlib.metadata as m; m.version("${pkg}")`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return r.exitCode === 0;
}

type MissingCmd = (typeof cmds)[number];
const missingCmds: MissingCmd[] = [];
let missingPkgs: YtdlpPkg[] = [];
let modelMissing = false;

for (const dep of cmds) {
  const found = !!Bun.which(dep.cmd);
  console.log(found ? pc.green(`✓ ${dep.cmd}`) : pc.red(`✗ ${dep.cmd} not found`));
  if (!found) missingCmds.push(dep);
}

let python = Bun.which("yt-dlp") ? ytdlpPython() : null;
if (python) {
  for (const pkg of ytdlpPkgs) {
    const found = pkg.check(python);
    console.log(found ? pc.green(`✓ ${pkg.label}`) : pc.red(`✗ ${pkg.label} not available`));
    if (!found) missingPkgs.push(pkg);
  }
} else {
  for (const pkg of ytdlpPkgs) {
    console.log(pc.yellow(`? ${pkg.label} (will check after yt-dlp is installed)`));
  }
}

const modelLabel = `whisper model (${WHISPER_MODEL_PATH})`;
if (await Bun.file(WHISPER_MODEL_PATH).exists()) {
  console.log(pc.green(`✓ ${modelLabel}`));
} else {
  console.log(pc.red(`✗ ${modelLabel} not found`));
  modelMissing = true;
}

if (
  missingCmds.length === 0 &&
  missingPkgs.length === 0 &&
  !modelMissing &&
  python !== null
) {
  process.exit(0);
}

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

if (!python && Bun.which("yt-dlp")) {
  python = ytdlpPython();
  if (python) {
    missingPkgs = ytdlpPkgs.filter((p) => !p.check(python!));
  }
}

if (missingPkgs.length > 0) {
  if (!python) {
    console.error(pc.red("Could not locate yt-dlp's Python env (expected brew install)."));
    process.exit(1);
  }
  const specs = missingPkgs.map((p) => p.spec);
  console.log(`\nInstalling ${specs.join(", ")} into yt-dlp's venv...`);
  const proc = Bun.spawnSync([python, "-m", "pip", "install", ...specs], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    console.error(pc.red("pip install failed"));
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
