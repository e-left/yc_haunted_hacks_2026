import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

try {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  if (!status.API_URL || !status.PUBLISHABLE_KEY) throw new Error("Local Supabase did not return its URL and publishable key.");
  writeFileSync(".env.local", `SUPABASE_URL=${status.API_URL}\nSUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY}\n`, { flag: "wx", mode: 0o600 });
  console.log("Local Supabase configuration written to .env.local.");
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error(".env.local already exists; leave it in place and set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY there if needed.");
  } else {
    console.error("Could not configure local Supabase. Start it with ./dev supabase start and try again.");
  }
  process.exitCode = 1;
}
