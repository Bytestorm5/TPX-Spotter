#!/usr/bin/env node
/**
 * `trusplex` — the Trusplex CLI as shipped with @trusplex/spotter.
 *
 *   npx trusplex spotter init   [--project pk_…] [--secret sk_…] [--no-install] [--cwd dir]
 *   npx trusplex spotter doctor [--cwd dir]
 *
 * Plain Node ESM with no dependencies.
 */
import { resolve } from "node:path";
import { doctor, printFindings } from "./doctor.ts";
import { init } from "./init.ts";

const HELP = `Usage:
  trusplex spotter init    Install Spotter into a Next.js app
      --project <pk_…>     Public project key (default: placeholder in .env.local)
      --secret <sk_…>      Secret key (written to .env.local, server only)
      --no-install         Don't run the package manager
  trusplex spotter doctor  Check config, keys, CSP, route handler, source maps and bundle impact
  --cwd <dir>              App root (default: current directory)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const [product, command, ...rest] = argv;
  if (!product || product === "--help" || product === "-h" || product !== "spotter") {
    console.log(HELP);
    return product && product !== "--help" && product !== "-h" ? 1 : 0;
  }
  const root = resolve(flag(rest, "--cwd") ?? process.cwd());
  switch (command) {
    case "init":
      return init({ root, install: !rest.includes("--no-install"), project: flag(rest, "--project"), secretKey: flag(rest, "--secret") });
    case "doctor":
      console.log(`Spotter doctor — ${root}\n`);
      return printFindings(doctor(root));
    default:
      console.log(HELP);
      return command ? 1 : 0;
  }
}

process.exitCode = main(process.argv.slice(2));
