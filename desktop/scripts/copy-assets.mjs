import { copyFile, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

await mkdir(path.join(root, "dist"), { recursive: true });
await copyFile(path.join(root, "src", "index.html"), path.join(root, "dist", "index.html"));

for (const file of ["appPreload.ts", "capturePreload.ts"]) {
  await new Promise((resolve, reject) => {
    exec(
      `npx tsc src/${file} --module commonjs --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --outDir dist --declaration false --sourceMap false`,
      { cwd: root },
      (error, stdout, stderr) => {
        if (error) { reject(error); return; }
        if (stderr) console.warn(stderr);
        resolve(undefined);
      },
    );
  });
}
