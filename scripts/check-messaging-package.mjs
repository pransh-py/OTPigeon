/** Clean consumer check against the actual npm tarball, never the source tree. */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  pkg = JSON.parse(
    await readFile(join(root, "packages/otpigeon/package.json"), "utf8"),
  );
const directory = await mkdtemp(join(tmpdir(), "otpigeon-consumer-")),
  started = performance.now();
const run = (file, args) =>
  execFileSync(file, args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
try {
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(".local", `${pkg.name}-${pkg.version}.tgz`),
  ]);
  const consumer = `import assert from 'node:assert/strict';
import {MessagingClient} from 'otpigeon';
import {MockTransport} from 'otpigeon/testing';
import {createGateway,hashApiKey} from 'otpigeon/gateway';
import {existsSync} from 'node:fs';
assert.equal(existsSync('.otpigeon'),false);
assert.throws(()=>import.meta.resolve('whatsapp-web.js'));
const client=new MessagingClient({transport:new MockTransport(),minIntervalMs:0});await client.connect();
const key='otpg_test_'+ 'a'.repeat(43);
const gateway=await createGateway({databasePath:'disposable/messages.sqlite',storageSecret:'disposable-consumer-secret-'.repeat(3),projects:[{id:'consumer',environment:'test',keyHashes:[hashApiKey(key)],client}]});
try {
const {port}=await gateway.listen({port:0});
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'one'};
const response=await fetch('http://127.0.0.1:'+port+'/v1/messages',{method:'POST',headers,body:JSON.stringify({kind:'text',to:'+6834002',text:'Clean consumer message'})});
assert.equal(response.status,202);const message=await response.json();await gateway.runOnce();
const status=await fetch('http://127.0.0.1:'+port+'/v1/messages/'+message.id,{headers});assert.equal((await status.json()).status,'accepted');
console.log('Installed tarball: HTTP -> encrypted durable job -> mock send -> accepted');
}finally{await gateway.close();}
`;
  await writeFile(join(directory, "consumer.mjs"), consumer);
  const output = run(process.execPath, ["consumer.mjs"]);
  const examples = ["order-notification", "incoming-bot", "otp-verification"];
  for (const example of examples)
    run(process.execPath, [`node_modules/otpigeon/examples/${example}.js`]);
  const lock = JSON.parse(
    await readFile(join(root, "packages/otpigeon/package-lock.json"), "utf8"),
  );
  const types = lock.packages["node_modules/@types/node"].version;
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-dev",
    "@types/node@" + types,
  ]);
  await writeFile(
    join(directory, "consumer.mts"),
    `import {MessagingClient} from 'otpigeon';\nimport {MockTransport} from 'otpigeon/testing';\nimport {MemoryVerification} from 'otpigeon/verification';\nimport {createGateway,mongoKeyAuthorizer,verifyWebhook} from 'otpigeon/gateway';\nconst client=new MessagingClient({transport:new MockTransport()});\nclient.on('message',message=>message.reply('ready'));\nnew MemoryVerification({client});\n// @ts-expect-error image filename is required\nclient.sendImage({to:'+12025550123',data:new Uint8Array([1]),mimeType:'image/png'});\n`,
  );
  run(join(root, "packages/otpigeon/node_modules/.bin/tsc"), [
    "--noEmit",
    "--strict",
    "--types",
    "node",
    "--module",
    "nodenext",
    "--target",
    "es2022",
    "consumer.mts",
  ]);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  console.log(
    JSON.stringify(
      {
        package: `${pkg.name}@${pkg.version}`,
        node: process.version,
        elapsedSeconds: Number(
          ((performance.now() - started) / 1000).toFixed(2),
        ),
        mandatoryRuntimeDependencies: 0,
        optionalEngineInstalled: false,
        installedHttpFlow: output.trim(),
        examples,
        typescriptConsumer: "passed",
        externalBetaDevelopers: 0,
        liveMessages: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
