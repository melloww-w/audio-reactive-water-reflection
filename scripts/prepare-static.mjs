import { cp, mkdir, rm } from "node:fs/promises";

await rm("public", { recursive: true, force: true });
await mkdir("public", { recursive: true });

await Promise.all([
  cp("index.html", "public/artwork.html"),
  cp("style.css", "public/style.css"),
  cp("sketch.js", "public/sketch.js"),
  cp("shader.vert", "public/shader.vert"),
  cp("shader.frag", "public/shader.frag"),
  cp("rainbow.jpg", "public/rainbow.jpg"),
  cp("assets", "public/assets", { recursive: true }),
]);

