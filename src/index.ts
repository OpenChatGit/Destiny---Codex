#!/usr/bin/env node
import "dotenv/config";
import { runCli } from "./cli.js";

runCli(process.argv).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
