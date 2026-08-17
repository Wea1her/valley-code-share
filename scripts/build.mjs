import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });

await build({
  entryPoints: ["src/app.ts", "src/admin.ts"],
  bundle: true,
  outdir: "public",
  platform: "browser",
  target: "es2022"
});

for (const file of ["index.html", "admin.html", "styles.css", "admin.css"]) {
  await copyFile(`static/${file}`, `public/${file}`);
}

// Keep the dependency-free Python local server usable after a TypeScript build.
for (const file of ["app.js", "admin.js"]) {
  await copyFile(`public/${file}`, `static/${file}`);
}
