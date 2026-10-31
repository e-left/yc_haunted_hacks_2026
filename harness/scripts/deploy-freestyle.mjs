// Deploys the harness, gateway and actors to one Freestyle VM. Safe to rerun.
// Only the gateway is public. The actor server stays on localhost with auth off.
// Usage: npm run deploy
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Freestyle } from "freestyle";

process.loadEnvFile(".env");
const { FREESTYLE_VM_ID: vmId, FREESTYLE_DOMAIN: domain } = process.env;
if (!vmId || !domain) throw new Error("set FREESTYLE_VM_ID and FREESTYLE_DOMAIN");

const freestyle = new Freestyle();
const vm = freestyle.vms.ref(vmId);
const ROOT = "/srv/lild";

async function run(command, timeoutMs = 180_000) {
  const result = await vm.exec({ command, timeoutMs });
  if (result.statusCode !== 0) {
    throw new Error(`failed: ${command.slice(0, 80)}\n${(result.stderr ?? "").slice(-600)}\n${(result.stdout ?? "").slice(-600)}`);
  }
  return result.stdout ?? "";
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

async function upload(base, paths, target) {
  for (const path of paths) {
    await vm.fs.writeTextFile(`${target}/${relative(base, path)}`, readFileSync(path, "utf8"));
  }
}

/** The VM gets runtime secrets only: never the Freestyle key that controls the VM itself. */
function vmEnv() {
  const lines = readFileSync(".env", "utf8").split("\n").filter((line) => !line.startsWith("FREESTYLE_"));
  const withGateway = lines.filter((line) => !line.startsWith("GATEWAY_BASE_URL="));
  return [...withGateway, `GATEWAY_BASE_URL=https://${domain}`, ""].join("\n");
}

const unit = (description, directory, command, after = "") => `[Unit]
Description=${description}
After=network-online.target ${after}
[Service]
User=ubuntu
WorkingDirectory=${directory}
Environment=HOME=/home/ubuntu
ExecStart=${command}
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
`;

console.log("stopping services");
await run("sudo systemctl stop lild-harness lild-gateway lild-actors 2>/dev/null; true");
await run(`sudo mkdir -p ${ROOT}/harness/src ${ROOT}/actors/src && sudo chown -R ubuntu:ubuntu ${ROOT}`);

console.log("uploading");
await upload("src", files("src"), `${ROOT}/harness/src`);
await upload(".", ["package.json", "package-lock.json", "tsconfig.json", "supabase-ca.crt", ".relay-agent-token"], `${ROOT}/harness`);
await vm.fs.writeTextFile(`${ROOT}/harness/.env`, vmEnv());
await upload("../actors", ["package.json", "bun.lock", "tsconfig.json", "bunfig.toml", ".env", "src/actors.ts"].map((name) => `../actors/${name}`), `${ROOT}/actors`);
await run(`sudo chown -R ubuntu:ubuntu ${ROOT} && chmod 600 ${ROOT}/harness/.env ${ROOT}/actors/.env ${ROOT}/harness/.relay-agent-token`);

console.log("installing");
await run(`cd ${ROOT}/actors && bun install 2>&1 | tail -1`, 300_000);
await run(`cd ${ROOT}/harness && npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -1`, 300_000);

console.log("starting actors");
const units = {
  "lild-actors": unit("LI/LD Terse actors", `${ROOT}/actors`, "/usr/local/bin/bunx durable-actors dev --no-watch"),
  "lild-harness": unit("LI/LD harness", `${ROOT}/harness`, `${ROOT}/harness/node_modules/.bin/tsx src/main.ts`, "lild-actors.service"),
  "lild-gateway": unit("LI/LD gateway", `${ROOT}/harness`, `${ROOT}/harness/node_modules/.bin/tsx src/gateway-main.ts`, "lild-actors.service"),
};
for (const [name, text] of Object.entries(units)) {
  await vm.fs.writeTextFile(`/tmp/${name}.service`, text);
  await run(`sudo mv /tmp/${name}.service /etc/systemd/system/ && sudo chown root:root /etc/systemd/system/${name}.service`);
}
await run("sudo systemctl daemon-reload && sudo systemctl enable lild-actors lild-harness lild-gateway 2>&1 | tail -1 && sudo systemctl start lild-actors");
await run("for i in $(seq 1 90); do curl -sf -m 2 http://127.0.0.1:7100/healthz >/dev/null && exit 0; sleep 2; done; exit 1", 200_000);

console.log("generating client");
await run(`cd ${ROOT}/actors && for i in $(seq 1 20); do bunx durable-actors generate --out-dir ../harness/generated >/dev/null 2>&1; grep -q invoke ../harness/generated/index.d.ts && exit 0; sleep 2; done; exit 1`, 120_000);

console.log("starting harness and gateway");
await run("sudo systemctl start lild-harness lild-gateway");
await run("for i in $(seq 1 45); do curl -sf -m 2 http://127.0.0.1:3001/health >/dev/null && exit 0; sleep 2; done; exit 1", 120_000);

console.log("routing domain");
await freestyle.tls.rules
  .create({ action: "allow", domain, source: { public: true }, destination: { vmId, port: 3001 } })
  .catch((error) => console.log("rule not created (it may already exist):", String(error.message).slice(0, 160)));

console.log(await run("systemctl is-active lild-actors lild-harness lild-gateway; sudo ss -ltnp | grep -E ':(3001|7100) ' | awk '{print $4}'"));
console.log(`deployed: https://${domain}/health`);
process.exit(0);
