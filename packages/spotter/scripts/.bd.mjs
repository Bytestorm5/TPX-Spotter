import { build } from "esbuild";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
const pkg = process.cwd();
const entry = join(pkg, ".bd-entry.ts");
writeFileSync(entry, `import { spotter } from "./src/core/singleton.ts";\nspotter.init({ project: "pk_live_sizecheck1" });\n(globalThis as any).__s = spotter;\n`);
const r = await build({ entryPoints:{core:entry}, bundle:true, splitting:true, format:"esm", platform:"browser", target:"es2022", minify:true, write:false, metafile:true, outdir: mkdtempSync("/tmp/bd"), define:{__SPOTTER_DEV__:"false","process.env.NODE_ENV":'"production"'}, external:["react","react-dom","react/jsx-runtime","next","next/*","node:*"], logLevel:"silent", legalComments:"none"});
rmSync(entry);
const files = new Map(r.outputFiles.map(f=>[f.path,f.contents]));
for (const [out, m] of Object.entries(r.metafile.outputs)) {
  if (!out.endsWith(".js")) continue;
  const c = files.get(resolve(pkg,out));
  console.log(`\n== ${out} ${m.entryPoint??"shared"} min=${m.bytes} gz=${gzipSync(c,{level:9}).length} imports=${m.imports.map(i=>i.kind[0]+":"+i.path.split("/").pop()).join(",")}`);
  for (const [i, v] of Object.entries(m.inputs).sort((a,b)=>b[1].bytesInOutput-a[1].bytesInOutput)) if (v.bytesInOutput>0) console.log(`   ${String(v.bytesInOutput).padStart(6)} ${i}`);
}
