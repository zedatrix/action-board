// Render the SVG with an existing FFmpeg build that includes the librsvg decoder.
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const render = promisify(execFile);
const formats = [[16, "icp4"], [32, "icp5"], [64, "icp6"], [128, "ic07"], [256, "ic08"], [512, "ic09"], [1024, "ic10"]];

function header(type, size) {
  const bytes = Buffer.alloc(8);
  bytes.write(type, 0, "ascii");
  bytes.writeUInt32BE(size + bytes.length, 4);
  return bytes;
}

async function build() {
  const folder = await mkdtemp(join(tmpdir(), "action-board-icon-"));
  try {
    const chunks = [];
    for (const [size, type] of formats) {
      const out = join(folder, `icon-${size}.png`);
      await render("ffmpeg", [
        "-loglevel", "error", "-c:v", "librsvg", "-width", String(size), "-height", String(size),
        "-i", join(__dirname, "action-board-icon.svg"), "-frames:v", "1", "-threads", "1", out,
      ]);
      const png = await readFile(out);
      chunks.push(header(type, png.length), png);
    }
    const body = Buffer.concat(chunks);
    await writeFile(join(__dirname, "icon.icns"), Buffer.concat([header("icns", body.length), body]));
    const png = await readFile(join(folder, "icon-256.png"));
    await writeFile(join(__dirname, "icon.png"), png);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

build().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
