import pc from "picocolors";

const deps = ["yt-dlp", "ffmpeg", "whisper-cli", "claude", "op"];

let ok = true;
for (const cmd of deps) {
  const found = !!Bun.which(cmd);
  console.log(found ? pc.green(`✓ ${cmd}`) : pc.red(`✗ ${cmd} not found`));
  if (!found) ok = false;
}
if (!ok) process.exit(1);
